// 写真のぼけ（手ぶれ・ピンぼけ）の目安。文字の輪郭がどれだけ急に濃さが変わるかを見る。
// 輪郭の近く（7×7 の範囲で濃淡の差が大きい所）で「隣との差 ÷ まわりの濃淡の差」を求め、その上位2割の値を返す。
// くっきりした写真は 0.26〜0.36、文字がにじむほどぼけると 0.22 を下回る（長辺1600pxに縮めた写真で測った値）。
// 濃淡の差で割るので、文字の量や紙の明るさにはあまり左右されない。文字がほとんどないページは null（判定しない）。
export const BLURRY_BELOW = 0.22;

export async function sharpness(blob) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * s), H = Math.round(bmp.height * s);
  // 端の影や机を避けて、写真の中央 2/3 だけを見る
  const x0 = Math.round(W / 6), y0 = Math.round(H / 6), w = W - 2 * x0, h = H - 2 * y0;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, x0 / s, y0 / s, w / s, h / s, 0, 0, w, h);
  bmp.close?.();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  // 7×7 の最大・最小（横、縦の順に分けて求める）
  const R = 3;
  const slide = (src, pick) => {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = src[y * w + x];
      for (let k = Math.max(0, x - R), e = Math.min(w - 1, x + R); k <= e; k++) v = pick(v, src[y * w + k]);
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - R), e = Math.min(h - 1, y + R); k <= e; k++) v = pick(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
    return out;
  };
  const hi = slide(g, Math.max), lo = slide(g, Math.min);
  const hist = new Uint32Array(101);
  let n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, r = hi[i] - lo[i];
    if (r <= 50) continue;
    const d = Math.max(Math.abs(g[i + 1] - g[i - 1]), Math.abs(g[i + w] - g[i - w])) / 2;
    hist[Math.min(100, Math.round(d / r * 100))]++;
    n++;
  }
  if (n < 2000) return null;
  let acc = 0;
  for (let b = 0; b <= 100; b++) { acc += hist[b]; if (acc >= n * 0.8) return b / 100; }
  return 1;
}
