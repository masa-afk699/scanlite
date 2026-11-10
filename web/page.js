// ページの範囲（四隅）を求める。すべて端末内で計算する。
//
// 考え方: 文字の行（OCRの行検出）で「どのページを切り出すか」と「ページの向き」を決め、
// 四辺それぞれを、本文の外側にある直線（紙の端・のど）から選ぶ。
//  1. 行を横方向に投影し、大きなすき間（のど）でページごとのかたまりに分ける。
//     1ページの撮影では写真の中央に近い、いちばん文字の多いかたまり、見開きでは隣り合う2つを対象にする。
//  2. 写真の明暗・色の境目から、行の向きにそった直線（上下の辺）と、それに直交する直線（左右の辺）の候補を
//     ハフ変換で集める（傾きの範囲を行の向きで絞るので、速く、誤りにくい）。
//  3. 辺ごとに、本文の外側にあり文字を横切らない候補のうち、内側が紙で、内と外で明るさか色がはっきり
//     変わる（紙の端）ものを、本文に近い順に採る。隣のページとの境（のど）は、両ページの本文のすき間の
//     中で、のどの影の線を採る。見つからない辺は、本文の行頭・行末・最初と最後の行から余白を足した線にする。
//  4. 選んだ辺は、境目の位置を細かく測り直して直線を当てはめ、四隅を求める。

function makeCanvas(w, h) {
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const RAD = Math.PI / 180;

// 縮小した明るさ Y と黄色っぽさ C（R-B）。少しぼかしておく
function prepare(canvas, longSide) {
  const k = Math.min(1, longSide / Math.max(canvas.width, canvas.height));
  const w = Math.max(16, Math.round(canvas.width * k)), h = Math.max(16, Math.round(canvas.height * k));
  const c = makeCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  let Y = new Float32Array(w * h), C = new Float32Array(w * h);
  for (let p = 0, i = 0; p < Y.length; p++, i += 4) {
    Y[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    C[p] = d[i] - d[i + 2];
  }
  Y = blur(blur(Y, w, h), w, h); C = blur(blur(C, w, h), w, h);
  return { w, h, Y, C };
}

function blur(a, w, h) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    t[r] = (a[r] * 2 + a[r + 1]) / 3; t[r + w - 1] = (a[r + w - 1] * 2 + a[r + w - 2]) / 3;
    for (let x = 1; x < w - 1; x++) t[r + x] = (a[r + x - 1] + a[r + x] + a[r + x + 1]) / 3;
  }
  for (let x = 0; x < w; x++) { o[x] = (t[x] * 2 + t[x + w]) / 3; o[(h - 1) * w + x] = (t[(h - 1) * w + x] * 2 + t[(h - 2) * w + x]) / 3; }
  for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) { const p = y * w + x; o[p] = (t[p - w] + t[p] + t[p + w]) / 3; }
  return o;
}

// 双一次補間で値を読む（写真の外は NaN）
function sample(a, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
  const x0 = Math.min(w - 2, x | 0), y0 = Math.min(h - 2, y | 0), fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + w] * (1 - fx) + a[i + w + 1] * fx) * fy;
}

// 内（紙）から外への段差: 外が暗くなる分と、色みの違い
const stepOf = (yi, yo, ci, co) => Math.max(0, yi - yo) + 1.5 * Math.abs(ci - co);
const wrap180 = a => { a = ((a + 90) % 180 + 180) % 180 - 90; return a; };

// 直線: 法線 (nx, ny) と ρ（n・p = ρ）
const lineFrom = (phi, rho) => ({ nx: Math.cos(phi * RAD), ny: Math.sin(phi * RAD), rho });
function meetLines(a, b) {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [(a.rho * b.ny - a.ny * b.rho) / det, (a.nx * b.rho - a.rho * b.nx) / det];
}
// 点の並びに直線を当てはめる（外れた点を除きながら）
function fit(pts, tol) {
  let sel = pts, line = null;
  for (let it = 0; it < 5 && sel.length >= 3; it++) {
    let mx = 0, my = 0, sw = 0;
    for (const p of sel) { const wt = p[2] ?? 1; mx += p[0] * wt; my += p[1] * wt; sw += wt; }
    mx /= sw; my /= sw;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of sel) { const wt = p[2] ?? 1, dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx * wt; sxy += dx * dy * wt; syy += dy * dy * wt; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), nx = -Math.sin(th), ny = Math.cos(th);
    line = { nx, ny, rho: nx * mx + ny * my };
    const keep = sel.filter(p => Math.abs(p[0] * nx + p[1] * ny - line.rho) < tol);
    if (keep.length === sel.length || keep.length < Math.max(3, sel.length * 0.5)) break;
    sel = keep;
  }
  return line;
}

// ---------- 文字の行 ----------
// 行の向き（ページの傾き）。横書きでも縦書きでも、ページの横方向の傾き α（度、-45〜45）を返す
function tiltOf(L) {
  let sx = 0, sy = 0;
  for (const l of L) { const th = Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]); sx += l.len * Math.cos(4 * th); sy += l.len * Math.sin(4 * th); }
  return Math.atan2(sy, sx) / 4 / RAD;
}

