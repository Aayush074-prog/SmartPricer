export interface PlatformFeeConfig {
  base_delivery_fee: number;        // ₹ charged when subtotal < free_delivery_threshold
  free_delivery_threshold: number;  // subtotal at/above which delivery is waived (0 = always charged)
  min_checkout_value: number;       // ₹ minimum order value required to place an order at all (0 = none)
  handling_fee: number;             // flat per-order fee
  packaging_fee: number;            // flat per-order packaging fee
  surge_multiplier: number;         // 1.0 = normal; 1.5 = surge (applied to delivery fee only)
}

// Which operational boundary a basket subtotal falls short of. min_checkout is a
// hard gate (the order cannot be placed); free_delivery is an optimisation (the
// order is valid but pays an avoidable delivery fee). min_checkout takes priority.
export type ThresholdKind = 'min_checkout' | 'free_delivery';

// The Minimum-Order-Value evaluation for a single platform's subtotal.
export interface ThresholdStatus {
  underThreshold: boolean;      // true when subtotal falls short of an actionable threshold
  kind: ThresholdKind | null;   // which threshold is unmet (null when none / no order)
  subtotal: number;             // the platform subtotal this status was computed from
  target: number;               // subtotal value that must be reached (0 when not underThreshold)
  gap: number;                  // target - subtotal (>0 when underThreshold, else 0)
  recoverable_fee: number;      // delivery fee currently charged that reaching free_delivery would waive
}

// A staple product (milk, curd, bread…) sourced from the products table that is
// a candidate for bridging a basket's MOV gap.
export interface StapleItem {
  productId: string;
  itemName: string;
  price: number;
  platform: 'zepto' | 'blinkit';
}

// A ready-to-render suggestion for the checkout panel:
//   "Add {itemName} to unlock free delivery and save ₹{recoverable_fee}!"
export interface SuggestedFiller {
  platform: 'zepto' | 'blinkit';
  kind: ThresholdKind;      // whether adding this unlocks checkout or free delivery
  itemName: string;
  productId: string;
  cost: number;             // price of the filler item
  gap: number;              // shortfall it bridges
  surplus: number;          // cost - gap (rupees spent beyond the threshold)
  recoverable_fee: number;  // delivery fee waived by crossing free_delivery (the "save ₹X" figure); 0 for min_checkout
  net_saving: number;       // recoverable_fee - surplus for free_delivery; 0 for mandatory min_checkout
}

export interface PlatformBasketResult {
  platform: 'zepto' | 'blinkit';
  subtotal: number;
  delivery_fee: number;
  handling_fee: number;
  packaging_fee: number;
  total: number;
  covered_items: number;
  oos_count: number;
  is_complete: boolean;   // true when every basket item has a price match on this platform
  threshold: ThresholdStatus;   // MOV / free-delivery evaluation for this platform's subtotal
}

export interface SplitAllocation {
  requirement_id: string;
  item_name: string;
  platform: 'zepto' | 'blinkit';
  product_name: string;
  price: number;
}

export interface SplitBasketResult {
  allocations: SplitAllocation[];
  zepto_subtotal: number;
  blinkit_subtotal: number;
  zepto_fees: number;
  blinkit_fees: number;
  total: number;
  uses_both_platforms: boolean;
  oos_count: number;      // items with no match on either platform
  is_complete: boolean;   // true when every item can be routed to at least one platform
  zepto_threshold: ThresholdStatus;    // MOV evaluation for the Zepto leg of the split
  blinkit_threshold: ThresholdStatus;  // MOV evaluation for the Blinkit leg of the split
}

export type WinnerStrategy = 'zepto' | 'blinkit' | 'split';

export interface BasketCompilerResult {
  zepto: PlatformBasketResult;
  blinkit: PlatformBasketResult;
  split: SplitBasketResult;
  winner: WinnerStrategy;
  winner_total: number;
  winner_is_complete: boolean;
  savings: number;
  suggestedFillers: SuggestedFiller[];   // gap-filler nudges for the winning strategy's under-threshold legs
  computed_at: number;
}
