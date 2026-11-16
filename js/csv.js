// ===== Export CSV (UTF-8 + BOM, กัน Formula Injection, รหัสเป็นข้อความ) =====
import { fmtDate, fmtDateTime } from './util.js';
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

/** รายการซิม: 1 แถว = 1 ซิม */
export function simsCsv(snap) {
  const header = ['รหัสรอบงาน', 'วันที่รอบงาน', 'ผู้รับผิดชอบ', 'ลำดับร้าน', 'เลขร้าน', 'ชื่อร้าน', 'ลำดับซิม', 'Part no.',
    'Barcode (ค่าที่อ่านได้ครั้งแรก)', 'S/N', 'เบอร์ที่พิมพ์กำกับ', 'ผลตรวจ Barcode เทียบเลขพิมพ์', 'ความสัมพันธ์ Barcode–S/N',
    'สถานะซ้ำในรอบงาน', 'แหล่งข้อมูล', 'ภาพอ้างอิง', 'ย้ายมาจากร้าน', 'หมายเหตุ'];
  const count = new Map(); for (const st of snap.stores) for (const s of st.sims) if (s.serial) count.set(s.serial, (count.get(s.serial) || 0) + 1);
  const rows = [];
  for (const st of snap.stores) {
    st.sims.forEach((s, i) => rows.push([
      snap.round.code, fmtDate(snap.round.workDate), snap.round.owner, st.seq, st.code, st.name, i + 1, s.partNo || '',
      s.barcodeRaw || '', s.serial || '', s.msisdn || '', CHECK_TEXT[s.check] || s.check || '', RELATION_TEXT,
      (count.get(s.serial) || 0) > 1 ? 'ซ้ำ' : 'ไม่ซ้ำ', s.entry === 'manual' ? 'กรอกมือ' : 'สแกน', s.sourceFileName || '', s.movedFrom || '', s.note || '',
    ]));
  }
  return toCsv(header, rows);
}

/** สรุปรายร้าน: 1 แถว = 1 ร้าน (ไม่มียอดเงิน เพราะ V2 ไม่อ่านบิล) */
export function storesCsv(snap) {
  const header = ['รหัสรอบงาน', 'วันที่รอบงาน', 'ผู้รับผิดชอบ', 'ลำดับร้าน', 'เลขร้าน', 'ชื่อร้าน', 'สถานะ', 'จำนวนซิม (S/N ไม่ซ้ำ)',
    'ภาพ Barcode', 'ภาพบิล', 'ติ๊กยืนยันจำนวนในบิล', 'ยืนยันโดย/เวลา', 'รูปลงพื้นที่', 'แสดงวันที่เวลาบนรูป', 'ยังขาด'];
  const rows = snap.stores.map(st => [
    snap.round.code, fmtDate(snap.round.workDate), snap.round.owner, st.seq, st.code, st.name, st.statusText, st.simCount,
    st.counts.barcode, st.counts.bill, st.billChecked ? 'ติ๊กแล้ว' : 'ยังไม่ติ๊ก', st.billChecked ? `${st.billCheckedBy || ''} ${fmtDateTime(st.billCheckedAt)}` : '',
    st.counts.field, st.fieldShowTime ? 'แสดง' : 'ไม่แสดง', st.missing.join(' | '),
  ]);
  return toCsv(header, rows);
}
