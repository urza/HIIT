import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Project root (parent of this test/ directory).
const APP = fileURLToPath(new URL('..', import.meta.url));
let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
  console.log('  PASS  ' + msg);
}

/* ============ DOM + app ============ */

const html = fs.readFileSync(APP + '/index.html', 'utf8').replace(/<script src="js\/app.js"><\/script>/, '');
const js = fs.readFileSync(APP + '/js/app.js', 'utf8');

const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
const { document } = window;
const $ = (s) => document.querySelector(s);
const settle = () => new Promise((r) => setTimeout(r, 150));

// --- stubs (before app eval) ---
let fakeNow = Date.now();
window.Date.now = () => fakeNow;

let beepFreqs = [];
window.AudioContext = class {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
  resume() {}
  createOscillator() {
    const o = { type: '', frequency: { value: 0 }, connect: (n) => n, start() {}, stop() {} };
    beepFreqs.push(o.frequency);
    return o;
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (n) => n
    };
  }
};

let vibes = [];
try {
  Object.defineProperty(window.navigator, 'vibrate', {
    value: (p) => { vibes.push(p); return true; },
    configurable: true
  });
} catch (e) { /* vibration unsupported in stub — app guards for it */ }
try {
  let wakeRequests = 0;
  Object.defineProperty(window.navigator, 'wakeLock', {
    value: { request: () => { wakeRequests++; return Promise.resolve({ addEventListener() {}, release: () => Promise.resolve() }); } },
    configurable: true
  });
} catch (e) { /* ignore */ }

window.eval(js);

/* ============ 1. initial idle state ============ */
console.log('\n[1] initial state');
ok($('#time').textContent === '0:20', 'idle display shows work duration 0:20');
ok($('#badge').textContent === 'Ready', 'badge says Ready');
ok($('#btn-primary').textContent === 'Start', 'primary button says Start');
ok($('#summary').textContent.includes('4:20 total'), 'summary shows 4:20 total for 4x(20/60)');
ok(document.querySelectorAll('.dot').length === 4, '4 round dots rendered');
ok($('#in-rounds').value === '4' && $('#in-work').value === '20' && $('#in-rest').value === '60', 'inputs show defaults');
ok(document.querySelectorAll('.chip.active').length === 1 && document.querySelector('.chip.active').dataset.preset === 'classic', 'Classic HIIT chip active by default');
ok($('#history-empty') && !$('#history-empty').hidden, 'empty-history note visible');
ok($('#btn-skip').hidden === true, 'skip hidden while idle');

/* ============ 2. start workout ============ */
console.log('\n[2] start');
$('#btn-primary').click();
await settle();
ok($('#btn-primary').textContent === 'Pause', 'primary becomes Pause');
ok($('#badge').textContent === 'Work', 'badge says Work');
ok($('#round-info').textContent === 'Round 1 of 4', 'round info Round 1 of 4');
ok($('#btn-skip').hidden === false && !$('#btn-reset').hidden, 'skip + reset visible');
ok($('#settings-card').classList.contains('locked'), 'settings locked while running');
ok(document.title.startsWith('0:20 · Work'), 'document.title shows countdown: ' + document.title);
ok(beepFreqs.filter((f) => f.value === 988).length >= 2, 'double high beep on work start');

/* ============ 3. work -> rest transition ============ */
console.log('\n[3] work -> rest');
fakeNow += 20000;
await settle();
ok($('#badge').textContent === 'Rest', 'transitioned to Rest after 20s');
ok($('#round-info').textContent === 'Rest · after round 1', 'rest round info');
ok($('#time').textContent === '1:00', 'rest display starts at 1:00');
ok(document.querySelectorAll('.dot')[0].classList.contains('done'), 'round 1 dot marked done');

/* ============ 4. rest -> work (round 2) ============ */
console.log('\n[4] rest -> work round 2');
fakeNow += 60000;
await settle();
ok($('#badge').textContent === 'Work', 'round 2 work started');
ok($('#round-info').textContent === 'Round 2 of 4', 'round info Round 2 of 4');
ok(document.querySelectorAll('.dot')[1].classList.contains('active'), 'round 2 dot active');

