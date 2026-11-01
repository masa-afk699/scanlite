// オフライン動作用。自サイトのファイルだけをキャッシュし、外部への通信は行わない。
const CACHE = 'scanlite-shell-v12';
// OCRモデルなど大きなファイルは別に保存し、アプリを更新しても消さない（毎回ダウンロードし直さないため）
const MODELS = 'scanlite-models-v1';
const FILES = [
  './', './index.html', './style.css', './app.js', './scan.js', './db.js', './pdf.js', './ocr.js', './ocr-worker.js', './scan-worker.js', './camera.js', './save.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
  './vendor/tesseract/tesseract.esm.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/lang/jpn.traineddata.gz',
  './vendor/paddle/ort.wasm.min.mjs',
  './vendor/paddle/ort-wasm-simd-threaded.mjs',
];
const isModel = url => url.pathname.includes('/vendor/paddle/');

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== MODELS).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

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
  const store = isModel(url) ? MODELS : CACHE;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(store).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())).then(isolate)
  );
});
