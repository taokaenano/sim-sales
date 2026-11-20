// ===== สร้างรายงาน PDF (pdf-lib + ฟอนต์ IBM Plex Sans Thai ฝังในไฟล์) =====
// วาดข้อความไทยแบบจัดตำแหน่งสระ/วรรณยุกต์เองตามข้อมูล GPOS ของฟอนต์ (pdf-lib วาดเองไม่ถูก)
import * as db from './db.js';
import { fmtDateTime, nowIso } from './util.js';
import { loadBitmap } from './image.js';

const { PDFDocument, PDFHexString, rgb, pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setTextMatrix, showText, setFillingRgbColor, degrees } = window.PDFLib;
const A4 = [595.28, 841.89]; const M = 36;
const RED = [0.784, 0.063, 0.18], GREY = [0.42, 0.42, 0.45], DARK = [0.1, 0.1, 0.12];

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
 * รายงาน PDF: รูปหน้าแรก (ครั้งเดียว) → ร้านตามลำดับ: รูปบาร์โค้ด → รูปบิล → รูปหน้าร้านพร้อมลายน้ำ → ร้านถัดไป
 * หน้าละ 1 รูป มีป้ายร้านเล็ก ๆ ที่หัวหน้า
 */
export async function buildPdf(snap, { createdAt = nowIso() } = {}) {
  const doc = await PDFDocument.create(); doc.registerFontkit(window.fontkit);
  const fb = await fonts();
  const fr = await doc.embedFont(fb.r, { subset: false }); const fbold = await doc.embedFont(fb.b, { subset: false });
  const W = new Writer(doc, fr, fbold, { isDraft: false });
  doc.setTitle(`หลักฐานส่งซิม ${snap.round.code}`); doc.setCreator('SIM Sales'); doc.setProducer('pdf-lib');
  const avail = () => W.y - (M + 24) - 12;

  // 1) รูปหน้าแรก — รอบเก่าที่เป็น PDF ใช้หน้าแรกของไฟล์
  if (snap.coverId) {
    const f = await db.get('files', snap.coverId);
    if (f.mime === 'application/pdf') {
      const src = await PDFDocument.load(await f.blob.arrayBuffer(), { ignoreEncryption: true });
      const [p] = await doc.copyPages(src, [0]); doc.addPage(p);
    } else { W.newPage(); await W.image(f.blob, { maxH: avail(), maxSide: 2800, quality: 0.9 }); }
  }

  // 2) ร้านตามลำดับในรอบงาน
  for (const s of snap.stores) {
    W.curStore = `ร้าน ${s.code} · ${s.name}`;
    for (const [kind, ids] of [['บาร์โค้ด', s.images.barcode], ['บิล / สลิป', s.images.bill], ['รูปหน้าร้าน', s.images.field]]) {
      for (const id of ids) {
        const f = await db.get('files', id);
        W.newPage(W.curStore);
        W.text(`${W.curStore} · ${kind}`, M, W.y - 10, { size: 9, bold: true, color: RED }); W.y -= 18;
        await W.image(f.blob, { maxH: avail(), maxSide: 3000, quality: 0.9 });
      }
    }
  }
  if (!doc.getPageCount()) { W.newPage(); W.para('ยังไม่มีเอกสาร', { color: GREY }); }
  W.footer(createdAt, false);
  return { bytes: await doc.save() };
}

/** สร้างไฟล์ PDF แล้วเก็บไว้ (ตัวอย่างและไฟล์ดาวน์โหลดเป็นไฟล์เดียวกัน) */
export async function createReport(snap, user) {
  const createdAt = nowIso();
  const { bytes } = await buildPdf(snap, { createdAt });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const name = `${snap.round.code}.pdf`;
  const f = await db.insert('files', { roundId: snap.round.id, rsId: null, kind: 'report', role: 'original', blob, mime: 'application/pdf', size: blob.size, name, savedAt: createdAt, createdBy: user.name });
  await db.audit({ entity: 'report', entityId: f.id, roundId: snap.round.id, action: 'create', after: { name } });
  return { file: f };
}
