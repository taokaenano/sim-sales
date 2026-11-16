// ===== กฎธุรกิจ: สถานะร้าน, เงื่อนไขก่อนส่ง, ข้อยกเว้น, snapshot รายงาน =====
import * as db from './db.js';
import { billSummary, SIG_TEXT } from './bill.js';
import { stableStringify, sha256Text } from './util.js';

export const STATUS_TEXT = {
  none: 'ยังไม่เริ่ม', preparing: 'กำลังเตรียมสินค้า', prepared: 'เตรียมแล้ว', collecting: 'กำลังเก็บหลักฐาน',
  ready: 'พร้อมส่ง', submitted: 'ส่งแล้ว', needs_fix: 'ต้องแก้ไข / มีข้อยกเว้น', other: 'ไม่ได้ส่ง',
};
export const REVIEW_TEXT = { reviewed: 'ตรวจแล้ว', returned: 'ส่งกลับให้แก้', resubmitted: 'แก้แล้วส่งใหม่ (รอตรวจ)' };
export const OUTCOME_TEXT = { not_visited: 'ไม่ได้เข้าร้าน', not_delivered: 'เข้าร้านแต่ไม่ได้ส่งสินค้า', cancelled: 'ยกเลิก' };

/** ผลตรวจลายเซ็นสุดท้าย: ระบบพบรอย → อนุมัติอัตโนมัติ (ตามที่ผู้ใช้กำหนด) เว้นแต่ผู้ใช้แก้เป็นอย่างอื่น */
export function signatureFinal(bill) {
  if (!bill?.signature) return null;
  if (bill.signature.user) return bill.signature.user;
  if (bill.signature.system === 'found') return 'present';
  return null;
}
export function signatureText(bill) {
  if (!bill?.signature) return 'ยังไม่ได้ตรวจ';
  const sys = `ระบบ: ${SIG_TEXT[bill.signature.system] || '-'}`;
  const fin = signatureFinal(bill);
  if (bill.signature.user) return `${sys} · ผู้ใช้ยืนยัน: ${bill.signature.user === 'present' ? 'มีลายเซ็น' : 'ไม่มีลายเซ็น'}`;
  if (fin === 'present') return `${sys} · อนุมัติอัตโนมัติ (มีรอยในช่องผู้รับ)`;
  return `${sys} · รอผู้ใช้ตรวจ`;
}

export async function loadStoreData(rs) {
  const [sims, bill, files] = await Promise.all([db.simsOfRs(rs.id), db.billOf(rs.id), db.filesOf(rs.id)]);
  return { sims, bill, files };
}