// 行を横方向に投影し、すき間でページごとのかたまりに分ける
function pageGroups(L, e1, gap) {
  const items = L.map(l => {
    const ua = l.a[0] * e1[0] + l.a[1] * e1[1], ub = l.b[0] * e1[0] + l.b[1] * e1[1];
    return { l, u0: Math.min(ua, ub) - l.th / 2, u1: Math.max(ua, ub) + l.th / 2 };
  }).sort((p, q) => p.u0 - q.u0);
  const groups = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    if (g && it.u0 <= g.u1 + gap) { g.lines.push(it.l); g.u1 = Math.max(g.u1, it.u1); g.weight += it.l.len; }
    else groups.push({ lines: [it.l], u0: it.u0, u1: it.u1, weight: it.l.len });
  }
  return groups;
}

// ---------- 直線の候補（ハフ変換） ----------
// fam: 法線の向きの中心（度）。±span 度の範囲で、勾配の向きが法線に近い画素だけが投票する
function houghLines(G, GA, w, h, center, span, max) {
  const step = 0.5, nPhi = Math.round(2 * span / step) + 1, D = Math.ceil(Math.hypot(w, h)), nRho = 2 * D + 1;
  const acc = new Float32Array(nPhi * nRho);
  const cos = new Float32Array(nPhi), sin = new Float32Array(nPhi);
  for (let i = 0; i < nPhi; i++) { const a = (center - span + i * step) * RAD; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  const win = Math.round(3 / step);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, g = G[p];
    if (g === 0) continue;
    const d = wrap180(GA[p] - center);
    if (Math.abs(d) > span + 3) continue;
    const ic = Math.round((d + span) / step);
    for (let i = Math.max(0, ic - win); i <= Math.min(nPhi - 1, ic + win); i++) {
      const r = Math.round(x * cos[i] + y * sin[i]) + D;
      acc[i * nRho + r] += g;
    }
  }
  // 極大を拾う
  const peaks = [];
  const thr = Math.min(w, h) * 0.08 * 6;
  for (let i = 0; i < nPhi; i++) for (let r = 1; r < nRho - 1; r++) {
    const v = acc[i * nRho + r];
    if (v < thr) continue;
    let isMax = true;
    for (let di = -4; di <= 4 && isMax; di++) {
      const ii = i + di; if (ii < 0 || ii >= nPhi) continue;
      for (let dr = -5; dr <= 5; dr++) {
        const rr = r + dr; if (rr < 0 || rr >= nRho || (di === 0 && dr === 0)) continue;
        const u = acc[ii * nRho + rr];
        if (u > v || (u === v && (di < 0 || (di === 0 && dr < 0)))) { isMax = false; break; }
      }
    }
    if (isMax) peaks.push({ phi: center - span + i * step, rho: r - D, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  return peaks.slice(0, max).map(p => ({ ...lineFrom(p.phi, p.rho), votes: p.v }));
}

// ---------- 本体 ----------
// canvas: 向きを直した写真。lines: OCRの行（割合の座標）。
// side: null（1ページ。見開きを1枚として撮ったときは見開き全体）/ 'left' / 'right'（見開きの左右のページ）。
// 返り値: { corners: 割合の四隅（左上から時計回り）, kinds: 辺ごとの決め方 [上,右,下,左]（'edge' 紙の端 / 'gutter' のど /
//          'border' 写真の端 / 'text' 本文からの推定）, outline: 紙の端の辺の、実際の境目の点の並び（割合。曲がった端の外を消すため）,
//          text: 本文の範囲（割合の四隅）, alpha: 傾き（度） } または null
export function findPage(canvas, lines, { side: half = null, debug = null } = {}) {
  if (!lines || lines.length < 4) return null;
  const { w, h, Y, C } = prepare(canvas, 800);
  const S = Math.max(w, h);
  // 行を縮小画像の画素に
  const L = lines.map(l => {
    const a = [l.a[0] * w, l.a[1] * h], b = [l.b[0] * w, l.b[1] * h];
    const pts = (l.pts || []).map(([x, y]) => [x * w, y * h]);
    return { a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]), th: Math.max(1, l.t * S), pts, all: [a, b, ...pts] };
  }).filter(l => l.len > 2);
  if (L.length < 4) return null;
  const alpha = tiltOf(L);
  const e1 = [Math.cos(alpha * RAD), Math.sin(alpha * RAD)], e2 = [-e1[1], e1[0]];
  const U = p => p[0] * e1[0] + p[1] * e1[1], V = p => p[0] * e2[0] + p[1] * e2[1];
  const at = (u, v) => [u * e1[0] + v * e2[0], u * e1[1] + v * e2[1]];
  const ths = L.map(l => l.th).sort((a, b) => a - b), em = ths[ths.length >> 1];
  const boxOf = ls => {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const l of ls) for (const p of l.all) {
      const u = U(p), v = V(p);
      u0 = Math.min(u0, u - l.th / 2); u1 = Math.max(u1, u + l.th / 2); v0 = Math.min(v0, v - l.th / 2); v1 = Math.max(v1, v + l.th / 2);
    }
    return { u0, u1, v0, v1 };
  };

  // 紙の明るさと色（文字のある範囲の明るい方）
  const all = boxOf(L), vals = [];
  for (let v = all.v0; v <= all.v1; v += 4) for (let u = all.u0; u <= all.u1; u += 4) { const [x, y] = at(u, v), s = sample(Y, w, h, x, y); if (s === s) vals.push(s); }
  vals.sort((a, b) => a - b);
  const P = vals[Math.floor(vals.length * 0.85)] || 200;
  let cs = 0, cn = 0;
  for (let v = all.v0; v <= all.v1; v += 6) for (let u = all.u0; u <= all.u1; u += 6) { const [x, y] = at(u, v), s = sample(Y, w, h, x, y); if (s > P * 0.9) { cs += sample(C, w, h, x, y); cn++; } }
  const Pc = cn ? cs / cn : 0;

  // 勾配（明るさと色の境目）。向きは法線の向き（度）
  const G = new Float32Array(w * h), GA = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    const gx = (Y[p - w + 1] + 2 * Y[p + 1] + Y[p + w + 1] - Y[p - w - 1] - 2 * Y[p - 1] - Y[p + w - 1]) / 8;
    const gy = (Y[p + w - 1] + 2 * Y[p + w] + Y[p + w + 1] - Y[p - w - 1] - 2 * Y[p - w] - Y[p - w + 1]) / 8;
    const cx = (C[p - w + 1] + 2 * C[p + 1] + C[p + w + 1] - C[p - w - 1] - 2 * C[p - 1] - C[p + w - 1]) / 8 * 2;
    const cy = (C[p + w - 1] + 2 * C[p + w] + C[p + w + 1] - C[p - w - 1] - 2 * C[p - w] - C[p - w + 1]) / 8 * 2;
    const my = gx * gx + gy * gy, mc = cx * cx + cy * cy, m2 = my >= mc ? my : mc;
    if (m2 < 4) continue;
    G[p] = Math.min(Math.sqrt(m2), 30); GA[p] = (my >= mc ? Math.atan2(gy, gx) : Math.atan2(cy, cx)) / RAD;
  }
  // 文字の行の中の勾配は除く（行の数だけ強い横線ができ、紙の端の候補が埋もれるので）
  for (const l of L) {
    const dx = (l.b[0] - l.a[0]) / l.len, dy = (l.b[1] - l.a[1]) / l.len, r = l.th * 0.9 + 1;
    for (let t = -r; t <= l.len + r; t += 0.7) for (let q = -r; q <= r; q += 0.7) {
      const x = Math.round(l.a[0] + dx * t - dy * q), y = Math.round(l.a[1] + dy * t + dx * q);
      if (x >= 0 && y >= 0 && x < w && y < h) G[y * w + x] = 0;
    }
  }
  const hCands = houghLines(G, GA, w, h, alpha + 90, 22, 60);
  const vCands = houghLines(G, GA, w, h, alpha, 25, 60);

  // 線分と直線が交わるか
  const crosses = (ln, l) => { const sa = ln.nx * l.a[0] + ln.ny * l.a[1] - ln.rho, sb = ln.nx * l.b[0] + ln.ny * l.b[1] - ln.rho; return sa * sb < 0 || Math.abs(sa) < l.th * 0.5 || Math.abs(sb) < l.th * 0.5; };
  const pointAtU = (ln, u) => { const n1 = ln.nx * e1[0] + ln.ny * e1[1], n2 = ln.nx * e2[0] + ln.ny * e2[1]; return Math.abs(n2) < 1e-6 ? null : at(u, (ln.rho - u * n1) / n2); };
  const pointAtV = (ln, v) => { const n1 = ln.nx * e1[0] + ln.ny * e1[1], n2 = ln.nx * e2[0] + ln.ny * e2[1]; return Math.abs(n1) < 1e-6 ? null : at((ln.rho - v * n2) / n1, v); };

  // 辺の証拠: 区間 [a0, a1]（横の辺は u、縦の辺は v）にわたって、内側（inPt の側）が紙で、
  // 内と外で明るさか色がはっきり変わる所の割合（support）と、線の上の明るさ（明るい方から2割）
  function evidence(ln, horizontal, a0, a1, inPt) {
    const nIn = Math.sign(ln.nx * inPt[0] + ln.ny * inPt[1] - ln.rho) || 1;
    const ix = ln.nx * nIn, iy = ln.ny * nIn;
    let ok = 0, n = 0, both = 0;
    const dark = [], darkW = [], st = Math.max(2, (a1 - a0) / 80);
    for (let t = a0; t <= a1; t += st) {
      const p = horizontal ? pointAtU(ln, t) : pointAtV(ln, t);
      if (!p) continue;
      n++;
      let yi = 0, yo = 0, ci = 0, co = 0;
      for (let s = 2; s <= 5; s++) {
        yi += sample(Y, w, h, p[0] + ix * s, p[1] + iy * s); yo += sample(Y, w, h, p[0] - ix * s, p[1] - iy * s);
        ci += sample(C, w, h, p[0] + ix * s, p[1] + iy * s); co += sample(C, w, h, p[0] - ix * s, p[1] - iy * s);
      }
      yi /= 4; yo /= 4; ci /= 4; co /= 4;
      // 線の上と、少し離れた所（のどの影は幅があり、印刷の細い線にはない）
      const yl = sample(Y, w, h, p[0], p[1]), yw = (sample(Y, w, h, p[0] + ix * 3, p[1] + iy * 3) + sample(Y, w, h, p[0] - ix * 3, p[1] - iy * 3)) / 2;
      if (yl === yl && yw === yw) { dark.push(yl); darkW.push(yw); }
      if (!(yi === yi) || !(yo === yo)) continue;
      const paperIn = yi > P * 0.6 && Math.abs(ci - Pc) < 25;
      if (paperIn && yo > P * 0.6 && Math.abs(co - Pc) < 25) both++;
      // 紙の端: 内側（紙）より外が暗いか、色が違う（内側が暗い所は印刷の線のすぐ外側）
      if (paperIn && yi > P * 0.75 && stepOf(yi, yo, ci, co) > 12) {
        // 外が少し先でまた紙に戻るなら、紙の上に印刷された帯や図（紙の端ではない）
        // （すぐ外側だけが暗く、その先が内側と同じ明るさ・色みに戻る）
        let back = 0, yoMin = Infinity;
        for (let s = 1; s <= 6; s++) { const v = sample(Y, w, h, p[0] - ix * s, p[1] - iy * s); if (v < yoMin) yoMin = v; }
        for (let s = 8; s <= 30; s += 3) {
          const y2 = sample(Y, w, h, p[0] - ix * s, p[1] - iy * s), c2 = sample(C, w, h, p[0] - ix * s, p[1] - iy * s);
          if (Math.abs(y2 - yi) < P * 0.06 && Math.abs(c2 - ci) < 5 && y2 - yoMin > 12) back++;
        }
        if (back < 3) ok++;
      }
    }
    dark.sort((a, b) => a - b); darkW.sort((a, b) => a - b);
    // shade: 線の上が紙より暗い度合い（のどの影）。両側が紙のときだけ数える（図の黒い部分を除く）
    const pct = a => P - a[Math.floor(a.length * 0.8)];
    const shade = dark.length && n && both / n > 0.7 ? Math.min(pct(dark), 2 * pct(darkW)) : 0;
    return { support: n ? ok / n : 0, shade: Math.min(shade, P * 0.4) };
  }
  // 直線がかたまりの文字をどちら側に置くか（内側=正）。いちばん近い点までの距離
  const sideDist = (ln, ls, inPt) => {
    const sg = Math.sign(ln.nx * inPt[0] + ln.ny * inPt[1] - ln.rho) || 1;
    let mn = Infinity;
    for (const l of ls) for (const p of l.all) mn = Math.min(mn, (ln.nx * p[0] + ln.ny * p[1] - ln.rho) * sg - l.th / 2);
    return mn;
  };
  const outsideShare = (ln, ls, inPt) => {
    const sg = Math.sign(ln.nx * inPt[0] + ln.ny * inPt[1] - ln.rho) || 1;
    let o = 0, t = 0;
    for (const l of ls) { const m = [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2]; t += l.len; if ((ln.nx * m[0] + ln.ny * m[1] - ln.rho) * sg < 0) o += l.len; }
    return t ? o / t : 1;
  };

  // ページのかたまり: 行を横方向に投影して、すき間で分ける。すき間に のど（上から下まで続く境目・影の線）が
  // あれば別のページ、なければ同じページの段組や図のまわりの文字とみなしてまとめる
  const groups = pageGroups(L, e1, Math.max(3 * em, w * 0.015));
  const pages = [{ lines: groups[0].lines.slice(), u0: groups[0].u0, u1: groups[0].u1, weight: groups[0].weight }];
  for (let i = 1; i < groups.length; i++) {
    const a = pages[pages.length - 1], b = groups[i];
    const ba = boxOf(a.lines), bb = boxOf(b.lines);
    const va = Math.min(ba.v0, bb.v0), vb = Math.max(ba.v1, bb.v1);
    const inPt = at(ba.u0, (ba.v0 + ba.v1) / 2);
    let sep = false;
    for (const ln of vCands) {
      const p = pointAtV(ln, (va + vb) / 2);
      if (!p || U(p) < a.u1 - em || U(p) > b.u0 + em) continue;
      if (L.some(l => crosses(ln, l))) continue;
      if (sideDist(ln, a.lines, inPt) < 0 || outsideShare(ln, b.lines, inPt) < 0.8) continue;
      const ev = evidence(ln, false, va, vb, inPt);
      // 影だけで分けるのは、すき間が広いとき（2ページ分の余白）。図の中の線と取り違えないように
      if (ev.support > 0.45 || (ev.shade > 10 && b.u0 - a.u1 > Math.max(4.5 * em, w * 0.035))) { sep = true; if (debug) (debug.seps = debug.seps || []).push({ i, ln, ...ev, u: U(p) }); break; }
    }
    // 写真の端にかかる小さなかたまりは、隣のページの切れ端
    if (!sep && b.weight < a.weight * 0.25 && bb.u1 > U([w, h / 2]) - w * 0.03 && Math.abs(e1[0]) > 0.7) sep = true;
    if (!sep && a.weight < b.weight * 0.25 && pages.length === 1 && ba.u0 < U([0, h / 2]) + w * 0.03) sep = true;
    if (sep) pages.push({ lines: b.lines.slice(), u0: b.u0, u1: b.u1, weight: b.weight });
    else { a.lines.push(...b.lines); a.u1 = Math.max(a.u1, b.u1); a.weight += b.weight; }
  }
  const cu = U([w / 2, h / 2]);
  const pScore = g => g.weight * Math.max(0.1, 1 - 0.9 * Math.abs((g.u0 + g.u1) / 2 - cu) / (w / 2));
  let target, leftN = null, rightN = null;
  if (half) {
    let li, ri;
    if (pages.length >= 2) {
      let best = -1;
      for (let i = 0; i + 1 < pages.length; i++) { const s = pScore(pages[i]) + pScore(pages[i + 1]); if (s > best) { best = s; li = i; } }
      ri = li + 1;
      const tp = pages[half === 'left' ? li : ri];
      target = tp.lines;
      leftN = half === 'left' ? pages[li - 1] : pages[li];
      rightN = half === 'left' ? pages[ri] : pages[ri + 1];
    } else {
      // のどが見つからないときは、いちばん広いすき間で左右に分ける
      if (groups.length < 2) return null;
      let cut = 1, best = -1;
      for (let i = 1; i < groups.length; i++) { const g = groups[i].u0 - groups[i - 1].u1; if (g > best) { best = g; cut = i; } }
      const lg = groups.slice(0, cut).flatMap(g => g.lines), rg = groups.slice(cut).flatMap(g => g.lines);
      target = half === 'left' ? lg : rg;
      if (half === 'left') rightN = { lines: rg }; else leftN = { lines: lg };
    }
  } else {
    let bi = 0;
    pages.forEach((g, i) => { if (pScore(g) > pScore(pages[bi])) bi = i; });
    let pick = [bi];
    // 1ページとして撮った見開き: 写真の中央をはさんで同じくらいの大きさのページがあれば両方
    for (const i2 of [bi + 1, bi - 1]) {
      const o = pages[i2], g = pages[bi];
      if (!o || pick.length > 1) continue;
      const lo = Math.min(g.u1, o.u1), hi = Math.max(g.u0, o.u0);
      if (o.weight > g.weight * 0.45 && cu > Math.min(lo, hi) - w * 0.08 && cu < Math.max(lo, hi) + w * 0.08) pick = [Math.min(bi, i2), Math.max(bi, i2)];
    }
    target = pick.flatMap(i => pages[i].lines);
    leftN = pages[pick[0] - 1] || null; rightN = pages[pick[pick.length - 1] + 1] || null;
  }
  const others = L.filter(l => !target.includes(l));
  const { u0, u1, v0, v1 } = boxOf(target);
  const tw = u1 - u0, tht = v1 - v0;
  if (tw < w * 0.08 || tht < h * 0.05) return null;
  const tc = at((u0 + u1) / 2, (v0 + v1) / 2);

  // 本文から余白を足した線（見つからない辺の代わり）
  const maxLen = Math.max(...target.map(q => q.len));
  const longs = target.filter(l => l.len > maxLen * 0.5);
  const near = (ln, ref) => ln && Math.abs(ln.nx * ref[0] + ln.ny * ref[1]) > Math.cos(10 * RAD);
  const outDir = side => { const o = [[0, -1], [1, 0], [0, 1], [-1, 0]][side]; return [o[0] * e1[0] + o[1] * e2[0], o[0] * e1[1] + o[1] * e2[1]]; };
  const fallback = side => {
    const m = side === 0 || side === 2 ? Math.max(2.5 * em, tht * 0.04) : Math.max(1.8 * em, tw * 0.03);
    let ln = null;
    if (side === 0 || side === 2) {
      const mv = l => V([(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2]);
      const byV = longs.slice().sort((p, q) => mv(p) - mv(q));
      const r = side === 0 ? byV[0] : byV[byV.length - 1];
      ln = r ? fit(r.all, 1e9) : null;
      if (!near(ln, e2)) ln = null;
    } else {
      // 行頭（左）の線の向き。行頭は字下げ以外そろっているので、右の辺にも同じ向きを使う
      const ends = target.filter(l => l.len > tw * 0.25).map(l => (U(l.a) < U(l.b) ? l.a : l.b));
      ln = ends.length >= 4 ? fit(ends, em * 0.8) : null;
      if (ln) { const vs = ends.map(V); if (Math.max(...vs) - Math.min(...vs) < tht * 0.4) ln = null; }
      if (!near(ln, e1)) ln = null;
    }
    if (!ln) ln = side === 0 || side === 2 ? { nx: e2[0], ny: e2[1], rho: 0 } : { nx: e1[0], ny: e1[1], rho: 0 };
    const od = outDir(side);
    if (ln.nx * od[0] + ln.ny * od[1] < 0) ln = { nx: -ln.nx, ny: -ln.ny, rho: -ln.rho };
    let far = -Infinity;
    for (const l of target) for (const p of l.all) far = Math.max(far, ln.nx * p[0] + ln.ny * p[1] + l.th / 2);
    return { ...ln, rho: far + m };
  };

  // 本文の外へ、紙の上の印刷（図・ページ番号）が続くかぎり線を外へずらす。f は余白を足した線（外向きの法線）。
  // 机など紙でない所に出たら、その手前で止める。印刷のない所が文字の高さの8倍以上続いたら打ち切る
  function extendInk(f, horizontal, a0, a1) {
    const m0 = f.rho, base = { ...f };
    // 余白を足す前の位置（本文の外端）
    let far = -Infinity;
    for (const l of target) for (const p of l.all) far = Math.max(far, f.nx * p[0] + f.ny * p[1] + l.th / 2);
    const margin = m0 - far, gapMax = Math.max(10 * em, (horizontal ? tht : tw) * 0.12), st = Math.max(2, (a1 - a0) / 100);
    let lastInk = 0, hitBorder = false, heavy = 0;
    for (let s = 1; s < S; s++) {
      const ln = { ...base, rho: far + s };
      let ink = 0, bad = 0, n = 0, out = 0;
      for (let t = a0; t <= a1; t += st) {
        const p = horizontal ? pointAtU(ln, t) : pointAtV(ln, t);
        if (!p) continue;
        n++;
        const y = sample(Y, w, h, p[0], p[1]);
        if (!(y === y)) { out++; continue; }
        const c = sample(C, w, h, p[0], p[1]);
        // 印刷: 暗い所、または紙と同じ色みの灰色（薄い罫線・図）。紙でない所: 紙と色みが違う（机など）
        if (y < P * 0.6 || (y < P * 0.85 && Math.abs(c - Pc) <= 18)) ink++;
        else if (Math.abs(c - Pc) > 18) bad++;
      }
      if (!n || out > n * 0.3) { hitBorder = lastInk > 0 && s - lastInk < margin * 1.5; break; }
      // 紙でない（机・影）所が多い、または暗い所ばかりが続く（背景の物。表の罫線や帯は数画素で終わる）
      if (debug && debug.ink) debug.ink.push([s, n, ink, bad, out]);
      if (bad > n * 0.35) break;
      heavy = ink > n * 0.6 ? heavy + 1 : 0;
      if (heavy > 3 * em) break;
      if (ink >= Math.max(1, n * 0.01)) lastInk = s;
      if (s - lastInk > gapMax) break;
    }
    if (!lastInk) return null;
    return { ln: { ...base, rho: Math.max(m0, far + lastInk + margin * 0.8) }, hitBorder };
  }

  // 本文の向きから決めた線を、少しずつ回しながら外へずらして、紙の端らしい所（内側が紙で、内外の段差が
  // 続く所）を探す。弱い境目（白い紙とクリーム色の机）や、強い直線のそばの境目はハフ変換で拾いにくいので
  function sweep(side, horizontal, a0, a1) {
    const f = fallback(side), found = [];
    let far = -Infinity;
    for (const l of target) for (const p of l.all) far = Math.max(far, f.nx * p[0] + f.ny * p[1] + l.th / 2);
    const base = Math.atan2(f.ny, f.nx), pivot = horizontal ? pointAtU({ ...f, rho: far }, (a0 + a1) / 2) : pointAtV({ ...f, rho: far }, (a0 + a1) / 2);
    if (!pivot) return found;
    const K = 30, st = (a1 - a0) / K;
    for (let da = -6; da <= 6; da += 1.5) {
      const th = base + da * RAD, nx = Math.cos(th), ny = Math.sin(th), r0 = nx * pivot[0] + ny * pivot[1];
      const prof = [];
      for (let off = Math.max(1, em * 0.3); off < S; off += 1.5) {
        const ln = { nx, ny, rho: r0 + off };
        let ok = 0, n = 0, out = 0;
        for (let k = 0; k <= K; k++) {
          const p = horizontal ? pointAtU(ln, a0 + k * st) : pointAtV(ln, a0 + k * st);
          if (!p) continue;
          n++;
          const yi = sample(Y, w, h, p[0] - nx * 3, p[1] - ny * 3), yo = sample(Y, w, h, p[0] + nx * 3, p[1] + ny * 3);
          if (!(yi === yi) || !(yo === yo)) { out++; continue; }
          const ci = sample(C, w, h, p[0] - nx * 3, p[1] - ny * 3), co = sample(C, w, h, p[0] + nx * 3, p[1] + ny * 3);
          if (yi > P * 0.75 && Math.abs(ci - Pc) < 25 && stepOf(yi, yo, ci, co) > 12) ok++;
        }
        if (!n || out > n * 0.5) break;
        prof.push([ok / n, ln]);
      }
      for (let i = 1; i < prof.length - 1; i++) {
        const v = prof[i][0];
        if (v >= 0.3 && v >= prof[i - 1][0] && v > prof[i + 1][0]) found.push({ ...prof[i][1], score: v });
      }
    }
    found.sort((a, b) => b.score - a.score);
    return found.slice(0, 12);
  }

  // 辺の候補が横切ってはいけない、ほかの文字（このページの幅・高さの範囲にあるもの）
  const midOf = l => [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2];
  const nearOthers = [0, 1, 2, 3].map(side => others.filter(l => {
    const m = midOf(l);
    return side === 0 || side === 2 ? U(m) > u0 - tw * 0.05 && U(m) < u1 + tw * 0.05 : V(m) > v0 - tht * 0.05 && V(m) < v1 + tht * 0.05;
  }));
  // 辺ごとに選ぶ（0:上 1:右 2:下 3:左）
  const sides = [], kinds = [], dbg = [];
  const borderLine = side => [{ nx: 0, ny: 1, rho: 0 }, { nx: 1, ny: 0, rho: w - 1 }, { nx: 0, ny: 1, rho: h - 1 }, { nx: 1, ny: 0, rho: 0 }][side];
  for (let side = 0; side < 4; side++) {
    const horizontal = side === 0 || side === 2;
    const nb = side === 1 ? rightN : side === 3 ? leftN : null;
    const [a0, a1] = horizontal ? [u0, u1] : [v0, v1];
    const list = [];
    for (const ln of [...(horizontal ? hCands : vCands), ...sweep(side, horizontal, a0, a1)]) {
      // 本文の外側で、どの文字も横切らないこと。隣のページとの境なら、隣の文字は外側
      const p = horizontal ? pointAtU(ln, (u0 + u1) / 2) : pointAtV(ln, (v0 + v1) / 2);
      if (!p) continue;
      const od = outDir(side);
      if ((p[0] - tc[0]) * od[0] + (p[1] - tc[1]) * od[1] <= 0) continue;
      const dist = sideDist(ln, target, tc);
      if (dist < em * 0.3) continue;
      if (nearOthers[side].some(l => crosses(ln, l))) continue;
      if (nb && outsideShare(ln, nb.lines, tc) < 0.8) continue;
      list.push({ ln, dist, pos: horizontal ? V(p) : U(p), ...evidence(ln, horizontal, a0, a1, tc) });
    }
    let chosen = null, kind = 'text';
    if (nb) {
      // のど: 両ページの文字のすき間で、境目か影の線がはっきりしたもの（すき間の中央に近いほどよい）
      const inner = side === 1 ? u1 : u0, nbBox = boxOf(nb.lines), lim = side === 1 ? nbBox.u0 : nbBox.u1;
      const mid = (inner + lim) / 2, half2 = Math.max(em, Math.abs(lim - inner) / 2);
      let best = null, bs = -Infinity;
      for (const c of list) {
        const s = Math.max(c.support * 2, c.shade / 10);
        if (s < 0.8) continue;
        const sc = s - Math.abs(c.pos - mid) / half2;
        if (sc > bs) { bs = sc; best = c; }
      }
      if (best) chosen = best.ln;
      else {
        // 影が見えなければ、すき間の中央を通り、行頭の線と同じ向きの線
        const f = fallback(side), pm = at(mid, (v0 + v1) / 2);
        chosen = { nx: f.nx, ny: f.ny, rho: f.nx * pm[0] + f.ny * pm[1] };
      }
      kind = 'gutter';
    } else {
      const good = list.filter(c => c.support >= 0.35).sort((a, b) => a.dist - b.dist);
      if (good.length) { chosen = good[0].ln; kind = 'edge'; }
    }
    if (!chosen) {
      const f = fallback(side), b = borderLine(side);
      // 余白を足した線が写真からはみ出すなら写真の端
      const pa = horizontal ? pointAtU(f, (u0 + u1) / 2) : pointAtV(f, (v0 + v1) / 2);
      const outside = !pa || pa[0] < 0 || pa[1] < 0 || pa[0] > w - 1 || pa[1] > h - 1;
      chosen = outside ? b : f; kind = outside ? 'border' : 'text';
      if (!outside) {
        // 本文の外に図・表・ページ番号など印刷が続くなら、そこまで広げる
        const x = extendInk(f, horizontal, a0, a1);
        if (x) { chosen = x.ln; if (x.hitBorder) kind = 'border'; }
      }
    }
    sides.push(chosen); kinds.push(kind);
    dbg.push(list);
  }
  const quad = () => [meetLines(sides[3], sides[0]), meetLines(sides[0], sides[1]), meetLines(sides[1], sides[2]), meetLines(sides[2], sides[3])];
  // 選んだ紙の端は、境目の位置を細かく測り直す
  const outline = [null, null, null, null];
  let corners = quad();
  if (corners.some(c => !c)) return null;
  for (let side = 0; side < 4; side++) {
    if (kinds[side] !== 'edge') continue;
    const r = refine(Y, C, w, h, corners[side], corners[(side + 1) % 4], tc, P, Pc);
    if (r && Math.abs(r.nx * sides[side].nx + r.ny * sides[side].ny) > Math.cos(3 * RAD)) {
      // 曲がった紙の端が切れないよう、外へはみ出した分だけ広げる（広げた所に残る机は、仕上げの端の掃除で消す）
      const sg = Math.sign(r.nx * tc[0] + r.ny * tc[1] - r.rho) || 1;
      sides[side] = { nx: r.nx, ny: r.ny, rho: r.rho - sg * Math.min(r.outer, S * 0.03) };
      if (r.edge.length > 8) outline[side] = r.edge.map(([x, y]) => [x / w, y / h]);
    }
  }
  corners = quad();
  if (corners.some(c => !c)) return null;
  const out = corners.map(([x, y]) => [Math.min(1.02, Math.max(-0.02, x / w)), Math.min(1.02, Math.max(-0.02, y / h))]);
  const text = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  if (debug) Object.assign(debug, { w, h, alpha, groups, pages, hCands, vCands, sides, kinds, cands: dbg, text, P });
  return { corners: out, kinds, outline, text: text.map(([x, y]) => [x / w, y / h]), alpha };
}

