// 画像補正を画面の処理とは別のスレッドで行う（撮影中も画面やシャッターが固まらないように）。
// 画像はこの端末の中でやり取りするだけで、どこにも送らない。
import { processImage, limitOriginal } from './scan.js';

self.onmessage = async ({ data: { id, op, blob, opts } }) => {
  try {
    const result = op === 'limit' ? await limitOriginal(blob) : await processImage(blob, opts);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
