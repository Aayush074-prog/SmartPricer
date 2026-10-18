// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform product title matching (P10-05)
//
// Dependency-free. Replaces the old SQL `ILIKE %token%` substring-AND matcher,
// which was simultaneously too strict (any spelling drift like "mazedaar" vs
// "mazedar" broke the substring run → "Not available") and too loose (a 2-char
// token like "ma" matched the infix inside "Maxx"/"Ramen" → wrong product).
//
// The engine here is a length-gated Jaro-Winkler + Token-Set Coverage:
//   • order-independent (set membership, so scrambled word order is a non-issue),
//   • spelling-tolerant within a bounded window (fuzzy per-token equality),
//   • extra-token-tolerant (coverage is anchored on the query's strong tokens,
//     so a platform's extra descriptors like "Cup Noodles" never penalise),
//   • fail-closed on short/ambiguous tokens (a <3-char token must match exactly).
// ─────────────────────────────────────────────────────────────────────────────

// Packaging / format words that carry no product identity. Stripped entirely.
const HARD_NOISE = new Set([
  'pack', 'packet', 'packets', 'combo', 'pouch', 'bottle', 'box', 'jar',
  'sachet', 'refill', 'value', 'saver', 'buy', 'offer', 'free', 'pc', 'pcs',
  'of', 'with', 'the', 'and', 'for', 'a', 'an', 'in', 'on', 'or', 'to', 'x',
]);

// Format/category words that are weakly discriminative. Kept for tie-breaking
// but NOT required for a match, so "Nissin Mazedar Masala Cup Noodles" (Blinkit)
// still matches "Nissin Cup Mazedaar Masala" (Zepto) despite the missing
// "Noodles" token. Deliberately does NOT include flavour words like "masala"
// or "korean" — those stay strong so they can distinguish real variants.
const SOFT_CATEGORY = new Set([
  'cup', 'noodles', 'noodle', 'ramen',
]);

// Size / unit tokens are handled separately by sizeHint / pack_size and must
// never pollute name similarity, e.g. "70g", "1kg", "500", "ml".
const UNIT_RE = /^\d+(?:\.\d+)?(?:g|gm|gram|kg|ml|l|ltr|litre|liter|pc|pcs|pack|x)?$/;

export interface NormalizedTitle {
  strong: string[];   // discriminative tokens (brand, flavour, variant …)
  soft: string[];     // format/category tokens (cup, noodles …)
  all: string[];      // strong ∪ soft, in original order — the match corpus
}

/**
 * Deterministic sanitation → tokenisation → classification. Lowercases, strips
 * diacritics (mazedā → mazeda), replaces `&`→"and", drops punctuation, removes
 * size/unit tokens, then splits the rest into strong vs soft buckets.
 */
export function normalizeTitle(raw: string): NormalizedTitle {
  const cleaned = (raw ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritical marks
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')       // punctuation → space
    .trim();

  const strong: string[] = [];
  const soft: string[] = [];
  const all: string[] = [];

  for (const tok of cleaned.split(/\s+/)) {
    if (!tok) continue;
    if (UNIT_RE.test(tok)) continue;   // size/unit noise
    if (HARD_NOISE.has(tok)) continue; // packaging noise
    all.push(tok);
    if (SOFT_CATEGORY.has(tok)) soft.push(tok);
    else strong.push(tok);
  }

  return { strong, soft, all };
}

/**
 * Jaro similarity ∈ [0,1]. Rewards matched characters within a sliding window
 * and penalises transpositions.
 */
export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatched = new Array<boolean>(la).fill(false);
  const bMatched = new Array<boolean>(lb).fill(false);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, lb);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  // Count transpositions among the matched characters.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
}

/**
 * Jaro-Winkler: Jaro boosted by shared prefix length (capped at 4, scale 0.1).
 * Excels on short brand/product tokens and typos.
 */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  return j + prefix * 0.1 * (1 - j);
}

/**
 * Length-gated token equality — the short-token safeguard.
 *   • either token < 3 chars  → must be exactly equal ("ma" never fuzzes into
 *                               "maxx"/"masala"),
 *   • shorter token 3–4 chars → Jaro-Winkler ≥ 0.92 or exact,
 *   • shorter token ≥ 5 chars → Jaro-Winkler ≥ 0.88 (absorbs "mazedaar"≈"mazedar").
 */
export function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 3) return false;         // strict: short tokens require exact match
  const jw = jaroWinkler(a, b);
  if (minLen <= 4) return jw >= 0.92;
  return jw >= 0.88;
}

