// ===== หน้าร้าน: Barcode / บิล / รูปลงพื้นที่ / ตรวจทานและส่ง =====
import * as db from './db.js';
import { esc, fmtDateTime, nowIso, uid } from './util.js';
import { $, $$, toast, guard, modal, confirmBox, blobSrc, pickFiles, badgeFor, zoomImage, nav } from './ui.js';
import { checkImageFile, saveOriginal, makeDerived, loadBitmap, timeSourceText } from './image.js';
import { evaluate, loadStoreData, signatureText, OUTCOME_TEXT, REVIEW_TEXT } from './logic.js';
import { decodeImage, readPrinted, compareBarcodeVsPrinted, referenceCrop, CHECK_TEXT, RELATION_TEXT } from './barcode.js';
import { warpBill, readBill, defaultQuad, cellBlob, billSummary, TEMPLATE as T, ITEM_TYPES, STATE_TEXT, SIG_TEXT } from './bill.js';

let USER;
const TABS = [['barcode', 'Barcode'], ['bill', 'บิล'], ['photos', 'รูปลงพื้นที่'], ['review', 'ตรวจทาน / ส่ง']];

export async function renderStore(app, rsId, tab, user) {
  USER = user;
  const rs = await db.get('roundStores', rsId); if (!rs) throw new Error('ไม่พบร้านในรอบงาน');
  const round = await db.get('rounds', rs.roundId);
  const data = await loadStoreData(rs); const ev = evaluate(rs, data);
  const locked = !!rs.submittedAt && rs.review?.status !== 'returned' || round.status === 'closed' || (rs.outcome && rs.outcome !== 'delivered');
  const ctx = { app, rs, round, data, ev, locked, tab, reload: () => renderStore(app, rsId, tab, user) };
  const back = tab === 'barcode' ? 'prep' : 'field';
  app.innerHTML = `<div class="row between" style="margin-bottom:8px"><a class="btn sm" href="#/r/${round.id}/${back}">← ${esc(round.code)}</a><span class="muted small">ลำดับ ${rs.seq}</span></div>
    <div class="storebar"><div><div class="code mono">${esc(rs.storeCodeSnap)}</div><div class="name">${esc(rs.storeNameSnap)}</div></div><span class="st">${esc(ev.statusText)}</span></div>
    <div class="tabs">${TABS.map(([k, t]) => `<a href="#/s/${rsId}/${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>
    ${locked ? `<div class="card" style="border-color:var(--g3)"><b>ร้านนี้${rs.outcome && rs.outcome !== 'delivered' ? 'บันทึกผลว่าไม่ได้ส่ง' : round.status === 'closed' ? 'อยู่ในรอบงานที่ปิดแล้ว' : 'ส่งหลักฐานแล้ว'}</b> — ดูได้อย่างเดียว${round.status !== 'closed' ? ' · แก้ไขได้ที่แท็บ "ตรวจทาน / ส่ง"' : ''}</div>` : ''}
    <div id="tab"></div>`;
  const el = $('#tab');
  if (tab === 'barcode') return barcodeTab(el, ctx);
  if (tab === 'bill') return billTab(el, ctx);
  if (tab === 'photos') return photosTab(el, ctx);
  return reviewTab(el, ctx);
}

/** หลังแก้ข้อมูลหลังยืนยัน: ยกเลิกสถานะยืนยันที่ได้รับผลกระทบ */
async function invalidatePrep(rs, why) {
  const cur = await db.get('roundStores', rs.id);
  if (cur.prep?.confirmedAt || cur.delivery?.confirmedAt || cur.prep?.checkedAgainstImage) {
    await db.update('roundStores', rs.id, cur.version, x => ({ ...x, prep: { checkedAgainstImage: false, confirmedAt: null, confirmedBy: null }, delivery: { selectionMode: null, confirmedAt: null, confirmedBy: null } }));
    await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: 'invalidate_prep', reason: why });
  }
}

// ======================= Barcode =======================
async function processBarcodeFile(f, ctx, onStep) {
  const { rs } = ctx;
  await db.update('files', f.id, null, x => ({ ...x, proc: { state: 'running', at: nowIso() } }));
  try {
    onStep('ถอด Barcode…', 0);
    const res = await decodeImage(f.blob, p => onStep('ถอด Barcode…', p * 0.5));
    const result = { found: res.found.length, added: 0, dupSame: 0, dupOther: [], failed: res.failed.map(x => x.quad), width: res.width, height: res.height, boxes: [] };
    let i = 0; const existing = await db.simsOfRs(rs.id); let order = existing.length;
    for (const b of res.found) {
      onStep(`อ่านเลขที่พิมพ์ ${++i}/${res.found.length}`, 0.5 + 0.5 * i / res.found.length);
      const dup = await db.findSimBySerial(rs.roundId, b.text);
      result.boxes.push({ text: b.text, quad: b.quad, dup: dup ? (dup.rsId === rs.id ? 'same' : 'other') : null });
      if (dup) { if (dup.rsId === rs.id) result.dupSame++; else { const o = await db.get('roundStores', dup.rsId); result.dupOther.push({ serial: b.text, store: o?.storeCodeSnap }); } continue; }
      let pr = { msisdn: null, printedSn: null, partNo: null, msisdnRaw: '', printedRaw: '' };
      try { pr = await readPrinted(res.bitmap, b.quad); } catch (e) { console.warn('ocr', e); pr.ocrError = String(e.message || e); }
      const crop = await referenceCrop(res.bitmap, b.quad);
      await db.insert('sims', {
        roundId: rs.roundId, rsId: rs.id, order: order++, entry: 'scan', sourceFileId: f.id, quad: b.quad, format: b.format,
        barcodeRaw: b.text, ocrRaw: { above: pr.msisdnRaw, below: pr.printedRaw, error: pr.ocrError || null }, printedSn: pr.printedSn,
        serial: b.text, msisdn: pr.msisdn, partNo: pr.partNo, check: compareBarcodeVsPrinted(b.text, pr.printedSn),
        relation: RELATION_TEXT, cropBlob: crop, edited: false, confirmed: false, delivery: 'allocated', giveType: null, note: '',
      });
      result.added++;
    }
    res.bitmap.close?.();
    await db.update('files', f.id, null, x => ({ ...x, proc: { state: 'done', at: nowIso(), result } }));
    if (result.added) await invalidatePrep(rs, 'เพิ่มรายการซิมจากภาพ');
    return result;
  } catch (e) {
    await db.update('files', f.id, null, x => ({ ...x, proc: { state: 'error', at: nowIso(), error: String(e.message || e) } }));
    throw e;
  }
}

async function addImages(ctx, kind, capture) {
  const files = await pickFiles({ capture, multiple: true });
  const saved = [];
  for (const file of files) {
    const err = checkImageFile(file); if (err) { toast(err, true); continue; }
    const r = await saveOriginal(file, { roundId: ctx.rs.roundId, rsId: ctx.rs.id, kind, captureSource: capture ? 'camera' : 'upload' });
    if (r.duplicate) { toast(`ภาพ ${file.name} เคยแนบกับร้านนี้แล้ว — ไม่เพิ่มซ้ำ`); continue; }
    await makeDerived(r.file, { storeCode: ctx.rs.storeCodeSnap, storeName: ctx.rs.storeNameSnap });
    saved.push(r.file);
  }
  if (saved.length) await db.audit({ entity: 'roundStore', entityId: ctx.rs.id, roundId: ctx.rs.roundId, action: `add_${kind}`, after: saved.map(f => f.name) });
  return saved;
}

function procBadge(f) {
  const p = f.proc || { state: 'none' };
  if (p.state === 'running') return '<span class="badge warn">กำลังประมวลผล</span>';
  if (p.state === 'error') return `<span class="badge bad">ประมวลผลไม่สำเร็จ</span>`;
  if (p.state === 'done') return `<span class="badge ok">ถอดได้ ${p.result.found}${p.result.failed.length ? ` · ถอดไม่ได้ ${p.result.failed.length} จุด` : ''}</span>`;
  return '<span class="badge">ยังไม่ประมวลผล</span>';
}

async function drawOverlay(canvas, f, sims) {
  const bmp = await loadBitmap(f.blob); const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  canvas.width = Math.round(bmp.width * sc); canvas.height = Math.round(bmp.height * sc);
  const g = canvas.getContext('2d'); g.drawImage(bmp, 0, 0, canvas.width, canvas.height); bmp.close?.();
  const lw = Math.max(2, canvas.width / 400); g.lineWidth = lw; g.font = `700 ${Math.max(14, canvas.width / 45)}px "IBM Plex Sans Thai"`;
  const poly = (q, color) => { g.strokeStyle = color; g.beginPath(); g.moveTo(q.topLeft.x * sc, q.topLeft.y * sc); g.lineTo(q.topRight.x * sc, q.topRight.y * sc); g.lineTo(q.bottomRight.x * sc, q.bottomRight.y * sc); g.lineTo(q.bottomLeft.x * sc, q.bottomLeft.y * sc); g.closePath(); g.stroke(); };
  sims.filter(s => s.sourceFileId === f.id && s.quad).forEach(s => {
    poly(s.quad, s.confirmed ? '#1d7a46' : '#c8102e');
    const n = String(s._n); const x = s.quad.topLeft.x * sc, y = s.quad.topLeft.y * sc; const w = g.measureText(n).width + 8;
    g.fillStyle = s.confirmed ? '#1d7a46' : '#c8102e'; g.fillRect(x - 2, y - 22, w, 22); g.fillStyle = '#fff'; g.fillText(n, x + 2, y - 5);
  });
  (f.proc?.result?.failed || []).forEach(q => { g.setLineDash([8, 6]); poly(q, '#ff9800'); g.setLineDash([]); g.fillStyle = '#ff9800'; g.fillText('?', q.topLeft.x * sc, q.topLeft.y * sc - 4); });
  (f.proc?.result?.boxes || []).filter(b => b.dup === 'other').forEach(b => { poly(b.quad, '#6a1b9a'); });
}

async function barcodeTab(el, ctx) {
  const { rs, data, locked } = ctx;
  const files = data.files.filter(f => f.kind === 'barcode' && f.role === 'original');
  const sims = data.sims; sims.forEach((s, i) => s._n = i + 1);
  const all = await db.simsOfRound(rs.roundId);
  const dupMap = new Map(); for (const s of all) if (s.serial) dupMap.set(s.serial, (dupMap.get(s.serial) || 0) + 1);
  const msisdnMap = new Map(); for (const s of all) if (s.msisdn) msisdnMap.set(s.msisdn, (msisdnMap.get(s.msisdn) || 0) + 1);
  const confirmedN = sims.filter(s => s.confirmed).length;
  el.innerHTML = `
    ${locked ? '' : `<div class="btn-grid"><button class="btn primary" id="cam">ถ่ายภาพ Barcode</button><button class="btn" id="up">เลือกภาพ</button></div>`}
    <div id="progress" class="card hidden"><div id="ptext" class="small"></div><div class="prog"><i id="pbar"></i></div></div>
    <div class="card"><div class="row between"><h2 style="margin:0">ภาพ (${files.length})</h2></div>
      <div class="list" style="margin-top:8px">${files.map(f => `<div class="item" style="align-items:flex-start"><img src="${blobSrc(f.id, f.blob)}" style="width:64px;height:64px;object-fit:cover;border-radius:8px">
        <div class="grow"><div class="small">${esc(f.name)}</div><div class="statusline">${procBadge(f)}<span class="badge">บันทึกในเครื่องแล้ว</span></div>
        ${f.proc?.result ? `<div class="muted small">เพิ่มใหม่ ${f.proc.result.added} · ซ้ำในร้าน ${f.proc.result.dupSame}${f.proc.result.dupOther.length ? ` · <b style="color:var(--red)">ซ้ำร้านอื่น ${f.proc.result.dupOther.length}: ${esc([...new Set(f.proc.result.dupOther.map(d => d.store))].join(', '))}</b>` : ''}</div>` : ''}
        ${f.proc?.state === 'error' ? `<div class="small" style="color:var(--red)">${esc(f.proc.error)}</div>` : ''}</div>
        <div class="row" style="flex-direction:column;gap:4px"><button class="btn sm" data-view="${f.id}">ดูตำแหน่ง</button>${locked ? '' : `<button class="btn sm" data-proc="${f.id}">${f.proc?.state === 'done' ? 'ประมวลผลใหม่' : 'ประมวลผล'}</button><button class="btn sm ghost" data-rmf="${f.id}">ลบภาพ</button>`}</div></div>`).join('') || '<div class="muted">ยังไม่มีภาพ</div>'}</div>
      <div id="ov" class="hidden" style="margin-top:10px"><div class="imgwrap"><canvas id="ovc"></canvas></div><p class="muted small">กรอบแดง = ยังไม่ยืนยัน · เขียว = ยืนยันแล้ว · ส้มประ = คล้าย Barcode แต่ถอดไม่ได้ · ม่วง = ซ้ำกับร้านอื่น</p></div></div>
    <div class="card"><div class="row between"><h2 style="margin:0">รายการซิม (${sims.length})</h2><span class="badge ${confirmedN === sims.length && sims.length ? 'ok' : 'warn'}">ยืนยัน ${confirmedN}/${sims.length}</span></div>
      <div class="row" style="margin-top:8px"><label class="f" style="margin:0">จำนวนที่คาด (ไม่บังคับ)</label><input type="text" inputmode="numeric" id="exp" style="width:90px" value="${rs.expectedCount ?? ''}" ${locked ? 'disabled' : ''}>
      ${rs.expectedCount != null ? `<span class="small ${rs.expectedCount === sims.length ? '' : 'muted'}">อ่านได้ ${sims.length} / คาด ${rs.expectedCount}</span>` : ''}</div>
      <div class="statusline" style="margin-top:6px"><span class="badge info">ความสัมพันธ์ Barcode–S/N: ${RELATION_TEXT}</span></div>
      ${files.some(f => f.proc?.result?.failed?.length) ? '<p class="small" style="color:var(--warn);margin:6px 0 0">มีจุดที่คล้าย Barcode แต่ถอดไม่ได้ — ถ่ายใกล้ขึ้นหรือกรอกเอง</p>' : ''}
      <div class="list" style="margin-top:8px">${sims.map(s => { const dup = (dupMap.get(s.serial) || 0) > 1; const md = s.msisdn && (msisdnMap.get(s.msisdn) || 0) > 1; const warn = s.check === 'mismatch' || s.check === 'printed_unreadable'; return `<div class="item" style="flex-direction:column;align-items:stretch;${dup ? 'border-color:var(--red);background:var(--red-l)' : warn ? 'border-color:#f0b46a' : ''}">
        <div class="row between"><div class="row" style="gap:8px"><span class="badge ${s.confirmed ? 'ok' : 'warn'}">#${s._n}</span><span class="mono" style="font-size:15px;font-weight:600">${esc(s.serial || '—')}</span></div>${s.confirmed ? '<span class="badge ok">ยืนยันแล้ว</span>' : ''}</div>
        <div class="row small" style="gap:12px"><span>เบอร์ <b class="mono">${esc(s.msisdn || '—')}</b></span><span>Part <b class="mono">${esc(s.partNo || '—')}</b></span></div>
        <div class="statusline"><span class="badge ${s.check === 'match' ? 'ok' : warn ? 'warn' : ''}">${esc(CHECK_TEXT[s.check] || '')}</span>${dup ? '<span class="badge bad">S/N ซ้ำ</span>' : '<span class="badge">ไม่ซ้ำ</span>'}${md ? '<span class="badge warn">เบอร์ซ้ำ</span>' : ''}${s.entry === 'manual' ? '<span class="badge">กรอกมือ</span>' : ''}</div>
        ${s.edited ? `<div class="muted small">อ่านครั้งแรก: <span class="mono">${esc(s.barcodeRaw || '—')}</span></div>` : ''}${s.movedFrom ? `<div class="muted small">ย้ายมาจากร้าน ${esc(s.movedFrom)}</div>` : ''}
        ${s.cropBlob ? `<img class="crop" style="max-width:100%;max-height:120px" src="${blobSrc('c' + s.id, s.cropBlob)}" data-zoom="${s.id}">` : ''}
        ${locked ? '' : `<div class="row">${s.confirmed ? '' : `<button class="btn sm primary" data-cf="${s.id}">ยืนยัน</button>`}<button class="btn sm" data-ed="${s.id}">แก้</button><button class="btn sm" data-mv="${s.id}">ย้ายร้าน</button><button class="btn sm ghost" data-del="${s.id}">ลบ</button></div>`}</div>`; }).join('') || '<div class="muted">ยังไม่มีรายการ</div>'}</div>
      ${locked ? '' : `<div class="row" style="margin-top:10px"><button class="btn sm" id="addm">+ กรอกเอง</button><button class="btn sm" id="cfall" ${sims.length ? '' : 'disabled'}>ยืนยันทุกรายการที่ตรวจแล้ว</button></div>
      <label class="cb" style="margin-top:8px"><input type="checkbox" id="chk" ${rs.prep?.checkedAgainstImage ? 'checked' : ''}> ตรวจรายการเทียบกับภาพแล้ว (จำนวนและเลขตรงกับภาพ)</label>
      <button class="btn primary big" id="prepok" style="margin-top:8px">${rs.prep?.confirmedAt ? `เตรียมแล้ว ✓ (${fmtDateTime(rs.prep.confirmedAt)})` : 'ยืนยันการเตรียมร้านนี้'}</button>`}</div>`;

  const prog = (t, p) => { $('#progress').classList.remove('hidden'); $('#ptext').textContent = t; $('#pbar').style.width = Math.round(p * 100) + '%'; };
  const runFiles = async list => {
    for (const f of list) {
      try { const r = await processBarcodeFile(f, ctx, prog); if (r.dupOther.length) toast(`พบ S/N ซ้ำกับร้านอื่น ${r.dupOther.length} รายการ — ไม่ได้เพิ่ม`, true); }
      catch (e) { toast(`ประมวลผล ${f.name} ไม่สำเร็จ: ${e.message || e} — กด "ประมวลผล" เพื่อลองใหม่`, true); }
    }
    ctx.reload();
  };
  if (!locked) {
    $('#cam').onclick = guard(async () => runFiles(await addImages(ctx, 'barcode', true)));
    $('#up').onclick = guard(async () => runFiles(await addImages(ctx, 'barcode', false)));
    $$('[data-proc]').forEach(b => b.onclick = guard(async () => runFiles([files.find(f => f.id === b.dataset.proc)])));
    $$('[data-rmf]').forEach(b => b.onclick = guard(async () => {
      const f = files.find(x => x.id === b.dataset.rmf);
      const used = sims.filter(s => s.sourceFileId === f.id).length;
      if (used) throw new Error(`ภาพนี้มีรายการซิม ${used} รายการ — ลบรายการซิมเหล่านั้นก่อน`);
      const r = await confirmBox('ลบภาพนี้?', { danger: true, ok: 'ลบ', reason: true }); if (!r) return;
      for (const x of [f, ...(await db.derivedOf(f.id))]) await db.update('files', x.id, null, y => ({ ...y, deletedAt: nowIso(), deleteReason: r }));
      await db.audit({ entity: 'file', entityId: f.id, roundId: rs.roundId, action: 'delete', reason: r }); ctx.reload();
    }));
    $('#exp').onchange = guard(async e => { const v = e.target.value.trim(); const n = v === '' ? null : Number(v); if (v !== '' && !Number.isInteger(n)) throw new Error('จำนวนต้องเป็นจำนวนเต็ม'); const cur = await db.get('roundStores', rs.id); await db.update('roundStores', rs.id, cur.version, { expectedCount: n }); ctx.reload(); });
    $$('[data-cf]').forEach(b => b.onclick = guard(async () => { const s = sims.find(x => x.id === b.dataset.cf); await db.update('sims', s.id, s.version, { confirmed: true, confirmedBy: USER.name, confirmedAt: nowIso() }); ctx.reload(); }));
    $('#cfall').onclick = guard(async () => {
      const bad = sims.filter(s => !s.serial);
      if (bad.length) throw new Error(`มี ${bad.length} รายการที่ยังไม่มี S/N — แก้ก่อนยืนยัน`);
      if (!(await confirmBox(`ยืนยัน ${sims.filter(s => !s.confirmed).length} รายการว่าตรวจกับภาพแล้ว?`))) return;
      for (const s of sims.filter(s => !s.confirmed)) await db.update('sims', s.id, s.version, { confirmed: true, confirmedBy: USER.name, confirmedAt: nowIso() });
      ctx.reload();
    });
    $('#chk').onchange = guard(async e => { const cur = await db.get('roundStores', rs.id); await db.update('roundStores', rs.id, cur.version, x => ({ ...x, prep: { ...x.prep, checkedAgainstImage: e.target.checked, ...(e.target.checked ? {} : { confirmedAt: null, confirmedBy: null }) } })); ctx.reload(); });
    $('#prepok').onclick = guard(async () => {
      if (!sims.length) throw new Error('ยังไม่มีรายการซิม');
      if (sims.some(s => !s.confirmed)) throw new Error('ยังมีรายการที่ไม่ได้ยืนยัน');
      if (!rs.prep?.checkedAgainstImage) throw new Error('ติ๊ก "ตรวจรายการเทียบกับภาพแล้ว" ก่อน');
      const cur = await db.get('roundStores', rs.id);
      await db.update('roundStores', rs.id, cur.version, x => ({ ...x, prep: { ...x.prep, confirmedAt: nowIso(), confirmedBy: USER.name } }));
      await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: 'prep_confirm', after: { sims: sims.length } });
      toast('เตรียมร้านนี้แล้ว'); nav(`#/r/${rs.roundId}/prep`);
    });
    $('#addm').onclick = guard(() => simForm(ctx, null));
    $$('[data-ed]').forEach(b => b.onclick = guard(() => simForm(ctx, sims.find(s => s.id === b.dataset.ed))));
    $$('[data-del]').forEach(b => b.onclick = guard(async () => {
      const s = sims.find(x => x.id === b.dataset.del);
      const r = await confirmBox(`ลบรายการ ${s.serial || ''}?`, { danger: true, ok: 'ลบ', reason: true }); if (!r) return;
      await db.update('sims', s.id, s.version, { deletedAt: nowIso(), deletedBy: USER.name, deleteReason: r });
      await db.audit({ entity: 'sim', entityId: s.id, roundId: rs.roundId, action: 'delete', before: { serial: s.serial }, reason: r });
      await invalidatePrep(rs, 'ลบรายการซิม'); ctx.reload();
    }));
    $$('[data-mv]').forEach(b => b.onclick = guard(() => moveSim(ctx, sims.find(s => s.id === b.dataset.mv))));
  }
  $$('[data-zoom]').forEach(i => i.onclick = () => zoomImage(i.src));
  $$('[data-view]').forEach(b => b.onclick = guard(async () => { $('#ov').classList.remove('hidden'); await drawOverlay($('#ovc'), files.find(f => f.id === b.dataset.view), sims); $('#ov').scrollIntoView({ behavior: 'smooth' }); }));
}

