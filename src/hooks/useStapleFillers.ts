import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { StapleItem } from '../types/basket';
import { STAPLE_KEYWORDS } from '../config/staples';
import { dlog, dwarn } from '../lib/debugLog';

interface StapleRow {
  id: string;
  name: string;
  price: number;
  source: 'zepto' | 'blinkit';
}

/**
 * Loads high-frequency household staples (milk, curd, bread…) from the live
 * `products` table for use as MOV gap-fillers. Staples are identified by name
 * keyword today (see STAPLE_KEYWORDS); if the products schema later gains a
 * dedicated `is_staple` flag, swap the `.or(...)` filter below for a single
 * `.eq('is_staple', true)` — StapleItem and the gap-filler engine are unchanged.
 *
 * Returns the flat candidate pool; the basket compiler decides which (if any)
 * bridges a given under-threshold leg with the least surplus.
 */
export function useStapleFillers(): { staples: StapleItem[]; loading: boolean } {
  const [staples, setStaples] = useState<StapleItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Build "name.ilike.%milk%,name.ilike.%curd%,…" — a single OR-filtered query
      // rather than one round-trip per keyword.
      const orFilter = STAPLE_KEYWORDS.map(k => `name.ilike.%${k}%`).join(',');

      const { data, error } = await supabase
        .from('products')
        .select('id, name, price, source')
        .or(orFilter)
        .order('price', { ascending: true });

      if (cancelled) return;

      if (error) {
        dwarn('[useStapleFillers] staple query failed:', error.message);
        setStaples([]);
      } else {
        const rows = (data ?? []) as StapleRow[];
        const mapped: StapleItem[] = rows
          // Drop corrupt / non-positive prices so they can never be picked as a filler.
          .filter(r => Number.isFinite(r.price) && r.price > 0)
          .map(r => ({
            productId: r.id,
            itemName: r.name,
            price: r.price,
            platform: r.source,
          }));
        dlog(`[useStapleFillers] loaded ${mapped.length} staple candidate(s)`);
        setStaples(mapped);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { staples, loading };
}
