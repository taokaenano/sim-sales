// ===== ถอด Barcode (zxing-wasm) + อ่านเลขที่พิมพ์กำกับ (tesseract.js) =====
// ผลอ่านทุกค่าต้องให้ผู้ใช้ตรวจและยืนยัน ระบบไม่เดาเลขที่อ่านไม่ได้
import { loadBitmap } from './image.js';
import { ocrLine } from './ocr.js';

let zxReady;
function zx() {
  if (!zxReady) {
    window.ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (p, prefix) => p.endsWith('.wasm') ? new URL('vendor/zxing_reader.wasm', location.href).href : prefix + p },
    });
    zxReady = Promise.resolve(window.ZXingWASM);
  }
  return zxReady;
}

const FORMATS = ['Code128', 'Code39', 'Code93', 'ITF', 'EAN13', 'EAN8', 'UPCA', 'Codabar', 'DataBar'];

function toImageData(src, sx, sy, sw, sh, scale) {
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const c = new OffscreenCanvas(w, h); const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function center(q) { return { x: (q.topLeft.x + q.topRight.x + q.bottomRight.x + q.bottomLeft.x) / 4, y: (q.topLeft.y + q.topRight.y + q.bottomRight.y + q.bottomLeft.y) / 4 }; }

/**
 * ถอดบาร์โค้ดทั้งภาพ: สแกนทั้งภาพ + แบ่งเป็นช่องซ้อนกัน (tile) แล้วขยาย เพื่อเก็บบาร์โค้ดเล็ก ๆ หลายสิบอัน
 * คืน { found:[{text, format, quad}], failed:[{quad}] } พิกัดอยู่ในระบบภาพต้นฉบับ (หลังหมุนตาม EXIF)
 */
export async function decodeImage(blob, onProgress = () => {}) {
  const bmp = await loadBitmap(blob);
  return decodeBitmap(bmp, onProgress);
}

/** สร้างรายการรอบสแกน: ทั้งภาพ + ช่องซ้อนกันหลายขนาด (ยิ่งช่องเล็ก ยิ่งขยายมาก) + วิธีแยกขาวดำ 2 แบบ */
function planPasses(W, H, { quick = false } = {}) {
  const L = Math.max(W, H); const passes = [];
  if (quick) { passes.push({ x: 0, y: 0, w: W, h: H, s: Math.min(1.5, Math.max(1, 2400 / L)), bin: 'LocalAverage' }); return passes; }
  passes.push({ x: 0, y: 0, w: W, h: H, s: Math.min(Math.min(4, Math.max(1, 3200 / L)), 4000 / L), bin: 'LocalAverage' });
  for (const [n, bin] of [[2, 'LocalAverage'], [3, 'LocalAverage'], [4, 'LocalAverage'], [3, 'GlobalHistogram']]) {
    const tw = W / n * 1.35, th = H / n * 1.35;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = Math.max(0, Math.min(W - tw, (W / n) * i - (tw - W / n) / 2));
      const y = Math.max(0, Math.min(H - th, (H / n) * j - (th - H / n) / 2));
      const w = Math.min(tw, W), h = Math.min(th, H);
      passes.push({ x, y, w, h, s: Math.min(4, Math.max(1, 2400 / Math.max(w, h))), bin });
    }
  }
  return passes;
}

/** ถอดบาร์โค้ดจาก ImageBitmap/canvas (ใช้ทั้งภาพนิ่งและเฟรมจากโหมดสแกนสด) */
export async function decodeBitmap(bmp, onProgress = () => {}, { quick = false } = {}) {
  const Z = await zx();
  const W = bmp.width, H = bmp.height;
  const found = new Map(); const failed = [];
  const base = { formats: FORMATS, tryHarder: true, tryRotate: true, tryInvert: false, maxNumberOfSymbols: 255, returnErrors: !quick };
  const passes = planPasses(W, H, { quick });
  let k = 0;
  for (const p of passes) {
    onProgress(++k / passes.length);
    const id = toImageData(bmp, p.x, p.y, p.w, p.h, p.s);
    let res = [];
    try { res = await Z.readBarcodes(id, { ...base, binarizer: p.bin }); } catch (e) { console.warn(e); }
    for (const r of res) {
      const map = pt => ({ x: p.x + pt.x / p.s, y: p.y + pt.y / p.s });
      const quad = { topLeft: map(r.position.topLeft), topRight: map(r.position.topRight), bottomRight: map(r.position.bottomRight), bottomLeft: map(r.position.bottomLeft) };
      if (r.isValid && r.text) {
        if (!found.has(r.text)) found.set(r.text, { text: r.text, format: r.format, quad });
      } else {
        failed.push({ quad, error: r.error || 'ถอดรหัสไม่ได้' });
      }
    }
  }
  // ตัดบริเวณถอดไม่ได้ที่ซ้อนกับบาร์โค้ดที่ถอดได้แล้วออก
  const ok = [...found.values()];
  const near = (a, b) => { const ca = center(a), cb = center(b); const h = Math.hypot(a.topLeft.x - a.bottomLeft.x, a.topLeft.y - a.bottomLeft.y) + 20; return Math.hypot(ca.x - cb.x, ca.y - cb.y) < h * 1.5; };
  const fails = [];
  for (const f of failed) if (!ok.some(o => near(o.quad, f.quad)) && !fails.some(x => near(x.quad, f.quad))) fails.push(f);
  // เรียงตามตำแหน่ง: คอลัมน์ (ซ้าย→ขวา) แล้วแถว (บน→ล่าง)
  ok.sort((a, b) => { const ca = center(a.quad), cb = center(b.quad); const colW = W / 8; const da = Math.floor(ca.x / colW) - Math.floor(cb.x / colW); return da || ca.y - cb.y; });
  return { width: W, height: H, bitmap: bmp, found: ok, failed: fails };
}