/** ประเมินร้าน: สถานะ, รายการตรวจก่อนส่ง, ข้อยกเว้น */
export function evaluate(rs, { sims, bill, files }) {
  const originals = files.filter(f => f.role === 'original');
  const barcodeFiles = originals.filter(f => f.kind === 'barcode');
  const billFiles = originals.filter(f => f.kind === 'bill');
  const fieldFiles = originals.filter(f => f.kind === 'field');
  const fieldDerived = files.filter(f => f.role === 'derived' && f.kind === 'field');
  const preparedCount = sims.length;
  const deliveredCount = rs.delivery?.confirmedAt ? sims.filter(s => s.delivery === 'delivered').length : null;
  const sum = bill ? billSummary(bill) : null;
  const billConfirmed = !!bill?.confirmed;
  const sig = signatureFinal(bill);

  const exceptions = [];
  const R = rs.exceptionReasons || {};
  const ex = (code, text, needsReason = true) => exceptions.push({ code, text, reason: R[code] || '', needsReason, resolved: !needsReason || !!R[code] });
  if (billConfirmed && sum.simQty !== preparedCount) ex('bill_vs_prepared', `จำนวนซิมตามบิล ${sum.simQty} ≠ ซิมที่เตรียม ${preparedCount} (ต่าง ${sum.simQty - preparedCount})`);
  if (billConfirmed && deliveredCount != null && deliveredCount !== sum.simQty) ex('delivered_vs_bill', `ซิมที่เลือกว่าส่งจริง ${deliveredCount} รายการ ≠ จำนวนตามบิล ${sum.simQty}`);
  if (billConfirmed && sum.checks.length) ex('bill_calc', 'ตัวเลขในบิลคำนวณไม่ตรง: ' + sum.checks.map(c => c.text).join(' / '));
  if (sig === 'absent') ex('signature_absent', 'ไม่มีลายเซ็นผู้รับในบิล');
  if (rs.review?.status === 'returned') ex('central_return', `ส่วนกลางส่งกลับให้แก้: ${rs.review.note || '-'}`, false);

  const checks = [
    { key: 'sims', label: 'รายการซิมตรวจกับภาพและยืนยันแล้ว', ok: preparedCount > 0 && sims.every(s => s.confirmed) && !!rs.prep?.checkedAgainstImage,
      detail: preparedCount ? `${sims.filter(s => s.confirmed).length}/${preparedCount} ยืนยัน${rs.prep?.checkedAgainstImage ? ' · ตรวจกับภาพแล้ว' : ' · ยังไม่ยืนยันว่าตรวจกับภาพ'}` : 'ยังไม่มีรายการซิม' },
    { key: 'bill_image', label: 'มีภาพบิล', ok: billFiles.length > 0, detail: `${billFiles.length} ภาพ` },
    { key: 'bill_confirmed', label: 'จำนวนซิมและยอดเงินในบิลยืนยันแล้ว', ok: billConfirmed, detail: bill ? (billConfirmed ? `ยืนยันโดย ${bill.confirmed.by}` : 'ยังเป็นฉบับร่าง') : 'ยังไม่ได้อ่านบิล' },
    { key: 'signature', label: 'ผลตรวจช่องลายเซ็นผู้รับ', ok: sig === 'present' || (sig === 'absent' && !!R.signature_absent), detail: signatureText(bill) },
    { key: 'delivery', label: 'ยืนยันรายการซิมที่ส่งจริง', ok: deliveredCount != null, detail: deliveredCount != null ? `ส่งจริง ${deliveredCount} / เตรียม ${preparedCount}` : 'ยังไม่ได้เลือก' },
    { key: 'field', label: 'รูปลงพื้นที่อย่างน้อย 1 ภาพ (มีลายน้ำ)', ok: fieldFiles.length > 0 && fieldDerived.length >= fieldFiles.length, detail: `${fieldFiles.length} ภาพ` },
    { key: 'files', label: 'ไฟล์บันทึกครบ', ok: true, detail: 'บันทึกในเครื่องแล้ว (เดโม: ยังไม่มีเซิร์ฟเวอร์)' },
    { key: 'exceptions', label: 'ข้อยกเว้นทุกข้อมีเหตุผล', ok: exceptions.every(e => e.resolved), detail: exceptions.length ? `${exceptions.length} ข้อ` : 'ไม่มี' },
  ];
  const ready = checks.every(c => c.ok);

  let status;
  if (rs.outcome && rs.outcome !== 'delivered') status = 'other';
  else if (rs.submittedAt && rs.review?.status !== 'returned') status = 'submitted';
  else if ((rs.review?.status === 'returned' && !rs.submittedAt) || (billConfirmed && exceptions.some(e => !e.resolved)) || sig === 'absent') status = 'needs_fix';
  else if (ready) status = 'ready';
  else if (billFiles.length || fieldFiles.length || bill) status = 'collecting';
  else if (rs.prep?.confirmedAt) status = 'prepared';
  else if (barcodeFiles.length || sims.length) status = 'preparing';
  else status = 'none';
  let statusText = STATUS_TEXT[status];
  if (status === 'other') statusText = `${STATUS_TEXT.other}: ${OUTCOME_TEXT[rs.outcome]}`;
  if (status === 'submitted' && exceptions.length) statusText = 'ส่งแล้ว · มีข้อยกเว้น';

  return { status, statusText, checks, ready, exceptions, preparedCount, deliveredCount, billSum: sum, billConfirmed, signature: sig,
    counts: { barcode: barcodeFiles.length, bill: billFiles.length, field: fieldFiles.length } };
}