async function simForm(ctx, s) {
  const { rs } = ctx;
  const v = await modal(`<h2>${s ? 'แก้ไขรายการซิม' : 'กรอกรายการซิมเอง'}</h2>
    ${s?.barcodeRaw ? `<p class="small muted">ค่าที่ถอดจาก Barcode ครั้งแรก: <span class="mono">${esc(s.barcodeRaw)}</span> (เก็บไว้ไม่เปลี่ยน)</p>` : ''}
    ${s?.cropBlob ? `<img class="crop" style="max-width:100%;max-height:none" src="${blobSrc('c' + s.id, s.cropBlob)}">` : ''}
    <label class="f">S/N (รหัสเฉพาะซิม)</label><input type="text" inputmode="numeric" id="sn" class="mono" value="${esc(s?.serial || '')}">
    <label class="f">เบอร์ที่พิมพ์กำกับ</label><input type="text" inputmode="numeric" id="ms" class="mono" value="${esc(s?.msisdn || '')}">
    <label class="f">Part no.</label><input type="text" id="pn" class="mono" value="${esc(s?.partNo || '')}">
    <label class="f">หมายเหตุ</label><input type="text" id="nt" value="${esc(s?.note || '')}">
    ${s ? '<label class="f">เหตุผลที่แก้</label><input type="text" id="rs">' : ''}
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">บันทึก</button></div>`,
  { onMount: (m, close) => m.querySelector('#ok').onclick = () => {
    const sn = m.querySelector('#sn').value.replace(/\s/g, ''); if (!sn) return toast('ต้องมี S/N', true);
    if (s && !m.querySelector('#rs').value.trim()) return toast('ต้องระบุเหตุผลที่แก้', true);
    close({ serial: sn, msisdn: m.querySelector('#ms').value.replace(/\s/g, '') || null, partNo: m.querySelector('#pn').value.trim() || null, note: m.querySelector('#nt').value.trim(), reason: s ? m.querySelector('#rs').value.trim() : '' });
  } });
  if (!v) return;
  const dup = await db.findSimBySerial(rs.roundId, v.serial);
  if (dup && dup.id !== s?.id) { const o = await db.get('roundStores', dup.rsId); throw new Error(`S/N นี้มีอยู่แล้วที่ร้าน ${o.storeCodeSnap} — ใช้ "ย้าย" แทนการเพิ่มซ้ำ`); }
  if (s) {
    const after = await db.update('sims', s.id, s.version, x => ({ ...x, serial: v.serial, msisdn: v.msisdn, partNo: v.partNo, note: v.note, edited: true, confirmed: false, confirmedBy: null, confirmedAt: null,
      check: x.barcodeRaw ? (x.barcodeRaw === v.serial ? compareBarcodeVsPrinted(x.barcodeRaw, x.printedSn) : 'mismatch') : 'manual' }));
    await db.audit({ entity: 'sim', entityId: s.id, roundId: rs.roundId, action: 'edit', before: { serial: s.serial, msisdn: s.msisdn, partNo: s.partNo }, after: { serial: after.serial, msisdn: after.msisdn, partNo: after.partNo }, reason: v.reason });
  } else {
    const n = (await db.simsOfRs(rs.id)).length;
    const sim = await db.insert('sims', { roundId: rs.roundId, rsId: rs.id, order: n, entry: 'manual', sourceFileId: null, quad: null, barcodeRaw: null, ocrRaw: null, printedSn: null,
      serial: v.serial, msisdn: v.msisdn, partNo: v.partNo, check: 'manual', relation: RELATION_TEXT, edited: false, confirmed: false, delivery: 'allocated', giveType: null, note: v.note });
    await db.audit({ entity: 'sim', entityId: sim.id, roundId: rs.roundId, action: 'create_manual', after: { serial: v.serial } });
  }
  await invalidatePrep(rs, 'แก้ไขรายการซิม'); ctx.reload();
}

