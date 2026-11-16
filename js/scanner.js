// ===== โหมดสแกนสด: เปิดกล้องในแอป อ่าน Barcode ต่อเนื่อง เก็บเฟรมที่เจอรหัสใหม่เป็นภาพหลักฐาน =====
import { decodeBitmap } from './barcode.js';
import { esc } from './util.js';

const MAX_FRAMES = 40;

function beep(ac) {
  try {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 1500; g.gain.value = 0.08; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.07);
  } catch { /* ไม่มีเสียงก็ทำงานต่อได้ */ }
  try { navigator.vibrate?.(40); } catch { /* iPhone ไม่รองรับการสั่น */ }
}

/**
 * เปิดหน้าสแกนสด คืน null ถ้ายกเลิก หรือ { frames:[{blob, bitmap, found:[{text,format,quad}]}] }
 * รหัสแต่ละตัวผูกกับเฟรมแรกที่พบ (เฟรมนั้นถูกเก็บเป็นภาพหลักฐาน)
 */
export async function liveScan({ title = '', knownSerials = new Set(), expected = null } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('เบราว์เซอร์นี้เปิดกล้องในหน้าเว็บไม่ได้ — ใช้ปุ่มถ่ายภาพแทน');
  const ac = (() => { try { return new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } })();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) {
    throw new Error(e?.name === 'NotAllowedError' ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง — เปิดสิทธิ์กล้องให้เว็บนี้ในการตั้งค่าเบราว์เซอร์' : 'เปิดกล้องไม่ได้: ' + (e?.message || e));
  }
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};

  const wrap = document.createElement('div');
  wrap.className = 'scan-wrap';
  wrap.innerHTML = `
    <div class="scan-top"><div class="grow"><div class="scan-title">${esc(title)}</div><div class="scan-count"><b id="sc-n">0</b> รหัส${expected != null ? ` / คาด ${expected}` : ''}</div></div>
      ${caps.torch ? '<button class="btn sm" id="sc-torch">ไฟฉาย</button>' : ''}</div>
    <div class="scan-view"><video id="sc-v" playsinline muted autoplay></video><canvas id="sc-o"></canvas></div>
    <div class="scan-list" id="sc-l"></div>
    <div class="scan-bottom"><button class="btn" id="sc-x">ยกเลิก</button><button class="btn primary" id="sc-ok">เสร็จ</button></div>`;
  document.body.appendChild(wrap);
  const v = wrap.querySelector('#sc-v'), o = wrap.querySelector('#sc-o'), og = o.getContext('2d');
  v.srcObject = stream; try { await v.play(); } catch { /* autoplay บางเครื่องต้องรอ */ }

  const codes = new Map();           // text -> { frameIdx, quad, format, isKnown }
  const frames = [];                  // { blob, bitmap, found: [] }
  let running = true, torch = false, lastBoxes = [], full = false;

  const drawOverlay = () => {
    if (!running) return;
    const r = v.getBoundingClientRect(); o.width = r.width * devicePixelRatio; o.height = r.height * devicePixelRatio;
    og.clearRect(0, 0, o.width, o.height);
    const vw = v.videoWidth, vh = v.videoHeight;
    if (vw && vh) {
      const k = Math.min(o.width / vw, o.height / vh); const dx = (o.width - vw * k) / 2, dy = (o.height - vh * k) / 2; // object-fit: contain
      og.lineWidth = 3 * devicePixelRatio;
      for (const b of lastBoxes) {
        og.strokeStyle = b.isNew ? '#2ecc71' : (b.isKnown ? '#ff9800' : '#ffffff');
        const q = b.quad; og.beginPath();
        [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft].forEach((p, i) => { const x = dx + p.x * k, y = dy + p.y * k; i ? og.lineTo(x, y) : og.moveTo(x, y); });
        og.closePath(); og.stroke();
      }
    }
    requestAnimationFrame(drawOverlay);
  };
  requestAnimationFrame(drawOverlay);

  const listEl = wrap.querySelector('#sc-l'), nEl = wrap.querySelector('#sc-n');
  const renderList = () => {
    nEl.textContent = [...codes.values()].filter(c => !c.isKnown).length;
    const last = [...codes.entries()].slice(-4).reverse();
    listEl.innerHTML = last.map(([t, c]) => `<div class="mono small">${c.isKnown ? '⚠ มีอยู่แล้ว · ' : '✓ '}${esc(t)}</div>`).join('');
  };

  const loop = async () => {
    while (running) {
      if (v.readyState >= 2 && v.videoWidth) {
        const W = v.videoWidth, H = v.videoHeight;
        const c = new OffscreenCanvas(W, H); c.getContext('2d').drawImage(v, 0, 0, W, H);
        let res;
        try { res = await decodeBitmap(c, () => {}, { quick: true }); } catch { res = { found: [] }; }
        const fresh = res.found.filter(f => !codes.has(f.text));
        lastBoxes = res.found.map(f => ({ quad: f.quad, isNew: fresh.includes(f), isKnown: knownSerials.has(f.text) }));
        if (fresh.length && frames.length < MAX_FRAMES) {
          const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
          const bitmap = await createImageBitmap(c);
          const fi = frames.push({ blob, bitmap, found: [] }) - 1;
          for (const f of fresh) { codes.set(f.text, { frameIdx: fi, quad: f.quad, format: f.format, isKnown: knownSerials.has(f.text) }); frames[fi].found.push(f); }
          if (ac) beep(ac); renderList();
        } else if (fresh.length && !full) {
          full = true;
          wrap.querySelector('.scan-count').insertAdjacentHTML('beforeend', '<span class="small"> · ครบ 40 ภาพแล้ว กด "เสร็จ" แล้วสแกนรอบใหม่</span>');
        }
      }
      await new Promise(r => setTimeout(r, 120));
    }
  };

  return new Promise(resolve => {
    const close = result => {
      running = false; stream.getTracks().forEach(t => t.stop()); wrap.remove(); try { ac?.close(); } catch { /* */ }
      if (!result) frames.forEach(f => f.bitmap.close?.());
      resolve(result);
    };
    wrap.querySelector('#sc-x').onclick = () => close(null);
    wrap.querySelector('#sc-ok').onclick = () => close({ frames: frames.filter(f => f.found.length) });
    const tb = wrap.querySelector('#sc-torch');
    if (tb) tb.onclick = async () => { torch = !torch; try { await track.applyConstraints({ advanced: [{ torch }] }); tb.classList.toggle('primary', torch); } catch { /* */ } };
    loop();
  });
}
