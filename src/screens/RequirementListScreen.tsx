import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabaseClient';
import { DbProduct, RichProduct, MatchQuality } from '../types/product';
import ProductCard from '../components/ProductCard';
import { requestSearch, forceEnqueue, dequeue, setQueueDrainedCallback } from '../lib/searchQueue';
import { parseItemQuery } from '../utils/parseItemQuery';
import { useBasket } from '../context/BasketContext';
import { compileBasket } from '../utils/basketCompiler';
import { useStapleFillers } from '../hooks/useStapleFillers';
import { selectSeeds, pickBestMatch } from '../utils/textMatch';
import { BasketCompilerResult, SuggestedFiller, PlatformFeeConfig } from '../types/basket';
import { resetLocationSetup } from '../components/WarmWebViewManager';

const STOP_WORDS = new Set(['and', 'the', 'of', 'a', 'an', 'in', 'for', 'or', 'with', '&']);

function toSearchWords(term: string): string[] {
  const words = term
    .split(/[\s&]+/)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
    // Keep numbers of any length (e.g. "3" in "3 in 1", "5" in "5 litre")
    // Keep text words longer than 1 char; drop stop words.
    .filter(w => w.length > 0 && !STOP_WORDS.has(w.toLowerCase()) && (/^\d+$/.test(w) || w.length > 1));
  return words.length > 0 ? words : [term.trim()];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchCandidates(
  orFilter: string,
  source: string,
  sizeHint: string | null,
  withSize: boolean,
): Promise<DbProduct[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase.from('products').select('*').eq('source', source).or(orFilter);
  // Zepto format: "1 pack (5 L)", "1 can (500 ml)" — match "(NUMBER " to avoid
  // "5" hitting "(500 ml)" or "(1.5 L)".
  if (withSize && sizeHint) q = q.ilike('pack_size', `%(${sizeHint} %`);
  const { data } = await q.order('price', { ascending: true }).limit(40);
  return (data ?? []) as DbProduct[];
}

/**
 * Extracts the canonical numeric pack size (in grams or millilitres) from a
 * pack_size string. Prefers parenthesised values (e.g. "1 pack (200 g)")
 * over bare values ("200g") so Zepto's "1 can (500 ml)" format is handled
 * correctly without matching the leading "1".
 */
function parsePackSize(packSize: string): { value: number; unit: 'g' | 'ml' } | null {
  const PAREN_RE    = /\((\d+(?:\.\d+)?)\s*(g|gm|gram|kg|ml|l|ltr|litre)\b/i;
  const FALLBACK_RE = /(\d+(?:\.\d+)?)\s*(g|gm|gram|kg|ml|l|ltr|litre)\b/i;
  const m = packSize.match(PAREN_RE) ?? packSize.match(FALLBACK_RE);
  if (!m) return null;

  const val = parseFloat(m[1]);
  const raw = m[2].toLowerCase();

  if (raw === 'kg')                                    return { value: val * 1000, unit: 'g'  };
  if (raw === 'l' || raw === 'ltr' || raw === 'litre') return { value: val * 1000, unit: 'ml' };
  if (raw === 'g' || raw === 'gm'  || raw === 'gram')  return { value: val,        unit: 'g'  };
  if (raw === 'ml')                                    return { value: val,        unit: 'ml' };
  return null;
}

/**
 * Returns true when two parsed sizes are in the same unit but one is at least
 * 2× the other — e.g. 200 g vs 500 g. Prices for different weight classes
 * cannot be meaningfully compared as if they were the same product.
 */
function packSizeMismatch(
  a: { value: number; unit: string },
  b: { value: number; unit: string },
): boolean {
  if (a.unit !== b.unit) return false; // Can't compare grams to ml
  return Math.max(a.value, b.value) / Math.min(a.value, b.value) >= 2.0;
}

/**
 * Finds the best product on one platform for an anchor title, using the
 * retrieve-then-rerank pipeline (see src/utils/textMatch.ts):
 *   1. RETRIEVE — coarse SQL prefilter: OR the brand + longest strong token as
 *      `name ILIKE` seeds. Seeding on the stable brand still surfaces
 *      spelling-variant rows (e.g. "mazedaar" when the anchor says "mazedar").
 *   2. RERANK — score each candidate with length-gated Jaro-Winkler + token-set
 *      coverage, then pick exact-over-substitute, coverage desc, price asc.
 *
 * `anchorText` is the RICHEST title available — a pinned product's full name
 * when the requirement is pinned, otherwise the user's typed query. Returns a
 * confidence label ('exact' | 'substitute'); 'substitute' is excluded from
 * pricing by the compiler. Returns null when nothing clears the match bar —
 * zero-data beats bad-data.
 */
async function findBestMatch(
  anchorText: string,
  sizeHint: string | null,
  source: string,
): Promise<{ product: DbProduct; quality: 'exact' | 'substitute' } | null> {
  const seeds = selectSeeds(anchorText);
  if (seeds.length === 0) return null;

  const orFilter = seeds.map(s => `name.ilike.%${s}%`).join(',');

  // Prefer size-constrained candidates; fall back to unconstrained if the size
  // filter starves the candidate pool (e.g. platform stores size only in name).
  let candidates = await fetchCandidates(orFilter, source, sizeHint, !!sizeHint);
  if (candidates.length === 0 && sizeHint) {
    candidates = await fetchCandidates(orFilter, source, sizeHint, false);
  }

  const best = pickBestMatch(anchorText, candidates);
  if (!best) return null;
  return { product: best.product, quality: best.quality };
}

const SOURCE_BADGE: Record<string, { bg: string; label: string }> = {
  zepto:   { bg: '#7C3AED', label: 'Z' },
  blinkit: { bg: '#F59E0B', label: 'B' },
};

type Requirement = {
  id: string;
  item_name: string;
  created_at: string;
  pinned_product_id: string | null;
};

export default function RequirementListScreen() {
  const [items, setItems] = useState<Requirement[]>([]);
  const [productsMap, setProductsMap] = useState<Record<string, RichProduct[]>>({});
  const [newItem, setNewItem] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [suggestions, setSuggestions] = useState<DbProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<DbProduct | null>(null);
  // Product id of the gap-filler currently being injected, so only its badge spins.
  const [addingFillerId, setAddingFillerId] = useState<string | null>(null);
  const debounceRef              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const realtimeDebounceRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef                 = useRef<Requirement[]>([]);
  // Tracks the words currently live in the suggestions dropdown so the
  // realtime callback can re-query them when fresh product rows land.
  const currentSuggestionWordsRef = useRef<string[] | null>(null);
  // Tracks the last term enqueued from the suggestions input so we can
  // dequeue the partial-word entry when the user keeps typing.
  const prevEnqueuedTermRef = useRef<string | null>(null);

  const { feeConfig, surgeActive, setSurge } = useBasket();
  const [feesExpanded, setFeesExpanded] = useState(false);
  const [roadmapVisible, setRoadmapVisible] = useState(false);
  const insets = useSafeAreaInsets();

  // Compiler-safe map: strip substitute matches so the basket totals are never
  // inflated by a product that only partially matched the requirement name.
  // Typed as RichProduct[] (not DbProduct[]) so renderItem can still read
  // matchQuality without a second lookup into the raw productsMap.
  const strictProductsMap = useMemo<Record<string, RichProduct[]>>(() => {
    const strict: Record<string, RichProduct[]> = {};
    for (const [id, products] of Object.entries(productsMap)) {
      strict[id] = products.filter(p => p.matchQuality !== 'substitute');
    }
    return strict;
  }, [productsMap]);

  // MOV gap-filler candidate pool (staples not necessarily in the basket).
  const { staples } = useStapleFillers();

  const basketResult: BasketCompilerResult | null = useMemo(
    () => compileBasket(items, strictProductsMap, feeConfig, staples),
    [items, strictProductsMap, feeConfig, staples],
  );

  // Subtotal / logistical fees / final landing cost for whichever strategy won,
  // so the collapsed panel can show one clean champion breakdown regardless of
  // which of the three candidates the compiler elected.
  const winnerMetrics = useMemo(() => {
    if (!basketResult) return null;
    const { winner, zepto, blinkit, split } = basketResult;
    if (winner === 'zepto') {
      return { subtotal: zepto.subtotal, fees: zepto.delivery_fee + zepto.handling_fee + zepto.packaging_fee, total: zepto.total };
    }
    if (winner === 'blinkit') {
      return { subtotal: blinkit.subtotal, fees: blinkit.delivery_fee + blinkit.handling_fee + blinkit.packaging_fee, total: blinkit.total };
    }
    return {
      subtotal: split.zepto_subtotal + split.blinkit_subtotal,
      fees: split.zepto_fees + split.blinkit_fees,
      total: split.total,
    };
  }, [basketResult]);

  // Free-delivery proximity for BOTH platforms, independent of who won the
  // basket math — powers the inline status label under each comparison card's
  // total. Derived straight from subtotal vs free_delivery_threshold so it always
  // reflects the delivery gap (never a min-checkout gap). Gaps round to whole ₹.
  const freeDelStatus = useMemo(() => {
    if (!basketResult) return null;
    const calc = (subtotal: number, covered: number, cfg: PlatformFeeConfig) => {
      // No items on this platform, or delivery never free → nothing to show.
      if (covered <= 0 || cfg.free_delivery_threshold <= 0) {
        return { show: false, unlocked: false, gap: 0 };
      }
      const gap = cfg.free_delivery_threshold - subtotal;
      return { show: true, unlocked: gap <= 0, gap: Math.max(0, Math.round(gap)) };
    };
    return {
      zepto: calc(basketResult.zepto.subtotal, basketResult.zepto.covered_items, feeConfig.zepto),
      blinkit: calc(basketResult.blinkit.subtotal, basketResult.blinkit.covered_items, feeConfig.blinkit),
    };
  }, [basketResult, feeConfig]);

  // Item-by-item roadmap for the winning strategy: which requirement is bought
  // on which platform and at what price. For a monolithic winner every covered
  // item lands on the one platform; for a split it follows the compiler's
  // per-item allocation (skipping the ₹0 "unavailable on both" sentinels).
  type RoadmapRow = { key: string; item: string; product: string; price: number };
  const roadmap = useMemo<{ zepto: RoadmapRow[]; blinkit: RoadmapRow[] }>(() => {
    const zepto: RoadmapRow[] = [];
    const blinkit: RoadmapRow[] = [];
    if (!basketResult) return { zepto, blinkit };

    if (basketResult.winner === 'split') {
      for (const a of basketResult.split.allocations) {
        if (a.price <= 0) continue; // sentinel for items unavailable on both platforms
        (a.platform === 'zepto' ? zepto : blinkit).push({
          key: a.requirement_id, item: a.item_name, product: a.product_name, price: a.price,
        });
      }
    } else {
      const src = basketResult.winner; // 'zepto' | 'blinkit'
      const bucket = src === 'zepto' ? zepto : blinkit;
      for (const it of items) {
        const match = (strictProductsMap[it.id] ?? []).find(p => p.source === src);
        if (match) bucket.push({ key: it.id, item: it.item_name, product: match.name, price: match.price });
      }
    }
    return { zepto, blinkit };
  }, [basketResult, items, strictProductsMap]);

  const roadmapZTotal = roadmap.zepto.reduce((s, r) => s + r.price, 0);
  const roadmapBTotal = roadmap.blinkit.reduce((s, r) => s + r.price, 0);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Keep itemsRef in sync so the drained callback can access current items.
  useEffect(() => { itemsRef.current = items; }, [items]);

  const fetchProductMatches = useCallback(async (requirements: Requirement[]) => {
    if (requirements.length === 0) return;

    // Per-invocation dedup cache keyed by "baseTerm|sizeHint".
    const termCache = new Map<string, Promise<RichProduct[]>>();

    const results = await Promise.all(
      requirements.map(async (req): Promise<{ id: string; products: RichProduct[] }> => {
        const { baseTerm, sizeHint } = parseItemQuery(req.item_name);

        // Pinned: show the user's chosen SKU for its platform, AND run a broad
        // search for all other platforms so the compiler can compare costs.
        if (req.pinned_product_id) {
          const { data: pinnedData } = await supabase
            .from('products')
            .select('*')
            .eq('id', req.pinned_product_id)
            .maybeSingle();

          const pinnedProduct: RichProduct | null = pinnedData
            ? { ...(pinnedData as DbProduct), matchQuality: 'pinned' }
            : null;

          const pinnedSource = pinnedProduct?.source;
          const otherSources = (['zepto', 'blinkit'] as const).filter(s => s !== pinnedSource);

          // Anchor cross-platform matching on the pinned product's rich title
          // (not the user's sparse typed query), so "Nissin Cup Mazedaar Masala"
          // — not "Nissin Ma" — drives the search on the other platform.
          const anchorText = pinnedProduct?.name ?? baseTerm;

          const otherResults = await Promise.all(
            otherSources.map(async (source): Promise<RichProduct | null> => {
              const result = await findBestMatch(anchorText, sizeHint, source);
              if (!result) return null;
              return { ...result.product, matchQuality: result.quality };
            }),
          );

          // Size guardrail: if a broad-search result is a different weight class
          // than the pinned product, degrade it — we don't want to compare
          // a 68g pinned Zepto SKU against a 500g Blinkit result as if equal.
          const pinnedSz = pinnedProduct ? parsePackSize(pinnedProduct.pack_size) : null;
          const sizeCheckedOthers = otherResults.map(other => {
            if (!other || !pinnedSz || sizeHint) return other;
            const otherSz = parsePackSize(other.pack_size);
            if (otherSz && packSizeMismatch(pinnedSz, otherSz)) {
              return { ...other, matchQuality: 'substitute' as MatchQuality };
            }
            return other;
          });

          const products = [pinnedProduct, ...sizeCheckedOthers].filter((p): p is RichProduct => p !== null);
          void requestSearch(baseTerm);
          return { id: req.id, products };
        }

        // Non-pinned: use termCache to avoid duplicate DB round-trips.
        const cacheKey = `${baseTerm}||${sizeHint ?? ''}`;

        if (!termCache.has(cacheKey)) {
          termCache.set(
            cacheKey,
            Promise.all(
              (['zepto', 'blinkit'] as const).map(async (source): Promise<RichProduct | null> => {
                // Non-pinned: anchor on the user's typed query term.
                const result = await findBestMatch(baseTerm, sizeHint, source);
                if (!result) return null;
                return { ...result.product, matchQuality: result.quality };
              }),
            ).then(perSource => {
              void requestSearch(baseTerm);
              let [z, b] = perSource;

              // Cross-platform size guardrail (no size hint means the user gave
              // no canonical weight). If the two platforms return products in
              // different weight classes (ratio ≥ 2×), comparing their prices
              // is semantically wrong — degrade both to 'substitute'.
              if (!sizeHint && z && b) {
                const zSz = parsePackSize(z.pack_size);
                const bSz = parsePackSize(b.pack_size);
                if (zSz && bSz && packSizeMismatch(zSz, bSz)) {
                  z = { ...z, matchQuality: 'substitute' };
                  b = { ...b, matchQuality: 'substitute' };
                }
              }

              return [z, b].filter((p): p is RichProduct => p !== null);
            }),
          );
        }

        const products = await termCache.get(cacheKey)!;
        return { id: req.id, products };
      }),
    );

    const map: Record<string, RichProduct[]> = {};
    for (const { id, products } of results) {
      map[id] = products;
    }

    // Post-normalisation merge: when two requirements share the same baseTerm
    // (duplicate list entries), consolidate their results and prefer the higher-
    // confidence match for each platform (exact beats substitute).
    const QUALITY_RANK: Record<MatchQuality, number> = { pinned: 2, exact: 1, substitute: 0 };
    const termMerge = new Map<string, RichProduct[]>();
    for (const req of requirements) {
      if (req.pinned_product_id) continue;
      const { baseTerm } = parseItemQuery(req.item_name);
      const existing = termMerge.get(baseTerm) ?? [];
      for (const p of map[req.id] ?? []) {
        const idx = existing.findIndex(e => e.source === p.source);
        if (idx === -1) {
          existing.push(p);
        } else if (QUALITY_RANK[p.matchQuality] > QUALITY_RANK[existing[idx].matchQuality]) {
          existing[idx] = p;
        }
      }
      termMerge.set(baseTerm, existing);
    }
    for (const req of requirements) {
      if (req.pinned_product_id) continue;
      const { baseTerm } = parseItemQuery(req.item_name);
      const merged = termMerge.get(baseTerm);
      if (merged) map[req.id] = merged;
    }

    setProductsMap(map);
  }, []);

  // Re-fetch product matches automatically once all background scrapes finish.
  useEffect(() => {
    setQueueDrainedCallback(() => {
      if (itemsRef.current.length > 0) {
        fetchProductMatches(itemsRef.current);
      }
      setRefreshingPrices(false);
    });
    return () => setQueueDrainedCallback(null);
  }, [fetchProductMatches]);

  // Live-refresh cards the moment any product row is upserted — don't wait for
  // the entire queue to drain. Debounced 600ms so a batch of 12 upserts fires
  // one re-fetch instead of twelve.
  useEffect(() => {
    const channel = supabase
      .channel('products-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'products' },
        () => {
          if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
          realtimeDebounceRef.current = setTimeout(async () => {
            // Refresh requirement-list cards.
            if (itemsRef.current.length > 0) fetchProductMatches(itemsRef.current);

            // Also refresh the suggestions dropdown if the user is actively
            // typing — this is what makes fresh scrape results appear instantly
            // instead of waiting for the 9-second fallback timer.
            const activeWords = currentSuggestionWordsRef.current;
            if (activeWords && activeWords.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let sq: any = supabase.from('products').select('*');
              for (const word of activeWords) sq = sq.ilike('name', `%${word}%`);
              const { data: freshData } = await sq.order('price', { ascending: true }).limit(6);
              const fresh = (freshData as DbProduct[]) ?? [];
              if (fresh.length > 0) setSuggestions(fresh);
            }
          }, 600);
        }
      )
      .subscribe();
    return () => {
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
      supabase.removeChannel(channel);
    };
  }, [fetchProductMatches]);

  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from('requirement_items')
      .select('id, item_name, created_at, pinned_product_id')
      .order('created_at', { ascending: false });

    if (error) {
      Alert.alert('Error', error.message);
    } else {
      const fetched = data ?? [];
      setItems(fetched);
      fetchProductMatches(fetched);
    }
    setLoading(false);
  }, [fetchProductMatches]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchItems();
    setRefreshing(false);
  }, [fetchItems]);

  // Hard price refresh: bypasses the 2-hour snapshot cache and the session-level
  // dedup so every term gets a live WebView scrape using the current location session.
  // Cards immediately switch to loading spinners; they repopulate when the queue drains.
  const handleRefreshPrices = useCallback(() => {
    if (items.length === 0 || refreshingPrices) return;
    setProductsMap({});
    setRefreshingPrices(true);
    const seen = new Set<string>();
    for (const item of items) {
      const { baseTerm } = parseItemQuery(item.item_name);
      if (!seen.has(baseTerm)) {
        seen.add(baseTerm);
        forceEnqueue(baseTerm);
      }
    }
  }, [items, refreshingPrices]);

  const handleTextChange = useCallback((text: string) => {
    setNewItem(text);
    setSelectedProduct(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = text.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      currentSuggestionWordsRef.current = null;
      prevEnqueuedTermRef.current = null;
      return;
    }

    const words = toSearchWords(trimmed).slice(0, 3);
    if (words.length === 0) {
      setSuggestions([]);
      currentSuggestionWordsRef.current = null;
      prevEnqueuedTermRef.current = null;
      return;
    }

    debounceRef.current = setTimeout(async () => {
      const { baseTerm } = parseItemQuery(trimmed);

      // Pin the active search words so the realtime callback can re-query
      // the suggestions dropdown the moment fresh rows land in Supabase.
      currentSuggestionWordsRef.current = words;

      // Drop the previous partial-word entry (e.g. "Pot") before enqueuing
      // the new one (e.g. "Pota") so only the most recent term sits in the
      // queue, not a trail of every intermediate keystroke.
      if (prevEnqueuedTermRef.current) dequeue(prevEnqueuedTermRef.current);
      prevEnqueuedTermRef.current = baseTerm;
      forceEnqueue(baseTerm);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase.from('products').select('*');
      for (const word of words) q = q.ilike('name', `%${word}%`);
      const { data } = await q.order('price', { ascending: true }).limit(6);
      setSuggestions((data as DbProduct[]) ?? []);
    }, 300);
  }, []);

  function handleSelectSuggestion(product: DbProduct) {
    setSelectedProduct(product);
    setSuggestions([]);
    currentSuggestionWordsRef.current = null;
    prevEnqueuedTermRef.current = null;
  }

  function handleClearSelection() {
    setSelectedProduct(null);
  }

  // Core insertion path shared by the manual add box and the one-tap gap-filler.
  // Handles auth → household resolution → same-name dedup → insert. Returns a
  // discriminated result so each caller can drive its own UI feedback instead of
  // firing alerts from deep inside shared logic.
  const addRequirement = useCallback(async (
    rawName: string,
    pinned_product_id: string | null,
  ): Promise<{ status: 'ok' | 'duplicate' | 'error'; message?: string }> => {
    const item_name = rawName.trim();
    if (!item_name) return { status: 'error', message: 'Empty item name.' };

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { status: 'error', message: 'Not authenticated.' };

    const { data: memberRows, error: memberError } = await supabase
      .from('household_members')
      .select('household_id')
      .eq('user_id', user.id)
      .limit(1);
    if (memberError || !memberRows?.length) {
      return {
        status: 'error',
        message: memberError?.message ?? 'No household_members row found for this user.',
      };
    }
    const { household_id } = memberRows[0];

    // Deduplicate: reject if an item with the same normalised name already exists
    // in this household. Prevents duplicate slots that split platform results
    // across two cards instead of showing them together under one requirement.
    const normalised = item_name.toLowerCase().trim();
    const { data: existing } = await supabase
      .from('requirement_items')
      .select('id')
      .eq('household_id', household_id)
      .ilike('item_name', normalised)
      .limit(1)
      .maybeSingle();
    if (existing) return { status: 'duplicate' };

    const { error } = await supabase
      .from('requirement_items')
      .insert({
        item_name,
        added_by: user.id,
        household_id,
        pinned_product_id,
      });
    if (error) return { status: 'error', message: error.message };

    return { status: 'ok' };
  }, []);

  async function handleAdd() {
    const item_name = newItem.trim();
    if (!item_name) return;

    setAdding(true);
    const result = await addRequirement(item_name, selectedProduct?.id ?? null);
    setAdding(false);

    if (result.status === 'duplicate') {
      Alert.alert('Already on your list', `"${item_name}" is already in your requirement list.`);
      return;
    }
    if (result.status === 'error') {
      Alert.alert('Error', result.message ?? 'Could not add item.');
      return;
    }

    setNewItem('');
    setSuggestions([]);
    setSelectedProduct(null);
    // Manual free-text adds have no pinned SKU, so kick off a live scrape.
    // Filler adds (below) always carry a pinned product_id, so they skip this.
    if (!selectedProduct) forceEnqueue(parseItemQuery(item_name).baseTerm);
    fetchItems();
  }

  // One-Tap Add: append a suggested staple (pinned to its exact SKU so the
  // basket picks up its known price on the intended platform) and let the memo
  // pipeline recompute — the nudge banner updates or vanishes as the threshold
  // is cleared. Tracks the in-flight product id so only the tapped badge spins.
  const handleAddFiller = useCallback(async (filler: SuggestedFiller) => {
    if (addingFillerId) return; // one injection at a time
    setAddingFillerId(filler.productId);
    const result = await addRequirement(filler.itemName, filler.productId);
    setAddingFillerId(null);

    if (result.status === 'error') {
      Alert.alert('Could not add', result.message ?? 'Please try again.');
      return;
    }
    // 'duplicate' means it's already on the list — a refetch still recomputes
    // the basket and settles the banner, so treat it the same as success.
    fetchItems();
  }, [addingFillerId, addRequirement, fetchItems]);

  async function handleDelete(id: string) {
    const { error } = await supabase.from('requirement_items').delete().eq('id', id);
    if (error) Alert.alert('Error', error.message);
    else {
      setItems(prev => prev.filter(item => item.id !== id));
      setProductsMap(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  // Clears the persisted per-platform location flags so the one-time setup
  // modals run again. The flags are only re-read when WarmWebViewManager
  // mounts (app-lifetime singleton), so the modals reappear on next relaunch.
  function handleResetLocation() {
    Alert.alert(
      'Reset delivery location?',
      'This clears your saved Zepto and Blinkit location setup. The setup screens will run again the next time you reopen the app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await resetLocationSetup();
              Alert.alert(
                'Location reset',
                'Please fully close and reopen SmartPricer to set your new location.',
              );
            } catch (e) {
              Alert.alert('Reset failed', e instanceof Error ? e.message : 'Could not clear location setup.');
            }
          },
        },
      ],
    );
  }

  const renderItem = ({ item }: { item: Requirement }) => {
    // Loading gate still reads from the raw map — a key is set there the moment
    // fetchProductMatches resolves, even if all results were filtered out.
    const isLoading = !(item.id in productsMap);
    // Card content reads from the strict map so substitutes never render as real
    // product cards. If a platform only had a substitute match, its slot shows
    // the greyed-out "Not available" placeholder instead.
    const matches = strictProductsMap[item.id];

    const zMatch = matches?.find(p => p.source === 'zepto') ?? null;
    const bMatch = matches?.find(p => p.source === 'blinkit') ?? null;

    return (
      <View style={styles.itemRow}>
        <View style={styles.itemHeader}>
          <Text style={styles.itemText}>{item.item_name}</Text>
          <TouchableOpacity onPress={() => handleDelete(item.id)}>
            <Text style={styles.deleteText}>Remove</Text>
          </TouchableOpacity>
        </View>

        {isLoading ? (
          <View style={styles.pendingRow}>
            <ActivityIndicator size="small" color="#9CA3AF" />
            <Text style={styles.pendingText}>Searching...</Text>
          </View>
        ) : (
          <>
            <ProductCard
              product={zMatch}
              matchQuality={zMatch?.matchQuality ?? 'unavailable'}
              source="zepto"
            />
            <ProductCard
              product={bMatch}
              matchQuality={bMatch?.matchQuality ?? 'unavailable'}
              source="blinkit"
            />
          </>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <Text style={styles.heading}>Requirement List</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={[
              styles.refreshPricesButton,
              (refreshingPrices || items.length === 0) && styles.refreshPricesButtonDisabled,
            ]}
            onPress={handleRefreshPrices}
            disabled={refreshingPrices || items.length === 0}
          >
            {refreshingPrices ? (
              <ActivityIndicator size="small" color="#2563EB" />
            ) : (
              <Text style={styles.refreshPricesText}>↻ Prices</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={handleResetLocation}>
            <Text style={styles.resetLocationText}>Reset location</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSignOut}>
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder='e.g. "Mustard Oil" or "Water 5 litre"'
          value={newItem}
          onChangeText={handleTextChange}
          onSubmitEditing={handleAdd}
          returnKeyType="done"
        />
        <TouchableOpacity style={styles.addButton} onPress={handleAdd} disabled={adding}>
          <Text style={styles.addButtonText}>{adding ? '...' : 'Add'}</Text>
        </TouchableOpacity>
      </View>

      {selectedProduct && (
        <View style={styles.selectedChip}>
          <View style={styles.selectedChipInfo}>
            <Text style={styles.selectedChipLabel}>Pinned: </Text>
            <Text style={styles.selectedChipName} numberOfLines={1}>
              {selectedProduct.name}
            </Text>
            <Text style={styles.selectedChipPrice}> ₹{selectedProduct.price.toFixed(0)}</Text>
          </View>
          <TouchableOpacity onPress={handleClearSelection} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.selectedChipClear}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {suggestions.length > 0 && !selectedProduct && (
        <ScrollView
          style={styles.suggestionsContainer}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {suggestions.map((product) => {
            const badge = SOURCE_BADGE[product.source] ?? { bg: '#6B7280', label: '?' };
            return (
              <TouchableOpacity
                key={product.id}
                style={styles.suggestionRow}
                onPress={() => handleSelectSuggestion(product)}
              >
                <View style={styles.suggestionInfo}>
                  <Text style={styles.suggestionName} numberOfLines={1}>{product.name}</Text>
                  <Text style={styles.suggestionMeta}>{product.pack_size} · ₹{product.price.toFixed(0)}</Text>
                </View>
                <View style={[styles.suggestionBadge, { backgroundColor: badge.bg }]}>
                  <Text style={styles.suggestionBadgeText}>{badge.label}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} size="large" color="#2563EB" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => item.id}
          contentContainerStyle={{ paddingBottom: 260 }}
          renderItem={renderItem}
          refreshing={refreshing}
          onRefresh={handleRefresh}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No items yet. Add your first requirement above.
            </Text>
          }
        />
      )}
      {/* Muted placeholder while items exist but no priced candidate has landed
          yet (scrapers still running / everything unavailable so far). */}
      {items.length > 0 && !basketResult && (
        <View style={[styles.checkoutPanel, styles.checkoutPanelMuted, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.awaitingRow}>
            <ActivityIndicator size="small" color="#9CA3AF" />
            <Text style={styles.awaitingText}>Awaiting local dark store calculations…</Text>
          </View>
        </View>
      )}

      {/* ── Sticky Checkout Recommendation Panel ── */}
      {basketResult && items.length > 0 && (
        <View style={[styles.checkoutPanel, { paddingBottom: Math.max(insets.bottom, 12) }]}>

          {/* Winner headline bar */}
          <View style={[
            styles.panelWinnerBar,
            basketResult.winner === 'zepto'   && { borderLeftColor: '#5C13C4' },
            basketResult.winner === 'blinkit' && { borderLeftColor: '#F7D117' },
            basketResult.winner === 'split'   && { borderLeftColor: '#10B981' },
          ]}>
            {basketResult.winner === 'zepto' && (
              <View style={styles.splitHeadlineRow}>
                <Text style={styles.panelWinnerText}>
                  {basketResult.winner_is_complete
                    ? `Order on Zepto — ₹${basketResult.zepto.total.toFixed(0)} total`
                    : `Best partial: Zepto — ₹${basketResult.zepto.total.toFixed(0)} (${basketResult.zepto.oos_count} item${basketResult.zepto.oos_count !== 1 ? 's' : ''} not available)`}
                </Text>
                {basketResult.savings > 0 && (
                  <View style={styles.savingsPill}>
                    <Text style={styles.savingsPillText}>Saves ₹{basketResult.savings.toFixed(0)}</Text>
                  </View>
                )}
              </View>
            )}
            {basketResult.winner === 'blinkit' && (
              <View style={styles.splitHeadlineRow}>
                <Text style={styles.panelWinnerText}>
                  {basketResult.winner_is_complete
                    ? `Order on Blinkit — ₹${basketResult.blinkit.total.toFixed(0)} total`
                    : `Best partial: Blinkit — ₹${basketResult.blinkit.total.toFixed(0)} (${basketResult.blinkit.oos_count} item${basketResult.blinkit.oos_count !== 1 ? 's' : ''} not available)`}
                </Text>
                {basketResult.savings > 0 && (
                  <View style={styles.savingsPill}>
                    <Text style={styles.savingsPillText}>Saves ₹{basketResult.savings.toFixed(0)}</Text>
                  </View>
                )}
              </View>
            )}
            {basketResult.winner === 'split' && (
              <View style={styles.splitHeadlineRow}>
                <Text style={styles.panelWinnerText}>
                  {basketResult.winner_is_complete
                    ? `Split Optimised — ₹${basketResult.split.total.toFixed(0)}`
                    : `Partial split — ₹${basketResult.split.total.toFixed(0)} (${basketResult.split.oos_count} unavailable)`}
                </Text>
                {basketResult.savings > 0 && (
                  <View style={styles.savingsPill}>
                    <Text style={styles.savingsPillText}>
                      Saves ₹{basketResult.savings.toFixed(0)}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* Platform comparison cells */}
          <View style={styles.platformRow}>
            {/* Zepto cell */}
            <View style={[
              styles.platformCell,
              basketResult.winner === 'zepto' && basketResult.zepto.is_complete && styles.platformCellWinner,
              !basketResult.zepto.is_complete && styles.platformCellIncomplete,
            ]}>
              <View style={[styles.sourceBadge, { backgroundColor: basketResult.zepto.is_complete ? '#5C13C4' : '#9CA3AF' }]}>
                <Text style={styles.sourceBadgeText}>Z</Text>
              </View>
              <View style={styles.platformInfo}>
                <Text style={styles.platformName}>Zepto</Text>
                {basketResult.zepto.covered_items > 0 ? (
                  <Text style={[
                    styles.platformTotal,
                    basketResult.winner === 'zepto' && basketResult.zepto.is_complete && styles.platformTotalWinner,
                    !basketResult.zepto.is_complete && styles.platformTotalIncomplete,
                  ]}>
                    ₹{basketResult.zepto.total.toFixed(0)}
                  </Text>
                ) : (
                  <Text style={styles.platformTotalNA}>N/A</Text>
                )}
                {!basketResult.zepto.is_complete && (
                  <Text style={styles.oosLabel}>
                    {basketResult.zepto.oos_count} item{basketResult.zepto.oos_count !== 1 ? 's' : ''} not found
                  </Text>
                )}
                {freeDelStatus?.zepto.show && (
                  freeDelStatus.zepto.unlocked ? (
                    <Text style={styles.freeDelOk} numberOfLines={1}>✓ Free Delivery</Text>
                  ) : (
                    <Text style={styles.freeDelGap} numberOfLines={1}>
                      ₹{freeDelStatus.zepto.gap} away from Free Del
                    </Text>
                  )
                )}
              </View>
              {basketResult.winner === 'zepto' && basketResult.zepto.is_complete && (
                <View style={[styles.bestTag, { backgroundColor: '#5C13C4' }]}>
                  <Text style={styles.bestTagText}>BEST</Text>
                </View>
              )}
            </View>

            <View style={styles.platformDivider} />

            {/* Blinkit cell */}
            <View style={[
              styles.platformCell,
              basketResult.winner === 'blinkit' && basketResult.blinkit.is_complete && styles.platformCellWinner,
              !basketResult.blinkit.is_complete && styles.platformCellIncomplete,
            ]}>
              <View style={[styles.sourceBadge, { backgroundColor: basketResult.blinkit.is_complete ? '#D97706' : '#9CA3AF' }]}>
                <Text style={styles.sourceBadgeText}>B</Text>
              </View>
              <View style={styles.platformInfo}>
                <Text style={styles.platformName}>Blinkit</Text>
                {basketResult.blinkit.covered_items > 0 ? (
                  <Text style={[
                    styles.platformTotal,
                    basketResult.winner === 'blinkit' && basketResult.blinkit.is_complete && styles.platformTotalWinner,
                    !basketResult.blinkit.is_complete && styles.platformTotalIncomplete,
                  ]}>
                    ₹{basketResult.blinkit.total.toFixed(0)}
                  </Text>
                ) : (
                  <Text style={styles.platformTotalNA}>N/A</Text>
                )}
                {!basketResult.blinkit.is_complete && (
                  <Text style={styles.oosLabel}>
                    {basketResult.blinkit.oos_count} item{basketResult.blinkit.oos_count !== 1 ? 's' : ''} not found
                  </Text>
                )}
                {freeDelStatus?.blinkit.show && (
                  freeDelStatus.blinkit.unlocked ? (
                    <Text style={styles.freeDelOk} numberOfLines={1}>✓ Free Delivery</Text>
                  ) : (
                    <Text style={styles.freeDelGap} numberOfLines={1}>
                      ₹{freeDelStatus.blinkit.gap} away from Free Del
                    </Text>
                  )
                )}
              </View>
              {basketResult.winner === 'blinkit' && basketResult.blinkit.is_complete && (
                <View style={[styles.bestTag, { backgroundColor: '#D97706' }]}>
                  <Text style={styles.bestTagText}>BEST</Text>
                </View>
              )}
            </View>
          </View>

          {/* Champion landing-cost breakdown: subtotal · logistical fees · total */}
          {winnerMetrics && (
            <View style={styles.metricsRow}>
              <View style={styles.metricCell}>
                <Text style={styles.metricLabel}>Subtotal</Text>
                <Text style={styles.metricValue}>₹{winnerMetrics.subtotal.toFixed(0)}</Text>
              </View>
              <View style={styles.metricDivider} />
              <View style={styles.metricCell}>
                <Text style={styles.metricLabel}>Fees</Text>
                <Text style={styles.metricValue}>₹{winnerMetrics.fees.toFixed(0)}</Text>
              </View>
              <View style={styles.metricDivider} />
              <View style={styles.metricCell}>
                <Text style={styles.metricLabel}>Total</Text>
                <Text style={[styles.metricValue, styles.metricValueTotal]}>₹{winnerMetrics.total.toFixed(0)}</Text>
              </View>
            </View>
          )}

          {/* Smart Nudge banners: one per under-threshold leg of the winning strategy */}
          {basketResult.suggestedFillers.map(filler => {
            const isFreeDelivery = filler.kind === 'free_delivery';
            const platformLabel = filler.platform === 'zepto' ? 'Zepto' : 'Blinkit';
            const accent = filler.platform === 'zepto' ? '#5C13C4' : '#D97706';
            const busy = addingFillerId === filler.productId;
            return (
              <View
                key={`${filler.platform}-${filler.productId}`}
                style={[styles.nudgeBanner, isFreeDelivery ? styles.nudgeBannerSave : styles.nudgeBannerWarn]}
              >
                <View style={styles.nudgeTextWrap}>
                  {isFreeDelivery ? (
                    <>
                      <Text style={styles.nudgeTitleSave}>💡 Unlock FREE delivery on {platformLabel}</Text>
                      <Text style={styles.nudgeSubtitle}>
                        Add {filler.itemName} (₹{filler.cost.toFixed(0)}) — save ₹{filler.recoverable_fee.toFixed(0)} in delivery
                        {filler.net_saving > 0 ? ` (net ₹${filler.net_saving.toFixed(0)})` : ''}
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text style={styles.nudgeTitleWarn}>⚠ Below {platformLabel} minimum order</Text>
                      <Text style={styles.nudgeSubtitle}>
                        Add ₹{filler.gap.toFixed(0)} more to checkout — e.g. {filler.itemName} (₹{filler.cost.toFixed(0)})
                      </Text>
                    </>
                  )}
                </View>
                <TouchableOpacity
                  style={[styles.nudgeAddBtn, { backgroundColor: accent }, busy && styles.nudgeAddBtnBusy]}
                  onPress={() => handleAddFiller(filler)}
                  disabled={busy || addingFillerId !== null}
                  activeOpacity={0.8}
                >
                  {busy
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.nudgeAddBtnText}>+ Add</Text>}
                </TouchableOpacity>
              </View>
            );
          })}

          {/* Tappable opener for the item-by-item allocation sheet (all winners) */}
          <TouchableOpacity style={styles.planRow} onPress={() => setRoadmapVisible(true)} activeOpacity={0.7}>
            <Text style={styles.planRowText}>
              {basketResult.winner === 'split'
                ? `${roadmap.zepto.length} on Zepto  ·  ${roadmap.blinkit.length} on Blinkit`
                : `All ${roadmap[basketResult.winner].length} item${roadmap[basketResult.winner].length !== 1 ? 's' : ''} on ${basketResult.winner === 'zepto' ? 'Zepto' : 'Blinkit'}`}
            </Text>
            <Text style={styles.planRowCta}>View plan ▸</Text>
          </TouchableOpacity>

          {/* Surge toggles + fee disclosure */}
          <View style={styles.panelControls}>
            <TouchableOpacity
              style={[styles.surgeChip, surgeActive.zepto && styles.surgeChipActive]}
              onPress={() => setSurge('zepto', !surgeActive.zepto)}
              activeOpacity={0.75}
            >
              <Text style={[styles.surgeChipText, surgeActive.zepto && styles.surgeChipTextActive]}>
                ⚡ Z Surge
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.surgeChip, surgeActive.blinkit && styles.surgeChipActive]}
              onPress={() => setSurge('blinkit', !surgeActive.blinkit)}
              activeOpacity={0.75}
            >
              <Text style={[styles.surgeChipText, surgeActive.blinkit && styles.surgeChipTextActive]}>
                ⚡ B Surge
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.feesToggle}
              onPress={() => setFeesExpanded(p => !p)}
              activeOpacity={0.75}
            >
              <Text style={styles.feesToggleText}>
                View Fees {feesExpanded ? '▲' : '▾'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Expandable per-platform fee breakdown */}
          {feesExpanded && (
            <View style={styles.feesBreakdown}>
              {basketResult.zepto.covered_items > 0 ? (
                <View style={styles.feesRow}>
                  <View style={[styles.feesBadge, { backgroundColor: '#5C13C4' }]}>
                    <Text style={styles.feesBadgeText}>Z</Text>
                  </View>
                  <Text style={styles.feesDetail}>
                    {`Del ₹${basketResult.zepto.delivery_fee}${basketResult.zepto.delivery_fee === 0 ? ' (free)' : ''} · Handle ₹${basketResult.zepto.handling_fee}${basketResult.zepto.packaging_fee > 0 ? ` · Pack ₹${basketResult.zepto.packaging_fee}` : ''} = `}
                    <Text style={styles.feesTotal}>
                      {`₹${basketResult.zepto.delivery_fee + basketResult.zepto.handling_fee + basketResult.zepto.packaging_fee}`}
                    </Text>
                    {!basketResult.zepto.is_complete ? <Text style={{ color: '#EF4444' }}>{` (partial)`}</Text> : null}
                  </Text>
                </View>
              ) : (
                <View style={styles.feesRow}>
                  <View style={[styles.feesBadge, { backgroundColor: '#9CA3AF' }]}>
                    <Text style={styles.feesBadgeText}>Z</Text>
                  </View>
                  <Text style={[styles.feesDetail, { color: '#9CA3AF' }]}>Zepto — no items available</Text>
                </View>
              )}
              {basketResult.blinkit.covered_items > 0 ? (
                <View style={styles.feesRow}>
                  <View style={[styles.feesBadge, { backgroundColor: '#D97706' }]}>
                    <Text style={styles.feesBadgeText}>B</Text>
                  </View>
                  <Text style={styles.feesDetail}>
                    {`Del ₹${basketResult.blinkit.delivery_fee}${basketResult.blinkit.delivery_fee === 0 ? ' (free)' : ''} · Handle ₹${basketResult.blinkit.handling_fee}${basketResult.blinkit.packaging_fee > 0 ? ` · Pack ₹${basketResult.blinkit.packaging_fee}` : ''} = `}
                    <Text style={styles.feesTotal}>
                      {`₹${basketResult.blinkit.delivery_fee + basketResult.blinkit.handling_fee + basketResult.blinkit.packaging_fee}`}
                    </Text>
                    {!basketResult.blinkit.is_complete ? <Text style={{ color: '#EF4444' }}>{` (partial)`}</Text> : null}
                  </Text>
                </View>
              ) : (
                <View style={styles.feesRow}>
                  <View style={[styles.feesBadge, { backgroundColor: '#9CA3AF' }]}>
                    <Text style={styles.feesBadgeText}>B</Text>
                  </View>
                  <Text style={[styles.feesDetail, { color: '#9CA3AF' }]}>Blinkit — no items available</Text>
                </View>
              )}
              {(surgeActive.zepto || surgeActive.blinkit) && (
                <Text style={styles.surgeNote}>⚡ Surge active — delivery fees at 1.5×</Text>
              )}
            </View>
          )}

        </View>
      )}

      {/* ── Detailed item-by-item allocation sheet ── */}
      <Modal
        visible={roadmapVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setRoadmapVisible(false)}
      >
        <View style={styles.roadmapBackdrop}>
          <TouchableOpacity
            style={styles.roadmapBackdropTap}
            activeOpacity={1}
            onPress={() => setRoadmapVisible(false)}
          />
          <View style={[styles.roadmapSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={styles.roadmapHandle} />
            <View style={styles.roadmapHeader}>
              <Text style={styles.roadmapTitle}>Your shopping plan</Text>
              <TouchableOpacity
                onPress={() => setRoadmapVisible(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.roadmapClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.roadmapScroll} contentContainerStyle={{ paddingBottom: 8 }}>
              {/* Section A — Zepto */}
              {roadmap.zepto.length > 0 && (
                <View style={styles.roadmapSection}>
                  <View style={styles.roadmapSectionHead}>
                    <View style={[styles.roadmapBadge, { backgroundColor: '#5C13C4' }]}>
                      <Text style={styles.roadmapBadgeText}>Z</Text>
                    </View>
                    <Text style={styles.roadmapSectionTitle}>
                      Buy from Zepto ({roadmap.zepto.length} item{roadmap.zepto.length !== 1 ? 's' : ''})
                    </Text>
                    <Text style={styles.roadmapSectionTotal}>₹{roadmapZTotal.toFixed(0)}</Text>
                  </View>
                  {roadmap.zepto.map(r => (
                    <View key={r.key} style={styles.roadmapItemRow}>
                      <View style={styles.roadmapItemInfo}>
                        <Text style={styles.roadmapItemName} numberOfLines={1}>{r.item}</Text>
                        <Text style={styles.roadmapItemProduct} numberOfLines={1}>{r.product}</Text>
                      </View>
                      <Text style={styles.roadmapItemPrice}>₹{r.price.toFixed(0)}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Section B — Blinkit */}
              {roadmap.blinkit.length > 0 && (
                <View style={styles.roadmapSection}>
                  <View style={styles.roadmapSectionHead}>
                    <View style={[styles.roadmapBadge, { backgroundColor: '#D97706' }]}>
                      <Text style={styles.roadmapBadgeText}>B</Text>
                    </View>
                    <Text style={styles.roadmapSectionTitle}>
                      Buy from Blinkit ({roadmap.blinkit.length} item{roadmap.blinkit.length !== 1 ? 's' : ''})
                    </Text>
                    <Text style={styles.roadmapSectionTotal}>₹{roadmapBTotal.toFixed(0)}</Text>
                  </View>
                  {roadmap.blinkit.map(r => (
                    <View key={r.key} style={styles.roadmapItemRow}>
                      <View style={styles.roadmapItemInfo}>
                        <Text style={styles.roadmapItemName} numberOfLines={1}>{r.item}</Text>
                        <Text style={styles.roadmapItemProduct} numberOfLines={1}>{r.product}</Text>
                      </View>
                      <Text style={styles.roadmapItemPrice}>₹{r.price.toFixed(0)}</Text>
                    </View>
                  ))}
                </View>
              )}

              {roadmap.zepto.length === 0 && roadmap.blinkit.length === 0 && (
                <Text style={styles.roadmapEmpty}>No items to route yet.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  heading: { fontSize: 20, fontWeight: '700' },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  refreshPricesButton: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#2563EB',
    minWidth: 76,
    alignItems: 'center',
    justifyContent: 'center',
    height: 30,
  },
  refreshPricesButtonDisabled: {
    borderColor: '#BFDBFE',
  },
  refreshPricesText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#2563EB',
  },
  resetLocationText: { color: '#2563EB', fontSize: 15 },
  signOutText: { color: '#EF4444', fontSize: 15 },
  inputRow: { flexDirection: 'row', padding: 16, gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: '#fff',
  },
  addButton: {
    backgroundColor: '#2563EB',
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  addButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  itemRow: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    borderRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  itemText: { fontSize: 16, fontWeight: '600', flex: 1, marginRight: 8 },
  deleteText: { color: '#EF4444', fontSize: 14, flexShrink: 0 },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  pendingText: { fontSize: 12, color: '#9CA3AF', fontStyle: 'italic' },
  emptyText: {
    textAlign: 'center',
    marginTop: 60,
    color: '#9CA3AF',
    fontSize: 15,
  },
  selectedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  selectedChipInfo: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  selectedChipLabel: { fontSize: 12, color: '#2563EB', fontWeight: '600' },
  selectedChipName: { fontSize: 12, color: '#1E40AF', flex: 1 },
  selectedChipPrice: { fontSize: 12, color: '#15803D', fontWeight: '700' },
  selectedChipClear: { fontSize: 14, color: '#6B7280' },
  suggestionsContainer: {
    marginHorizontal: 16,
    marginBottom: 6,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    maxHeight: 260,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 10,
    zIndex: 10,
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  suggestionInfo: { flex: 1, marginRight: 10 },
  suggestionName: { fontSize: 13, fontWeight: '600', color: '#111827' },
  suggestionMeta: { fontSize: 11, color: '#6B7280', marginTop: 1 },
  suggestionBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // ── Checkout Recommendation Panel ──────────────────────────────────────
  checkoutPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.10,
    shadowRadius: 8,
    elevation: 16,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  panelWinnerBar: {
    borderLeftWidth: 4,
    borderLeftColor: '#10B981',
    paddingLeft: 10,
    marginBottom: 10,
    justifyContent: 'center',
    minHeight: 28,
  },
  panelWinnerText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
  },
  splitHeadlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  savingsPill: {
    backgroundColor: '#10B981',
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  savingsPillText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  platformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  platformCell: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  platformCellWinner: {
    backgroundColor: '#F9FAFB',
  },
  sourceBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  platformInfo: {
    flex: 1,
  },
  platformName: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },
  platformTotal: {
    fontSize: 16,
    fontWeight: '700',
    color: '#374151',
  },
  platformTotalWinner: {
    color: '#111827',
  },
  bestTag: {
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  bestTagText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  platformDivider: {
    width: 1,
    height: 36,
    backgroundColor: '#E5E7EB',
    marginHorizontal: 4,
  },
  panelControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  surgeChip: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#F9FAFB',
  },
  surgeChipActive: {
    borderColor: '#F59E0B',
    backgroundColor: '#FFFBEB',
  },
  surgeChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6B7280',
  },
  surgeChipTextActive: {
    color: '#D97706',
  },
  feesToggle: {
    marginLeft: 'auto' as unknown as number,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  feesToggleText: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },
  feesBreakdown: {
    marginTop: 8,
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  feesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  feesBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  feesBadgeText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '700',
  },
  feesDetail: {
    fontSize: 11,
    color: '#374151',
    flex: 1,
    flexWrap: 'wrap',
  },
  feesTotal: {
    fontWeight: '700',
    color: '#111827',
  },
  surgeNote: {
    fontSize: 10,
    color: '#D97706',
    fontStyle: 'italic',
    marginTop: 2,
  },

  // ── Loading / awaiting placeholder ─────────────────────────────────────────
  checkoutPanelMuted: {
    paddingTop: 14,
  },
  awaitingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  awaitingText: {
    fontSize: 13,
    color: '#9CA3AF',
    fontStyle: 'italic',
  },

  // ── Champion metrics row ───────────────────────────────────────────────────
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    paddingVertical: 8,
    marginBottom: 8,
  },
  metricCell: {
    flex: 1,
    alignItems: 'center',
  },
  metricDivider: {
    width: 1,
    height: 26,
    backgroundColor: '#E5E7EB',
  },
  metricLabel: {
    fontSize: 10,
    color: '#6B7280',
    fontWeight: '500',
    marginBottom: 2,
  },
  metricValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#374151',
  },
  metricValueTotal: {
    color: '#111827',
    fontSize: 16,
  },

  // ── Smart Nudge (MOV gap-filler) banner ────────────────────────────────────
  nudgeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  nudgeBannerSave: {   // free-delivery optimisation — positive/green
    backgroundColor: '#ECFDF5',
    borderColor: '#10B981',
  },
  nudgeBannerWarn: {   // hard min-order gate — warm/amber warning
    backgroundColor: '#FFF7ED',
    borderColor: '#F59E0B',
  },
  nudgeTextWrap: {
    flex: 1,
    marginRight: 10,
  },
  nudgeTitleSave: {
    fontSize: 13,
    fontWeight: '700',
    color: '#047857',
    marginBottom: 2,
  },
  nudgeTitleWarn: {
    fontSize: 13,
    fontWeight: '700',
    color: '#B45309',
    marginBottom: 2,
  },
  nudgeSubtitle: {
    fontSize: 11,
    color: '#4B5563',
    fontWeight: '500',
    lineHeight: 15,
  },
  nudgeAddBtn: {
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minWidth: 66,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nudgeAddBtnBusy: {
    opacity: 0.7,
  },
  nudgeAddBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },

  // ── Plan opener row ────────────────────────────────────────────────────────
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 8,
  },
  planRowText: {
    fontSize: 12,
    color: '#374151',
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  planRowCta: {
    fontSize: 12,
    color: '#2563EB',
    fontWeight: '700',
  },

  // ── Detailed allocation sheet ──────────────────────────────────────────────
  roadmapBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  roadmapBackdropTap: {
    flex: 1,
  },
  roadmapSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 8,
    maxHeight: '80%',
  },
  roadmapHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D1D5DB',
    marginBottom: 10,
  },
  roadmapHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  roadmapTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
  },
  roadmapClose: {
    fontSize: 16,
    color: '#6B7280',
  },
  roadmapScroll: {
    flexGrow: 0,
  },
  roadmapSection: {
    marginTop: 8,
  },
  roadmapSectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    marginBottom: 4,
  },
  roadmapBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roadmapBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  roadmapSectionTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  roadmapSectionTotal: {
    fontSize: 14,
    fontWeight: '700',
    color: '#15803D',
  },
  roadmapItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingLeft: 30,
  },
  roadmapItemInfo: {
    flex: 1,
    marginRight: 10,
  },
  roadmapItemName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  roadmapItemProduct: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 1,
  },
  roadmapItemPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  roadmapEmpty: {
    textAlign: 'center',
    color: '#9CA3AF',
    fontSize: 14,
    paddingVertical: 24,
  },
  platformCellIncomplete: {
    opacity: 0.6,
  },
  platformTotalIncomplete: {
    color: '#9CA3AF',
  },
  platformTotalNA: {
    fontSize: 16,
    fontWeight: '700',
    color: '#D1D5DB',
  },
  oosLabel: {
    fontSize: 9,
    color: '#EF4444',
    fontWeight: '600',
    marginTop: 1,
  },
  // Inline free-delivery status under each platform total.
  freeDelOk: {
    fontSize: 10,
    color: '#059669',   // emerald — delivery already free
    fontWeight: '600',
    marginTop: 2,
  },
  freeDelGap: {
    fontSize: 10,
    color: '#6B7280',   // muted grey — distance to the free-delivery threshold
    fontWeight: '500',
    marginTop: 2,
  },
});