async function moveSim(ctx, s) {
  const { rs } = ctx;
  const others = (await db.roundStoresOf(rs.roundId)).filter(x => x.id !== rs.id);
  if (!others.length) throw new Error('รอบงานนี้มีร้านเดียว');
  const v = await modal(`<h2>ย้ายซิมไปร้านอื่น</h2><p class="mono">${esc(s.serial)}</p>
    <label class="f">ร้านปลายทาง</label><select id="to">${others.map(o => `<option value="${o.id}" ${o.submittedAt ? 'disabled' : ''}>${esc(o.storeCodeSnap)} · ${esc(o.storeNameSnap)}${o.submittedAt ? ' (ส่งแล้ว)' : ''}</option>`).join('')}</select>
    <label class="f">เหตุผล</label><input type="text" id="rs">
    <p class="muted small">ภาพต้นฉบับยังอยู่กับร้านเดิม ร้านปลายทางอาจต้องถ่ายภาพหลักฐานใหม่</p>
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">ย้าย</button></div>`,
  { onMount: (m, close) => m.querySelector('#ok').onclick = () => { const r = m.querySelector('#rs').value.trim(); if (!r) return toast('ต้องระบุเหตุผล', true); close({ to: m.querySelector('#to').value, reason: r }); } });
  if (!v) return;
  const to = await db.get('roundStores', v.to);
  if (to.submittedAt) throw new Error('ร้านปลายทางส่งหลักฐานแล้ว ต้องเปิดแก้ไขก่อน');
  await db.update('sims', s.id, s.version, x => ({ ...x, rsId: to.id, movedFrom: rs.storeCodeSnap, confirmed: false, confirmedBy: null, confirmedAt: null, delivery: 'allocated' }));
  await db.insert('moves', { simId: s.id, roundId: rs.roundId, fromRs: rs.id, toRs: to.id, fromCode: rs.storeCodeSnap, toCode: to.storeCodeSnap, reason: v.reason, by: USER.name, at: nowIso() });
  await db.audit({ entity: 'sim', entityId: s.id, roundId: rs.roundId, action: 'move', before: { store: rs.storeCodeSnap }, after: { store: to.storeCodeSnap }, reason: v.reason });
  await invalidatePrep(rs, 'ย้ายซิมออก'); await invalidatePrep(to, 'ย้ายซิมเข้า');
  toast(`ย้ายไปร้าน ${to.storeCodeSnap} แล้ว — ร้านปลายทางต้องตรวจยืนยันใหม่`); ctx.reload();
}

