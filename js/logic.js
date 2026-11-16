// ===== กฎ V2: สถานะร้าน, ช่องติ๊กยืนยันจำนวน, snapshot รายงาน =====
// V2 ไม่บังคับอ่านบิล ไม่บังคับยืนยันซิมทีละรายการ และไม่มีขั้นส่ง/ปิดรอบ
// ข้อมูลรุ่นเก่า (prep, delivery, exceptions, bills OCR, submittedAt) ยังเก็บอยู่ แต่ไม่ถูกใช้ตัดสินสถานะ
import * as db from './db.js';
import { ensureDerived } from './image.js';

export const STATUS_TEXT = {
  none: 'ยังไม่เตรียม', prepared: 'เตรียมเอกสารแล้ว', field: 'มีรูปลงพื้นที่แล้ว', complete: 'หลักฐานครบ',
};

/** กุญแจชุดรายการซิม: S/N ที่ไม่ซ้ำ เรียงแล้ว — เปลี่ยนเมื่อเพิ่ม/ลบ/แก้/ย้ายซิม */
export function simKey(sims) { return [...new Set(sims.map(s => s.serial).filter(Boolean))].sort().join('|'); }
/** กุญแจชุดภาพบิล: id ภาพต้นฉบับ เรียงแล้ว — เปลี่ยนเมื่อเพิ่ม/ลบ/เปลี่ยนภาพบิล */
export function billKey(billFiles) { return billFiles.map(f => f.id).sort().join('|'); }
export function uniqueSimCount(sims) { return new Set(sims.map(s => s.serial).filter(Boolean)).size; }

export async function loadStoreData(rs) {
  const [sims, files] = await Promise.all([db.simsOfRs(rs.id), db.filesOf(rs.id)]);
  return { sims, files };
}

/** ช่องติ๊กยังมีผลหรือไม่: ต้องติ๊กโดยผู้ใช้ และชุดซิม/ชุดภาพบิลยังเหมือนตอนติ๊ก */
export function billCheckValid(rs, sims, billFiles) {
  const c = rs.billCheck;
  return !!(c?.checked && sims.length > 0 && billFiles.length > 0 && c.simKey === simKey(sims) && c.billKey === billKey(billFiles));
}

export function evaluate(rs, { sims, files }) {
  const originals = files.filter(f => f.role === 'original');
  const barcodeFiles = originals.filter(f => f.kind === 'barcode');
  const billFiles = originals.filter(f => f.kind === 'bill');
  const fieldFiles = originals.filter(f => f.kind === 'field');
  const simCount = uniqueSimCount(sims);
  const billChecked = billCheckValid(rs, sims, billFiles);
  const missingDocs = [];
  if (!barcodeFiles.length) missingDocs.push('ภาพ Barcode');
  if (!simCount) missingDocs.push('รายการซิม');
  if (!billFiles.length) missingDocs.push('ภาพบิล');
  if (!billChecked) missingDocs.push('ติ๊กยืนยันจำนวนซิมในบิล');
  const docsReady = missingDocs.length === 0;
  const hasField = fieldFiles.length > 0;
  const missing = [...missingDocs, ...(hasField ? [] : ['รูปลงพื้นที่'])];
  const status = docsReady && hasField ? 'complete' : hasField ? 'field' : docsReady ? 'prepared' : 'none';
  return {
    status, statusText: STATUS_TEXT[status], docsReady, hasField, billChecked, missingDocs, missing, simCount,
    counts: { barcode: barcodeFiles.length, bill: billFiles.length, field: fieldFiles.length, sims: simCount },
  };
}

/** ยกเลิกการติ๊กยืนยันจำนวน (เมื่อชุดซิมหรือภาพบิลเปลี่ยน) */
export async function resetBillCheck(rsId, reason) {
  const cur = await db.get('roundStores', rsId);
  if (!cur?.billCheck?.checked) return;
  await db.update('roundStores', rsId, cur.version, x => ({ ...x, billCheck: { checked: false, resetAt: new Date().toISOString(), resetReason: reason } }));
  await db.audit({ entity: 'roundStore', entityId: rsId, roundId: cur.roundId, action: 'bill_check_reset', reason });
}

export function statusBadge(status) { return { complete: 'ok', prepared: 'info', field: 'warn', none: '' }[status] ?? ''; }

/** snapshot สำหรับ PDF/CSV — เรียงร้านตามลำดับในรอบงาน, ภาพเรียงตามเวลาที่เพิ่ม */
export async function buildSnapshot(roundId, { rsIds = null } = {}) {
  const round = await db.get('rounds', roundId);
  let rss = await db.roundStoresOf(roundId);
  if (rsIds) rss = rss.filter(r => rsIds.includes(r.id));
  const requisitionFiles = (await db.roundFiles(roundId, 'requisition')).filter(f => f.role === 'original');
  const stores = [];
  for (const rs of rss) {
    const d = await loadStoreData(rs); const ev = evaluate(rs, d);
    const origs = kind => d.files.filter(f => f.role === 'original' && f.kind === kind);
    const images = {};
    for (const kind of ['barcode', 'bill', 'field']) {
      images[kind] = [];
      for (const o of origs(kind)) images[kind].push((await ensureDerived(o, rs)).id); // ลายน้ำตรงร้านและตัวเลือกปัจจุบัน
    }
    stores.push({
      rsId: rs.id, seq: rs.seq, code: rs.storeCodeSnap, name: rs.storeNameSnap, status: ev.status, statusText: ev.statusText,
      simCount: ev.simCount, counts: ev.counts, billChecked: ev.billChecked, billCheckedAt: ev.billChecked ? rs.billCheck.at : null,
      billCheckedBy: ev.billChecked ? rs.billCheck.by : null, missing: ev.missing, fieldShowTime: !!rs.fieldShowTime,
      sims: d.sims.map(s => ({ serial: s.serial, barcodeRaw: s.barcodeRaw, msisdn: s.msisdn, partNo: s.partNo, check: s.check, entry: s.entry, note: s.note || '',
        sourceFileName: d.files.find(f => f.id === s.sourceFileId)?.name || '', movedFrom: s.movedFrom || null })),
      images,
    });
  }
  return {
    round: { id: round.id, code: round.code, workDate: round.workDate, owner: round.owner },
    requisition: { fileIds: requisitionFiles.map(f => f.id) },
    scope: rsIds ? 'store' : 'round', stores,
    complete: stores.length > 0 && stores.every(s => s.status === 'complete') && requisitionFiles.length > 0,
    missingRequisition: requisitionFiles.length === 0,
  };
}
