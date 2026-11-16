// ===== อ่านตัวเลขลายมือแบบคร่าว ๆ =====
// โมเดล MLP เล็ก (784-192-10) เทรนจากชุดข้อมูล MNIST + เลข 1 แบบมีหัวตามลายมือไทย (tools/train.py)
// ทำงานในเครื่อง ไม่ต้องใช้เน็ตหรือ API key — ผลอ่านเป็นเพียง "ค่าที่ระบบอ่านได้" ต้องให้ผู้ใช้ยืนยันทุกช่อง
let model;
async function load() {
  if (model) return model;
  const m = await (await fetch(new URL('models/digit-mlp.json', location.href))).json();
  const dec = o => { const b = atob(o.b64); const a = new Float32Array(b.length); for (let i = 0; i < b.length; i++) { const v = b.charCodeAt(i); a[i] = (v > 127 ? v - 256 : v) * o.s; } return a; };
  model = { W1: dec(m.W1), b1: Float32Array.from(m.b1), W2: dec(m.W2), b2: Float32Array.from(m.b2), hid: m.hid };
  return model;
}

function predict(m, x) {
  const H = m.hid, h = new Float32Array(H);
  for (let j = 0; j < H; j++) h[j] = m.b1[j];
  for (let i = 0; i < 784; i++) { const v = x[i]; if (!v) continue; const row = i * H; for (let j = 0; j < H; j++) h[j] += v * m.W1[row + j]; }
  for (let j = 0; j < H; j++) if (h[j] < 0) h[j] = 0;
  let best = -1, bi = 0;
  for (let k = 0; k < 10; k++) { let s = m.b2[k]; for (let j = 0; j < H; j++) s += h[j] * m.W2[j * 10 + k]; if (s > best || k === 0) { best = s; bi = k; } }
  return bi;
}

function countHoles(x) {
  const bin = new Uint8Array(784); for (let i = 0; i < 784; i++) bin[i] = x[i] > 0.35 ? 1 : 0;
  const seen = new Uint8Array(784); let holes = 0;
  const flood = (s0) => { const st = [s0]; seen[s0] = 1; let border = false, n = 0; while (st.length) { const p = st.pop(); n++; const px = p % 28, py = (p / 28) | 0; if (px === 0 || py === 0 || px === 27 || py === 27) border = true; for (const q of [p - 1, p + 1, p - 28, p + 28]) { if (q < 0 || q >= 784) continue; if ((q % 28 === 0 && p % 28 === 27) || (q % 28 === 27 && p % 28 === 0)) continue; if (!bin[q] && !seen[q]) { seen[q] = 1; st.push(q); } } } return { border, n }; };
  for (let i = 0; i < 784; i++) if (!bin[i] && !seen[i]) { const r = flood(i); if (!r.border && r.n >= 4) holes++; }
  return holes;
}

/** สร้าง mask หมึกจาก ImageData: เข้มกว่าพื้นหลัง หรือเป็นหมึกสีน้ำเงิน */
export function inkMask(img, { darkTh = 45, blueTh = 40 } = {}) {
  const { data, width: w, height: h } = img;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
  const sorted = Float32Array.from(g).sort(); const bg = sorted[Math.floor(sorted.length / 2)];
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = bg - g[i]; const blue = data[i * 4 + 2] - data[i * 4];
    m[i] = (d > darkTh || (blue > blueTh && d > 15)) ? 1 : 0;
  }
  // opening 2x2 แบบง่าย: ตัดจุดเดี่ยว
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x; if (m[i] && m[i + 1] && m[i + w] && m[i + w + 1]) { o[i] = o[i + 1] = o[i + w] = o[i + w + 1] = 1; }
  }
  return { mask: o, w, h };
}

function components(mask, w, h) {
  const lab = new Int32Array(w * h); let n = 0; const comps = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s]) continue;
    n++; let x0 = w, x1 = 0, y0 = h, y1 = 0, area = 0; stack.push(s); lab[s] = n;
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p / w) | 0; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx; if (mask[q] && !lab[q]) { lab[q] = n; stack.push(q); }
      }
    }
    comps.push({ id: n, x0, x1: x1 + 1, y0, y1: y1 + 1, area });
  }
  return { lab, comps };
}

/**
 * อ่านช่องตัวเลขลายมือ 1 ช่อง (ImageData ของช่อง รวมเส้นขอบ)
 * คืน { state: 'blank'|'value'|'unclear', text, inkRatio, note }
 *  - blank   = ไม่มีหมึก (ห้ามแปลงเป็น 0)
 *  - unclear = มีหมึกแต่แยกตัวเลขไม่ได้ / มีเส้นขีดผ่านทั้งช่อง / จำนวนหลักเกินที่คาด
 */