// ======================= บิล =======================
async function billTab(el, ctx) {
  const { rs, data, locked } = ctx;
  const bill = data.bill;
  const billFiles = data.files.filter(f => f.kind === 'bill' && f.role === 'original');
  const active = bill ? billFiles.find(f => f.id === bill.fileId) : null;
  el.innerHTML = `${locked ? '' : `<div class="btn-grid"><button class="btn primary" id="cam">ถ่ายภาพบิล</button><button class="btn" id="up">เลือกภาพบิล</button></div>`}
    <div id="progress" class="card hidden"><div id="ptext" class="small"></div><div class="prog"><i id="pbar"></i></div></div>
    ${billFiles.length > 1 ? `<div class="card small">ภาพบิลทั้งหมด ${billFiles.length} ภาพ · ใช้ภาพล่าสุดเป็นบิลหลัก ภาพเก่ายังเก็บไว้</div>` : ''}
    <div id="billbody"></div>`;
  const body = $('#billbody');
  const prog = (t, p) => { $('#progress').classList.remove('hidden'); $('#ptext').textContent = t; $('#pbar').style.width = Math.round(p * 100) + '%'; };
  const newBill = guard(async capture => {
    const [f] = await addImages(ctx, 'bill', capture); if (!f) return;
    if (bill) { await db.update('bills', bill.id, bill.version, { deletedAt: nowIso(), replacedBy: f.id }); await db.audit({ entity: 'bill', entityId: bill.id, roundId: rs.roundId, action: 'replace_image', reason: 'เปลี่ยนภาพบิล — ต้องตรวจยืนยันใหม่' }); }
    await db.insert('bills', { rsId: rs.id, roundId: rs.roundId, fileId: f.id, templateId: T.id, templateVersion: T.version, quad: null, rows: null, totals: null, signature: null, confirmed: null, status: 'draft' });
    ctx.reload();
  });
  if (!locked) { $('#cam').onclick = () => newBill(true); $('#up').onclick = () => newBill(false); }
  if (!bill || !active) { body.innerHTML = '<div class="card muted">ยังไม่มีบิล</div>'; return; }
  if (!bill.rows || bill._adjust) return cornerEditor(body, ctx, bill, active, prog);
  return billReview(body, ctx, bill, active);
}