// 辺 a→b にそって、境目（内外の明るさ・色の段差がいちばん大きい所）を探し、直線を当てはめ直す。
// 本の紙の端は少し曲がっているので、直線より外へはみ出した境目の分（outer）も返す（紙が切れないように広げるため）
function refine(Y, C, w, h, a, b, inside, P, Pc) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 10) return null;
  const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len;
  let nx = -ty, ny = tx;
  if ((inside[0] - a[0]) * nx + (inside[1] - a[1]) * ny < 0) { nx = -nx; ny = -ny; }
  // 位置 (px,py) から法線方向に s（内向きが正）ずらした所の段差。内側が紙でなければ 0
  const stepAt = (px, py, s) => {
    const xi = px + nx * (s + 2), yi2 = py + ny * (s + 2), xo = px + nx * (s - 2), yo2 = py + ny * (s - 2);
    const yi = sample(Y, w, h, xi, yi2), ci = sample(C, w, h, xi, yi2);
    if (!(yi > P * 0.75) || Math.abs(ci - Pc) > 25) return 0;
    const g = stepOf(yi, sample(Y, w, h, xo, yo2), ci, sample(C, w, h, xo, yo2));
    return g === g ? g : 0;
  };
  const pts = [];
  for (let t = len * 0.04; t <= len * 0.96; t += 2) {
    const px = a[0] + tx * t, py = a[1] + ty * t;
    let best = 0, bs = 0;
    for (let s = -6; s <= 6; s += 0.5) { const g = stepAt(px, py, s); if (g > best) { best = g; bs = s; } }
    if (best > 10) pts.push([px + nx * bs, py + ny * bs, best]);
  }
  if (pts.length < len / 2 / 4) return null;
  const ln = fit(pts, 1.5);
  if (!ln) return null;
  // 当てはめた直線から外へ、紙の境目がどこまで出ているか（曲がった端）。edge: 境目の点の並び
  const sg = Math.sign(ln.nx * inside[0] + ln.ny * inside[1] - ln.rho) || 1;
  const outs = [], edge = [];
  for (let t = len * 0.04; t <= len * 0.96; t += 3) {
    const px0 = a[0] + tx * t, py0 = a[1] + ty * t;
    const d0 = (ln.nx * px0 + ln.ny * py0 - ln.rho) * sg; // 直線までの距離（内向き正）
    const px = px0 - ln.nx * sg * d0, py = py0 - ln.ny * sg * d0; // 直線上の点
    let best = 0, bs = 0;
    for (let s = 3; s >= -24; s -= 1) { const g = stepAt(px, py, s); if (g > best * 1.15 && g > 12) { best = g; bs = s; } }
    outs.push(Math.max(0, -bs));
    if (best > 12) edge.push([px + nx * bs, py + ny * bs]);
  }
  outs.sort((p, q) => p - q);
  return { ...ln, outer: outs.length ? outs[Math.floor(outs.length * 0.9)] : 0, edge };
}
