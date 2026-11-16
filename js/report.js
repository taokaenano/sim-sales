// ===== สร้างรายงาน PDF (pdf-lib + ฟอนต์ IBM Plex Sans Thai ฝังในไฟล์) =====
// วาดข้อความไทยแบบจัดตำแหน่งสระ/วรรณยุกต์เองตามข้อมูล GPOS ของฟอนต์ (pdf-lib วาดเองไม่ถูก)
import * as db from './db.js';
import { fmtDate, fmtDateTime, fmtSatang, nowIso } from './util.js';
import { CHECK_TEXT, RELATION_TEXT } from './barcode.js';
import { loadBitmap } from './image.js';
import { TEMPLATE, STATE_TEXT, ITEM_TYPES } from './bill.js';
import { OUTCOME_TEXT, REVIEW_TEXT } from './logic.js';

const { PDFDocument, PDFHexString, rgb, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, showText, setFillingRgbColor, degrees } = window.PDFLib;
const A4 = [595.28, 841.89]; const M = 36;
const RED = [0.784, 0.063, 0.18], GREY = [0.42, 0.42, 0.45], DARK = [0.1, 0.1, 0.12], LIGHT = [0.94, 0.94, 0.95];

let fontBytes;
async function fonts() {
  if (!fontBytes) {
    const [r, b] = await Promise.all(['vendor/fonts/IBMPlexSansThai_400Regular.ttf', 'vendor/fonts/IBMPlexSansThai_600SemiBold.ttf'].map(p => fetch(new URL(p, location.href)).then(x => x.arrayBuffer())));
    fontBytes = { r, b };
  }
  return fontBytes;
}

