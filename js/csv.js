// ===== Export CSV (UTF-8 + BOM, กัน Formula Injection, รหัสเป็นข้อความ) =====
import { fmtDate, fmtDateTime, fmtSatang } from './util.js';
import { CHECK_TEXT, RELATION_TEXT } from './barcode.js';

function cell(v) {
  let s = v == null ? '' : String(v);
  // กัน CSV/Excel formula injection: ขึ้นต้นด้วย = + - @ tab CR → เติม ' นำหน้า
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function toCsv(header, rows) {
  return '﻿' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const DELIV = { allocated: 'จัดให้ร้าน (ยังไม่ยืนยันส่ง)', delivered: 'ส่งจริง', returned: 'คืน/ไม่ได้ส่ง' };
const GIVE = { paid: 'ขาย (คิดเงิน)', free: 'แถม' };

/** ไฟล์รายการซิม: 1 แถว = 1 ซิม (ไม่มียอดเงินทั้งบิลในไฟล์นี้ เพื่อกันรวมซ้ำ) */
export function simsCsv(snap) {
  const header = ['รหัสรอบงาน', 'วันที่รอบงาน', 'ผู้รับผิดชอบ', 'ลำดับร้าน', 'เลขร้าน', 'ชื่อร้าน', 'ลำดับซิม', 'ประเภทซิม (Part no.)',
    'Barcode (ค่าที่ถอดได้)', 'S/N (ค่าที่ยืนยัน)', 'เบอร์ที่พิมพ์กำกับ', 'ผลตรวจ Barcode เทียบเลขพิมพ์', 'ความสัมพันธ์ Barcode–S/N',
    'สถานะซ้ำ', 'สถานะการยืนยัน', 'สถานะจัดสรร/ส่ง', 'ขาย/แถม', 'ภาพอ้างอิง', 'แหล่งข้อมูล', 'หมายเหตุ'];
  const rows = [];
  for (const st of snap.stores) {
    st.sims.forEach((s, i) => rows.push([
      snap.round.code, fmtDate(snap.round.workDate), snap.round.owner, st.seq, st.code, st.name, i + 1, s.partNo || '',
      s.barcodeRaw || '', s.serial || '', s.msisdn || '', CHECK_TEXT[s.check] || s.check || '', RELATION_TEXT,
      s.dupNote || 'ไม่ซ้ำ', s.confirmed ? `ยืนยันแล้ว (${s.confirmedBy || '-'} ${fmtDateTime(s.confirmedAt)})` : 'ยังไม่ยืนยัน',
      DELIV[s.delivery] || s.delivery || '', GIVE[s.giveType] || 'ไม่ระบุ', s.sourceFileName || '', s.entry === 'manual' ? 'กรอกมือ' : 'สแกน', s.note || '',
    ]));
  }
  return toCsv(header, rows);
}

/** ไฟล์สรุปบิล: 1 แถว = 1 ร้าน */
export function billsCsv(snap) {
  const header = ['รหัสรอบงาน', 'วันที่รอบงาน', 'ผู้รับผิดชอบ', 'เลขร้าน', 'ชื่อร้าน', 'สถานะร้าน', 'จำนวนเบิก/จัดให้ร้าน (ซิมที่เตรียม)', 'ส่งจริง (เลือกตาม S/N)',
    'จำนวนซิมตามบิล (ยืนยันแล้ว)', 'ซิมขายตามบิล', 'ซิมแถมตามบิล', 'ส่วนต่าง (บิล − เตรียม)', 'ยอดเงินรวมรายการตามบิล (บาท)', 'ยอดรับเงินทั้งสิ้นตามบิล (บาท)',
    'สถานะยืนยันบิล', 'ผลตรวจลายเซ็นผู้รับ', 'ข้อยกเว้น'];
  const rows = snap.stores.map(st => [
    snap.round.code, fmtDate(snap.round.workDate), snap.round.owner, st.code, st.name, st.statusText,
    st.preparedCount, st.deliveredCount ?? '', st.bill?.confirmed ? st.bill.simQty : '', st.bill?.confirmed ? st.bill.paidQty : '', st.bill?.confirmed ? st.bill.freeQty : '',
    st.bill?.confirmed ? st.bill.simQty - st.preparedCount : '',
    st.bill?.confirmed ? fmtSatang(st.bill.lineAmount) : '', st.bill?.confirmed && st.bill.received != null ? fmtSatang(st.bill.received) : '',
    st.bill ? (st.bill.confirmed ? `ยืนยันแล้ว ${st.bill.confirmedBy} ${fmtDateTime(st.bill.confirmedAt)}` : 'ฉบับร่าง (ยังไม่ยืนยัน)') : 'ไม่มีบิล',
    st.bill?.signatureText || '', st.exceptions.map(e => e.text + (e.reason ? ` (เหตุผล: ${e.reason})` : '')).join(' | '),
  ]);
  return toCsv(header, rows);
}
