// ===== สร้างรายงาน PDF (pdf-lib + ฟอนต์ IBM Plex Sans Thai ฝังในไฟล์) =====
// วาดข้อความไทยแบบจัดตำแหน่งสระ/วรรณยุกต์เองตามข้อมูล GPOS ของฟอนต์ (pdf-lib วาดเองไม่ถูก)
import * as db from './db.js';
import { fmtDate, fmtDateTime, nowIso } from './util.js';
import { loadBitmap } from './image.js';

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
  async image(blob, { maxH = 520, caption = '', maxSide = 2000, quality = 0.88 } = {}) {
    const bmp = await loadBitmap(blob);
    const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * sc), Math.round(bmp.height * sc)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    const jpg = await (await c.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer();
    const img = await this.doc.embedJpg(jpg);
    const maxW = A4[0] - 2 * M; const k = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * k, h = img.height * k;
    this.ensure(h + (caption ? 16 : 6));
    this.page.drawImage(img, { x: M + (maxW - w) / 2, y: this.y - h, width: w, height: h });
    this.y -= h + 4;
    if (caption) { this.text(caption, M, this.y - 9, { size: 8, color: GREY }); this.y -= 14; }
  }
  footer(created, draft) {
    const pages = this.doc.getPages(); const n = pages.length;
    pages.forEach((p, i) => {
      const sc = this.pageStore.get(p);
      const t = `${sc ? sc + ' · ' : ''}${draft ? 'ฉบับร่าง · ' : ''}สร้าง ${fmtDateTime(created)}`;
      this.text(t, M, 18, { size: 7.5, color: GREY, page: p });
      const pn = `หน้า ${i + 1}/${n}`; this.text(pn, A4[0] - M - this.width(pn, 7.5), 18, { size: 7.5, color: GREY, page: p });
    });
  }
}


/**
 * PDF V2 — ค่าเริ่มต้นมีเฉพาะภาพหลักฐาน:
 *   ใบเบิกต้นฉบับครบทุกหน้า → [หน้าสรุป ถ้าเลือก] → ร้านที่ 1: Barcode → บิล → รูปลงพื้นที่ → ร้านถัดไป
 * ไม่สร้างตาราง Barcode/OCR/ยอดเงิน และไม่เพิ่มหน้าปกหรือหน้าแบ่งร้าน
 */
