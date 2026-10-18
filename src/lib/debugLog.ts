// Lightweight debug logger. Silent in production builds (React Native sets the
// global `__DEV__` to false when bundling for release), so the verbose Phase 8
// diagnostics stay fully available in Expo Go / dev without shipping console
// noise to users. Route error reporting through a real service (e.g. Sentry)
// rather than these helpers if you need production-visible signals.
/* eslint-disable no-console */
export function dlog(...args: unknown[]): void {
  if (__DEV__) console.log(...args);
}

export function dwarn(...args: unknown[]): void {
  if (__DEV__) console.warn(...args);
}