async function cornerEditor(body, ctx, bill, file, prog) {
  const bmp = await loadBitmap(file.blob); const W = bmp.width, H = bmp.height;
  const quad = bill.quad || defaultQuad(W, H);
  body.innerHTML = `<div class="card"><h2>วางมุมให้ตรงกรอบบิล</h2>
    <ol class="small" style="margin:0 0 8px;padding-left:20px">${T.anchors.map(a => `<li>${a}</li>`).join('')}</ol>
    <div class="imgwrap" id="cw"><canvas id="cc"></canvas>${[1, 2, 3, 4].map(i => `<div class="handle" data-h="${i - 1}">${i}</div>`).join('')}</div>
    ${ctx.locked ? '' : '<button class="btn primary big" id="read" style="margin-top:10px">อ่านบิล</button>'}</div>`;
  const c = $('#cc'); const sc = Math.min(1, 1400 / Math.max(W, H)); c.width = Math.round(W * sc); c.height = Math.round(H * sc);
  const g = c.getContext('2d'); const q = quad.map(p => [...p]);
  const draw = () => {
    g.drawImage(bmp, 0, 0, c.width, c.height); g.strokeStyle = '#c8102e'; g.lineWidth = 3; g.beginPath();
    q.forEach((p, i) => i ? g.lineTo(p[0] * sc, p[1] * sc) : g.moveTo(p[0] * sc, p[1] * sc)); g.closePath(); g.stroke();
    const r = c.getBoundingClientRect(); const k = r.width / c.width;
    $$('.handle').forEach((h, i) => { h.style.left = q[i][0] * sc * k + 'px'; h.style.top = q[i][1] * sc * k + 'px'; });
  };
  requestAnimationFrame(draw); window.addEventListener('resize', draw, { once: true });
  $$('.handle').forEach(h => {
    h.onpointerdown = e => {
      h.setPointerCapture(e.pointerId); const i = +h.dataset.h;
      h.onpointermove = ev => { const r = c.getBoundingClientRect(); const k = c.width / r.width; q[i] = [Math.max(0, Math.min(W, (ev.clientX - r.left) * k / sc)), Math.max(0, Math.min(H, (ev.clientY - r.top) * k / sc))]; draw(); };
      h.onpointerup = () => { h.onpointermove = null; };
    };
  });
  if (ctx.locked) return;
  $('#read').onclick = guard(async () => {
    $('#read').disabled = true;
    try {
      prog('ปรับภาพให้ตรง…', 0.05);
      const warped = await warpBill(file.blob, q);
      const res = await readBill(warped, p => prog('อ่านช่องตัวเลข…', 0.1 + p * 0.9));
      const warpedBlob = await warped.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      // ค่าที่ผู้ใช้จะยืนยัน: เริ่มจากค่าที่อ่านได้ แต่ช่อง "อ่านไม่ชัด" ต้องเลือกเอง
      const prefill = c => ({ ...c, value: (c.readState === 'value' || c.readState === 'printed') ? c.read : '', state: c.readState === 'printed' ? 'value' : (c.readState === 'unclear' ? null : c.readState) });
      for (const k in res.rows) { const r = res.rows[k]; r.qty = prefill(r.qty); r.price = prefill(r.price); r.amount = prefill(r.amount); }
      for (const k in res.totals) res.totals[k] = prefill(res.totals[k]);
      await db.update('bills', bill.id, bill.version, x => ({ ...x, quad: q, warpedBlob, rows: res.rows, totals: res.totals, signature: { system: res.signature.system, inkRatio: res.signature.inkRatio, user: null }, readAt: nowIso(), confirmed: null, status: 'draft', _adjust: false }));
      await db.audit({ entity: 'bill', entityId: bill.id, roundId: ctx.rs.roundId, action: 'read', after: { signature: res.signature.system } });
      ctx.reload();
    } finally { $('#read') && ($('#read').disabled = false); }
  });
}

