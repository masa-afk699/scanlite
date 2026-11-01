// アプリ内カメラ。ページをめくって手を止めると自動で撮影する（連続撮影）。
// 映像はこの画面の中で使うだけで、どこにも送らない。

const MOTION = 10;     // これ以上の変化で「動いた」とみなす（0〜255の平均差）
const STILL = 3.2;     // これ以下で「止まっている」とみなす
const HOLD_MS = 900;   // 止まってから撮影するまでの時間

import { detectPage } from './scan.js';

export function createCamera({ dialog, video, status, shutter, autoToggle, counter, onCapture, guide, torch, subject = () => 'paper' }) {
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
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
    } catch (e) {
      say('カメラを使えませんでした。ブラウザーの設定でカメラを許可してください。');
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    setupTorch();
    prev = null; stillSince = 0; needMotion = false;
    say(autoToggle.checked ? 'ページを枠に入れて、手を止めると自動で撮影します' : 'シャッターを押して撮影します');
    timer = setInterval(watch, 180);
  }

  function close() {
    clearInterval(timer); timer = null;
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
    if (!corners) return;
    // 映像は object-fit: contain で表示しているので、その位置に合わせる
    const s = Math.min(guide.width / vw, guide.height / vh), ox = (guide.width - vw * s) / 2, oy = (guide.height - vh * s) / 2;
    g.beginPath();
    corners.forEach(([x, y], i) => { const px = ox + x * vw * s, py = oy + y * vh * s; i ? g.lineTo(px, py) : g.moveTo(px, py); });
    g.closePath();
    g.fillStyle = 'rgba(184,237,113,0.16)'; g.fill();
    g.lineWidth = 3 * dpr; g.strokeStyle = '#b8ed71'; g.stroke();
  }

  // 小さく縮小した映像の前回との差で、動きと静止を判定する
  function watch() {
    if (!video.videoWidth || busy) return;
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
      needMotion = false; stillSince = 0;
      say('動きを検出しました。手を止めてください');
    } else if (!needMotion && diff < STILL) {
      if (!stillSince) stillSince = now;
      else if (now - stillSince > HOLD_MS) take();
    } else if (diff >= STILL) {
      stillSince = 0;
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
    if (busy || !stream) return;
    busy = true;
    try {
      if (!video.videoWidth) return;
      // 押した瞬間に反応を返してから、画像を保存する
      shots++;
      counter.textContent = `${shots}枚`;
      navigator.vibrate?.(30);
      dialog.classList.remove('flash'); void dialog.offsetWidth; dialog.classList.add('flash');
      const blob = await grab();
      if (!blob) { shots--; counter.textContent = `${shots}枚`; return; }
      onCapture(blob);
      needMotion = true; stillSince = 0;
      say(autoToggle.checked ? '撮影しました。次のページをめくってください' : '撮影しました');
    } finally { busy = false; }
  }

  shutter.onclick = () => take();
  autoToggle.onchange = () => { needMotion = false; stillSince = 0; say(autoToggle.checked ? '手を止めると自動で撮影します' : 'シャッターを押して撮影します'); };
  dialog.addEventListener('close', close);
  return { open, close };
}
