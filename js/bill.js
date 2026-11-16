// ===== อ่านบิลลายมือตามเทมเพลตจริง =====
// ขั้นตอน: ผู้ใช้ลากจุด 4 มุมให้ตรงกรอบในบิล → ปรับภาพให้ตรง (perspective) → ตัดช่องตามเทมเพลต
// → อ่านตัวเลขลายมือแบบคร่าว ๆ (digits.js) → ผู้ใช้ตรวจ/แก้/ยืนยันทุกช่อง
import { BILL_TEMPLATE as T } from './bill-template.js';
import { loadBitmap } from './image.js';
import { readDigitsCell, inkMask } from './digits.js';
import { parseIntStrict, parseBahtToSatang } from './util.js';

// ---- homography ----
function solve(A, b) { // Gaussian elimination 8x8
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
/** H ที่แปลงจุด src → dst (4 คู่) */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b); return [...h, 1];
}
const apply = (H, x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };

/** มุมเริ่มต้น (สัดส่วนของภาพ) ตามตำแหน่งในบิลตัวอย่าง */
export function defaultQuad(w, h) {
  return [[0.095 * w, 0.24 * h], [0.95 * w, 0.24 * h], [0.95 * w, 0.94 * h], [0.095 * w, 0.94 * h]];
}

/** ปรับภาพบิลให้ตรงตามเทมเพลต คืน canvas ในระบบ canonical (เลื่อนด้วย view.x0/y0) */
export async function warpBill(blob, quad) {
  const bmp = await loadBitmap(blob);
  const sw = bmp.width, sh = bmp.height;
  const sc = new OffscreenCanvas(sw, sh); const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(bmp, 0, 0); bmp.close?.();
  const src = sctx.getImageData(0, 0, sw, sh).data;
  const canon = [[0, 0], [T.W, 0], [T.W, T.H], [0, T.H]];
  const H = homography(canon, quad); // canonical → image
  const { x0, y0, x1, y1 } = T.view; const OW = x1 - x0, OH = y1 - y0;
  const out = new OffscreenCanvas(OW, OH); const octx = out.getContext('2d', { willReadFrequently: true });
  const od = octx.createImageData(OW, OH); const o = od.data;
  for (let j = 0; j < OH; j++) for (let i = 0; i < OW; i++) {
    const [x, y] = apply(H, i + x0, j + y0); const k = (j * OW + i) * 4;
    if (x < 0 || y < 0 || x >= sw - 1 || y >= sh - 1) { o[k] = o[k + 1] = o[k + 2] = 255; o[k + 3] = 255; continue; }
    const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi; const p = (yi * sw + xi) * 4;
    for (let ch = 0; ch < 3; ch++) {
      const a = src[p + ch], b = src[p + 4 + ch], c = src[p + sw * 4 + ch], d = src[p + sw * 4 + 4 + ch];
      o[k + ch] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    o[k + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  return out;
}

function cellImage(warped, x, y) {
  const { x0, y0 } = T.view;
  const w = Math.round(x[1] - x[0]), h = Math.round(y[1] - y[0]);
  return warped.getContext('2d', { willReadFrequently: true }).getImageData(Math.round(x[0] - x0), Math.round(y[0] - y0), w, h);
}
export async function cellBlob(warped, x, y, pad = 0.25) {
  const { x0, y0 } = T.view; const w = x[1] - x[0], h = y[1] - y[0];
  const px = w * pad * 0.3, py = h * pad;
  const c = new OffscreenCanvas(Math.round(w + 2 * px), Math.round(h + 2 * py));
  c.getContext('2d').drawImage(warped, x[0] - x0 - px, y[0] - y0 - py, c.width, c.height, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

function cellResult(r) {
  return { read: r.state === 'value' ? r.text : (r.state === 'unclear' ? r.text : ''), readState: r.state, note: r.note || '', value: null, state: null, edited: false };
}

/** อ่านทุกช่องของบิล */
export async function readBill(warped, onProgress = () => {}) {
  const rows = {}; let k = 0; const total = T.rows.length * 3 + T.totals.length + 1;
  for (const r of T.rows) {
    const qty = await readDigitsCell(cellImage(warped, T.cols.qty, r.y), { maxDigits: 2 }); onProgress(++k / total);
    const price = r.printedPrice ? { state: 'printed', text: r.printedPrice } : await readDigitsCell(cellImage(warped, T.cols.price, r.y), { maxDigits: 3 }); onProgress(++k / total);
    const amount = await readDigitsCell(cellImage(warped, T.cols.amount, r.y), { maxDigits: 5 }); onProgress(++k / total);
    const itemInk = inkRatioOf(cellImage(warped, [T.cols.item[0] + 90, T.cols.item[1]], r.y));
    rows[r.key] = {
      item: { hasInk: itemInk > 0.006, type: null },
      qty: cellResult(qty),
      price: r.printedPrice ? { read: r.printedPrice, readState: 'printed', note: 'ราคาพิมพ์ในแบบฟอร์ม', value: null, state: null, edited: false } : cellResult(price),
      amount: cellResult(amount),
    };
  }
  const totals = {};
  for (const t of T.totals) { totals[t.key] = cellResult(await readDigitsCell(cellImage(warped, T.totalsValueX, t.y), { maxDigits: 5 })); onProgress(++k / total); }
  const sig = signatureCheck(warped); onProgress(1);
  return { rows, totals, signature: sig };
}

function inkRatioOf(img) {
  const { mask } = inkMask(img); let s = 0; for (const v of mask) s += v; return s / mask.length;
}

/** ตรวจว่ามีรอยหมึกในช่องลายเซ็นผู้รับหรือไม่ (ไม่ใช่การยืนยันตัวตน) */
export function signatureCheck(warped) {
  const z = T.signature.receiver;
  const img = cellImage(warped, z.x, [z.y[0], z.y[1] - (z.y[1] - z.y[0]) * 0.12]);
  const ratio = inkRatioOf(img);
  const system = ratio >= 0.012 ? 'found' : ratio < 0.004 ? 'not_found' : 'unsure';
  return { system, inkRatio: Math.round(ratio * 10000) / 10000 };
}
export const SIG_TEXT = { found: 'พบลักษณะคล้ายลายเซ็น', not_found: 'ไม่พบ', unsure: 'ไม่แน่ใจ' };

// ---- การคำนวณจากค่าที่ผู้ใช้ยืนยัน ----
/** ค่าที่ใช้ได้ของช่อง: ใช้เฉพาะค่าที่ผู้ใช้ยืนยันแล้ว */
export function cellValue(cell, kind) {
  if (!cell || cell.state !== 'value') return null;
  return kind === 'money' ? parseBahtToSatang(cell.value) : parseIntStrict(cell.value);
}

/** สรุปบิลจากค่าที่ยืนยัน + ผลตรวจความสอดคล้อง (ไม่แก้ค่าต้นฉบับ) */
export function billSummary(bill) {
  const out = { byType: {}, simQty: 0, paidQty: 0, freeQty: 0, lineAmount: 0, checks: [], incomplete: false };
  if (!bill || !bill.rows) { out.incomplete = true; return out; }
  for (const r of T.rows) {
    const row = bill.rows[r.key]; if (!row) continue;
    const q = cellValue(row.qty, 'int'), p = cellValue(row.price, 'money'), a = cellValue(row.amount, 'money');
    if (row.qty.state == null || row.amount.state == null || (!r.printedPrice && row.price.state == null)) out.incomplete = true;
    const type = row.item.type;
    if (q != null && q > 0) {
      if (!type) { out.incomplete = true; out.checks.push({ level: 'warn', text: `แถว ${r.label}: มีจำนวน ${q} แต่ยังไม่ระบุประเภทรายการ` }); }
      if (type && type !== 'other') {
        out.simQty += q; out.byType[type] = (out.byType[type] || 0) + q;
        if (type === 'free') out.freeQty += q; else out.paidQty += q;
      }
    }
    if (a != null) out.lineAmount += a;
    if (q != null && p != null && a != null && q * p !== a) out.checks.push({ level: 'warn', text: `แถว ${r.label}: จำนวน×ราคา = ${(q * p / 100).toLocaleString()} แต่ช่องเงินรวมอ่านได้ ${(a / 100).toLocaleString()}` });
  }
  const recv = cellValue(bill.totals.received, 'money'), gross = cellValue(bill.totals.gross, 'money');
  out.received = recv; out.gross = gross;
  for (const t of T.totals) if (bill.totals[t.key]?.state == null) out.incomplete = true;
  if (recv != null && recv !== out.lineAmount && gross == null) out.checks.push({ level: 'warn', text: `ยอดรับเงินทั้งสิ้นตามบิล ${(recv / 100).toLocaleString()} ≠ ผลรวมรายการที่คำนวณได้ ${(out.lineAmount / 100).toLocaleString()}` });
  if (gross != null && gross !== out.lineAmount) out.checks.push({ level: 'warn', text: `จำนวนเงินรวมตามบิล ${(gross / 100).toLocaleString()} ≠ ผลรวมรายการที่คำนวณได้ ${(out.lineAmount / 100).toLocaleString()}` });
  return out;
}

export const ITEM_TYPES = [
  ['dtac', 'ซิม dtac'], ['true', 'ซิม true'], ['free', 'ซิมแถม'], ['other', 'อื่น ๆ (ไม่ใช่ซิม)'],
];
export const STATE_TEXT = { value: 'มีค่า', blank: 'ช่องว่าง', unclear: 'อ่านไม่ชัด', printed: 'พิมพ์ในแบบฟอร์ม' };
export { T as TEMPLATE };
