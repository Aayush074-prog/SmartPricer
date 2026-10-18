import { DbProduct } from '../types/product';
import { dlog, dwarn } from '../lib/debugLog';
import {
  PlatformFeeConfig,
  PlatformBasketResult,
  SplitAllocation,
  SplitBasketResult,
  BasketCompilerResult,
  WinnerStrategy,
  StapleItem,
  ThresholdStatus,
} from '../types/basket';
import { evaluateThreshold, buildFillerSuggestions } from './movEngine';

type Platform = 'zepto' | 'blinkit';

interface Requirement {
  id: string;
  item_name: string;
}

function calcFees(
  subtotal: number,
  cfg: PlatformFeeConfig,
): { delivery_fee: number; handling_fee: number; packaging_fee: number; fees_total: number } {
  const delivery_fee =
    cfg.free_delivery_threshold > 0 && subtotal >= cfg.free_delivery_threshold
      ? 0
      : Math.round(cfg.base_delivery_fee * cfg.surge_multiplier);

  return {
    delivery_fee,
    handling_fee: cfg.handling_fee,
    packaging_fee: cfg.packaging_fee,
    fees_total: delivery_fee + cfg.handling_fee + cfg.packaging_fee,
  };
}

function buildMonolithic(
  platform: Platform,
  items: Requirement[],
  productsMap: Record<string, DbProduct[]>,
  cfg: PlatformFeeConfig,
): PlatformBasketResult {
  let subtotal = 0;
  let covered = 0;
  let oos = 0;

  dlog(`\n[basket:${platform}] ── Monolithic build (${items.length} item${items.length !== 1 ? 's' : ''}) ──`);

  for (const item of items) {
    const match = (productsMap[item.id] ?? []).find(p => p.source === platform && isUsable(p));
    if (match) {
      subtotal += match.price;
      covered++;
      dlog(`  ✓ "${item.item_name}" → "${match.name}" ₹${match.price} (${match.pack_size})`);
    } else {
      oos++;
      // No penalty — an unavailable item is simply not included in this platform's total.
      // The is_complete flag communicates the gap; the UI handles the warning.
      dwarn(`  ✗ "${item.item_name}" → not carried on ${platform}`);
    }
  }

  const is_complete = oos === 0;
  const { delivery_fee, handling_fee, packaging_fee, fees_total } = calcFees(subtotal, cfg);
  // Only apply fees when at least one item was actually found (no ghost orders).
  const total = covered > 0 ? round2(subtotal + fees_total) : 0;
  // MOV / free-delivery evaluation. An empty basket (nothing covered) carries no
  // order to nudge, so it is never flagged under-threshold.
  const threshold = covered > 0 ? evaluateThreshold(subtotal, cfg) : evaluateThreshold(0, cfg);

  dlog(
    `  ── subtotal ₹${round2(subtotal)}` +
    (covered > 0
      ? ` | del ₹${delivery_fee}${delivery_fee === 0 ? ' (free)' : ''}` +
        ` | handle ₹${handling_fee}` +
        (packaging_fee > 0 ? ` | pack ₹${packaging_fee}` : '') +
        ` | TOTAL ₹${total}`
      : ' | no items covered → TOTAL ₹0') +
    (oos > 0 ? ` ⚠ ${oos} item${oos !== 1 ? 's' : ''} not on ${platform}` : ''),
  );

  return {
    platform,
    subtotal: round2(subtotal),
    delivery_fee: covered > 0 ? delivery_fee : 0,
    handling_fee: covered > 0 ? handling_fee : 0,
    packaging_fee: covered > 0 ? packaging_fee : 0,
    total,
    covered_items: covered,
    oos_count: oos,
    is_complete,
    threshold,
  };
}

