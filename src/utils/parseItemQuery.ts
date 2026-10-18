export interface ParsedItemQuery {
  baseTerm: string;
  sizeHint: string | null;
}

// Matches size suffixes like "500ml", "1L", "500g", "1kg", "250gm", "1ltr", "5 litre"
const SIZE_RE = /\b(\d+(?:\.\d+)?)\s*(ml|l|ltr|litre|liter|g|gm|gram|kg)\b/i;

export function parseItemQuery(itemName: string): ParsedItemQuery {
  const match = itemName.match(SIZE_RE);
  if (!match) {
    return { baseTerm: itemName.trim(), sizeHint: null };
  }

  // Keep the raw number — Zepto stores pack sizes as "(5 L)", "(500 ml)", etc.
  // We match against the literal number so "5" finds "(5 L)" but not "(500 ml)".
  const rawNumber = match[1];
  const baseTerm = itemName.replace(match[0], '').replace(/\s+/g, ' ').trim();

  return { baseTerm, sizeHint: rawNumber };
}