export function isClosedResult(ev) { return ev.status === 'submitted' || ev.status === 'other'; }

/** snapshot ข้อมูลสำหรับรายงาน (PDF/CSV) — ใช้เฉพาะค่าที่ยืนยันแล้วในยอดยืนยัน */
export async function buildSnapshot(roundId, { rsIds = null } = {}) {
  const round = await db.get('rounds', roundId);
  let rss = await db.roundStoresOf(roundId);
  if (rsIds) rss = rss.filter(r => rsIds.includes(r.id));
  const requisitionFiles = (await db.roundFiles(roundId, 'requisition')).filter(f => f.role === 'original');
  const allSims = await db.simsOfRound(roundId);
  const stores = [];
  for (const rs of rss) {
    const d = await loadStoreData(rs); const ev = evaluate(rs, d);
    const fileName = id => d.files.find(f => f.id === id)?.name || '';
    const sims = d.sims.map(s => {
      const dupOther = allSims.filter(o => o.id !== s.id && o.serial && o.serial === s.serial);
      return { serial: s.serial, barcodeRaw: s.barcodeRaw, msisdn: s.msisdn, partNo: s.partNo, check: s.check, confirmed: !!s.confirmed, confirmedBy: s.confirmedBy, confirmedAt: s.confirmedAt,
        delivery: rs.delivery?.confirmedAt ? s.delivery : 'allocated', giveType: s.giveType, entry: s.entry, note: s.note || '', sourceFileName: fileName(s.sourceFileId),
        dupNote: dupOther.length ? `ซ้ำกับ ${dupOther.length} รายการ` : '', movedFrom: s.movedFrom || null };
    });
    const bill = d.bill ? {
      confirmed: !!d.bill.confirmed, confirmedBy: d.bill.confirmed?.by, confirmedAt: d.bill.confirmed?.at,
      simQty: ev.billSum.simQty, paidQty: ev.billSum.paidQty, freeQty: ev.billSum.freeQty, byType: ev.billSum.byType,
      lineAmount: ev.billSum.lineAmount, received: ev.billSum.received, checks: ev.billSum.checks, signatureText: signatureText(d.bill),
      rows: d.bill.rows, totals: d.bill.totals,
    } : null;
    const pick = (kind, role) => d.files.filter(f => f.kind === kind && f.role === role).map(f => f.id);
    stores.push({ rsId: rs.id, seq: rs.seq, code: rs.storeCodeSnap, name: rs.storeNameSnap, status: ev.status, statusText: ev.statusText,
      outcome: rs.outcome, outcomeReason: rs.outcomeReason, preparedCount: ev.preparedCount, deliveredCount: ev.deliveredCount,
      expectedCount: rs.expectedCount, sims, bill, exceptions: ev.exceptions, checks: ev.checks, submittedAt: rs.submittedAt, submittedBy: rs.submittedBy,
      review: rs.review || null, notes: rs.notes || '',
      images: { barcode: pick('barcode', 'derived'), barcodeOrig: pick('barcode', 'original'), bill: pick('bill', 'derived'), billOrig: pick('bill', 'original'), field: pick('field', 'derived') } });
  }
  const complete = stores.length > 0 && stores.every(s => s.status === 'submitted' || s.status === 'other');
  const snap = {
    round: { id: round.id, code: round.code, workDate: round.workDate, owner: round.owner, status: round.status, closedAt: round.closedAt || null },
    requisition: { lines: round.requisition?.lines || [], reconciled: false, fileIds: requisitionFiles.map(f => f.id) },
    scope: rsIds ? 'store' : 'round', stores, complete,
  };
  snap.hash = await sha256Text(stableStringify(snap));
  return snap;
}
