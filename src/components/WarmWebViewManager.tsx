import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, Modal, PermissionsAndroid, Platform, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import WebView, { WebViewMessageEvent, WebViewNavigation } from 'react-native-webview';
import { parseZeptoSearchPayload } from '../utils/zeptoParser';
import { parseBlinkitSearchPayload } from '../utils/blinkitParser';
import { supabase } from '../lib/supabaseClient';
import { ParsedProduct } from '../types/product';
import { setSearchListener, onSearchDone } from '../lib/searchQueue';
import * as SecureStore from 'expo-secure-store';
import { dlog, dwarn } from '../lib/debugLog';

const ZEPTO_URL   = 'https://www.zepto.com/';
const BLINKIT_URL = 'https://blinkit.com/';

// SecureStore keys — one flag per platform, persisted across app sessions.
const LOCATION_KEY: Record<'zepto' | 'blinkit', string> = {
  zepto:   'smartpricer_zepto_location_set',
  blinkit: 'smartpricer_blinkit_location_set',
};

/**
 * Resets the one-time location setup for both platforms so the setup modal
 * reappears on next launch. Call from a Settings screen when the user moves
 * to a new area or wants to change their delivery pincode.
 */
export async function resetLocationSetup(): Promise<void> {
  await SecureStore.deleteItemAsync(LOCATION_KEY.zepto);
  await SecureStore.deleteItemAsync(LOCATION_KEY.blinkit);
}

// Confirmed P2-04: Zepto search microservice
const ZEPTO_SEARCH_ENDPOINT = 'user-search-service/api/v3/search';

// Confirmed P7-01: Blinkit layout-search endpoint
// GET /v1/layout/search?q={term}&search_type=type_to_search
const BLINKIT_SEARCH_ENDPOINT = 'v1/layout/search';

// ── Interceptors ──────────────────────────────────────────────────────────────
// Identical structure for both platforms; differ only in the domain filter and
// the emitted message type so each WebView's onMessage handler can route cleanly.

const ZEPTO_INTERCEPTOR_JS = `
(function () {
  'use strict';

  function isZepto(url) {
    if (!url) return false;
    return url.toLowerCase().indexOf('zepto') !== -1;
  }

  function emit(url, payload) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'ZEPTO_API_RESPONSE', url: url, payload: payload })
      );
    } catch (e) {}
  }

  var _fetch = window.fetch;
  window.fetch = function () {
    var args = Array.prototype.slice.call(arguments);
    var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    return _fetch.apply(this, args).then(function (response) {
      if (isZepto(url)) {
        var ct = response.headers.get('content-type') || '';
        if (ct.indexOf('application/json') !== -1) {
          response.clone().text().then(function (text) {
            try { emit(url, JSON.parse(text)); } catch (e) {}
          });
        }
      }
      return response;
    });
  };

  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._rnsUrl = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (isZepto(this._rnsUrl)) {
      var self = this;
      this.addEventListener('load', function () {
        var ct = self.getResponseHeader('content-type') || '';
        if (ct.indexOf('application/json') !== -1) {
          try { emit(self._rnsUrl, JSON.parse(self.responseText)); } catch (e) {}
        }
      });
    }
    return _send.apply(this, arguments);
  };

  true;
})();
`;

// SCOUT MODE: broadened interceptor — logs every request URL immediately on fire,
// then also captures the full JSON payload on response. Reverts to BLINKIT_INTERCEPTOR_JS
// once the endpoint is confirmed.
const BLINKIT_SCOUT_INTERCEPTOR_JS = `
(function () {
  'use strict';

  function emitUrl(method, url) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'BLINKIT_SCOUT_URL', method: method, url: url })
      );
    } catch (e) {}
  }

  function emitPayload(url, payload) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'BLINKIT_API_RESPONSE', url: url, payload: payload })
      );
    } catch (e) {}
  }

  var _fetch = window.fetch;
  window.fetch = function () {
    var args = Array.prototype.slice.call(arguments);
    var req  = args[0];
    var url  = typeof req === 'string' ? req : (req && req.url) || '';
    var method = (args[1] && args[1].method) || 'GET';

    emitUrl(method, url);

    return _fetch.apply(this, args).then(function (response) {
      var ct = response.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        response.clone().text().then(function (text) {
          try { emitPayload(url, JSON.parse(text)); } catch (e) {}
        });
      }
      return response;
    });
  };

  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._blkMethod = method;
    this._blkUrl    = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this._blkUrl) {
      emitUrl(this._blkMethod || 'XHR', this._blkUrl);
      var self = this;
      this.addEventListener('load', function () {
        var ct = self.getResponseHeader('content-type') || '';
        if (ct.indexOf('application/json') !== -1) {
          try { emitPayload(self._blkUrl, JSON.parse(self.responseText)); } catch (e) {}
        }
      });
    }
    return _send.apply(this, arguments);
  };

  true;
})();
`;

