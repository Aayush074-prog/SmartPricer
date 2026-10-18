import { supabase } from './supabaseClient';
import { dlog, dwarn } from './debugLog';

export type Platform = 'zepto' | 'blinkit';

type SearchListener = (term: string) => void;

const ALL_PLATFORMS: Platform[] = ['zepto', 'blinkit'];

let queue: string[] = [];
const searchedThisSession = new Set<string>();
let listener: SearchListener | null = null;
let busy = false;
let pendingPlatforms = new Set<Platform>();
let queueDrainedCallback: (() => void) | null = null;

/** In-flight promises keyed by normalised search term (stampede guard). */
const inFlight = new Map<string, Promise<void>>();
/** Resolve functions for each active in-flight Promise. */
const resolvers = new Map<string, () => void>();

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function setQueueDrainedCallback(fn: (() => void) | null): void {
  queueDrainedCallback = fn;
}

function normalize(term: string): string {
  return term.toLowerCase().trim();
}

// Records that `key` was freshly scraped, so requestSearch()'s 2-hour TTL check
// can short-circuit repeat scrapes. Fire-and-forget: a cache-write failure must
// never block or crash the queue. Requires a unique constraint on
// price_snapshot_cache.search_term for the upsert's onConflict to work.
function writeCacheSnapshot(key: string): void {
  void supabase
    .from('price_snapshot_cache')
    .upsert({ search_term: key, fetched_at: new Date().toISOString() }, { onConflict: 'search_term' })
    .then(({ error }) => {
      if (error) dwarn(`[searchQueue] Cache snapshot write failed for "${key}":`, error.message);
      else dlog(`[searchQueue] Cache snapshot written for "${key}"`);
    });
}

function drainNext(): void {
  if (busy || queue.length === 0 || !listener) return;
  busy = true;
  pendingPlatforms = new Set<Platform>(ALL_PLATFORMS);
  const term = queue[0];
  dlog(`[searchQueue] Starting search for "${term}" (${queue.length} in queue)`);
  listener(term);
}

/**
 * Primary entry point for price-data fetching. Checks `price_snapshot_cache`
 * first; fires the WebView scrape only when the snapshot is absent or older
 * than 2 hours. Concurrent callers for the same term receive the same Promise
 * — only one WebView scrape is ever in-flight per normalised key.
 */
export async function requestSearch(term: string): Promise<void> {
  const key = normalize(term);

  // Stampede guard — coalesce all concurrent callers onto one Promise.
  if (inFlight.has(key)) {
    dlog(`[searchQueue] "${term}" already in-flight — coalescing caller`);
    return inFlight.get(key)!;
  }

  // Two-tier cache check — bypass WebView when a fresh snapshot exists.
  try {
    const { data } = await supabase
      .from('price_snapshot_cache')
      .select('fetched_at')
      .eq('search_term', key)
      .maybeSingle();

    if (data?.fetched_at) {
      const ageMs = Date.now() - new Date(data.fetched_at).getTime();
      if (ageMs < TWO_HOURS_MS) {
        dlog(
          `[searchQueue] "${term}" cache hit — ${Math.round(ageMs / 60_000)}m old, bypassing WebView`,
        );
        return;
      }
      dlog(
        `[searchQueue] "${term}" cache stale (${Math.round(ageMs / 60_000)}m old) — re-scraping`,
      );
    }
  } catch (err) {
    dwarn('[searchQueue] Cache check failed, falling through to WebView scrape:', err);
  }

  // Cache miss / stale — create in-flight Promise and enqueue the WebView scrape.
  const promise = new Promise<void>((resolve) => {
    resolvers.set(key, resolve);
  });
  inFlight.set(key, promise);
  promise.finally(() => {
    inFlight.delete(key);
    resolvers.delete(key);
  });

  enqueue(term);
  return promise;
}

export function enqueue(term: string): void {
  const key = normalize(term);
  if (searchedThisSession.has(key)) return;
  if (queue.some(t => normalize(t) === key)) return;
  queue.push(term);
  dlog(`[searchQueue] Enqueued "${term}"`);
  drainNext();
}

// Called by each platform's WebView once its results have been upserted.
// The queue only advances when ALL platforms report done for the current term.
export function onSearchDone(term: string, platform: Platform): void {
  // Guard against stale callbacks (e.g. a late response after the queue moved on).
  if (queue.length === 0 || normalize(queue[0]) !== normalize(term)) return;

  pendingPlatforms.delete(platform);
  dlog(`[searchQueue] "${term}" done on ${platform} — ${pendingPlatforms.size} platform(s) remaining`);

  if (pendingPlatforms.size > 0) return;

  const key = normalize(term);

  // Unblock all callers that were awaiting requestSearch() for this term.
  resolvers.get(key)?.();

  searchedThisSession.add(key);
  // A full scrape (all platforms) just completed — stamp the cache so the TTL
  // budget logic can bypass this term for the next 2 hours.
  writeCacheSnapshot(key);
  queue = queue.filter(t => normalize(t) !== key);
  busy = false;
  dlog(`[searchQueue] All platforms done for "${term}", ${queue.length} remaining`);
  drainNext();
  if (queue.length === 0 && queueDrainedCallback) {
    queueDrainedCallback();
  }
}

export function setSearchListener(fn: SearchListener | null): void {
  listener = fn;
  if (fn) drainNext();
}

// Like enqueue() but removes the term from the session-dedup set first, so
// an explicit user action always triggers a fresh scrape even if the term was
// already processed earlier this session (e.g. stale DB rows from old scrapes).
export function forceEnqueue(term: string): void {
  searchedThisSession.delete(normalize(term));
  enqueue(term);
}

// Remove a waiting term from the queue. Never cancels an in-flight search
// (i.e. queue[0] while busy) — only removes terms that haven't started yet.
export function dequeue(term: string): void {
  const key = normalize(term);
  if (busy && queue.length > 0 && normalize(queue[0]) === key) return;
  queue = queue.filter(t => normalize(t) !== key);
  searchedThisSession.delete(key);
}

// Hard-resets all in-memory state. Use when recovering from a stuck queue
// (e.g. scout mode where one platform is disabled and never calls onSearchDone).
export function flushQueue(): void {
  queue            = [];
  busy             = false;
  pendingPlatforms = new Set<Platform>();
  searchedThisSession.clear();
  // Resolve all pending in-flight promises so callers don't hang indefinitely.
  resolvers.forEach(resolve => resolve());
  inFlight.clear();
  resolvers.clear();
  dlog('[searchQueue] Queue flushed.');
}