export type MatchTier = 'exact' | 'substitute';

export interface MatchScore {
  tier: MatchTier;
  coverage: number;      // matched strong tokens / total strong tokens
  softMatched: number;   // matched soft tokens (tie-breaker only)
}

/**
 * Scores a candidate title against an anchor title.
 *
 * Rules:
 *   • The anchor's FIRST strong token (brand) MUST match — otherwise reject.
 *   • coverage = matched strong tokens / |strong|.
 *   • coverage = 1.0                       → 'exact'
 *   • coverage ≥ 0.6 AND ≥ 2 strong hits   → 'substitute'
 *   • otherwise                            → null (fail closed)
 *
 * Anchoring coverage on the anchor's strong set (not the union) is what makes
 * extra candidate descriptors harmless.
 */
export function scoreMatch(anchor: NormalizedTitle, candidate: NormalizedTitle): MatchScore | null {
  // Fall back to soft/all tokens when the anchor has no strong tokens at all.
  const strong = anchor.strong.length > 0
    ? anchor.strong
    : (anchor.soft.length > 0 ? anchor.soft : anchor.all);
  if (strong.length === 0) return null;

  const brandMatched = candidate.all.some(c => tokensMatch(strong[0], c));
  if (!brandMatched) return null;

  let matchedStrong = 0;
  for (const s of strong) {
    if (candidate.all.some(c => tokensMatch(s, c))) matchedStrong++;
  }
  const coverage = matchedStrong / strong.length;

  let softMatched = 0;
  for (const s of anchor.soft) {
    if (candidate.all.some(c => tokensMatch(s, c))) softMatched++;
  }

  if (coverage >= 1) return { tier: 'exact', coverage, softMatched };
  if (coverage >= 0.6 && matchedStrong >= 2) return { tier: 'substitute', coverage, softMatched };
  return null;
}

/** Convenience wrapper that normalises both sides. */
export function classifyMatch(anchorText: string, candidateName: string): MatchScore | null {
  return scoreMatch(normalizeTitle(anchorText), normalizeTitle(candidateName));
}

/**
 * Seed tokens for the coarse SQL prefilter (retrieve stage). Returns the brand
 * token plus the longest strong token (both ≥ 3 chars, deduped). Seeding on the
 * stable brand guarantees spelling-variant rows are still retrieved for the
 * client-side rerank — critical, because the misspelled token itself can't be
 * used as a substring seed.
 */
export function selectSeeds(anchorText: string): string[] {
  const { strong } = normalizeTitle(anchorText);
  const eligible = strong.filter(t => t.length >= 3);
  if (eligible.length === 0) return [];

  const brand = eligible[0];
  const longest = eligible.reduce((a, b) => (b.length > a.length ? b : a), eligible[0]);
  return Array.from(new Set([brand, longest]));
}

export interface RankedMatch<T> {
  product: T;
  quality: MatchTier;
  coverage: number;
}

/**
 * Rerank stage: scores every candidate against the anchor, keeps the accepted
 * ones, and returns the single best. Ranking priority (fixing the old
 * price-first poisoning): exact before substitute → higher coverage → more soft
 * matches → lower price.
 */
export function pickBestMatch<T extends { name: string; price: number }>(
  anchorText: string,
  candidates: T[],
): RankedMatch<T> | null {
  const anchor = normalizeTitle(anchorText);

  let best: (RankedMatch<T> & { softMatched: number }) | null = null;
  for (const cand of candidates) {
    const score = scoreMatch(anchor, normalizeTitle(cand.name));
    if (!score) continue;

    const contender = {
      product: cand,
      quality: score.tier,
      coverage: score.coverage,
      softMatched: score.softMatched,
    };
    if (best === null || isBetter(contender, best)) best = contender;
  }

  if (!best) return null;
  return { product: best.product, quality: best.quality, coverage: best.coverage };
}

function tierRank(t: MatchTier): number {
  return t === 'exact' ? 1 : 0;
}

function isBetter<T extends { name: string; price: number }>(
  a: RankedMatch<T> & { softMatched: number },
  b: RankedMatch<T> & { softMatched: number },
): boolean {
  if (tierRank(a.quality) !== tierRank(b.quality)) return tierRank(a.quality) > tierRank(b.quality);
  if (a.coverage !== b.coverage) return a.coverage > b.coverage;
  if (a.softMatched !== b.softMatched) return a.softMatched > b.softMatched;
  return a.product.price < b.product.price;
}
