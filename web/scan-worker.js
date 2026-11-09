// 画像補正を画面の処理とは別のスレッドで行う（撮影中も画面やシャッターが固まらないように）。
// 画像はこの端末の中でやり取りするだけで、どこにも送らない。
import { processImage, processSpread, finishHalf, limitOriginal, orientCandidates } from './scan.js';

self.onmessage = async ({ data: { id, op, blob, opts, optsB, image, state, pass } }) => {
  try {
    let result;
    if (op === 'limit') result = await limitOriginal(blob);
    else if (op === 'orient') result = await orientCandidates(blob, opts.split);
    else if (op === 'finish') result = await finishHalf(image, opts, state);
    else if (op === 'spread') {
      // 見開きの左右: 共通の処理のあと、2ページ目は（pass のとき）画面側へ渡して別のワーカーで仕上げてもらう
      const onSecond = pass ? half => self.postMessage({ id, second: half }, half ? [half.image] : []) : null;
      result = await processSpread(blob, opts, optsB, onSecond);
    } else result = await processImage(blob, opts);
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
