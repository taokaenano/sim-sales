// ===== ภาพ: ตรวจไฟล์, EXIF, ลายน้ำ =====
import { fmtDateTime, sha256Hex, uid, nowIso } from './util.js';
import * as db from './db.js';

const MAX_BYTES = 30 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** ตรวจชนิด/ขนาดไฟล์ คืนข้อความผิดพลาดภาษาไทย หรือ null */
export function checkImageFile(file, { allowPdf = false } = {}) {
  const name = (file.name || '').toLowerCase();
  if (/\.(heic|heif)$/.test(name) || /heic|heif/.test(file.type)) {
    return `ไฟล์ ${file.name} เป็น HEIC ซึ่งเบราว์เซอร์นี้ยังเปิดไม่ได้ — ตั้งกล้องเป็น JPEG (iPhone: ตั้งค่า > กล้อง > รูปแบบ > "เข้ากันได้มากที่สุด") หรือแปลงเป็น JPG ก่อนอัปโหลด`;
  }
  if (allowPdf && (file.type === 'application/pdf' || name.endsWith('.pdf'))) {
    return file.size > MAX_BYTES ? `ไฟล์ ${file.name} ใหญ่เกิน 30 MB` : null;
  }
  if (!OK_TYPES.includes(file.type) && !/\.(jpe?g|png|webp)$/.test(name)) {
    return `ไม่รองรับไฟล์ ${file.name} (${file.type || 'ไม่ทราบชนิด'}) — ใช้ JPG, PNG, WEBP${allowPdf ? ' หรือ PDF' : ''}`;
  }
  if (file.size > MAX_BYTES) return `ไฟล์ ${file.name} ใหญ่เกิน 30 MB`;
  return null;
}

/** โหลดภาพโดยหมุนตาม EXIF Orientation แล้ว */
export async function loadBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return await createImageBitmap(img);
    } finally { URL.revokeObjectURL(url); }
  }
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

/** ข้อความแหล่งที่มาของเวลา (ตามข้อกำหนดข้อ 11) */
export function timeSourceText(f) {
  if (f.captureSource === 'camera' && f.deviceTime) return `ถ่ายผ่านแอป — เวลาเครื่อง: ${fmtDateTime(f.deviceTime)}`;
  if (f.exif?.tzKnown) return `เวลาจาก EXIF: ${fmtDateTime(f.exif.iso)}`;
  if (f.exif?.raw) return `เวลาจาก EXIF: ${f.exif.display} (ไม่ทราบเขตเวลา)`;
  return `ไม่พบเวลาถ่าย | บันทึกเข้าแอป: ${fmtDateTime(f.savedAt)}`;
}

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
  if (file.type !== 'application/pdf') { const bmp = await loadBitmap(file); w = bmp.width; h = bmp.height; bmp.close?.(); }
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
 * สร้างภาพอนุพันธ์ (ไม่เขียนทับต้นฉบับ)
 *  - field: ลายน้ำแถบบนภาพ เลขร้าน + ชื่อร้าน + แหล่งที่มาของเวลา
 *  - barcode/bill: ต่อแถบขาวด้านบน (ไม่ทับรหัส ตัวเลข หรือลายเซ็น)
 */
export async function makeDerived(orig, { storeCode, storeName }) {
  try { await document.fonts.load('600 24px "IBM Plex Sans Thai"'); await document.fonts.load('400 24px "IBM Plex Sans Thai"'); } catch {}
  const bmp = await loadBitmap(orig.blob);
  const maxSide = orig.kind === 'field' ? 2560 : 3200;
  const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const W = Math.round(bmp.width * sc), H = Math.round(bmp.height * sc);
  const timeText = timeSourceText(orig);
  const minDim = Math.min(W, H);
  const line1 = `ร้าน ${storeCode} · ${storeName}`;
  let canvas;
  if (orig.kind === 'field') {
    canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, W, H);
    const band = Math.round(minDim * 0.13);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, band);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
    const s1 = fitFont(ctx, line1, W * 0.94, Math.round(band * 0.42));
    ctx.fillText(line1, W * 0.03, band * 0.36);
    const s2 = fitFont(ctx, timeText, W * 0.94, Math.round(band * 0.24), 400);
    ctx.fillText(timeText, W * 0.03, band * 0.36 + s1 * 0.5 + s2 * 0.8);
    // เลขร้านคาดมุมล่างขวาจาง ๆ
    ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff';
    const s3 = Math.round(minDim * 0.07); ctx.font = `700 ${s3}px "IBM Plex Sans Thai", sans-serif`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.lineWidth = Math.max(2, s3 / 14); ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(storeCode, W * 0.97, H * 0.97); ctx.fillText(storeCode, W * 0.97, H * 0.97); ctx.restore();
  } else {
    const band = Math.round(Math.max(60, minDim * 0.08));
    canvas = new OffscreenCanvas(W, H + band);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, band);
    ctx.fillStyle = '#c8102e'; ctx.fillRect(0, band - 4, W, 4);
    ctx.drawImage(bmp, 0, band, W, H);
    ctx.fillStyle = '#111'; ctx.textBaseline = 'middle';
    const kindTh = orig.kind === 'bill' ? 'บิล' : 'Barcode';
    const s1 = fitFont(ctx, `${kindTh} · ${line1}`, W * 0.95, Math.round(band * 0.38));
    ctx.fillText(`${kindTh} · ${line1}`, W * 0.02, band * 0.32);
    ctx.fillStyle = '#555'; const s2 = fitFont(ctx, timeText, W * 0.95, Math.round(band * 0.24), 400);
    ctx.fillText(timeText, W * 0.02, band * 0.32 + s1 * 0.5 + s2 * 0.75);
  }
  bmp.close?.();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  // ลบอนุพันธ์เดิม (ถ้ามี) แบบ soft delete แล้วสร้างใหม่จากต้นฉบับ
  for (const d of await db.derivedOf(orig.id)) await db.update('files', d.id, null, x => ({ ...x, deletedAt: nowIso() }));
  return db.insert('files', {
    roundId: orig.roundId, rsId: orig.rsId, kind: orig.kind, role: 'derived', parentId: orig.id,
    blob, mime: 'image/jpeg', size: blob.size, name: `${orig.kind}-${storeCode}-${uid().slice(0, 6)}.jpg`,
    storeCodeStamped: storeCode, timeText, savedAt: nowIso(), width: canvas.width, height: canvas.height, syncState: 'local',
  });
}

export function blobUrl(blob) { return URL.createObjectURL(blob); }
