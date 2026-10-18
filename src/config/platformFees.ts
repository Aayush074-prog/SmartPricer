import { PlatformFeeConfig } from '../types/basket';

export const DEFAULT_PLATFORM_FEES: Record<'zepto' | 'blinkit', PlatformFeeConfig> = {
  zepto: {
    base_delivery_fee: 30,
    free_delivery_threshold: 149,
    min_checkout_value: 99,
    handling_fee: 4,
    packaging_fee: 0,
    surge_multiplier: 1.0,
  },
  blinkit: {
    base_delivery_fee: 25,
    free_delivery_threshold: 199,
    min_checkout_value: 99,
    handling_fee: 5,
    packaging_fee: 0,
    surge_multiplier: 1.0,
  },
};

export const SURGE_MULTIPLIER = 1.5;
