// オフライン動作用。自サイトのファイルだけをキャッシュし、外部への通信は行わない。
const VERSION = 'v35';
const CACHE = 'scanlite-shell-' + VERSION;
// OCRの部品やモデルなど大きなファイルは別に保存し、アプリを更新しても消さない。
// （更新のたびに十数MBを取り直すと、スマホでは途中で止まって新しい版に切り替わらないことがあった）
const MODELS = 'scanlite-models-v1';
const SHELL = [
  './', './index.html', './style.css', './app.js', './scan.js', './page.js', './db.js', './pdf.js', './ocr.js', './ocr-worker.js', './scan-worker.js', './camera.js', './save.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
];
const VENDOR = [
  './vendor/tesseract/tesseract.esm.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/lang/jpn.traineddata.gz',
  './vendor/paddle/ort.wasm.min.mjs',
  './vendor/paddle/ort-wasm-simd-threaded.mjs',
];
const isVendor = url => url.pathname.includes('/vendor/');

// 新しい版の小さなファイルだけを、ブラウザの一時保存を通さずサーバーから取り直す
self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())
));

// 大きなファイルは別のキャッシュに置く。前の版のキャッシュにあるものはそのまま移し、
// 持っていないものは切り替えの後に裏で取る（取れなくても更新は止めない）。
async function moveVendor(fetchMissing) {
  const models = await caches.open(MODELS);
  for (const u of VENDOR) {
    const req = new Request(new URL(u, self.registration.scope).href);
    if (await models.match(req)) continue;
    try {
      const r = (await caches.match(req)) || (fetchMissing ? await fetch(req) : null);
      if (r && r.ok) await models.put(req, r);
    } catch (_) {}
  }
}

self.addEventListener('activate', e => e.waitUntil(
  moveVendor(false).catch(() => {})
    .then(() => caches.keys())
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== MODELS).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(() => { moveVendor(true).catch(() => {}); })
));

// 画面から「今の版」を尋ねられたら答える
self.addEventListener('message', e => {
  if (e.data === 'version' && e.ports[0]) e.ports[0].postMessage(VERSION);
});

// 同じサイトのファイルだけで動くので、ページを「クロスオリジン分離」にする。
// これでOCRが端末の複数のCPUコアを使えるようになり、速く終わる。
function isolate(r) {
  if (!r || r.status !== 200 || r.type === 'opaque') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const store = isVendor(url) ? MODELS : CACHE;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(store).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())).then(isolate)
  );
});