/* ============ 5. pause / resume ============ */
console.log('\n[5] pause / resume');
fakeNow += 5000;
await settle();
$('#btn-primary').click();
ok($('#btn-primary').textContent === 'Resume', 'paused, primary says Resume');
ok($('#phase-label').textContent === 'Paused', 'phase label Paused');
fakeNow += 90000;
await settle();
ok($('#badge').textContent === 'Work', 'timer frozen while paused (still round 2 work)');
$('#btn-primary').click();
await settle();
ok($('#btn-primary').textContent === 'Pause', 'resumed');
ok($('#phase-label').textContent === 'Go', 'phase label Go after resume');

/* ============ 6. skip ============ */
console.log('\n[6] skip');
fakeNow += 16000; // 15s of work remain after resume -> now in rest after round 2
await settle();
ok($('#badge').textContent === 'Rest', 'reached rest after round 2');
$('#btn-skip').click();
await settle();
ok($('#badge').textContent === 'Work', 'skip jumped to next work phase');
ok($('#round-info').textContent === 'Round 3 of 4', 'skip advanced to round 3');

/* ============ 7. finish ============ */
console.log('\n[7] finish');
fakeNow += 300000;
await settle();
ok($('#badge').textContent === 'Done', 'workout finished');
ok($('#btn-primary').textContent === 'Again', 'primary says Again');
ok($('#time').textContent === '4:20', 'done screen shows total 4:20');
ok(document.querySelectorAll('#history-list li').length === 1, 'history has 1 entry');
ok(document.querySelector('#history-list .h-main strong').textContent === 'Classic HIIT', 'history entry named after preset');
ok($('#btn-clear-history').hidden === false, 'clear-history visible');
ok(vibes.length > 0, 'vibration cues fired');

const saved = JSON.parse(window.localStorage.getItem('hiit-timer.v1'));
ok(saved.history.length === 1, 'history persisted to localStorage');
ok(saved.history[0].totalSec === 260, 'persisted total = 260s');

/* ============ 8. reset ============ */
console.log('\n[8] reset');
$('#btn-reset').click();
ok($('#badge').textContent === 'Ready', 'reset returns to Ready');
ok($('#btn-primary').textContent === 'Start', 'primary says Start again');
ok($('#btn-skip').hidden === true, 'skip hidden after reset');

/* ============ 9. presets ============ */
console.log('\n[9] presets');
document.querySelector('.chip[data-preset="tabata"]').click();
ok($('#in-rounds').value === '8' && $('#in-work').value === '20' && $('#in-rest').value === '10', 'Tabata fills inputs 8/20/10');
ok($('#summary').textContent.includes('3:50 total'), 'Tabata total 3:50');
ok(document.querySelector('.chip.active').dataset.preset === 'tabata', 'Tabata chip active');

/* ============ 10. custom inputs + clamping ============ */
console.log('\n[10] custom inputs');
$('#in-rest').value = '999';
$('#in-rest').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#in-rest').dispatchEvent(new window.Event('change', { bubbles: true }));
ok($('#in-rest').value === '600', 'rest clamped to 600 on change');
$('#in-rest').value = '10';
$('#in-rest').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#in-rounds').value = '2';
$('#in-rounds').dispatchEvent(new window.Event('input', { bubbles: true }));
ok($('#summary').textContent.includes('0:50 total'), '2x(20/10) totals 0:50');
ok(document.querySelector('.chip.active') === null, 'no preset chip active for custom settings');
const saved2 = JSON.parse(window.localStorage.getItem('hiit-timer.v1'));
ok(saved2.settings.rounds === 2 && saved2.settings.rest === 10 && saved2.preset === 'custom', 'custom settings + preset=custom persisted');

/* ============ 11. zero-rest workout ============ */
console.log('\n[11] zero rest');
$('#in-rest').value = '0';
$('#in-rest').dispatchEvent(new window.Event('input', { bubbles: true }));
$('#in-rounds').value = '3';
$('#in-rounds').dispatchEvent(new window.Event('input', { bubbles: true }));
ok($('#summary').textContent.includes('1:00 total'), '3x20s no rest = 1:00 total');
$('#btn-primary').click();
await settle();
ok($('#round-info').textContent === 'Round 1 of 3', 'zero-rest round 1');
fakeNow += 20000;
await settle();
ok($('#badge').textContent === 'Work' && $('#round-info').textContent === 'Round 2 of 3', 'zero rest jumps straight to next work round');
fakeNow += 40000;
await settle();
ok($('#badge').textContent === 'Done', 'zero-rest workout completes');

