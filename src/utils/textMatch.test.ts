// Dependency-free fixtures for the cross-platform matcher (P10-05).
//
// No jest in this project, so this file is a self-contained runner:
//   npx tsx src/utils/textMatch.test.ts
// It exits non-zero on the first failed assertion. Each fixture encodes one of
// the three failure modes from the P10-04 blueprint against the exact Nissin
// Masala titles observed in on-device testing.

import {
  normalizeTitle,
  jaroWinkler,
  tokensMatch,
  classifyMatch,
  selectSeeds,
  pickBestMatch,
} from './textMatch';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// Real catalog rows (name + price) as scraped on each platform.
const ZEPTO_CUP = { id: 'z-cup', name: 'Nissin Cup Mazedaar Masala', price: 53 };
const BLINKIT_CUP = { id: 'b-cup', name: 'Nissin Mazedar Masala Cup Noodles', price: 60 };
const BLINKIT_GEKI = { id: 'b-geki', name: 'Nissin Geki Spicy Maxx Korean Ramen Noodles', price: 58 };
const MAGGI_MASALA = { id: 'm-mas', name: 'Maggi Masala Noodles', price: 14 };
const MAGGI_ATTA = { id: 'm-atta', name: 'Maggi Atta Noodles', price: 16 };

console.log('\n── Primitives ──');
{
  // Jaro-Winkler on the spelling-drift pair should be very high.
  const jw = jaroWinkler('mazedaar', 'mazedar');
  check('JW(mazedaar, mazedar) ≥ 0.95', jw >= 0.95, `jw=${jw.toFixed(3)}`);

  // Length gate: the spelling variant matches…
  eq('tokensMatch(mazedaar, mazedar)', tokensMatch('mazedaar', 'mazedar'), true);
  // …but a 2-char token must be exact — never fuzzing into a longer word.
  eq('tokensMatch(ma, maxx)', tokensMatch('ma', 'maxx'), false);
  eq('tokensMatch(ma, masala)', tokensMatch('ma', 'masala'), false);
  eq('tokensMatch(ma, ma)', tokensMatch('ma', 'ma'), true);
}

console.log('\n── Normalization ──');
{
  const n = normalizeTitle('Nissin Mazedar Masala Cup Noodles 70g');
  eq('strips size token 70g', n.all.includes('70g'), false);
  eq('cup is soft', n.soft.includes('cup'), true);
  eq('noodles is soft', n.soft.includes('noodles'), true);
  eq('mazedar is strong', n.strong.includes('mazedar'), true);
  eq('masala is strong', n.strong.includes('masala'), true);
}

console.log('\n── Case 1 & 2: permutation + spelling drift (should MATCH exact) ──');
{
  // Anchor = Blinkit pinned title; candidate = Zepto title. Words are scrambled
  // (Cup/Noodles moved) AND spelled differently (mazedar vs mazedaar).
  const score = classifyMatch(BLINKIT_CUP.name, ZEPTO_CUP.name);
  check('Blinkit↔Zepto cup noodles resolve', score !== null, 'got null');
  eq('…as EXACT', score?.tier, 'exact');

  // Reverse direction is symmetric enough to also match.
  const rev = classifyMatch(ZEPTO_CUP.name, BLINKIT_CUP.name);
  eq('reverse direction EXACT', rev?.tier, 'exact');

  // Rerank: anchored on the Zepto cup, Blinkit candidates should pick the real
  // cup noodles (₹60) — NOT the cheaper Geki false positive (₹58).
  const best = pickBestMatch(ZEPTO_CUP.name, [BLINKIT_GEKI, BLINKIT_CUP]);
  eq('rerank picks the true cup noodles', best?.product.id, 'b-cup');
  eq('rerank quality exact', best?.quality, 'exact');
}

console.log('\n── Case 3: short-token false positive (should NOT match Geki) ──');
{
  // The old engine matched "Nissin Ma" → "…Maxx…" via infix. It must not now.
  const geki = classifyMatch('Nissin Ma', BLINKIT_GEKI.name);
  eq('“Nissin Ma” does NOT match Geki Maxx', geki, null);

  // With only [nissin, ma], nothing on Blinkit should be accepted — fail closed
  // rather than poison the basket with a wrong ₹58 comparison.
  const best = pickBestMatch('Nissin Ma', [BLINKIT_GEKI, BLINKIT_CUP]);
  eq('“Nissin Ma” yields no confident match', best, null);

  // Seeds for the SQL prefilter drop the 2-char "ma"; brand "nissin" remains.
  const seeds = selectSeeds('Nissin Ma');
  eq('seeds = [nissin]', JSON.stringify(seeds), JSON.stringify(['nissin']));
}

console.log('\n── Guard: same brand, different variant (should NOT be exact) ──');
{
  // Maggi Masala vs Maggi Atta share only the brand — must not collapse into one.
  const score = classifyMatch(MAGGI_MASALA.name, MAGGI_ATTA.name);
  check('Maggi Masala ≠ Maggi Atta (not exact)', score?.tier !== 'exact', `got ${score?.tier}`);
}

console.log('\n── Seeds include brand + longest strong token ──');
{
  const seeds = selectSeeds('Nissin Mazedar Masala Cup Noodles');
  check('seeds include nissin', seeds.includes('nissin'), JSON.stringify(seeds));
  check('seeds include a long descriptor', seeds.some(s => s.length >= 6), JSON.stringify(seeds));
}

console.log(`\n${failed === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