class Writer {
  constructor(doc, fr, fb, meta) { this.doc = doc; this.fr = fr; this.fb = fb; this.meta = meta; this.page = null; this.y = 0; this.pageStore = new Map(); }
  width(text, size, bold) { const f = (bold ? this.fb : this.fr).embedder.font; const run = f.layout(String(text)); let w = 0; for (const p of run.positions) w += p.xAdvance; return w * size / f.unitsPerEm; }
  text(text, x, y, { size = 10, bold = false, color = DARK, page = this.page } = {}) {
    text = String(text ?? ''); if (!text) return;
    const font = bold ? this.fb : this.fr; const fk = font.embedder.font; const run = fk.layout(text); font.encodeText(text);
    const s = size / fk.unitsPerEm; const key = page.node.newFontDictionary(font.name, font.ref);
    const ops = [pushGraphicsState(), beginText(), setFillingRgbColor(...color), setFontAndSize(key, size)];
    let cx = x;
    run.glyphs.forEach((g, i) => { const ps = run.positions[i]; ops.push(setTextMatrix(1, 0, 0, 1, cx + ps.xOffset * s, y + ps.yOffset * s)); ops.push(showText(PDFHexString.of(g.id.toString(16).padStart(4, '0')))); cx += ps.xAdvance * s; });
    ops.push(endText(), popGraphicsState()); page.pushOperators(...ops);
  }
  /** ตัดบรรทัด: ตามช่องว่างก่อน ถ้ายาวเกินตัดตามกลุ่มอักษรไทย */
  wrap(text, maxW, size, bold) {
    const out = [];
    for (const para of String(text ?? '').split('\n')) {
      let line = '';
      const units = para.match(/\s+|[฀-๿][ัิ-ฺ็-๎]*|[^\s฀-๿]+/g) || [''];
      for (const u of units) {
        const t = line + u;
        if (this.width(t, size, bold) <= maxW || !line) line = t; else { out.push(line.trimEnd()); line = u.trimStart(); }
      }
      out.push(line);
    }
    return out;
  }
  para(text, { size = 10, bold = false, color = DARK, x = M, w = A4[0] - 2 * M, gap = 1.35 } = {}) {
    for (const l of this.wrap(text, w, size, bold)) { this.ensure(size * gap); this.text(l, x, this.y - size, { size, bold, color }); this.y -= size * gap; }
  }
  newPage(storeCode = null) { this.page = this.doc.addPage(A4); this.y = A4[1] - M; if (storeCode) this.pageStore.set(this.page, storeCode); this.drawDraftMark(); return this.page; }
  ensure(h, storeCode) { if (!this.page || this.y - h < M + 24) this.newPage(storeCode ?? this.curStore); }
  rect(x, y, w, h, color, page = this.page) { page.drawRectangle({ x, y, width: w, height: h, color: rgb(...color) }); }
  line(x1, y1, x2, y2, color = [0.8, 0.8, 0.82], t = 0.6) { this.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: rgb(...color) }); }
  drawDraftMark() {
    if (!this.meta.isDraft) return;
    this.rect(0, A4[1] - 20, A4[0], 20, [1, 0.93, 0.93]);
    this.text('ฉบับร่าง / หลักฐานไม่ครบ — ห้ามใช้เป็นยอดยืนยันแล้ว', M, A4[1] - 14, { size: 9, bold: true, color: RED });
  }
  heading(t, size = 15) { this.ensure(size * 2.2); this.text(t, M, this.y - size, { size, bold: true }); this.y -= size * 1.7; }
  kv(pairs, cols = 2) {
    const colW = (A4[0] - 2 * M) / cols; const size = 9.5;
    for (let i = 0; i < pairs.length; i += cols) {
      this.ensure(30);
      let maxH = 0;
      for (let c = 0; c < cols && i + c < pairs.length; c++) {
        const [k, v] = pairs[i + c]; const x = M + c * colW;
        this.text(k, x, this.y - 8, { size: 7.5, color: GREY });
        const lines = this.wrap(v ?? '-', colW - 10, size, true);
        lines.forEach((l, j) => this.text(l, x, this.y - 20 - j * 12, { size, bold: true }));
        maxH = Math.max(maxH, 14 + lines.length * 12);
      }
      this.y -= maxH + 4;
    }
  }
  /** ตารางหลายหน้า: หัวตารางซ้ำทุกหน้า */
  table(cols, rows, { size = 8 } = {}) {
    const totalW = A4[0] - 2 * M; const ws = cols.map(c => c.w * totalW);
    const header = () => {
      this.ensure(40); const h = 16; this.rect(M, this.y - h, totalW, h, LIGHT);
      let x = M; cols.forEach((c, i) => { this.text(c.t, x + 3, this.y - 11, { size: size - 0.5, bold: true, color: GREY }); x += ws[i]; });
      this.y -= h;
    };
    header();
    for (const r of rows) {
      const cells = r.map((v, i) => this.wrap(v ?? '', ws[i] - 6, size, false));
      const h = Math.max(...cells.map(c => c.length)) * (size + 3) + 5;
      if (this.y - h < M + 24) { this.newPage(this.curStore); header(); }
      let x = M; cells.forEach((lines, i) => { lines.forEach((l, j) => this.text(l, x + 3, this.y - size - 2 - j * (size + 3), { size, color: (r.colors || [])[i] || DARK })); x += ws[i]; });
      this.y -= h; this.line(M, this.y, M + totalW, this.y);
    }
    this.y -= 8;
  }
  async image(blob, { maxH = 520, caption = '' } = {}) {
    const bmp = await loadBitmap(blob);
    const maxSide = 2000; const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * sc), Math.round(bmp.height * sc)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const jpg = await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 })).arrayBuffer();
    const img = await this.doc.embedJpg(jpg);
    const maxW = A4[0] - 2 * M; const k = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * k, h = img.height * k;
    this.ensure(h + (caption ? 16 : 6));
    this.page.drawImage(img, { x: M + (maxW - w) / 2, y: this.y - h, width: w, height: h });
    this.y -= h + 4;
    if (caption) { this.text(caption, M, this.y - 9, { size: 8, color: GREY }); this.y -= 14; }
  }
  footer(code, version, created) {
    const pages = this.doc.getPages(); const n = pages.length;
    pages.forEach((p, i) => {
      const sc = this.pageStore.get(p);
      const t = `รายงาน ${code} · เวอร์ชัน ${version} · สร้าง ${fmtDateTime(created)}${sc ? ' · ร้าน ' + sc : ''}`;
      this.text(t, M, 18, { size: 7.5, color: GREY, page: p });
      const pn = `หน้า ${i + 1}/${n}`; this.text(pn, A4[0] - M - this.width(pn, 7.5), 18, { size: 7.5, color: GREY, page: p });
    });
  }
}

const DELIV = { allocated: 'จัดให้ร้าน', delivered: 'ส่งจริง', returned: 'ไม่ได้ส่ง/คืน' };