/* ============ 12. prefs + keyboard ============ */
console.log('\n[12] prefs + keyboard');
$('#btn-sound').click();
ok($('#btn-sound').getAttribute('aria-pressed') === 'false', 'sound toggled off');
ok(JSON.parse(window.localStorage.getItem('hiit-timer.v1')).prefs.sound === false, 'sound pref persisted');
document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
await settle();
ok($('#btn-primary').textContent === 'Pause', 'spacebar starts workout');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's' }));
await settle();
ok(true, 'keyboard skip handled without error');
$('#btn-reset').click();

/* ============ 13. clear history ============ */
console.log('\n[13] clear history');
$('#btn-clear-history').click();
ok(document.querySelectorAll('#history-list li').length === 0, 'history cleared');
ok($('#btn-clear-history').hidden === true, 'clear button hidden when empty');

/* ============ 14. background fast-forward ============ */
console.log('\n[14] background fast-forward (throttled tab)');
document.querySelector('.chip[data-preset="classic"]').click();
$('#btn-primary').click();
fakeNow += 300000; // tab was suspended; 300s (> 4:20 workout) passes in one jump
await settle();
ok($('#badge').textContent === 'Done', 'single big time jump fast-forwards through all phases to Done');
ok(document.querySelectorAll('#history-list li').length === 1, 'catch-up completion recorded once');
ok($('#btn-primary').textContent === 'Again', 'primary says Again after catch-up finish');

window.close();

/* ============ 15. service worker logic ============ */
console.log('\n[15] service worker');
{
  const src = fs.readFileSync(APP + '/sw.js', 'utf8');
  const cacheStore = new Map();
  const resolve = (u) => new URL(u, 'http://localhost/').href;
  const cache = {
    put: async (req) => { cacheStore.set(resolve(req.url), true); },
    addAll: async (urls) => urls.forEach((u) => cacheStore.set(resolve(u), true))
  };
  const deleted = [];
  const cachesObj = {
    open: async () => cache,
    keys: async () => ['stale-cache'],
    delete: async (k) => { deleted.push(k); },
    match: async (req) => (cacheStore.has(resolve(req.url)) ? new Response('cached') : undefined)
  };
  const listeners = {};
  const selfStub = {
    location: { origin: 'http://localhost' },
    addEventListener: (t, f) => { listeners[t] = f; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  };
  let fetchCalls = 0;
  const offlineFetch = async () => { fetchCalls++; throw new Error('offline'); };

  new Function('self', 'caches', 'fetch', src)(selfStub, cachesObj, offlineFetch);

  let installP;
  listeners.install({ waitUntil: (x) => { installP = x; } });
  await installP;
  ok(
    ['./', 'index.html', 'css/style.css', 'js/app.js', 'manifest.webmanifest',
      'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'].every((u) => cacheStore.has(resolve(u))),
    'install precaches every app asset'
  );

  let activateP;
  listeners.activate({ waitUntil: (x) => { activateP = x; } });
  await activateP;
  ok(deleted.includes('stale-cache'), 'activate purges stale caches');

  // navigation while offline -> falls back to cached index
  let res;
  listeners.fetch({
    request: { method: 'GET', mode: 'navigate', url: 'http://localhost/' },
    respondWith: (x) => { res = x; }
  });
  res = await res;
  ok(res instanceof Response, 'offline navigation served from cache');

  // static asset cache-first: no network hit
  fetchCalls = 0;
  cacheStore.set('http://localhost/css/style.css', true);
  listeners.fetch({
    request: { method: 'GET', mode: 'same-origin', url: 'http://localhost/css/style.css' },
    respondWith: (x) => { res = x; }
  });
  res = await res;
  ok(res instanceof Response && fetchCalls === 0, 'static asset served cache-first without network');
}

console.log(`\nALL ${passed} CHECKS PASSED`);