const BLINKIT_INTERCEPTOR_JS = `
(function () {
  'use strict';

  function isBlinkit(url) {
    if (!url) return false;
    var u = url.toLowerCase();
    return u.indexOf('blinkit') !== -1 || u.indexOf('grofers') !== -1;
  }

  function emit(url, payload) {
    try {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'BLINKIT_API_RESPONSE', url: url, payload: payload })
      );
    } catch (e) {}
  }

  var _fetch = window.fetch;
  window.fetch = function () {
    var args = Array.prototype.slice.call(arguments);
    var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    return _fetch.apply(this, args).then(function (response) {
      if (isBlinkit(url)) {
        var ct = response.headers.get('content-type') || '';
        if (ct.indexOf('application/json') !== -1) {
          response.clone().text().then(function (text) {
            try { emit(url, JSON.parse(text)); } catch (e) {}
          });
        }
      }
      return response;
    });
  };

  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._blkUrl = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (isBlinkit(this._blkUrl)) {
      var self = this;
      this.addEventListener('load', function () {
        var ct = self.getResponseHeader('content-type') || '';
        if (ct.indexOf('application/json') !== -1) {
          try { emit(self._blkUrl, JSON.parse(self.responseText)); } catch (e) {}
        }
      });
    }
    return _send.apply(this, arguments);
  };

  true;
})();
`;

// ── Search triggers ───────────────────────────────────────────────────────────

// Zepto: simulate typing in the search overlay (click icon → find input → submit).
const ZEPTO_DOM_SEARCH_JS = (query: string): string => `
(function () {
  var INPUT_SELS = [
    'input[type="search"]',
    'input[placeholder*="Search" i]',
    'input[name="q"]',
    'input[name="query"]',
    '[data-testid*="search" i] input',
    '[class*="SearchBar"] input',
    '[class*="search-bar"] input',
  ];
  var BTN_SELS = [
    '[data-testid*="search" i]',
    '[aria-label*="Search" i]',
    '[class*="SearchIcon"]',
    '[class*="search-icon" i]',
  ];

  function findInput() {
    for (var i = 0; i < INPUT_SELS.length; i++) {
      var el = document.querySelector(INPUT_SELS[i]);
      if (el) return el;
    }
    return null;
  }

  function submitSearch(input) {
    var setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    setter.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(function () {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
    }, 300);
  }

  var input = findInput();
  if (input) { submitSearch(input); return; }

  var btn = null;
  for (var j = 0; j < BTN_SELS.length; j++) {
    btn = document.querySelector(BTN_SELS[j]);
    if (btn) break;
  }
  if (!btn) return;

  btn.click();
  var attempts = 0;
  var poll = setInterval(function () {
    attempts++;
    var inp = findInput();
    if (inp) {
      clearInterval(poll);
      submitSearch(inp);
    } else if (attempts >= 15) {
      clearInterval(poll);
    }
  }, 200);
})();
true;
`;

// Blinkit: navigate to the search results page — DOM injection fails because
// the search input lives in a lazy React portal not present on first paint.
// Navigation causes injectedJavaScriptBeforeContentLoaded to re-run on the new
// page, keeping the interceptor active throughout.
const BLINKIT_SEARCH_JS = (query: string): string => `
(function () {
  window.location.href = 'https://blinkit.com/s/?q=' + encodeURIComponent(${JSON.stringify(query)});
})();
true;
`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ZeptoApiMessage {
  type: 'ZEPTO_API_RESPONSE';
  url: string;
  payload: unknown;
}

