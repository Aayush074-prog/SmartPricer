export interface ParsedProduct {
  id: string;
  name: string;
  brand: string;
  price: number;
  mrp: number;
  packSize: string;
  imageUrl: string;
  source: 'zepto' | 'blinkit';
}

// Mirrors the snake_case columns returned by Supabase from the products table.
export interface DbProduct {
  id: string;
  name: string;
  brand: string;
  price: number;
  mrp: number;
  pack_size: string;
  image_url: string;
  source: 'zepto' | 'blinkit';
  updated_at: string;
}

/**
 * How confident the name-matching engine is that this product satisfies
 * the user's requirement.
 *   pinned     – the user explicitly selected this SKU
 *   exact      – all search words matched the product name
 *   substitute – only a partial word set matched (trimmed fallback)
 */
export type MatchQuality = 'pinned' | 'exact' | 'substitute';

/** DbProduct enriched with an in-memory match confidence label. */
export interface RichProduct extends DbProduct {
  matchQuality: MatchQuality;
}
