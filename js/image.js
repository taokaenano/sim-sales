// ===== ภาพ: ตรวจไฟล์, EXIF, ลายน้ำ =====
import { fmtDateTime, sha256Hex, uid, nowIso } from './util.js';
import * as db from './db.js';

const MAX_BYTES = 30 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** ตรวจชนิด/ขนาดไฟล์ คืนข้อความผิดพลาดภาษาไทย หรือ null */
export const MAX_SIDE = 4096; // ภาพที่ใช้ประมวลผล — ไม่เกินขีดจำกัด canvas ของ iPhone (~16.7 ล้านพิกเซล)

/** ตรวจชนิด/ขนาดไฟล์ คืนข้อความผิดพลาดภาษาไทย หรือ null */
export function checkImageFile(file, { allowPdf = false } = {}) {
  const name = (file.name || '').toLowerCase();
  if (allowPdf && (file.type === 'application/pdf' || name.endsWith('.pdf'))) {
    return file.size > MAX_BYTES ? `ไฟล์ ${file.name} ใหญ่เกิน 30 MB` : null;
  }
  const isImg = OK_TYPES.includes(file.type) || /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/.test(name);
  if (!isImg) return `ไม่รองรับไฟล์ ${file.name || ''} (${file.type || 'ไม่ทราบชนิด'}) — ใช้ JPG, PNG, WEBP${allowPdf ? ' หรือ PDF' : ''}`;
  if (file.size > MAX_BYTES) return `ไฟล์ ${file.name} ใหญ่เกิน 30 MB`;
  return null;
}

async function decodeImg(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.decoding = 'async'; img.src = url;
    await img.decode();
    return img;
  } catch {
    const heic = /heic|heif/i.test(blob.type || '') || /\.(heic|heif)$/i.test(blob.name || '');
    throw new Error(heic ? 'เบราว์เซอร์นี้เปิดไฟล์ HEIC ไม่ได้ — ตั้งกล้องเป็น JPEG (iPhone: ตั้งค่า > กล้อง > รูปแบบ > "เข้ากันได้มากที่สุด") แล้วถ่ายใหม่'
      : 'เปิดภาพนี้ไม่ได้ — ลองถ่ายใหม่หรือเลือกภาพอื่น');
  } finally { URL.revokeObjectURL(url); }
}

/** ขนาดภาพจริง (หลังหมุนตาม EXIF) */
export async function imageSize(blob) { const img = await decodeImg(blob); return { width: img.naturalWidth, height: img.naturalHeight }; }

/** โหลดภาพโดยหมุนตาม EXIF Orientation แล้ว และย่อไม่ให้ด้านยาวเกิน maxSide (ไฟล์ต้นฉบับไม่ถูกแก้) */
export async function loadBitmap(blob, { maxSide = MAX_SIDE } = {}) {
  const img = await decodeImg(blob);
  const w = img.naturalWidth, h = img.naturalHeight;
  const sc = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.max(1, Math.round(w * sc)), H = Math.max(1, Math.round(h * sc));
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, W, H);
  return createImageBitmap(c);
}