async function billReview(body, ctx, bill, file) {
  const { rs, locked } = ctx;
  const sum = billSummary(bill);
  const warpedBmp = await loadBitmap(bill.warpedBlob);
  const cropUrl = async (x, y, pad) => {
    const { x0, y0 } = T.view; const w = x[1] - x[0], h = y[1] - y[0]; const px = w * (pad ?? 0.08), py = h * (pad ?? 0.25);
    const c = new OffscreenCanvas(Math.round(w + 2 * px), Math.round(h + 2 * py));
    c.getContext('2d').drawImage(warpedBmp, x[0] - x0 - px, y[0] - y0 - py, c.width, c.height, 0, 0, c.width, c.height);
    return URL.createObjectURL(await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
  };
  const flag = c => c.readState === 'unclear' || c.state == null || c.edited;
  const cellUi = async (path, label, c, x, y, kind) => `<div class="cellbox ${c.state == null ? 'bad' : flag(c) ? 'flag' : ''}">
    <div class="row between"><span class="lbl">${esc(label)}</span><span class="small muted">ระบบอ่าน: <b class="mono">${esc(c.read || '—')}</b> (${STATE_TEXT[c.readState] || '-'})${c.note ? ' · ' + esc(c.note) : ''}</span></div>
    <img class="crop" style="max-width:100%" src="${await cropUrl(x, y)}" data-zoomrow="${y.join(',')}">
    <div class="inp"><select data-st="${path}" ${locked ? 'disabled' : ''}><option value="">— เลือก —</option><option value="value" ${c.state === 'value' ? 'selected' : ''}>มีค่า</option><option value="blank" ${c.state === 'blank' ? 'selected' : ''}>ช่องว่าง</option></select>
    <input type="text" inputmode="${kind === 'money' ? 'decimal' : 'numeric'}" class="mono" data-v="${path}" value="${esc(c.value || '')}" ${c.state !== 'value' || locked ? 'disabled' : ''} placeholder="${kind === 'money' ? 'บาท' : 'ซิม'}"></div></div>`;
  const mini = (path, label, c, kind) => `<div class="cellbox ${c.state == null ? 'bad' : flag(c) ? 'flag' : ''}" style="padding:6px">
    <div class="lbl">${esc(label)}</div><div class="small muted">อ่านได้ <b class="mono">${esc(c.read || '—')}</b>${c.readState === 'unclear' ? ' · ไม่ชัด' : ''}</div>
    <select data-st="${path}" style="min-height:36px;margin-top:4px" ${locked ? 'disabled' : ''}><option value="">ตรวจ…</option><option value="value" ${c.state === 'value' ? 'selected' : ''}>มีค่า</option><option value="blank" ${c.state === 'blank' ? 'selected' : ''}>ว่าง</option></select>
    <input type="text" inputmode="${kind === 'money' ? 'decimal' : 'numeric'}" class="mono" style="min-height:36px;margin-top:4px" data-v="${path}" value="${esc(c.value || '')}" ${c.state !== 'value' || locked ? 'disabled' : ''}></div>`;
  let rowsHtml = '';
  for (const r of T.rows) {
    const row = bill.rows[r.key];
    const active = row.qty.readState !== 'blank' || row.amount.readState !== 'blank' || row.qty.state !== 'blank' || row.amount.state !== 'blank' || !!row.item.type;
    const needs = [row.qty, row.price, row.amount].some(c => c.state == null);
    rowsHtml += `<details class="card" style="padding:10px" ${active || needs ? 'open' : ''}><summary class="row between" style="cursor:pointer"><b>${esc(r.label)}</b><span class="small muted">${row.qty.state === 'value' ? row.qty.value + ' ซิม' : row.qty.state === 'blank' ? 'ว่าง' : 'ต้องตรวจ'}${row.item.type ? ' · ' + ITEM_TYPES.find(t => t[0] === row.item.type)[1] : ''}</span></summary>
      <img class="crop" style="max-width:100%;max-height:none;margin-top:8px" src="${await cropUrl([0, 1000], r.y, 0.06)}" data-zoomrow="1">
      <select data-type="${r.key}" style="margin-top:6px" ${locked ? 'disabled' : ''}><option value="">ประเภทรายการ: ไม่ระบุ</option>${ITEM_TYPES.map(([k, t]) => `<option value="${k}" ${row.item.type === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:6px">${mini(`rows.${r.key}.qty`, 'จำนวน (ซิม)', row.qty, 'int')}${mini(`rows.${r.key}.price`, r.printedPrice ? 'ราคา (พิมพ์)' : 'ราคา (บาท)', row.price, 'money')}${mini(`rows.${r.key}.amount`, 'เงินรวม (บาท)', row.amount, 'money')}</div></details>`;
  }
  let totHtml = ''; for (const t of T.totals) totHtml += await cellUi(`totals.${t.key}`, t.label, bill.totals[t.key], T.totalsValueX, t.y, 'money');
  const sigUrl = await cropUrl(T.signature.receiver.x, T.signature.receiver.y, 0.05);
  const sigFinal = bill.signature?.user || (bill.signature?.system === 'found' ? 'present' : null);
  const undecided = [...T.rows.flatMap(r => ['qty', 'price', 'amount'].map(k => bill.rows[r.key][k])), ...T.totals.map(t => bill.totals[t.key])].filter(c => c.state == null).length;
  body.innerHTML = `
    <div class="card"><div class="row between"><h2 style="margin:0">ผลอ่านบิล</h2>${bill.confirmed ? `<span class="badge ok">ยืนยันแล้ว · ${esc(bill.confirmed.by)} ${fmtDateTime(bill.confirmed.at)}</span>` : '<span class="badge warn">ฉบับร่าง</span>'}</div>
      <div class="kv" style="margin-top:8px"><div><div class="k">จำนวนซิมรวม (คำนวณ)</div><div class="v num">${sum.simQty}</div></div><div><div class="k">ขาย / แถม</div><div class="v num">${sum.paidQty} / ${sum.freeQty}</div></div>
      <div><div class="k">ผลรวมเงินรายการ (คำนวณ)</div><div class="v num">${(sum.lineAmount / 100).toLocaleString()}</div></div><div><div class="k">ยอดรับเงินทั้งสิ้น (อ่านจากบิล)</div><div class="v num">${sum.received != null ? (sum.received / 100).toLocaleString() : '—'}</div></div>
      <div><div class="k">ซิมที่เตรียม</div><div class="v num">${ctx.ev.preparedCount}</div></div></div>
      ${sum.simQty !== ctx.ev.preparedCount ? `<p class="small" style="color:var(--red)">จำนวนตามบิล ${sum.simQty} ≠ ซิมที่เตรียม ${ctx.ev.preparedCount}</p>` : ''}
      ${sum.checks.map(c => `<p class="small" style="color:var(--warn)">${esc(c.text)}</p>`).join('')}
      ${undecided ? `<p class="small" style="color:var(--red)">ยังมี ${undecided} ช่องที่ต้องตรวจ (กรอบแดง)</p>` : ''}
      ${locked ? '' : '<button class="btn sm" id="adj">วางมุมใหม่ / อ่านใหม่</button>'}</div>
    <div class="card"><h2>ลายเซ็นผู้รับ</h2><img class="crop" style="max-width:100%" src="${sigUrl}" data-zoomrow="1">
      <p class="small">${esc(signatureText(bill))}</p>
      ${locked ? '' : `<div class="btn-grid"><button class="btn ${sigFinal === 'present' ? 'primary' : ''}" data-sig="present">มีลายเซ็น</button><button class="btn ${sigFinal === 'absent' ? 'danger' : ''}" data-sig="absent">ไม่มีลายเซ็น</button></div>`}
      <p class="muted small">ตรวจเพียงว่ามีรอยหมึกในช่องผู้รับ ไม่ใช่การยืนยันตัวตน</p></div>
    <h3>รายการในบิล</h3>${rowsHtml}
    <h3>ยอดท้ายบิล</h3><div class="cellgrid">${totHtml}</div>
    ${locked ? '' : `<div style="margin-top:14px"><button class="btn primary big" id="cfb" ${bill.confirmed ? 'disabled' : ''}>${bill.confirmed ? 'ยืนยันบิลแล้ว' : 'ยืนยันทั้งบิล'}</button></div>`}
    <details class="card" style="margin-top:12px"><summary>ภาพบิลต้นฉบับ</summary><img class="zoomimg" src="${blobSrc(file.id, file.blob)}" style="margin-top:8px"></details>`;
  $$('[data-zoomrow]').forEach(i => i.onclick = () => zoomImage(i.src));
  if (locked) return;
  const getCell = (b, path) => path.split('.').reduce((o, k) => o[k], b);
  const unconfirm = async (b, why) => {
    if (!b.confirmed) return b;
    await db.audit({ entity: 'bill', entityId: b.id, roundId: rs.roundId, action: 'unconfirm', before: b.confirmed, reason: why });
    return { ...b, confirmed: null, status: 'draft' };
  };
  const save = async (mut, why) => {
    const cur = await db.get('bills', bill.id);
    let next = structuredClone(cur); mut(next); next = await unconfirm(next, why);
    await db.update('bills', bill.id, cur.version, () => next); ctx.reload();
  };
  $$('[data-st]').forEach(s => s.onchange = guard(async () => {
    const before = getCell(bill, s.dataset.st);
    await save(b => { const c = getCell(b, s.dataset.st); c.state = s.value || null; if (c.state !== 'value') c.value = ''; c.edited = c.state !== (c.readState === 'printed' ? 'value' : c.readState) || c.value !== c.read; }, 'แก้สถานะช่อง');
    await db.audit({ entity: 'bill', entityId: bill.id, roundId: rs.roundId, action: 'cell_state', before: { path: s.dataset.st, state: before.state }, after: { state: s.value } });
  }));
  $$('[data-v]').forEach(i => i.onchange = guard(async () => {
    const v = i.value.trim(); const path = i.dataset.v; const isMoney = !path.endsWith('qty');
    if (v && (isMoney ? !/^[\d๐-๙,]+(\.\d{1,2})?$/.test(v) : !/^[\d๐-๙,]+$/.test(v))) throw new Error(isMoney ? 'ยอดเงินต้องเป็นตัวเลข (ทศนิยมไม่เกิน 2 ตำแหน่ง)' : 'จำนวนซิมต้องเป็นจำนวนเต็ม');
    const before = getCell(bill, path).value;
    await save(b => { const c = getCell(b, path); c.value = v; c.edited = v !== c.read; if (!v) c.state = null; }, 'แก้ตัวเลขในบิล');
    await db.audit({ entity: 'bill', entityId: bill.id, roundId: rs.roundId, action: 'cell_edit', before: { path, value: before }, after: { value: v } });
  }));
  $$('[data-type]').forEach(s => s.onchange = guard(async () => { await save(b => { b.rows[s.dataset.type].item.type = s.value || null; }, 'แก้ประเภทรายการ'); }));
  $$('[data-sig]').forEach(b => b.onclick = guard(async () => { await save(x => { x.signature.user = b.dataset.sig; x.signature.userBy = USER.name; x.signature.userAt = nowIso(); }, 'แก้ผลลายเซ็น'); }));
  $('#adj').onclick = guard(async () => { const cur = await db.get('bills', bill.id); await db.update('bills', bill.id, cur.version, { _adjust: true }); ctx.reload(); });
  $('#cfb').onclick = guard(async () => {
    if (undecided) throw new Error(`ยังมี ${undecided} ช่องที่ยังไม่ตรวจ`);
    const s2 = billSummary(bill); if (s2.incomplete) throw new Error('ยังมีแถวที่มีจำนวนแต่ไม่ได้ระบุประเภทรายการ');
    if (!bill.signature?.user && bill.signature?.system !== 'found') throw new Error('ตรวจช่องลายเซ็นผู้รับก่อน (กด มีลายเซ็น / ไม่มีลายเซ็น)');
    const hash = JSON.stringify({ rows: bill.rows, totals: bill.totals, sig: bill.signature });
    const cur = await db.get('bills', bill.id);
    await db.update('bills', bill.id, cur.version, { confirmed: { by: USER.name, at: nowIso(), dataHash: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hash)).then(b => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('')) }, status: 'confirmed' });
    await db.audit({ entity: 'bill', entityId: bill.id, roundId: rs.roundId, action: 'confirm', after: { simQty: s2.simQty, amount: s2.lineAmount } });
    toast('ยืนยันบิลแล้ว'); ctx.reload();
  });
}

