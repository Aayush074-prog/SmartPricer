import { ParsedProduct } from '../types/product';

// Blinkit product fields — shared across all card types we have seen.
// Prices are in RUPEES (not paise like Zepto).
interface BlinkitCartItem {
  product_id?:   number | string;
  product_name?: string;
  display_name?: string;
  price?:        number;
  mrp?:          number;
  unit?:         string;
  image_url?:    string;
  brand?:        string;
}

// ── Snippet-array extraction ──────────────────────────────────────────────────
// Blinkit uses at least three top-level shapes depending on query type:
//   1. Normal search   → payload.response.snippets  (packaged dairy, etc.)
//   2. Category browse → payload.response.objects
//   3. Typo / no-match → payload.snippets  OR  payload.data.snippets
//   4. Some layouts    → payload.response.results
function collectSnippets(raw: unknown): unknown[] {
  if (!raw || typeof raw !== 'object') return [];
  const p = raw as Record<string, unknown>;

  const resp = p.response as Record<string, unknown> | undefined;
  if (resp) {
    if (Array.isArray(resp.snippets)) return resp.snippets;
    if (Array.isArray(resp.objects))  return resp.objects;
    if (Array.isArray(resp.results))  return resp.results;
  }

  if (Array.isArray(p.snippets)) return p.snippets;
  if (Array.isArray(p.objects))  return p.objects;

  const data = p.data as Record<string, unknown> | undefined;
  if (data) {
    if (Array.isArray(data.snippets)) return data.snippets;
    if (Array.isArray(data.objects))  return data.objects;
  }

  return [];
}

// ── Cart-item extraction ───────────────────────────────────────────────────────
// Each snippet's product data may sit at different depths:
//   Path A (packaged goods): snippet.data.atc_action.add_to_cart.cart_item
//   Path B (some card types): snippet.data.atc_action.cart_item
//   Path C (fresh / loose):  snippet.data.product
//   Path D (flat layout):    snippet.data  (product_id lives directly on data)
// We also try each path with the data wrapper skipped, because some top-level
// arrays already unwrap it.
function extractCartItem(snippet: unknown): BlinkitCartItem | null {
  if (!snippet || typeof snippet !== 'object') return null;
  const s = snippet as Record<string, unknown>;

  // Try with and without the .data wrapper
  for (const node of [s.data, s]) {
    if (!node || typeof node !== 'object') continue;
    const d = node as Record<string, unknown>;

    // Path A & B — via atc_action
    const atc = d.atc_action as Record<string, unknown> | undefined;
    if (atc) {
      const add = atc.add_to_cart as Record<string, unknown> | undefined;
      if (add?.cart_item && typeof add.cart_item === 'object')
        return add.cart_item as BlinkitCartItem;

      if (atc.cart_item && typeof atc.cart_item === 'object')
        return atc.cart_item as BlinkitCartItem;
    }

    // Path C — product key (fresh produce / loose items)
    if (d.product && typeof d.product === 'object')
      return d.product as BlinkitCartItem;

    // Path D — flat: product_id sits directly on the node
    if (d.product_id !== undefined && d.product_name !== undefined)
      return d as BlinkitCartItem;
  }

  return null;
}

// ── Public entry point ────────────────────────────────────────────────────────

export function parseBlinkitSearchPayload(raw: unknown): ParsedProduct[] {
  // Do NOT gate on is_success — typo-correction payloads may return false
  // but still carry a valid snippets array with actual products.
  const snippets = collectSnippets(raw);
  if (snippets.length === 0) return [];

  const products: ParsedProduct[] = [];

  for (const snippet of snippets) {
    const item = extractCartItem(snippet);
    if (!item?.product_id || !item?.product_name) continue;

    const price = typeof item.price === 'number' ? item.price : 0;

    products.push({
      id:       `blinkit_${item.product_id}`,
      name:     item.display_name ?? item.product_name,
      brand:    typeof item.brand === 'string' ? item.brand : '',
      price,
      mrp:      typeof item.mrp === 'number' ? item.mrp : price,
      packSize: typeof item.unit === 'string' ? item.unit : '',
      imageUrl: typeof item.image_url === 'string' ? item.image_url : '',
      source:   'blinkit',
    });
  }

  return products;
}