export async function buildPdf(snap, { reportCode, version, createdAt = nowIso(), createdBy = '' }) {
  const doc = await PDFDocument.create(); doc.registerFontkit(window.fontkit);
  const fb = await fonts();
  const fr = await doc.embedFont(fb.r, { subset: false }); const fbold = await doc.embedFont(fb.b, { subset: false });
  const isDraft = !snap.complete || snap.stores.some(s => s.bill && !s.bill.confirmed);
  const W = new Writer(doc, fr, fbold, { isDraft });
  doc.setTitle(`รายงานส่งซิม ${snap.round.code}`); doc.setCreator('SIM Evidence (demo)'); doc.setProducer('pdf-lib');

  // 1) ใบเบิกต้นฉบับครบทุกหน้า (อยู่ต้นไฟล์เสมอ)
  for (const fid of snap.requisition.fileIds) {
    const f = await db.get('files', fid);
    if (f.mime === 'application/pdf') {
      const src = await PDFDocument.load(await f.blob.arrayBuffer(), { ignoreEncryption: true });
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const p of pages) { doc.addPage(p); W.page = p; W.drawDraftMark(); }
    } else {
      W.newPage(); W.heading('ใบเบิกสินค้า (ต้นฉบับ)', 12); await W.image(f.blob, { maxH: A4[1] - 2 * M - 50, caption: `ไฟล์: ${f.name}` });
    }
  }
  if (!snap.requisition.fileIds.length) { W.newPage(); W.heading('ใบเบิกสินค้า'); W.para('ไม่มีไฟล์ใบเบิกในรอบงานนี้', { color: RED, bold: true }); }

  // 2) สรุปรอบงาน
  W.newPage(); W.curStore = null;
  W.text('รายงานหลักฐานการส่งซิมให้ร้านค้า', M, W.y - 18, { size: 18, bold: true }); W.y -= 30;
  W.kv([['รหัสรอบงาน', snap.round.code], ['วันที่', fmtDate(snap.round.workDate)], ['ผู้รับผิดชอบ', snap.round.owner], ['ขอบเขต', snap.scope === 'round' ? 'ทั้งรอบงาน' : `เฉพาะร้าน ${snap.stores.map(s => s.code).join(', ')}`],
    ['รหัสรายงาน / เวอร์ชัน', `${reportCode} / v${version}`], ['สร้างเมื่อ / โดย', `${fmtDateTime(createdAt)} / ${createdBy || '-'}`], ['สถานะรายงาน', isDraft ? 'ฉบับร่าง / หลักฐานไม่ครบ' : 'หลักฐานครบ'], ['สถานะรอบงาน', snap.round.status === 'closed' ? `ปิดแล้ว ${fmtDateTime(snap.round.closedAt)}` : 'ยังไม่ปิด']]);
  if (snap.requisition.lines.length) {
    W.heading('ยอดเบิกที่กรอกด้วยมือ', 11);
    W.para('หมายเหตุ: ยอดนี้กรอกด้วยมือจากใบเบิก ระบบยังไม่ได้กระทบยอดกับไฟล์ใบเบิกอัตโนมัติ', { size: 8, color: GREY });
    const allocBy = {}; for (const s of snap.stores) for (const x of s.sims) allocBy[x.partNo || '-'] = (allocBy[x.partNo || '-'] || 0) + 1;
    W.table([{ t: 'สินค้า', w: 0.4 }, { t: 'Part code', w: 0.2 }, { t: 'จำนวนเบิก', w: 0.2 }, { t: 'ซิมที่จัดให้ร้านในรายงานนี้', w: 0.2 }],
      snap.requisition.lines.map(l => [l.productName, l.partCode, l.qtyRequisition ?? 'ไม่มีข้อมูล', l.partCode ? String(allocBy[l.partCode] || 0) : '-']));
  }
  W.heading('สรุปรายร้าน', 11);
  W.table([{ t: '#', w: 0.05 }, { t: 'ร้าน', w: 0.25 }, { t: 'สถานะ', w: 0.18 }, { t: 'เตรียม', w: 0.08 }, { t: 'ส่งจริง', w: 0.08 }, { t: 'ตามบิล*', w: 0.08 }, { t: 'ต่าง', w: 0.07 }, { t: 'ยอดเงินตามบิล*', w: 0.11 }, { t: 'ข้อยกเว้น', w: 0.10 }],
    snap.stores.map(s => {
      const c = s.bill?.confirmed; const r = [String(s.seq), `${s.code} ${s.name}`, s.statusText, String(s.preparedCount), s.deliveredCount ?? '-', c ? String(s.bill.simQty) : 'ยังไม่ยืนยัน', c ? String(s.bill.simQty - s.preparedCount) : '-', c ? fmtSatang(s.bill.lineAmount) : '-', String(s.exceptions.length)];
      r.colors = [null, null, s.status === 'needs_fix' ? RED : null, null, null, c ? null : GREY, c && s.bill.simQty !== s.preparedCount ? RED : null, null, s.exceptions.length ? RED : null]; return r;
    }));
  W.para('* นับเฉพาะบิลที่ผู้ใช้ยืนยันแล้ว — บิลฉบับร่างไม่รวมเป็นยอดยืนยัน · ยอดเงินคือจำนวนเงินที่ระบุในบิล ไม่ใช่ยืนยันว่ารับเงินแล้ว', { size: 7.5, color: GREY });
  const missing = snap.stores.filter(s => s.status !== 'submitted' && s.status !== 'other').flatMap(s => s.checks.filter(c => !c.ok).map(c => `${s.code}: ${c.label}`));
  const exAll = snap.stores.flatMap(s => s.exceptions.map(e => `${s.code}: ${e.text}${e.reason ? ' — เหตุผล: ' + e.reason : ' — ยังไม่ระบุเหตุผล'}`));
  if (missing.length) { W.heading('รายการที่ยังขาด', 11); W.para(missing.map(m => '• ' + m).join('\n'), { size: 8.5, color: RED }); }
  if (exAll.length) { W.heading('ข้อยกเว้น', 11); W.para(exAll.map(m => '• ' + m).join('\n'), { size: 8.5 }); }

  // 3) หลักฐานแต่ละร้าน
  for (const s of snap.stores) {
    W.curStore = s.code; W.newPage(s.code);
    W.rect(M, W.y - 30, A4[0] - 2 * M, 30, RED);
    W.text(`ร้าน ${s.code} · ${s.name}`, M + 8, W.y - 20, { size: 13, bold: true, color: [1, 1, 1] }); W.y -= 40;
    W.kv([['สถานะ', s.statusText], ['ลำดับ', String(s.seq)], ['จำนวนจัดให้ร้าน (เตรียม)', String(s.preparedCount)], ['ส่งจริง (เลือกตาม S/N)', s.deliveredCount == null ? 'ยังไม่ยืนยัน' : String(s.deliveredCount)],
      ['จำนวนตามบิล', s.bill?.confirmed ? `${s.bill.simQty} (ขาย ${s.bill.paidQty} / แถม ${s.bill.freeQty})` : (s.bill ? 'บิลยังไม่ยืนยัน' : 'ไม่มีบิล')], ['ส่วนต่าง บิล − เตรียม', s.bill?.confirmed ? String(s.bill.simQty - s.preparedCount) : '-'],
      ['ยอดเงินตามบิล (รวมรายการ)', s.bill?.confirmed ? fmtSatang(s.bill.lineAmount) + ' บาท' : '-'], ['ยอดรับเงินทั้งสิ้นตามบิล', s.bill?.confirmed && s.bill.received != null ? fmtSatang(s.bill.received) + ' บาท' : '-'],
      ['ลายเซ็นผู้รับ', s.bill?.signatureText || '-'], ['ส่งหลักฐานเมื่อ', s.submittedAt ? `${fmtDateTime(s.submittedAt)} โดย ${s.submittedBy}` : 'ยังไม่ส่ง']]);
    if (s.outcome && s.outcome !== 'delivered') W.para(`ผลการเข้าร้าน: ${OUTCOME_TEXT[s.outcome]} — ${s.outcomeReason || ''}`, { bold: true, color: RED });
    if (s.exceptions.length) { W.heading('ข้อยกเว้น', 10); W.para(s.exceptions.map(e => `• ${e.text}${e.reason ? ' — เหตุผล: ' + e.reason : ' — ยังไม่ระบุเหตุผล'}`).join('\n'), { size: 8.5 }); }
    if (s.review) W.para(`ส่วนกลาง: ${REVIEW_TEXT[s.review.status] || s.review.status} โดย ${s.review.by} ${fmtDateTime(s.review.at)} ${s.review.note || ''}`, { size: 8.5, color: GREY });
    if (s.bill) {
      W.heading('รายการตามบิล', 10);
      const rows = [];
      for (const r of TEMPLATE.rows) {
        const row = s.bill.rows[r.key]; if (!row) continue;
        const show = c => c.state === 'value' ? c.value : (STATE_TEXT[c.state] || 'ยังไม่ตรวจ');
        if (row.qty.state === 'blank' && row.amount.state === 'blank' && !row.item.type) continue;
        rows.push([r.label, ITEM_TYPES.find(t => t[0] === row.item.type)?.[1] || '-', show(row.qty), show(row.price), show(row.amount), `${row.qty.read || '-'} / ${row.amount.read || '-'}`]);
      }
      for (const t of TEMPLATE.totals) { const c = s.bill.totals[t.key]; if (c && c.state !== 'blank') rows.push([t.label, '', '', '', c.state === 'value' ? c.value : (STATE_TEXT[c.state] || 'ยังไม่ตรวจ'), c.read || '-']); }
      W.table([{ t: 'แถวในบิล', w: 0.18 }, { t: 'ประเภท', w: 0.16 }, { t: 'จำนวน', w: 0.12 }, { t: 'ราคา', w: 0.12 }, { t: 'เงินรวม', w: 0.16 }, { t: 'ค่าที่ระบบอ่านครั้งแรก (จำนวน/เงิน)', w: 0.26 }], rows);
      if (s.bill.checks.length) W.para('ผลตรวจความสอดคล้อง: ' + s.bill.checks.map(c => c.text).join(' / '), { size: 8.5, color: RED });
      if (!s.bill.confirmed) W.para('บิลนี้ยังเป็นฉบับร่าง — ตัวเลขยังไม่ถูกนับเป็นยอดยืนยัน', { size: 9, bold: true, color: RED });
    }
    W.heading(`รายการซิม (${s.sims.length})`, 10);
    W.table([{ t: '#', w: 0.05 }, { t: 'S/N (Barcode)', w: 0.27 }, { t: 'เบอร์', w: 0.13 }, { t: 'Part no.', w: 0.12 }, { t: 'ผลตรวจ', w: 0.17 }, { t: 'ยืนยัน', w: 0.08 }, { t: 'ส่ง', w: 0.1 }, { t: 'ซ้ำ', w: 0.08 }],
      s.sims.map((x, i) => { const r = [String(i + 1), x.serial || '-', x.msisdn || '-', x.partNo || '-', CHECK_TEXT[x.check] || '-', x.confirmed ? '✓' : 'ยัง', DELIV[x.delivery] || '-', x.dupNote || '-']; r.colors = [null, null, null, null, x.check === 'mismatch' ? RED : null, x.confirmed ? null : RED, null, x.dupNote ? RED : null]; return r; }));
    W.para(`ความสัมพันธ์ Barcode กับ S/N ตามกฎธุรกิจ: ${RELATION_TEXT}`, { size: 7.5, color: GREY });
    for (const id of s.images.barcode) { const f = await db.get('files', id); await W.image(f.blob, { maxH: 560, caption: `ภาพ Barcode · ${f.timeText || ''}` }); }
    for (const id of s.images.bill) { const f = await db.get('files', id); await W.image(f.blob, { maxH: 600, caption: `ภาพบิล · ${f.timeText || ''} · ลายเซ็น: ${s.bill?.signatureText || '-'}` }); }
    for (const id of s.images.field) { const f = await db.get('files', id); await W.image(f.blob, { maxH: 380, caption: `รูปลงพื้นที่ · ${f.timeText || ''}` }); }
    if (s.notes) { W.heading('หมายเหตุ', 10); W.para(s.notes, { size: 9 }); }
  }
  W.footer(reportCode, version, createdAt);
  return { bytes: await doc.save(), isDraft };
}