interface BlinkitApiMessage {
  type: 'BLINKIT_API_RESPONSE';
  url: string;
  payload: unknown;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

async function upsertProducts(products: ParsedProduct[]): Promise<void> {
  if (products.length === 0) return;

  const seen = new Set<string>();
  const unique = products.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const rows = unique.map(p => ({
    id:         p.id,
    name:       p.name,
    brand:      p.brand,
    price:      p.price,
    mrp:        p.mrp,
    pack_size:  p.packSize,
    image_url:  p.imageUrl,
    source:     p.source,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('products')
    .upsert(rows, { onConflict: 'id' });

  if (error) {
    dwarn('[WarmWebViewManager] Upsert error:', error.message);
  } else {
    dlog(
      `[WarmWebViewManager] Upserted ${unique.length} ${unique[0]?.source} products` +
      ` (deduped from ${products.length}).`
    );
  }
}

const LOG_PREVIEW_CHARS = 6000;

function logPayload(platform: string, url: string, payload: unknown): void {
  const full = JSON.stringify(payload, null, 2);
  const preview = full.length > LOG_PREVIEW_CHARS
    ? full.slice(0, LOG_PREVIEW_CHARS) + `\n… [truncated — ${full.length} chars total]`
    : full;

  dlog(`\n[WarmWebViewManager] ── ${platform} ────────────────────────────────`);
  dlog('[WarmWebViewManager] URL    :', url);
  if (payload !== null && typeof payload === 'object') {
    dlog('[WarmWebViewManager] Shape  :', JSON.stringify(Object.keys(payload as object)));
  }
  dlog('[WarmWebViewManager] Payload:\n', preview);
  dlog('[WarmWebViewManager] ─────────────────────────────────────────────\n');
}

// How long after the last search response to consider a platform "done".
// Zepto fires ~4 full responses; Blinkit fires 1 initial + pagination calls.
const SEARCH_DONE_DELAY_MS = 4000;

// ── Component ─────────────────────────────────────────────────────────────────
// Both WebViews are permanently resident and off-screen. Unmounting destroys
// their native cookie stores and breaks session warmth.

export default function WarmWebViewManager() {
  const zeptoRef   = useRef<WebView>(null);
  const blinkitRef = useRef<WebView>(null);

  const zeptoReadyRef   = useRef(false);
  const blinkitReadyRef = useRef(false);
  const currentTermRef  = useRef<string | null>(null);

  const zeptoDoneTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkitDoneTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Unblocks the queue if EITHER platform fails to report done within 20s
  // (e.g. Zepto DOM injection fails silently, or Blinkit returns no results
  // and scheduleBlinkitDone never fires).
  const searchSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Single listener: fires both platform searches simultaneously so Zepto and
  // Blinkit scrape the same term in parallel, halving total queue wait time.
  const triggerSearch = useRef((term: string): void => {
    currentTermRef.current = term;

    if (zeptoDoneTimerRef.current)    clearTimeout(zeptoDoneTimerRef.current);
    if (blinkitDoneTimerRef.current)  clearTimeout(blinkitDoneTimerRef.current);
    if (searchSafetyTimerRef.current) clearTimeout(searchSafetyTimerRef.current);

    if (zeptoReadyRef.current) {
      dlog(`[WarmWebViewManager] Zepto — searching "${term}"…`);
      zeptoRef.current?.injectJavaScript(ZEPTO_DOM_SEARCH_JS(term));
    } else {
      dlog(`[WarmWebViewManager] Zepto not ready — will search "${term}" on load.`);
    }

    // Safety net: mark BOTH platforms done after 20 s if either fails to
    // respond (Zepto DOM miss, Blinkit no-result, network error, etc.).
    // Each onSearchDone call is a no-op for a platform that already reported.
    searchSafetyTimerRef.current = setTimeout(() => {
      dlog(`[WarmWebViewManager] Safety timeout for "${term}" — unblocking queue.`);
      onSearchDone(term, 'zepto');
      onSearchDone(term, 'blinkit');
    }, 20000);

    if (blinkitReadyRef.current) {
      dlog(`[WarmWebViewManager] Blinkit — navigating to search "${term}"…`);
      blinkitRef.current?.injectJavaScript(BLINKIT_SEARCH_JS(term));
    } else {
      dlog(`[WarmWebViewManager] Blinkit not ready — will search "${term}" on load.`);
    }
  }).current;

  useEffect(() => {
    setSearchListener(triggerSearch);
    return () => {
      setSearchListener(null);
      if (zeptoDoneTimerRef.current)    clearTimeout(zeptoDoneTimerRef.current);
      if (blinkitDoneTimerRef.current)  clearTimeout(blinkitDoneTimerRef.current);
      if (searchSafetyTimerRef.current) clearTimeout(searchSafetyTimerRef.current);
    };
  }, [triggerSearch]);

  // ── Location setup state ─────────────────────────────────────────────────────
  // Tracks whether the user has completed the one-time address-selection flow
  // for each platform. Without this, the hidden WebViews default to a distant
  // warehouse because they have no session cookies or GPS context.
  const [locationReady, setLocationReady] = useState<Record<'zepto' | 'blinkit', boolean>>({
    zepto:   false,
    blinkit: false,
  });
  // Which platform's setup modal is currently visible (null = none).
  const [activeSetup, setActiveSetup] = useState<'zepto' | 'blinkit' | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const z = await SecureStore.getItemAsync(LOCATION_KEY.zepto);
        const b = await SecureStore.getItemAsync(LOCATION_KEY.blinkit);
        const ready = { zepto: z === 'true', blinkit: b === 'true' };
        setLocationReady(ready);
        // Show setup for the first platform that hasn't been configured yet.
        if (!ready.zepto)        setActiveSetup('zepto');
        else if (!ready.blinkit) setActiveSetup('blinkit');
      } catch {
        // SecureStore unavailable (emulator without secure hardware) — skip
        // location setup so the app still works in degraded mode.
        dwarn('[WarmWebViewManager] SecureStore unavailable — skipping location setup.');
      }
    })();
  }, []);

  // The WebView's `geolocationEnabled` prop only lets the page *ask* for a fix;
  // on Android the host app must also hold the ACCESS_FINE_LOCATION runtime
  // grant, or react-native-webview denies the request and the page reports
  // "location couldn't be determined". Request it once a setup modal opens.
  // iOS routes WKWebView geolocation through the app's Info.plist usage string,
  // so there is no runtime call to make here. Fully guarded so a permission
  // failure never crashes the manager.
  useEffect(() => {
    if (activeSetup === null || Platform.OS !== 'android') return;
    (async () => {
      try {
        const granted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        if (!granted) {
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          );
        }
      } catch (e) {
        dwarn('[WarmWebViewManager] Location permission request failed:', e);
      }
    })();
  }, [activeSetup]);

  // User pressed "Confirm" after selecting their address in the setup modal.
  // Persist the flag, reload the hidden WebView (so it inherits the session
  // cookies the modal just wrote), then advance to the next platform if needed.
  async function handleLocationConfirm() {
    if (!activeSetup) return;
    try {
      await SecureStore.setItemAsync(LOCATION_KEY[activeSetup], 'true');
    } catch { /* ignore — worst case the modal reappears next session */ }

    if (activeSetup === 'zepto') {
      // Reload the hidden Zepto WebView with the freshly-set address session.
      zeptoReadyRef.current = false;
      zeptoRef.current?.reload();
      const blinkitAlreadyReady = locationReady.blinkit;
      setLocationReady(prev => ({ ...prev, zepto: true }));
      setActiveSetup(blinkitAlreadyReady ? null : 'blinkit');
    } else {
      blinkitReadyRef.current = false;
      blinkitRef.current?.reload();
      setLocationReady(prev => ({ ...prev, blinkit: true }));
      setActiveSetup(null);
    }
  }

  // User dismissed the modal without confirming — the flag is NOT persisted,
  // so the modal will reappear on the next app launch.
  function handleLocationSkip() {
    if (activeSetup === 'zepto' && !locationReady.blinkit) {
      setActiveSetup('blinkit');
    } else {
      setActiveSetup(null);
    }
  }

  // ── Zepto handlers ──────────────────────────────────────────────────────────

  const scheduleZeptoDone = (): void => {
    if (zeptoDoneTimerRef.current) clearTimeout(zeptoDoneTimerRef.current);
    zeptoDoneTimerRef.current = setTimeout(() => {
      if (currentTermRef.current !== null) {
        onSearchDone(currentTermRef.current, 'zepto');
      }
    }, SEARCH_DONE_DELAY_MS);
  };

  const handleZeptoLoadEnd = (): void => {
    // Re-inject on every load as backup for Android's early-fetch race.
    zeptoRef.current?.injectJavaScript(ZEPTO_INTERCEPTOR_JS);

    if (zeptoReadyRef.current) return;
    zeptoReadyRef.current = true;

    if (currentTermRef.current) {
      dlog(`[WarmWebViewManager] Zepto ready — searching "${currentTermRef.current}"…`);
      zeptoRef.current?.injectJavaScript(ZEPTO_DOM_SEARCH_JS(currentTermRef.current));
    }
  };

  const handleZeptoMessage = async (event: WebViewMessageEvent): Promise<void> => {
    try {
      const message: ZeptoApiMessage = JSON.parse(event.nativeEvent.data);
      if (message.type !== 'ZEPTO_API_RESPONSE') return;
      if (!message.url.includes(ZEPTO_SEARCH_ENDPOINT)) return;
      if (
        message.payload === null ||
        typeof message.payload !== 'object' ||
        !('pageType' in (message.payload as object))
      ) return;

      logPayload('Zepto', message.url, message.payload);
      const products = parseZeptoSearchPayload(message.payload);
      await upsertProducts(products);
      scheduleZeptoDone();
    } catch {
      // Not a message from our interceptor — ignore.
    }
  };

  // ── Blinkit handlers ────────────────────────────────────────────────────────

  const scheduleBlinkitDone = (): void => {
    if (blinkitDoneTimerRef.current) clearTimeout(blinkitDoneTimerRef.current);
    blinkitDoneTimerRef.current = setTimeout(() => {
      if (currentTermRef.current !== null) {
        onSearchDone(currentTermRef.current, 'blinkit');
      }
    }, SEARCH_DONE_DELAY_MS);
  };

  const handleBlinkitLoadEnd = (): void => {
    blinkitRef.current?.injectJavaScript(BLINKIT_INTERCEPTOR_JS);

    if (blinkitReadyRef.current) return;
    blinkitReadyRef.current = true;
    dlog('[WarmWebViewManager] Blinkit WebView ready.');

    if (currentTermRef.current) {
      dlog(`[WarmWebViewManager] Blinkit ready — navigating to search "${currentTermRef.current}"…`);
      blinkitRef.current?.injectJavaScript(BLINKIT_SEARCH_JS(currentTermRef.current));
    }
  };

  const handleBlinkitMessage = async (event: WebViewMessageEvent): Promise<void> => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as {
        type: string; url: string; payload?: unknown;
      };

      if (message.type !== 'BLINKIT_API_RESPONSE') return;
      if (!message.url.includes(BLINKIT_SEARCH_ENDPOINT)) return;
      if (
        message.payload === null ||
        typeof message.payload !== 'object' ||
        !('is_success' in (message.payload as object))
      ) return;

      logPayload('Blinkit', message.url, message.payload as BlinkitApiMessage['payload']);
      const products = parseBlinkitSearchPayload(message.payload);
      await upsertProducts(products);
      scheduleBlinkitDone();
    } catch {
      // Not a message from our interceptor — ignore.
    }
  };

  const handleShouldStartLoad = (_request: WebViewNavigation): boolean => true;

  return (
    <>
      {/* Both WebViews are stacked inside the offScreen container — positioned
          2× screen heights above the viewport so the native UI is unobstructed. */}
      <View style={styles.offScreen}>
        {/* Zepto — background, session-warm */}
        <WebView
          ref={zeptoRef}
          source={{ uri: ZEPTO_URL }}
          style={styles.webView}
          injectedJavaScriptBeforeContentLoaded={ZEPTO_INTERCEPTOR_JS}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          geolocationEnabled
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onMessage={handleZeptoMessage}
          onLoadEnd={handleZeptoLoadEnd}
          onError={(e) =>
            dwarn('[WarmWebViewManager] Zepto error:', e.nativeEvent.description)
          }
        />

        {/* Blinkit — background, session-warm */}
        <WebView
          ref={blinkitRef}
          source={{ uri: BLINKIT_URL }}
          style={styles.webView}
          injectedJavaScriptBeforeContentLoaded={BLINKIT_INTERCEPTOR_JS}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          geolocationEnabled
          userAgent="Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36"
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onMessage={handleBlinkitMessage}
          onLoadEnd={handleBlinkitLoadEnd}
          onError={(e) =>
            dwarn('[WarmWebViewManager] Blinkit error:', e.nativeEvent.description)
          }
        />
      </View>

      {/* ── One-time location setup modal ─────────────────────────────────────
          Shown when the user hasn't yet set their delivery address on a platform.
          The visible WebView shares the same app-wide cookie store as the hidden
          WebViews, so address cookies written here are immediately available to
          the background scraper after reload(). ──────────────────────────────── */}
      {activeSetup !== null && (
        <Modal animationType="slide" visible statusBarTranslucent>
          <SafeAreaView style={styles.setupContainer}>

            <View style={styles.setupHeader}>
              <View style={styles.setupTitleBlock}>
                <Text style={styles.setupPlatformBadge}>
                  {activeSetup === 'zepto' ? 'ZEPTO' : 'BLINKIT'}
                </Text>
                <Text style={styles.setupTitle}>Set your delivery location</Text>
                <Text style={styles.setupHint}>
                  Search for your address and select it on the page below.
                  SmartPricer will then fetch prices from your exact local dark store.
                  This is a one-time step per platform.
                </Text>
              </View>

              <View style={styles.setupActions}>
                <TouchableOpacity
                  style={styles.skipButton}
                  onPress={handleLocationSkip}
                  activeOpacity={0.7}
                >
                  <Text style={styles.skipText}>Skip for now</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.confirmButton}
                  onPress={handleLocationConfirm}
                  activeOpacity={0.85}
                >
                  <Text style={styles.confirmText}>Confirm location ✓</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.setupPermHint}>
                Make sure to grant location permissions if prompted.
              </Text>
            </View>

            {/* Visible, interactive WebView — no interceptor injected so normal
                navigation works. Cookies written here flow to the hidden WebViews
                via the shared app-wide cookie store. */}
            <WebView
              source={{ uri: activeSetup === 'zepto' ? ZEPTO_URL : BLINKIT_URL }}
              style={styles.setupWebView}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              geolocationEnabled
              userAgent={
                activeSetup === 'blinkit'
                  ? 'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36'
                  : undefined
              }
            />

          </SafeAreaView>
        </Modal>
      )}
    </>
  );
}

// Both WebViews stacked vertically — container is 2× screen height, positioned
// 2× screen heights above the visible area so neither is ever on-screen.
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const styles = StyleSheet.create({
  // ── Hidden WebView container ────────────────────────────────────────────────
  offScreen: {
    position: 'absolute',
    top: -(SCREEN_H * 2),
    left: 0,
    width: SCREEN_W,
    height: SCREEN_H * 2,
    overflow: 'hidden',
  },
  webView: {
    flex: 1,
  },

  // ── Location setup modal ───────────────────────────────────────────────────
  setupContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  setupHeader: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#fff',
  },
  setupTitleBlock: {
    gap: 3,
  },
  setupPlatformBadge: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: '#6B7280',
    textTransform: 'uppercase',
  },
  setupTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  setupHint: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 19,
    marginTop: 2,
  },
  setupActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
  },
  skipButton: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  skipText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6B7280',
  },
  confirmButton: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#2563EB',
  },
  confirmText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
  setupPermHint: {
    fontSize: 11,
    color: '#9CA3AF',
    fontStyle: 'italic',
    textAlign: 'right',
  },
  setupWebView: {
    flex: 1,
  },
});
