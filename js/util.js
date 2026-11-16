// ===== ยูทิลิตี้ทั่วไป =====
export const TZ = 'Asia/Bangkok';

export function uid(prefix = '') {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export function nowIso() { return new Date().toISOString(); }

const dtf = new Intl.DateTimeFormat('th-TH-u-ca-gregory', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const df = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });

/** แสดงเวลาเป็น Asia/Bangkok: 16/11/2026 14:35 น. */
export function fmtDateTime(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(dtf.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} น.`;
}
export function fmtDate(isoOrYmd) {
  if (!isoOrYmd) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrYmd)) { const [y, m, d] = isoOrYmd.split('-'); return `${d}/${m}/${y}`; }
  const p = Object.fromEntries(df.formatToParts(new Date(isoOrYmd)).map(x => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year}`;
}
export function todayYmd() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// ===== เงิน: เก็บเป็นสตางค์ (จำนวนเต็ม) =====
/** แปลงข้อความเงิน "1,234.50" → 123450 สตางค์; คืน null ถ้าไม่ใช่ตัวเลขชัดเจน */
export function parseBahtToSatang(text) {
  if (text == null) return null;
  let s = String(text).trim().replace(/[๐-๙]/g, d => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)));
  s = s.replace(/[,\s]/g, '').replace(/\.-$/, '').replace(/-$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [i, f = ''] = s.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}
export function fmtSatang(satang) {
  if (satang == null) return '';
  const neg = satang < 0; const a = Math.abs(satang);
  const baht = Math.floor(a / 100).toLocaleString('en-US');
  const st = String(a % 100).padStart(2, '0');
  return (neg ? '-' : '') + baht + (st === '00' ? '' : '.' + st);
}
/** จำนวนเต็มจากข้อความ (รองรับเลขไทย) หรือ null */
export function parseIntStrict(text) {
  if (text == null) return null;
  const s = String(text).trim().replace(/[๐-๙]/g, d => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d))).replace(/,/g, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function sha256Hex(blobOrBuf) {
  const buf = blobOrBuf instanceof Blob ? await blobOrBuf.arrayBuffer() : blobOrBuf;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Text(text) { return sha256Hex(new TextEncoder().encode(text)); }

/** stable JSON (เรียงคีย์) สำหรับทำ hash ของ snapshot */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

let _dl;
/** ดาวน์โหลดไฟล์: ในหน้าที่โฮสต์บน claude.ai ใช้ความสามารถ downloads (ผู้ใช้กดยืนยัน) ไม่งั้นใช้ลิงก์ปกติ */
export async function download(blob, filename) {
  if (window.claude?.use) {
    try { _dl = _dl ?? await Promise.race([window.claude.use('downloads'), new Promise(r => setTimeout(() => r(null), 4000))]); } catch { _dl = null; }
    if (_dl) {
      try { await _dl.save({ filename, data: blob }); return; }
      catch (e) { if (e?.code === 'declined') return; if (!['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e?.code)) throw new Error('ดาวน์โหลดไม่สำเร็จ: ' + (e?.message || e?.code)); }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