/** อ่านเวลาจาก EXIF แบบรักษาค่าต้นฉบับ ไม่แปลงเขตเวลาเอง */
export async function readExifTime(blob) {
  try {
    if (!window.exifr) return null;
    const t = await window.exifr.parse(blob, { pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTime'], reviveValues: false });
    if (!t) return null;
    const raw = t.DateTimeOriginal || t.CreateDate;
    if (!raw) return null;
    const offset = t.OffsetTimeOriginal || t.OffsetTime || null;
    const m = String(raw).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    let iso = null;
    if (m && offset && /^[+-]\d{2}:\d{2}$/.test(offset)) iso = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${offset}`).toISOString();
    return { raw: String(raw), offset, tzKnown: !!iso, iso, display: m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]} น.` : String(raw) };
  } catch { return null; }
}

/** เวลาถ่ายพร้อมแหล่งที่มา — ไม่ใช้เวลาอัปโหลดแทนเวลาถ่าย คืน null ถ้าไม่พบเวลาถ่าย */
export function timeSourceText(f) {
  if (f.captureSource === 'camera' && f.deviceTime) return `ถ่ายผ่านแอป · ${fmtDateTime(f.deviceTime)}`;
  if (f.exif?.tzKnown) return `เวลาถ่าย (EXIF) · ${fmtDateTime(f.exif.iso)}`;
  if (f.exif?.raw) return `เวลาถ่าย (EXIF) · ${f.exif.display} (ไม่ทราบเขตเวลา)`;
  return null;
}
/** ข้อความใต้ภาพ */
export function timeNote(f) { return timeSourceText(f) || 'ไม่พบเวลาถ่าย'; }

/** บันทึกไฟล์ต้นฉบับลงฐานข้อมูล (ไม่แก้ไขต้นฉบับ) — กันซ้ำด้วย sha256 ภายในร้าน/ประเภทเดียวกัน */
export async function saveOriginal(file, { roundId, rsId = null, kind, captureSource }) {
  const sha = await sha256Hex(file);
  const same = rsId ? await db.filesOf(rsId, kind) : await db.roundFiles(roundId, kind);
  const dup = same.find(f => f.role === 'original' && f.sha256 === sha);
  if (dup) return { file: dup, duplicate: true };
  const est = await db.storageEstimate();
  if (est && est.free < file.size * 3 + 20e6) throw new Error('พื้นที่เก็บข้อมูลในเครื่องเหลือน้อย — ลบรอบงานเก่าหรือ Export แล้วล้างข้อมูลก่อนเพิ่มภาพ');
  const exif = file.type === 'application/pdf' ? null : await readExifTime(file);
  let w = null, h = null;
  if (file.type !== 'application/pdf') { const d = await imageSize(file); w = d.width; h = d.height; }
  const rec = await db.insert('files', {
    roundId, rsId, kind, role: 'original', parentId: null,
    blob: file, mime: file.type || 'application/octet-stream', size: file.size, name: file.name || `${kind}.jpg`,
    sha256: sha, captureSource, deviceTime: captureSource === 'camera' ? nowIso() : null,
    exif, savedAt: nowIso(), width: w, height: h, proc: { state: 'none' },
    syncState: 'local', // เดโม: ไม่มีเซิร์ฟเวอร์
  });
  return { file: rec, duplicate: false };
}

function fitFont(ctx, text, maxW, size, weight = 600) {
  let s = size;
  do { ctx.font = `${weight} ${s}px "IBM Plex Sans Thai", sans-serif`; if (ctx.measureText(text).width <= maxW) break; s -= 2; } while (s > 10);
  return s;
}

/**
 * สร้างภาพอนุพันธ์จากต้นฉบับเสมอ (ไม่ประทับซ้ำบนภาพที่มีลายน้ำแล้ว และไม่แก้ต้นฉบับ)
 *  - field: แถบเลขร้านคาดด้านบนภาพ + (ถ้าเลือก) วันที่เวลามุมล่างซ้าย เฉพาะภาพที่รู้เวลาถ่าย
 *  - barcode/bill: ต่อแถบขาวด้านบน (ไม่ทับรหัส ตัวเลข หรือลายเซ็น)
 */
export async function makeDerived(orig, { storeCode, storeName, showTime = false }) {
  try { await document.fonts.load('600 24px "IBM Plex Sans Thai"'); await document.fonts.load('400 24px "IBM Plex Sans Thai"'); } catch {}
  const bmp = await loadBitmap(orig.blob);
  const maxSide = orig.kind === 'field' ? 2560 : 3200;
  const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * sc), H = Math.round(bmp.height * sc);
  const tText = timeSourceText(orig);
  const minDim = Math.min(W, H);
  const line1 = `ร้าน ${storeCode} · ${storeName}`;
  let canvas, stampedTime = null;
  if (orig.kind === 'field') {
    canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, W, H);
    // แถบเลขร้านคาดด้านบน
    const band = Math.round(minDim * 0.11);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, W, band);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
    const code = `ร้าน ${storeCode}`;
    const s1 = fitFont(ctx, code, W * 0.6, Math.round(band * 0.56), 700);
    ctx.fillText(code, W * 0.03, band * 0.5);
    const cw = ctx.measureText(code).width;
    fitFont(ctx, storeName, Math.max(40, W * 0.94 - cw - W * 0.03), Math.round(s1 * 0.6), 400);
    ctx.fillText(storeName, W * 0.03 + cw + W * 0.025, band * 0.52);
    // วันที่เวลา (ถ้าเลือก และรู้เวลาถ่ายจริง)
    if (showTime && tText) {
      stampedTime = tText;
      const fs = Math.round(minDim * 0.032); ctx.font = `600 ${fs}px "IBM Plex Sans Thai", sans-serif`;
      const tw = ctx.measureText(tText).width; const pad = fs * 0.45;
      const x = W * 0.025, y = H - W * 0.025 - fs - pad * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y, tw + pad * 2, fs + pad * 2);
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.fillText(tText, x + pad, y + pad);
    }
  } else {
    const band = Math.round(Math.max(60, minDim * 0.08));
    canvas = new OffscreenCanvas(W, H + band);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, band);
    ctx.fillStyle = '#c8102e'; ctx.fillRect(0, band - 4, W, 4);
    ctx.drawImage(bmp, 0, band, W, H);
    ctx.fillStyle = '#111'; ctx.textBaseline = 'middle';
    const kindTh = orig.kind === 'bill' ? 'บิล' : 'Barcode';
    const label = `${kindTh} · ${line1}`;
    fitFont(ctx, label, W * 0.95, Math.round(band * (tText ? 0.38 : 0.5)));
    ctx.fillText(label, W * 0.02, tText ? band * 0.32 : band * 0.48);
    if (tText) { ctx.fillStyle = '#555'; fitFont(ctx, tText, W * 0.95, Math.round(band * 0.24), 400); ctx.fillText(tText, W * 0.02, band * 0.72); }
  }
  bmp.close?.();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  // ลบอนุพันธ์เดิม (ถ้ามี) แบบ soft delete แล้วสร้างใหม่จากต้นฉบับ
  for (const d of await db.derivedOf(orig.id)) await db.update('files', d.id, null, x => ({ ...x, deletedAt: nowIso() }));
  return db.insert('files', {
    roundId: orig.roundId, rsId: orig.rsId, kind: orig.kind, role: 'derived', parentId: orig.id,
    blob, mime: 'image/jpeg', size: blob.size, name: `${orig.kind}-${storeCode}-${uid().slice(0, 6)}.jpg`,
    storeCodeStamped: storeCode, showTime: orig.kind === 'field' ? !!showTime : null, timeText: stampedTime ?? (orig.kind === 'field' ? null : tText),
    v: 2, savedAt: nowIso(), width: canvas.width, height: canvas.height, syncState: 'local',
  });
}

/** ภาพอนุพันธ์ที่ตรงกับร้านและตัวเลือกปัจจุบัน — ถ้าไม่ตรง (เช่น ข้อมูลรุ่นเก่า) สร้างใหม่จากต้นฉบับ */
export async function ensureDerived(orig, rs) {
  const ds = await db.derivedOf(orig.id);
  const d = ds.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const showTime = !!rs.fieldShowTime;
  const ok = d && d.v === 2 && d.storeCodeStamped === rs.storeCodeSnap && (orig.kind !== 'field' || d.showTime === showTime);
  return ok ? d : makeDerived(orig, { storeCode: rs.storeCodeSnap, storeName: rs.storeNameSnap, showTime });
}

export function blobUrl(blob) { return URL.createObjectURL(blob); }