export async function buildPdf(snap, { includeSummary = false, createdAt = nowIso(), createdBy = '' } = {}) {
  const doc = await PDFDocument.create(); doc.registerFontkit(window.fontkit);
  const fb = await fonts();
  const fr = await doc.embedFont(fb.r, { subset: false }); const fbold = await doc.embedFont(fb.b, { subset: false });
  const isDraft = !snap.complete;
  const W = new Writer(doc, fr, fbold, { isDraft });
  doc.setTitle(`หลักฐานส่งซิม ${snap.round.code}`); doc.setCreator('SIM Sales V2'); doc.setProducer('pdf-lib');

  // 1) ใบเบิกต้นฉบับครบทุกหน้า
  for (const fid of snap.requisition.fileIds) {
    const f = await db.get('files', fid);
    if (f.mime === 'application/pdf') {
      const src = await PDFDocument.load(await f.blob.arrayBuffer(), { ignoreEncryption: true });
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const p of pages) { doc.addPage(p); W.page = p; W.drawDraftMark(); }
    } else {
      W.newPage(); await W.image(f.blob, { maxH: W.y - (M + 24) - 12, maxSide: 2800, quality: 0.9 });
    }
  }

  // 2) หน้าสรุป (เฉพาะเมื่อเลือก) — ใช้เฉพาะข้อมูลที่มีจริง
  if (includeSummary) {
    W.newPage(); W.curStore = null;
    W.text('สรุปข้อมูล', M, W.y - 18, { size: 18, bold: true }); W.y -= 30;
    W.kv([['รอบงาน', snap.round.code], ['วันที่', fmtDate(snap.round.workDate)], ['ผู้รับผิดชอบ', snap.round.owner], ['สร้างเมื่อ', `${fmtDateTime(createdAt)}${createdBy ? ' · ' + createdBy : ''}`]], 2);
    W.table([{ t: '#', w: 0.06 }, { t: 'ร้าน', w: 0.32 }, { t: 'สถานะ', w: 0.18 }, { t: 'ซิม', w: 0.08 }, { t: 'Barcode', w: 0.09 }, { t: 'บิล', w: 0.07 }, { t: 'ติ๊กยืนยัน', w: 0.11 }, { t: 'รูป', w: 0.09 }],
      snap.stores.map(s => [String(s.seq), `${s.code} ${s.name}`, s.statusText, String(s.simCount), String(s.counts.barcode), String(s.counts.bill), s.billChecked ? '✓' : '-', String(s.counts.field)]));
    const miss = [...(snap.missingRequisition ? ['ใบเบิก'] : []), ...snap.stores.filter(s => s.missing.length).map(s => `${s.code}: ${s.missing.join(', ')}`)];
    if (miss.length) { W.heading('ยังขาด', 11); W.para(miss.map(m => '• ' + m).join('\n'), { size: 9 }); }
  }

  // 3) หลักฐานรายร้าน ตามลำดับในรอบงาน
  for (const s of snap.stores) {
    W.curStore = `ร้าน ${s.code} · ${s.name}`;
    const label = () => { W.text(W.curStore, M, W.y - 10, { size: 9, bold: true, color: RED }); W.y -= 18; };
    const seq = [...s.images.barcode.map(id => ['barcode', id]), ...s.images.bill.map(id => ['bill', id]), ...s.images.field.map(id => ['field', id])];
    const avail = () => W.y - (M + 24) - 12; // พื้นที่ที่เหลือจริงบนหน้า (หักแถบฉบับร่าง/หัวร้าน/ท้ายหน้าแล้ว)
    let fieldOnPage = 0, half = 0;
    for (const [kind, id] of seq) {
      const f = await db.get('files', id);
      if (kind === 'field') {
        // รูปลงพื้นที่: ไม่เกิน 2 รูปต่อหน้า
        if (fieldOnPage === 0 || fieldOnPage >= 2) { W.newPage(W.curStore); label(); fieldOnPage = 0; half = avail() / 2 - 6; }
        await W.image(f.blob, { maxH: half, maxSide: 2000, quality: 0.88 }); fieldOnPage++;
      } else {
        // Barcode/บิล: หน้าละ 1 ภาพ เต็มหน้า เพื่อให้อ่านรหัสและตัวเลขได้
        W.newPage(W.curStore); label(); fieldOnPage = 0;
        await W.image(f.blob, { maxH: avail(), maxSide: 3000, quality: 0.92 });
      }
    }
    if (!seq.length) { W.newPage(W.curStore); label(); W.para('ยังไม่มีภาพหลักฐานของร้านนี้', { color: GREY }); }
  }
  if (!doc.getPageCount()) { W.newPage(); W.para('ยังไม่มีเอกสาร', { color: GREY }); }
  W.footer(createdAt, isDraft);
  return { bytes: await doc.save(), isDraft };
}

/** สร้างไฟล์ PDF แล้วเก็บไว้ (Preview และดาวน์โหลดใช้ไฟล์เดียวกันนี้) */
export async function createReport(snap, user, { includeSummary = false } = {}) {
  const createdAt = nowIso();
  const { bytes, isDraft } = await buildPdf(snap, { includeSummary, createdAt, createdBy: user.name });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const scope = snap.scope === 'store' ? '-' + snap.stores.map(s => s.code).join('_') : '';
  const name = `${snap.round.code}${scope}${isDraft ? '-ร่าง' : ''}${includeSummary ? '-สรุป' : ''}.pdf`;
  const f = await db.insert('files', { roundId: snap.round.id, rsId: null, kind: 'report', role: 'original', blob, mime: 'application/pdf', size: blob.size, name, savedAt: createdAt, includeSummary, isDraft });
  await db.audit({ entity: 'report', entityId: f.id, roundId: snap.round.id, action: 'create', after: { name, isDraft, includeSummary } });
  return { file: f };
}
