import {
  PlatformFeeConfig,
  ThresholdStatus,
  StapleItem,
  SuggestedFiller,
} from '../types/basket';

type Platform = 'zepto' | 'blinkit';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Self-contained delivery-fee calc so this module has no dependency on the
// basket compiler (compiler depends on movEngine, never the reverse). Mirrors
// the rule in basketCompiler.calcFees: waived at/above the free-delivery
// threshold, otherwise base fee scaled by the surge multiplier.
export function deliveryFeeFor(subtotal: number, cfg: PlatformFeeConfig): number {
  if (cfg.free_delivery_threshold > 0 && subtotal >= cfg.free_delivery_threshold) return 0;
  return Math.round(cfg.base_delivery_fee * cfg.surge_multiplier);
}

// A subtotal that is empty / corrupt carries no order to nudge.
const NO_ORDER: ThresholdStatus = {
  underThreshold: false,
  kind: null,
  subtotal: 0,
  target: 0,
  gap: 0,
  recoverable_fee: 0,
};

/**
 * Evaluates a single platform subtotal against its operational boundaries.
 *
 * Priority order:
 *   1. min_checkout_value — a hard gate. Below it the order cannot be placed at
 *      all, so this is always surfaced first.
 *   2. free_delivery_threshold — an optimisation. The order is valid but is
 *      paying an avoidable delivery fee that crossing this threshold would waive.
 *
 * `recoverable_fee` is the delivery fee currently charged at this subtotal — the
 * logistics saving a filler that reaches the free-delivery target would unlock.
 */
export function evaluateThreshold(subtotal: number, cfg: PlatformFeeConfig): ThresholdStatus {
  if (!Number.isFinite(subtotal) || subtotal <= 0) return NO_ORDER;

  const recoverable_fee = deliveryFeeFor(subtotal, cfg);

  if (cfg.min_checkout_value > 0 && subtotal < cfg.min_checkout_value) {
    return {
      underThreshold: true,
      kind: 'min_checkout',
      subtotal: round2(subtotal),
      target: cfg.min_checkout_value,
      gap: round2(cfg.min_checkout_value - subtotal),
      recoverable_fee,
    };
  }

  if (cfg.free_delivery_threshold > 0 && subtotal < cfg.free_delivery_threshold) {
    return {
      underThreshold: true,
      kind: 'free_delivery',
      subtotal: round2(subtotal),
      target: cfg.free_delivery_threshold,
      gap: round2(cfg.free_delivery_threshold - subtotal),
      recoverable_fee,
    };
  }

  return { ...NO_ORDER, subtotal: round2(subtotal) };
}

/**
 * Picks the single staple that bridges an under-threshold gap with the least
 * surplus spending. Only candidates on the given platform whose price actually
 * clears the shortfall qualify (a filler that doesn't cross the line unlocks
 * nothing). Among those, the one with the smallest overshoot (price - gap) wins,
 * tie-broken by the lower absolute price.
 *
 * Returns null when the status is healthy or no candidate can bridge the gap.
 */
export function pickGapFiller(
  status: ThresholdStatus,
  platform: Platform,
  candidates: StapleItem[],
): SuggestedFiller | null {
  if (!status.underThreshold || status.kind === null) return null;

  const gap = status.gap;
  const crossing = candidates.filter(
    c => c.platform === platform && Number.isFinite(c.price) && c.price >= gap,
  );
  if (crossing.length === 0) return null;

  crossing.sort((a, b) => a.price - gap - (b.price - gap) || a.price - b.price);
  const best = crossing[0];
  const surplus = round2(best.price - gap);

  // Only the free-delivery nudge produces a real logistics saving; reaching a
  // mandatory min-checkout is spend the user has to make to order at all.
  const recoverable_fee = status.kind === 'free_delivery' ? status.recoverable_fee : 0;
  const net_saving =
    status.kind === 'free_delivery' ? round2(recoverable_fee - surplus) : 0;

  return {
    platform,
    kind: status.kind,
    itemName: best.itemName,
    productId: best.productId,
    cost: best.price,
    gap,
    surplus,
    recoverable_fee,
    net_saving,
  };
}

/**
 * Builds gap-filler suggestions for a set of (platform, status) legs — typically
 * the legs of the winning strategy. Staples already present in the active basket
 * (matched by name against `excludeNames`) are dropped so we never suggest an
 * item the user already has. At most one filler is emitted per platform leg.
 */
export function buildFillerSuggestions(
  legs: { platform: Platform; status: ThresholdStatus }[],
  candidates: StapleItem[],
  excludeNames: Set<string>,
): SuggestedFiller[] {
  const pool = candidates.filter(c => !excludeNames.has(c.itemName.trim().toLowerCase()));

  const out: SuggestedFiller[] = [];
  for (const { platform, status } of legs) {
    const filler = pickGapFiller(status, platform, pool);
    if (filler) out.push(filler);
  }
  return out;
}