// ======================= รูปลงพื้นที่ =======================
async function photosTab(el, ctx) {
  const { rs, data, locked } = ctx;
  const origs = data.files.filter(f => f.kind === 'field' && f.role === 'original');
  const derived = data.files.filter(f => f.kind === 'field' && f.role === 'derived');
  el.innerHTML = `${locked ? '' : `<div class="btn-grid"><button class="btn primary" id="cam">ถ่ายรูปลงพื้นที่</button><button class="btn" id="up">เลือกรูป</button></div>`}
    <div class="card" style="margin-top:10px"><h2>รูปลงพื้นที่ (${origs.length})</h2>
    <div class="thumbs">${origs.map(o => { const d = derived.find(x => x.parentId === o.id); return `<div class="thumb"><img src="${blobSrc((d || o).id, (d || o).blob)}" data-z="${(d || o).id}"><div class="cap">${d ? '' : 'ยังไม่มีลายน้ำ · '}${esc(timeSourceText(o))}</div>${locked ? '' : `<button class="btn sm" style="position:absolute;top:4px;right:4px;min-height:28px;padding:0 8px" data-rm="${o.id}">ลบ</button>`}</div>`; }).join('') || '<div class="muted">ยังไม่มีรูป</div>'}</div></div>`;
  const add = guard(async cap => { const s = await addImages(ctx, 'field', cap); if (s.length) toast(`เพิ่ม ${s.length} รูป (ใส่ลายน้ำร้าน ${rs.storeCodeSnap} แล้ว)`); ctx.reload(); });
  if (!locked) { $('#cam').onclick = () => add(true); $('#up').onclick = () => add(false); }
  $$('[data-z]').forEach(i => i.onclick = () => zoomImage(i.src));
  $$('[data-rm]').forEach(b => b.onclick = guard(async () => {
    const r = await confirmBox('ลบรูปนี้ออกจากหลักฐาน?', { danger: true, ok: 'ลบ', reason: true }); if (!r) return;
    for (const f of [origs.find(o => o.id === b.dataset.rm), ...derived.filter(d => d.parentId === b.dataset.rm)]) await db.update('files', f.id, null, x => ({ ...x, deletedAt: nowIso(), deleteReason: r }));
    await db.audit({ entity: 'file', entityId: b.dataset.rm, roundId: rs.roundId, action: 'delete', reason: r }); ctx.reload();
  }));
}

