// アプリ内カメラ。ページをめくって手を止めると自動で撮影する（連続撮影）。
// 映像はこの画面の中で使うだけで、どこにも送らない。

const MOTION = 10;     // これ以上の変化で「動いた」とみなす（0〜255の平均差）
const STILL = 3.2;     // これ以下で「止まっている」とみなす
const HOLD_MS = 900;   // 止まってから撮影するまでの時間

import { detectPage } from './scan.js';

export function createCamera({ dialog, video, status, shutter, autoToggle, counter, onCapture, guide, torch, subject = () => 'paper', split = () => false, paused = () => false }) {
  let stream = null, timer = null, prev = null, stillSince = 0, needMotion = false, busy = false, shots = 0;
  const probe = document.createElement('canvas');
  probe.width = 80; probe.height = 60;
  const pctx = probe.getContext('2d', { willReadFrequently: true });

  const say = t => { status.textContent = t; };

  async function open() {
    shots = 0; counter.textContent = '0枚';
    dialog.showModal();
    say('カメラを起動しています…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // できるだけ高い解像度で（4:3の全画角→4K→ブラウザーに任せる、の順に試す）
        video: {
          facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 },
          advanced: [{ width: 4032, height: 3024 }, { width: 4000, height: 3000 }, { width: 3264, height: 2448 }],
        },
      });
    } catch (e) {
      say('カメラを使えませんでした。ブラウザーの設定でカメラを許可してください。');
      return;
    }
    // ピントは合わせ続ける（対応している端末だけ）
    try {
      const track = stream.getVideoTracks()[0], caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch {}
    video.srcObject = stream;
    await video.play().catch(() => {});
    setupTorch();
    prev = null; stillSince = 0; needMotion = false; sharpMax = 0;
    const aim = split() ? '本の綴じ目（のど）を中央の点線に合わせて、' : 'ページを枠に入れて、';
    say(autoToggle.checked ? aim + '手を止めると自動で撮影します' : aim + 'シャッターを押して撮影します');
    timer = setInterval(watch, 180);
    window.addEventListener('devicemotion', onMotion);
  }

  // 撮影したときのスマホの傾き（横持ちかどうか）。向きを決める手がかりにする
  // 横持ちかどうか（見開きの中央線の向きに使う）。向きが変わる境目でちらつかないよう少し幅を持たせる
  let tiltX = null, landscape = false;
  function onMotion(e) {
    const g = e.accelerationIncludingGravity;
    if (!g || typeof g.x !== 'number') return;
    tiltX = g.x;
    const ax = Math.abs(g.x), ay = Math.abs(g.y || 0);
    if (!landscape && ax > ay * 1.3 && ax > 4) landscape = true;
    else if (landscape && ay > ax * 1.3 && ay > 4) landscape = false;
  }

  function close() {
    clearInterval(timer); timer = null;
    window.removeEventListener('devicemotion', onMotion); tiltX = null; landscape = false;
    clearGuide();
    torchOn = false; torch.hidden = true; torch.setAttribute('aria-pressed', 'false');
    stream?.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    if (dialog.open) dialog.close();
  }

  // ---------- ライト（対応している端末だけ） ----------
  let torchOn = false;
  function setupTorch() {
    const track = stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities ? track.getCapabilities() : {};
    torch.hidden = !caps.torch;
  }
  torch.onclick = async () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
    torch.setAttribute('aria-pressed', String(torchOn));
  };

  // ---------- ページの枠をプレビューに重ねて表示 ----------
  const small = document.createElement('canvas');
  let tickCount = 0;
  function clearGuide() { guide.getContext('2d').clearRect(0, 0, guide.width, guide.height); }
  function drawGuide() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const k = 360 / Math.max(vw, vh);
    small.width = Math.round(vw * k); small.height = Math.round(vh * k);
    small.getContext('2d').drawImage(video, 0, 0, small.width, small.height);
    let corners = null;
    try { corners = detectPage(small, subject()); } catch {}
    const r = guide.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (guide.width !== Math.round(r.width * dpr)) { guide.width = Math.round(r.width * dpr); guide.height = Math.round(r.height * dpr); }
    const g = guide.getContext('2d');
    g.clearRect(0, 0, guide.width, guide.height);
    // 映像は object-fit: contain で表示しているので、その位置に合わせる
    const s = Math.min(guide.width / vw, guide.height / vh), ox = (guide.width - vw * s) / 2, oy = (guide.height - vh * s) / 2;
    if (split()) drawCenterLine(g, ox, oy, vw * s, vh * s, dpr);
    if (!corners) return;
    g.beginPath();
    corners.forEach(([x, y], i) => { const px = ox + x * vw * s, py = oy + y * vh * s; i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.closePath();
    g.fillStyle = 'rgba(184,237,113,0.16)'; g.fill();
    g.lineWidth = 3 * dpr; g.strokeStyle = '#b8ed71'; g.stroke();
  }

  // 見開き（2ページ）のとき、左右のページの境目（のど）を合わせる中央線を出す。
  // 横持ちで撮るときは、画面上では横向きの線になる
  function drawCenterLine(g, x, y, w, h, dpr) {
    const horiz = landscape;
    const cx = x + w / 2, cy = y + h / 2, m = (horiz ? w : h) * 0.04;
    const a = horiz ? [x + m, cy] : [cx, y + m], b = horiz ? [x + w - m, cy] : [cx, y + h - m];
    g.save();
    g.lineCap = 'round';
    g.setLineDash([14 * dpr, 10 * dpr]);
    g.lineWidth = 5 * dpr; g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
    g.lineWidth = 2.5 * dpr; g.strokeStyle = '#fff';
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
    // 両端に三角の目印
    g.setLineDash([]);
    g.fillStyle = '#fff';
    const t = 9 * dpr;
    for (const [px, py, dir] of [[...a, 1], [...b, -1]]) {
      g.beginPath();
      if (horiz) { g.moveTo(px - t * dir, py - t); g.lineTo(px - t * dir, py + t); g.lineTo(px + t * 0.6 * dir, py); }
      else { g.moveTo(px - t, py - t * dir); g.lineTo(px + t, py - t * dir); g.lineTo(px, py + t * 0.6 * dir); }
      g.closePath(); g.fill();
    }
    g.restore();
  }

  // 映像の中央部分のくっきり具合（細かい明暗の差の大きさ）。手ぶれ・ピンぼけのフレームでは小さくなる
  const sharpCanvas = document.createElement('canvas');
  sharpCanvas.width = 240; sharpCanvas.height = 180;
  const sctx = sharpCanvas.getContext('2d', { willReadFrequently: true });
  let sharpMax = 0;
  function sharpness() {
    const vw = video.videoWidth, vh = video.videoHeight;
    // 中央の 1/3 ほどを等倍に近い細かさで見る（縮小すると ぼけ が見えなくなるので）
    const cw = Math.min(vw, 720), ch = Math.min(vh, 540);
    sctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, 240, 180);
    const d = sctx.getImageData(0, 0, 240, 180).data;
    let e = 0;
    for (let y = 1; y < 179; y++) for (let x = 1; x < 239; x++) {
      const i = (y * 240 + x) * 4, c = d[i + 1];
      const g = Math.abs(4 * c - d[i - 3] - d[i + 5] - d[i - 959] - d[i + 961]);
      e += g * g;
    }
    return e / (238 * 178);
  }

  // 小さく縮小した映像の前回との差で、動きと静止を判定する
  function watch() {
    if (!video.videoWidth || busy) return;
    // 保存先を選んでいる間は自動撮影しない（選び終えたら、もう一度動きを待つ）
    if (paused()) { prev = null; stillSince = 0; needMotion = shots > 0; return; }
    if (++tickCount % 2 === 0) drawGuide();
    pctx.drawImage(video, 0, 0, 80, 60);
    const d = pctx.getImageData(0, 0, 80, 60).data, cur = new Uint8Array(80 * 60);
    for (let i = 0, p = 0; p < cur.length; i += 4, p++) cur[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    if (!prev) { prev = cur; return; }
    let diff = 0;
    for (let p = 0; p < cur.length; p++) diff += Math.abs(cur[p] - prev[p]);
    diff /= cur.length;
    prev = cur;
    if (!autoToggle.checked) return;
    const now = performance.now();
    if (diff > MOTION) {
      needMotion = false; stillSince = 0; sharpMax = 0;
      say('動きを検出しました。手を止めてください');
    } else if (!needMotion && diff < STILL) {
      // 止まっている間のくっきり具合を見て、ピントが合いぶれていないフレームで撮る
      // （ピント合わせの途中や、わずかに揺れたフレームは、文字がぼやけて仕上がりがかすれるので）
      const sh = sharpness();
      if (!stillSince) { stillSince = now; sharpMax = sh; }
      else {
        sharpMax = Math.max(sharpMax, sh);
        const held = now - stillSince;
        if (held > HOLD_MS && (sh >= sharpMax * 0.9 || held > HOLD_MS * 3)) take();
        else if (held > HOLD_MS) say('ピントを合わせています…');
      }
    } else if (diff >= STILL) {
      stillSince = 0; sharpMax = 0;
    }
  }

  // 映像のいまのフレームをそのまま使う（静止画撮影に切り替えるより速く、シャッターがすぐ切れる）
  async function grab() {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      c.getContext('2d').drawImage(video, 0, 0);
      return await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  }

  async function take() {
    if (busy || !stream || paused()) return;
    busy = true;
    try {
      if (!video.videoWidth) return;
      // 押した瞬間に反応を返してから、画像を保存する
      shots++;
      counter.textContent = `${shots}枚`;
      // 音は鳴らさず、振動で撮影を知らせる（映像のフレームを使うのでシャッター音も出ない）
      navigator.vibrate?.([60, 40, 60]);
      dialog.classList.remove('flash'); void dialog.offsetWidth; dialog.classList.add('flash');
      const blob = await grab();
      if (!blob) { shots--; counter.textContent = `${shots}枚`; return; }
      onCapture(blob, { tilt: tiltX });
      needMotion = true; stillSince = 0;
      say(autoToggle.checked ? '撮影しました。次のページをめくってください' : '撮影しました');
    } finally { busy = false; }
  }

  shutter.onclick = () => take();
  autoToggle.onchange = () => { needMotion = false; stillSince = 0; say(autoToggle.checked ? '手を止めると自動で撮影します' : 'シャッターを押して撮影します'); };
  dialog.addEventListener('close', close);
  return { open, close, redraw: () => { if (stream) drawGuide(); } };
}