/** สร้างรายงานเวอร์ชันใหม่ เก็บไว้ (ไม่เขียนทับฉบับเก่า) */
export async function createReport(snap, user) {
  const existing = (await db.byIndex('reports', 'roundId', snap.round.id)).filter(r => r.scope === snap.scope && (r.rsKey || '') === (snap.scope === 'store' ? snap.stores.map(s => s.rsId).join(',') : ''));
  const version = existing.length + 1;
  const reportCode = `RPT-${snap.round.code}${snap.scope === 'store' ? '-' + snap.stores.map(s => s.code).join('_') : ''}`;
  const createdAt = nowIso();
  const { bytes, isDraft } = await buildPdf(snap, { reportCode, version, createdAt, createdBy: user.name });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const f = await db.insert('files', { roundId: snap.round.id, rsId: null, kind: 'report', role: 'original', blob, mime: 'application/pdf', size: blob.size, name: `${reportCode}-v${version}${isDraft ? '-ร่าง' : ''}.pdf`, savedAt: createdAt });
  const rep = await db.insert('reports', { roundId: snap.round.id, scope: snap.scope, rsKey: snap.scope === 'store' ? snap.stores.map(s => s.rsId).join(',') : '', code: reportCode, version, isDraft, createdAt, createdBy: user.name, snapshotHash: snap.hash, fileId: f.id });
  await db.audit({ entity: 'report', entityId: rep.id, roundId: snap.round.id, action: 'create', after: { code: reportCode, version, isDraft } });
  return { report: rep, file: f };
}