// ======================= ตรวจทาน / ส่ง =======================
async function reviewTab(el, ctx) {
  const { rs, round, data, ev } = ctx;
  const isCentral = USER.role === 'central';
  const submitted = !!rs.submittedAt && rs.review?.status !== 'returned';
  const other = rs.outcome && rs.outcome !== 'delivered';
  const canEdit = round.status !== 'closed' && !submitted && !other;
  const sims = data.sims;
  el.innerHTML = `
    <div class="card"><h2>ตรวจก่อนส่ง</h2><ul class="checklist">${ev.checks.map(c => `<li><span class="ic ${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✕'}</span><div class="grow"><div>${esc(c.label)}</div><div class="muted small">${esc(c.detail)}</div></div></li>`).join('')}</ul></div>
    <div class="card"><h2>ซิมที่ส่งจริง</h2>
      <p class="small">เตรียม ${ev.preparedCount} · ตามบิล ${ev.billConfirmed ? ev.billSum.simQty : 'ยังไม่ยืนยันบิล'} · เลือกว่าส่งจริง ${ev.deliveredCount ?? '—'}</p>
      ${canEdit ? `<div class="row"><button class="btn sm" id="dall" ${sims.length ? '' : 'disabled'}>ส่งครบทุกรายการที่เตรียม</button><button class="btn sm" id="dsel" ${sims.length ? '' : 'disabled'}>เลือกเอง</button></div>` : ''}
      <div id="dpick" class="hidden" style="margin-top:8px"><div class="scroll-x" style="max-height:50vh"><table class="t"><tr><th>ส่ง</th><th>S/N</th><th>เบอร์</th><th>ขาย/แถม</th></tr>${sims.map(s => `<tr><td><input type="checkbox" data-d="${s.id}" ${s.delivery !== 'returned' ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--red)"></td><td class="mono small">${esc(s.serial)}</td><td class="mono small">${esc(s.msisdn || '—')}</td><td><select data-g="${s.id}" style="min-height:34px"><option value="">ไม่ระบุ</option><option value="paid" ${s.giveType === 'paid' ? 'selected' : ''}>ขาย</option><option value="free" ${s.giveType === 'free' ? 'selected' : ''}>แถม</option></select></td></tr>`).join('')}</table></div>
        <button class="btn primary" id="dsave" style="margin-top:8px">บันทึกรายการที่ส่งจริง</button></div></div>
    ${ev.exceptions.length ? `<div class="card"><h2>ข้อยกเว้น</h2>${ev.exceptions.map(e => `<div style="margin-bottom:10px"><div class="small"><span class="badge bad">ข้อยกเว้น</span> ${esc(e.text)}</div>${e.needsReason && e.code !== 'central_return' ? `<input type="text" data-ex="${e.code}" placeholder="เหตุผล (เช่น ส่งบางส่วน, มีสินค้าคืน, เปลี่ยนการจัดสรร)" value="${esc(e.reason)}" ${canEdit ? '' : 'disabled'}>` : ''}</div>`).join('')}</div>` : ''}
    <div class="card"><h2>หมายเหตุ</h2><textarea id="notes" ${canEdit ? '' : 'disabled'}>${esc(rs.notes || '')}</textarea></div>
    ${rs.review ? `<div class="card"><b>ส่วนกลาง:</b> ${REVIEW_TEXT[rs.review.status] || ''} · ${esc(rs.review.by)} ${fmtDateTime(rs.review.at)}<div class="small">${esc(rs.review.note || '')}</div></div>` : ''}
    ${isCentral ? `<div class="card"><h2>ส่วนกลางตรวจ</h2><textarea id="rvnote" placeholder="บันทึกของส่วนกลาง"></textarea><div class="btn-grid" style="margin-top:8px"><button class="btn primary" id="rvok">ตรวจแล้ว</button><button class="btn danger" id="rvret">ส่งกลับให้แก้</button></div></div>` : ''}
    ${canEdit ? `<div class="card"><h2>ไม่ได้ส่งสินค้าร้านนี้</h2><div class="btn-grid">${Object.entries(OUTCOME_TEXT).map(([k, t]) => `<button class="btn sm" data-oc="${k}">${t}</button>`).join('')}</div></div>` : ''}
    <div class="bottombar">${canEdit ? `<button class="btn" id="draft">บันทึก Draft</button><button class="btn primary" id="submit" ${ev.ready ? '' : 'disabled'}>ส่งหลักฐานร้านนี้</button>`
      : (round.status !== 'closed' && !isCentral ? `<button class="btn" id="reopen">${other ? 'ยกเลิกผล "ไม่ได้ส่ง"' : 'แก้ไขหลังส่ง'}</button>` : `<a class="btn" href="#/r/${round.id}/field">กลับรายการร้าน</a>`)}</div>`;

  const saveDraft = async () => {
    const cur = await db.get('roundStores', rs.id);
    const reasons = { ...(cur.exceptionReasons || {}) }; $$('[data-ex]').forEach(i => { reasons[i.dataset.ex] = i.value.trim(); });
    await db.update('roundStores', rs.id, cur.version, { exceptionReasons: reasons, notes: $('#notes').value });
  };
  if (canEdit) {
    $('#dall').onclick = guard(async () => {
      if (!(await confirmBox(`ยืนยันว่าส่งครบทั้ง ${sims.length} รายการที่เตรียม?`))) return;
      for (const s of sims) await db.update('sims', s.id, s.version, { delivery: 'delivered' });
      const cur = await db.get('roundStores', rs.id); await db.update('roundStores', rs.id, cur.version, { delivery: { selectionMode: 'all', confirmedBy: USER.name, confirmedAt: nowIso() } });
      await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: 'delivery_all', after: { count: sims.length } }); ctx.reload();
    });
    $('#dsel').onclick = () => $('#dpick').classList.toggle('hidden');
    $('#dsave').onclick = guard(async () => {
      for (const s of sims) {
        const d = $(`[data-d="${s.id}"]`).checked ? 'delivered' : 'returned'; const g = $(`[data-g="${s.id}"]`).value || null;
        if (s.delivery !== d || s.giveType !== g) await db.update('sims', s.id, s.version, { delivery: d, giveType: g });
      }
      const cur = await db.get('roundStores', rs.id); await db.update('roundStores', rs.id, cur.version, { delivery: { selectionMode: 'manual', confirmedBy: USER.name, confirmedAt: nowIso() } });
      await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: 'delivery_select', after: { delivered: sims.filter(s => $(`[data-d="${s.id}"]`).checked).length } }); ctx.reload();
    });
    $$('[data-ex]').forEach(i => i.onchange = guard(async () => { await saveDraft(); ctx.reload(); }));
    $('#notes').onchange = guard(saveDraft);
    $('#draft').onclick = guard(async () => { await saveDraft(); toast('บันทึก Draft แล้ว'); ctx.reload(); });
    $('#submit').onclick = guard(async () => {
      await saveDraft();
      const fresh = await db.get('roundStores', rs.id); const ev2 = evaluate(fresh, await loadStoreData(fresh));
      if (!ev2.ready) throw new Error('ยังไม่ครบเงื่อนไข: ' + ev2.checks.filter(c => !c.ok).map(c => c.label).join(', '));
      if (!(await confirmBox(`ส่งหลักฐานร้าน ${rs.storeCodeSnap}${ev2.exceptions.length ? ` (มีข้อยกเว้น ${ev2.exceptions.length} ข้อ)` : ''}?`, { ok: 'ส่งหลักฐาน' }))) return;
      await db.update('roundStores', rs.id, fresh.version, x => ({ ...x, submittedAt: nowIso(), submittedBy: USER.name, outcome: 'delivered', review: x.review?.status === 'returned' ? { ...x.review, status: 'resubmitted', resolvedAt: nowIso() } : x.review }));
      await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: 'submit', after: { exceptions: ev2.exceptions.map(e => e.code) } });
      toast('ส่งหลักฐานร้านนี้แล้ว'); nav(`#/r/${rs.roundId}/field`);
    });
    $$('[data-oc]').forEach(b => b.onclick = guard(async () => {
      const r = await confirmBox(`บันทึกผล: ${OUTCOME_TEXT[b.dataset.oc]}`, { reason: true, ok: 'บันทึกผล' }); if (!r) return;
      const cur = await db.get('roundStores', rs.id); await db.update('roundStores', rs.id, cur.version, { outcome: b.dataset.oc, outcomeReason: r, outcomeAt: nowIso(), outcomeBy: USER.name });
      await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: 'outcome', after: { outcome: b.dataset.oc }, reason: r });
      nav(`#/r/${rs.roundId}/field`);
    }));
  }
  $('#reopen') && ($('#reopen').onclick = guard(async () => {
    const r = await confirmBox(other ? 'ยกเลิกผล "ไม่ได้ส่ง" ของร้านนี้?' : 'เปิดแก้ไขร้านที่ส่งแล้ว? ต้องส่งใหม่หลังแก้', { reason: true, ok: 'เปิดแก้ไข' }); if (!r) return;
    const cur = await db.get('roundStores', rs.id);
    await db.update('roundStores', rs.id, cur.version, { submittedAt: null, submittedBy: null, outcome: null, outcomeReason: '' });
    await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: other ? 'outcome_cancel' : 'reopen', reason: r }); ctx.reload();
  }));
  if (isCentral) {
    const rv = status => guard(async () => {
      const note = $('#rvnote').value.trim(); if (status === 'returned' && !note) throw new Error('ระบุสิ่งที่ต้องแก้');
      const cur = await db.get('roundStores', rs.id);
      await db.update('roundStores', rs.id, cur.version, x => ({ ...x, review: { status, note, by: USER.name, at: nowIso() }, ...(status === 'returned' ? { submittedAt: null, outcome: x.outcome === 'delivered' ? null : x.outcome } : {}) }));
      if (status === 'returned' && round.status === 'closed') {
        const r = await db.get('rounds', round.id);
        await db.update('rounds', round.id, r.version, { status: 'open', closedAt: null, closedBy: null });
        await db.audit({ entity: 'round', entityId: round.id, roundId: round.id, action: 'reopen_by_central', reason: note });
      }
      await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: 'review_' + status, reason: note }); ctx.reload();
    });
    $('#rvok').onclick = rv('reviewed'); $('#rvret').onclick = rv('returned');
  }
}