/** ครอปบริเวณสัมพันธ์กับบาร์โค้ด (หมุนตามแนวบาร์โค้ด) — dy เป็นสัดส่วนของความสูงแท่ง */
function cropRel(bmp, quad, { dy0, dy1, dx0 = -0.08, dx1 = 0.08, scale = 2.5 }) {
  const ux = quad.topRight.x - quad.topLeft.x, uy = quad.topRight.y - quad.topLeft.y;
  const bw = Math.hypot(ux, uy) || 1; const ex = ux / bw, ey = uy / bw; // แกนตามความยาวบาร์โค้ด
  const vx = -ey, vy = ex; // แกนตั้งฉาก (ลง)
  let bh = Math.hypot(quad.bottomLeft.x - quad.topLeft.x, quad.bottomLeft.y - quad.topLeft.y);
  if (bh < bw * 0.12) bh = bw * 0.25; // zxing บางครั้งคืนกรอบบางเป็นเส้น
  const ox = quad.topLeft.x, oy = quad.topLeft.y;
  const w = bw * (1 + dx1 - dx0), h = bh * (dy1 - dy0);
  const cw = Math.max(8, Math.round(w * scale)), ch = Math.max(8, Math.round(h * scale));
  const c = new OffscreenCanvas(cw, ch); const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
  // แปลงพิกัด: จุด (u,v) ในระบบบาร์โค้ด → พิกเซลภาพ = o + u*e + v*n
  // ต้องการ canvas(i,j) = ((u-u0)*scale, (v-v0)*scale) จึงใช้เมทริกซ์ผกผัน
  const u0 = bw * dx0, v0 = bh * dy0;
  // image→canvas: i = ((x-ox)*ex + (y-oy)*ey - u0)*scale ; j = ((x-ox)*vx + (y-oy)*vy - v0)*scale
  const a = ex * scale, b = vx * scale, cc = ey * scale, d = vy * scale;
  const e = (-ox * ex - oy * ey - u0) * scale, f = (-ox * vx - oy * vy - v0) * scale;
  ctx.setTransform(a, b, cc, d, e, f);
  ctx.drawImage(bmp, 0, 0);
  return c;
}

const onlyDigits = s => (s || '').replace(/[^0-9]/g, '');

/** อ่านเลขที่พิมพ์รอบบาร์โค้ด: เบอร์ (บน) และ S/N + Part no. (ล่าง) */
export async function readPrinted(bmp, quad) {
  const above = cropRel(bmp, quad, { dy0: -1.15, dy1: -0.02 });
  const below = cropRel(bmp, quad, { dy0: 0.98, dy1: 2.0, dx0: -0.15, dx1: 0.1 });
  const [t1, t2] = await Promise.all([
    ocrLine(above, { whitelist: '0123456789', psm: 7 }),
    ocrLine(below, { whitelist: '0123456789SNPRCOartno./: ', psm: 6 }),
  ]);
  const msisdn = (onlyDigits(t1).match(/0\d{9}/) || [null])[0];
  const lines = (t2 || '').split(/\n/);
  const snLine = lines.find(l => /S\s*\/?\s*N/i.test(l)) || lines[0] || '';
  const sn = (onlyDigits(snLine).match(/\d{16,22}/) || [null])[0];
  const pm = (t2 || '').replace(/\s/g, '').match(/PRC[O0o]?[0-9O]{6,8}/i);
  const partNo = pm ? pm[0].toUpperCase().replace(/^PRC/, '').replace(/O/g, '0').replace(/^/, 'PRC') : null;
  return { msisdnRaw: t1.trim(), printedRaw: t2.trim(), msisdn, printedSn: sn, partNo, cropAbove: above, cropBelow: below };
}

/** ผลตรวจ: ค่า Barcode เทียบเลข S/N ที่พิมพ์ใต้แท่ง (ข้อมูลชุดเดียวกัน) */
export function compareBarcodeVsPrinted(barcode, printedSn) {
  if (!barcode) return 'no_barcode';
  if (!printedSn) return 'printed_unreadable';
  return barcode === printedSn ? 'match' : 'mismatch';
}

export const CHECK_TEXT = {
  match: 'ตรงกับเลข S/N ที่พิมพ์',
  mismatch: 'ไม่ตรงกับเลขที่พิมพ์ — ตรวจกับภาพ',
  printed_unreadable: 'อ่านเลขพิมพ์ไม่ได้ — ตรวจกับภาพ',
  no_barcode: 'ไม่มีค่า Barcode (กรอกมือ)',
  manual: 'กรอกด้วยมือ',
};
export const RELATION_TEXT = 'ยังตรวจสอบความสัมพันธ์ไม่ได้';

/** ครอปรอบบาร์โค้ดเพื่อเก็บเป็นภาพอ้างอิง (JPEG blob) */
export async function referenceCrop(bmp, quad) {
  const c = cropRel(bmp, quad, { dy0: -1.3, dy1: 2.2, dx0: -0.12, dx1: 0.12, scale: 1.2 });
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}