export async function readDigitsCell(img, { maxDigits = 2 } = {}) {
  const m = await load();
  // ตัดขอบช่องออก (เส้นตาราง)
  const W = img.width, H = img.height; const mx = Math.round(W * 0.06), my = Math.round(H * 0.12);
  const cw = W - 2 * mx, ch = H - 2 * my;
  const c = new OffscreenCanvas(cw, ch); c.getContext('2d').putImageData(img, -mx, -my);
  const inner = c.getContext('2d').getImageData(0, 0, cw, ch);
  const { mask, w, h } = inkMask(inner);
  let ink = 0; for (let i = 0; i < mask.length; i++) ink += mask[i];
  const inkRatio = ink / mask.length;
  const { lab, comps } = components(mask, w, h);
  let strike = false, edge = false;
  let boxes = comps.filter(cp => {
    const hh = cp.y1 - cp.y0, ww = cp.x1 - cp.x0;
    if (cp.area < 20 || hh < h * 0.3) return false;
    const touchT = cp.y0 <= 1, touchB = cp.y1 >= h - 1;
    if (touchT && touchB) { strike = true; return false; } // เส้นลากผ่านทั้งช่อง (เช่น วงเล็บ/ขีดฆ่า)
    if ((touchT || touchB) && ww / hh > 1) return false; // เศษเส้นขอบ
    if (touchT || touchB) edge = true; // เส้นลากเข้า/ออกขอบช่อง → ไม่แน่ใจ
    return true;
  }).map(cp => ({ ...cp, ids: [cp.id] })).sort((a, b) => a.x0 - b.x0);
  // รวมชิ้นส่วนที่ซ้อนกันแนวนอน (ตัวเลขขาดเป็นสองชิ้น)
  const merged = [];
  for (const b of boxes) {
    const last = merged[merged.length - 1];
    if (last && b.x0 < last.x1 - 2) { last.x1 = Math.max(last.x1, b.x1); last.y0 = Math.min(last.y0, b.y0); last.y1 = Math.max(last.y1, b.y1); last.ids.push(b.id); }
    else merged.push({ ...b });
  }
  if (!merged.length) {
    if (inkRatio < 0.004 && !strike) return { state: 'blank', text: '', inkRatio };
    return { state: 'unclear', text: '', inkRatio, note: strike ? 'มีเส้นลากผ่านช่อง' : 'มีรอยหมึกแต่แยกตัวเลขไม่ได้' };
  }
  let text = '';
  for (const b of merged) {
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0; const sc = 20 / Math.max(bw, bh);
    const nw = Math.max(1, Math.round(bw * sc)), nh = Math.max(1, Math.round(bh * sc));
    // วาด mask ของตัวเลขลง canvas เล็ก
    const src = new OffscreenCanvas(bw, bh); const sctx = src.getContext('2d'); const sd = sctx.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const l = lab[(b.y0 + y) * w + b.x0 + x]; if (b.ids.includes(l)) { const k = (y * bw + x) * 4; sd.data[k] = sd.data[k + 1] = sd.data[k + 2] = 255; sd.data[k + 3] = 255; } }
    sctx.putImageData(sd, 0, 0);
    const dst = new OffscreenCanvas(nw, nh); const dctx = dst.getContext('2d'); dctx.imageSmoothingQuality = 'high'; dctx.drawImage(src, 0, 0, nw, nh);
    const dd = dctx.getImageData(0, 0, nw, nh).data;
    const small = new Float32Array(nw * nh); let sx = 0, sy = 0, st = 0;
    for (let i = 0; i < nw * nh; i++) { const v = dd[i * 4] / 255; small[i] = v; sx += (i % nw) * v; sy += ((i / nw) | 0) * v; st += v; }
    const cx = st ? sx / st : nw / 2, cy = st ? sy / st : nh / 2;
    let ox = Math.round(14 - cx), oy = Math.round(14 - cy); ox = Math.min(Math.max(ox, 0), 28 - nw); oy = Math.min(Math.max(oy, 0), 28 - nh);
    let x28 = new Float32Array(784);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) x28[(oy + y) * 28 + ox + x] = small[y * nw + x];
    // เส้นบาง → หนาขึ้นเล็กน้อยให้คล้าย MNIST
    if (st / (nw * nh) < 0.25) { const t = new Float32Array(784); for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) { let v = 0; for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) { const yy = y - dy, xx = x - dx; if (yy >= 0 && xx >= 0) v = Math.max(v, x28[yy * 28 + xx]); } t[y * 28 + x] = v; } x28 = t; }
    let d = predict(m, x28);
    const holes = countHoles(x28);
    // ตรวจรูปทรงอย่างง่าย: 8 มี 2 รู, 0/6/9 มี 1 รู — แก้ผลที่ขัดกับจำนวนรูชัดเจน
    if (d === 8 && holes === 1) d = 0;
    else if (d === 0 && holes === 2) d = 8;
    text += String(d);
  }
  if (strike) return { state: 'unclear', text, inkRatio, note: 'มีเส้นลากผ่านช่อง — อาจขีดฆ่า' };
  if (edge) return { state: 'unclear', text, inkRatio, note: 'มีเส้นลากเลยขอบช่อง' };
  if (text.length > maxDigits) return { state: 'unclear', text, inkRatio, note: `อ่านได้ ${text.length} หลัก มากกว่าที่คาด` };
  return { state: 'value', text, inkRatio };
}
