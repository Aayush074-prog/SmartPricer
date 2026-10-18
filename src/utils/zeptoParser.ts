import { ParsedProduct } from '../types/product';

const ZEPTO_CDN = 'https://cdn.zeptonow.com/';

export function parseZeptoSearchPayload(payload: unknown): ParsedProduct[] {
  try {
    const p = payload as Record<string, unknown>;
    const layout = p?.layout;
    if (!Array.isArray(layout)) return [];

    const products: ParsedProduct[] = [];

    for (const widget of layout) {
      if (widget?.widgetId !== 'PRODUCT_GRID') continue;

      const items = widget?.data?.resolver?.data?.items;
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        try {
          const pr = item?.productResponse;

          const id: string = pr?.id ?? pr?.objectId ?? '';
          const name: string = pr?.product?.name ?? '';
          const brand: string = pr?.product?.brand ?? '';
          const packSize: string = pr?.productVariant?.formattedPacksize ?? '';
          const rawImage: string = pr?.productVariant?.images?.[0]?.path ?? '';
          const imageUrl: string = rawImage
            ? rawImage.startsWith('http') ? rawImage : `${ZEPTO_CDN}${rawImage}`
            : '';

          // Prices arrive in paise — divide by 100 for rupees.
          const price: number = Number(pr?.sellingPrice ?? 0) / 100;
          const mrp: number = Number(pr?.mrp ?? pr?.sellingPrice ?? 0) / 100;

          if (!id || !name) continue;

          products.push({ id, name, brand, price, mrp, packSize, imageUrl, source: 'zepto' });
        } catch {
          // Skip malformed individual items without aborting the batch.
        }
      }
    }

    console.log(`[zeptoParser] Extracted ${products.length} products.`);
    return products;
  } catch {
    return [];
  }
}