function buildSplit(
  items: Requirement[],
  productsMap: Record<string, DbProduct[]>,
  feeConfig: Record<Platform, PlatformFeeConfig>,
): SplitBasketResult {
  const allocations: SplitAllocation[] = [];
  let zepto_subtotal = 0;
  let blinkit_subtotal = 0;
  let uses_zepto = false;
  let uses_blinkit = false;
  let oos_both = 0;

  dlog(`\n[basket:split] ── Tactical split build (${items.length} item${items.length !== 1 ? 's' : ''}) ──`);

  for (const item of items) {
    const matches = productsMap[item.id] ?? [];
    const z = matches.find(p => p.source === 'zepto' && isUsable(p));
    const b = matches.find(p => p.source === 'blinkit' && isUsable(p));

    if (z && b) {
      if (z.price <= b.price) {
        allocations.push({ requirement_id: item.id, item_name: item.item_name, platform: 'zepto', product_name: z.name, price: z.price });
        zepto_subtotal += z.price;
        uses_zepto = true;
        dlog(`  → "${item.item_name}" Z ₹${z.price} ≤ B ₹${b.price} — Zepto`);
      } else {
        allocations.push({ requirement_id: item.id, item_name: item.item_name, platform: 'blinkit', product_name: b.name, price: b.price });
        blinkit_subtotal += b.price;
        uses_blinkit = true;
        dlog(`  → "${item.item_name}" B ₹${b.price} < Z ₹${z.price} — Blinkit`);
      }
    } else if (z) {
      allocations.push({ requirement_id: item.id, item_name: item.item_name, platform: 'zepto', product_name: z.name, price: z.price });
      zepto_subtotal += z.price;
      uses_zepto = true;
      dlog(`  → "${item.item_name}" Zepto-only ₹${z.price}`);
    } else if (b) {
      allocations.push({ requirement_id: item.id, item_name: item.item_name, platform: 'blinkit', product_name: b.name, price: b.price });
      blinkit_subtotal += b.price;
      uses_blinkit = true;
      dlog(`  → "${item.item_name}" Blinkit-only ₹${b.price}`);
    } else {
      // Cannot be sourced from either platform — price ₹0, no fees, no penalty.
      allocations.push({ requirement_id: item.id, item_name: item.item_name, platform: 'zepto', product_name: '[Not Available]', price: 0 });
      oos_both++;
      dwarn(`  ✗ "${item.item_name}" unavailable on both platforms`);
    }
  }

  const zepto_fees = uses_zepto ? calcFees(zepto_subtotal, feeConfig.zepto).fees_total : 0;
  const blinkit_fees = uses_blinkit ? calcFees(blinkit_subtotal, feeConfig.blinkit).fees_total : 0;
  const total = round2(zepto_subtotal + blinkit_subtotal + zepto_fees + blinkit_fees);

  // Per-leg MOV evaluation. A leg that carries no items is never under-threshold.
  const zepto_threshold = uses_zepto
    ? evaluateThreshold(zepto_subtotal, feeConfig.zepto)
    : evaluateThreshold(0, feeConfig.zepto);
  const blinkit_threshold = uses_blinkit
    ? evaluateThreshold(blinkit_subtotal, feeConfig.blinkit)
    : evaluateThreshold(0, feeConfig.blinkit);

  dlog(
    `  ── Z sub ₹${round2(zepto_subtotal)} + fees ₹${zepto_fees}` +
    ` | B sub ₹${round2(blinkit_subtotal)} + fees ₹${blinkit_fees}` +
    ` | SPLIT TOTAL ₹${total}` +
    (oos_both > 0 ? ` ⚠ ${oos_both} item${oos_both !== 1 ? 's' : ''} unavailable everywhere` : ''),
  );

  return {
    allocations,
    zepto_subtotal: round2(zepto_subtotal),
    blinkit_subtotal: round2(blinkit_subtotal),
    zepto_fees,
    blinkit_fees,
    total,
    uses_both_platforms: uses_zepto && uses_blinkit,
    oos_count: oos_both,
    is_complete: oos_both === 0,
    zepto_threshold,
    blinkit_threshold,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// A scraped product whose price is null/NaN/non-finite or non-positive is
// corrupt data (e.g. an "N/A" cell or a failed parse). Treat it as if the
// platform doesn't carry the item, so it's dropped from the aggregate instead
// of poisoning the subtotal with NaN and rendering a "₹NaN" total.
function isUsable(p: DbProduct): boolean {
  return Number.isFinite(p.price) && p.price > 0;
}

export function compileBasket(
  items: Requirement[],
  productsMap: Record<string, DbProduct[]>,
  feeConfig: Record<Platform, PlatformFeeConfig>,
  stapleCandidates: StapleItem[] = [],
): BasketCompilerResult | null {
  if (items.length === 0) return null;

  dlog(`\n${'═'.repeat(52)}`);
  dlog(`[basketCompiler] compileBasket() — ${items.length} item(s)`);

  // ── Consolidated Slot Matrix ─────────────────────────────────────────────
  // Each row is anchored by the user's requirement id — NOT by the scraped
  // vendor product name. "Baby Potato" (Zepto) and "Baby Potato (Aloo)"
  // (Blinkit) both resolve to the same slot because they share the same
  // parent requirement row. Name divergence between vendors is irrelevant.
  dlog(`[basketCompiler] Consolidated Slot Matrix:`);
  items.forEach(it => {
    const matches = productsMap[it.id] ?? [];
    const z = matches.find(p => p.source === 'zepto');
    const b = matches.find(p => p.source === 'blinkit');
    const zLabel = z ? `"${z.name}" ₹${z.price}` : 'not available';
    const bLabel = b ? `"${b.name}" ₹${b.price}` : 'not available';
    const splitHint =
      z && b
        ? ` → split picks ${z.price <= b.price ? 'Zepto' : 'Blinkit'} (₹${Math.min(z.price, b.price)})`
        : z ? ` → Zepto-only`
        : b ? ` → Blinkit-only`
        : ` → unavailable everywhere`;
    dlog(`  "${it.item_name}" → Zepto: ${zLabel} | Blinkit: ${bLabel}${splitHint}`);
  });
  dlog('');

  const zepto   = buildMonolithic('zepto',   items, productsMap, feeConfig.zepto);
  const blinkit = buildMonolithic('blinkit', items, productsMap, feeConfig.blinkit);
  const split   = buildSplit(items, productsMap, feeConfig);

  const isComplete = (s: WinnerStrategy) =>
    s === 'zepto' ? zepto.is_complete : s === 'blinkit' ? blinkit.is_complete : split.is_complete;

  // ── Split Sanity Guardrail ───────────────────────────────────────────────
  // When every item is exclusive to one platform, buildSplit correctly routes
  // each item to its only available store and charges both sets of fees. The
  // arithmetic is accurate: split total = zepto partial + blinkit partial
  // (= sum of both incomplete monolithic runs). Recommending that as a winner
  // over a cheaper single-store option is wrong. Disqualify any split whose
  // total >= the cheapest individual monolithic option.
  const cheapestMonolithic = Math.min(
    zepto.total > 0 ? zepto.total : Infinity,
    blinkit.total > 0 ? blinkit.total : Infinity,
  );
  const splitQualifies = split.total > 0 && split.total < cheapestMonolithic;

  if (split.total > 0 && !splitQualifies) {
    dlog(
      `[basketCompiler] ⚠ Split ₹${split.total} ≥ cheapest monolithic` +
      ` ₹${cheapestMonolithic === Infinity ? '∞' : cheapestMonolithic}` +
      ` — disqualified by sanity guardrail`,
    );
  }

  // Build candidate list. Split is only admitted when it beats every
  // single-platform option on pure cost.
  const allCandidates: [WinnerStrategy, number][] = (
    [
      ['zepto',   zepto.total],
      ['blinkit', blinkit.total],
      ['split',   split.total],
    ] as [WinnerStrategy, number][]
  ).filter(([s, t]) => t > 0 && (s !== 'split' || splitQualifies));

  // Sort by absolute landing cost, ascending. Index 0 = cheapest strategy.
  // Completeness is surfaced in the UI (greyed cells, "not found" labels) but
  // does NOT gate winner election — a cheaper partial order beats a more
  // expensive complete one.
  allCandidates.sort(([, ta], [, tb]) => ta - tb);

  if (allCandidates.length === 0) return null;

  const [winner, winner_total] = allCandidates[0];
  const [, runner_up_total]    = allCandidates[1] ?? allCandidates[0];
  const winner_is_complete     = isComplete(winner);
  const savings                = allCandidates.length > 1
    ? round2(runner_up_total - winner_total)
    : 0;

  // ── Smart Gap-Filler ─────────────────────────────────────────────────────
  // Evaluate only the winning strategy's legs — those are what the checkout
  // panel actually renders. A monolithic winner has one leg; a split winner has
  // up to two (only the under-threshold ones are worth nudging).
  const winnerLegs: { platform: Platform; status: ThresholdStatus }[] =
    winner === 'zepto'
      ? [{ platform: 'zepto', status: zepto.threshold }]
      : winner === 'blinkit'
      ? [{ platform: 'blinkit', status: blinkit.threshold }]
      : [
          { platform: 'zepto' as Platform, status: split.zepto_threshold },
          { platform: 'blinkit' as Platform, status: split.blinkit_threshold },
        ].filter(leg => leg.status.underThreshold);

  // Never suggest a staple the user already has in their requirement list.
  const excludeNames = new Set(items.map(i => i.item_name.trim().toLowerCase()));
  const suggestedFillers = buildFillerSuggestions(winnerLegs, stapleCandidates, excludeNames);

  dlog(
    `\n[basketCompiler] WINNER: ${winner.toUpperCase()} @ ₹${winner_total}` +
    ` (${winner_is_complete ? 'complete' : 'partial'})` +
    (savings > 0 ? ` | saves ₹${savings} vs runner-up` : ''),
  );
  suggestedFillers.forEach(f =>
    dlog(
      `[basketCompiler] 💡 Gap-filler (${f.platform}): add "${f.itemName}" ₹${f.cost}` +
      ` to bridge ₹${f.gap} → ` +
      (f.kind === 'free_delivery'
        ? `unlock free delivery, save ₹${f.recoverable_fee} (net ₹${f.net_saving})`
        : `reach minimum checkout`),
    ),
  );
  dlog(`${'═'.repeat(52)}\n`);

  return {
    zepto,
    blinkit,
    split,
    winner,
    winner_total,
    winner_is_complete,
    savings,
    suggestedFillers,
    computed_at: Date.now(),
  };
}
