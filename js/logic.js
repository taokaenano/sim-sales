// ===== กฎสถานะร้าน + ข้อมูลสำหรับรายงาน (เวอร์ชันเก็บรูปอย่างเดียว) =====
// ร้านมี 3 สถานะ: รอเตรียมข้อมูล → รอถ่ายรูปหน้าร้าน → เสร็จ
// ข้อมูลรุ่นเก่า (ซิม, บิล OCR, ช่องติ๊ก) ยังอยู่ในเครื่อง แต่ไม่ใช้ตัดสินสถานะ
import * as db from './db.js';
import { ensureDerived } from './image.js';

export const STATUS_TEXT = { none: 'รอเตรียมข้อมูล', prepared: 'รอถ่ายรูปหน้าร้าน', complete: 'เสร็จ' };
export function statusBadge(status) { return { complete: 'ok', prepared: 'info', none: '' }[status] ?? ''; }

const originals = (files, kind) => files.filter(f => f.kind === kind && f.role === 'original');

/** กุญแจชุดรูปก่อนเข้าร้าน — เปลี่ยนเมื่อเพิ่ม/ลบรูปบาร์โค้ดหรือรูปบิล */
export function prepKey(files) { return [...originals(files, 'barcode'), ...originals(files, 'bill')].map(f => f.id).sort().join('|'); }

export async function loadStoreData(rs) { return { files: await db.filesOf(rs.id) }; }

export function evaluate(rs, { files }) {
  const barcode = originals(files, 'barcode'), bill = originals(files, 'bill'), field = originals(files, 'field');
  const hasPhotos = barcode.length > 0 && bill.length > 0;
  const confirmed = !!(rs.prepConfirm?.key && hasPhotos && rs.prepConfirm.key === prepKey(files));
  const hasField = field.length > 0;
  const status = confirmed && hasField ? 'complete' : confirmed ? 'prepared' : 'none';
  const missing = [];
  if (!barcode.length) missing.push('รูปบาร์โค้ด');
  if (!bill.length) missing.push('รูปบิล');
  if (hasPhotos && !confirmed) missing.push('ยืนยันข้อมูลร้าน');
  if (!hasField) missing.push('รูปหน้าร้าน');
  return { status, statusText: STATUS_TEXT[status], confirmed, hasPhotos, hasField, missing, counts: { barcode: barcode.length, bill: bill.length, field: field.length } };
}

/** รูปหน้าแรกของรอบ: ไฟล์แรกที่ยังไม่ถูกลบ (รอบเก่าอาจมีใบเบิกหลายไฟล์) */
export async function coverFile(roundId) {
  return (await db.roundFiles(roundId, 'requisition')).filter(f => f.role === 'original')[0] || null;
}

/** ข้อมูลสำหรับสร้าง PDF — เรียงร้านตามลำดับในรอบงาน รูปเรียงตามเวลาที่เพิ่ม */
export async function buildSnapshot(roundId) {
  const round = await db.get('rounds', roundId);
  const cover = await coverFile(roundId);
  const stores = [];
  for (const rs of await db.roundStoresOf(roundId)) {
    const d = await loadStoreData(rs); const ev = evaluate(rs, d);
    const field = [];
    for (const o of originals(d.files, 'field')) field.push((await ensureDerived(o, rs)).id); // รูปพร้อมลายน้ำ
    stores.push({
      rsId: rs.id, seq: rs.seq, code: rs.storeCodeSnap, name: rs.storeNameSnap, status: ev.status, missing: ev.missing,
      images: { barcode: originals(d.files, 'barcode').map(f => f.id), bill: originals(d.files, 'bill').map(f => f.id), field },
    });
  }
  return {
    round: { id: round.id, code: round.code, workDate: round.workDate, owner: round.owner },
    coverId: cover?.id || null, stores,
    complete: !!cover && stores.length > 0 && stores.every(s => s.status === 'complete'),
  };
}
