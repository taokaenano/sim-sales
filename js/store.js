// ===== หน้าร้าน V2 =====
//  - mode 'prep'  : เตรียมเอกสารที่ออฟฟิศ — Barcode + บิล + ติ๊กยืนยันจำนวนช่องเดียว
//  - mode 'field' : ลงพื้นที่ — ถ่าย/อัปโหลดรูป ใส่ลายน้ำเลขร้านอัตโนมัติ เลือกแสดงวันที่เวลาได้
import * as db from './db.js';
import { esc, fmtDateTime, nowIso } from './util.js';
import { $, $$, toast, guard, modal, confirmBox, blobSrc, pickFiles, zoomImage, nav, currentRoute } from './ui.js';
import { checkImageFile, saveOriginal, makeDerived, ensureDerived, loadBitmap, timeNote } from './image.js';
import { evaluate, loadStoreData, simKey, billKey, uniqueSimCount, resetBillCheck, statusBadge } from './logic.js';
import { liveScan } from './scanner.js';
import { decodeImage, readPrinted, compareBarcodeVsPrinted, referenceCrop, CHECK_TEXT, RELATION_TEXT } from './barcode.js';

let USER;

export async function renderStore(app, rsId, mode, user) {
  USER = user;
  const rs = await db.get('roundStores', rsId); if (!rs) throw new Error('ไม่พบร้านในรอบงาน');
  const round = await db.get('rounds', rs.roundId);
  const data = await loadStoreData(rs); const ev = evaluate(rs, data);
  const routeAtRender = currentRoute();
  // วาดหน้าใหม่เฉพาะเมื่อผู้ใช้ยังอยู่หน้าเดิม — งานที่ค้างอยู่จะไม่ดึงผู้ใช้กลับมาหน้าร้านเก่า
  const ctx = { app, rs, round, data, ev, mode, reload: () => { if (currentRoute() === routeAtRender) renderStore(app, rsId, mode, user); } };
  app.innerHTML = `<div class="row between" style="margin-bottom:8px"><a class="btn sm" href="#/r/${round.id}/${mode}">← ${mode === 'prep' ? 'รายชื่อร้าน (เตรียมเอกสาร)' : 'รายชื่อร้าน (ลงพื้นที่)'}</a><span class="muted small">ลำดับ ${rs.seq}</span></div>
    <div class="storebar"><div><div class="code mono">${esc(rs.storeCodeSnap)}</div><div class="name">${esc(rs.storeNameSnap)}</div></div><span class="st">${esc(ev.statusText)}</span></div>
    <div id="progress" class="card hidden"><div id="ptext" class="small"></div><div class="prog"><i id="pbar"></i></div></div>
    <div id="tab"></div>`;
  ctx.prog = (t, p) => { const el = $('#progress'); if (!el || currentRoute() !== routeAtRender) return; el.classList.remove('hidden'); $('#ptext').textContent = t; $('#pbar').style.width = Math.round(p * 100) + '%'; };
  const el = $('#tab');
  return mode === 'field' ? fieldPage(el, ctx) : prepPage(el, ctx);
}

/** ร้านถัดไปตามลำดับในรอบงาน (ข้ามร้านปัจจุบัน) */
async function nextStore(rs) {
  const all = await db.roundStoresOf(rs.roundId);
  const i = all.findIndex(x => x.id === rs.id);
  return all[i + 1] || null;
}

// ======================= Barcode =======================
async function processBarcodeFile(f, rs, onStep, pre = null) {
  await db.update('files', f.id, null, x => ({ ...x, proc: { state: 'running', at: nowIso() } }));
  try {
    onStep('ถอด Barcode…', 0);
    const res = pre || await decodeImage(f.blob, p => onStep('ถอด Barcode…', p * 0.5));
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
        relation: RELATION_TEXT, cropBlob: crop, edited: false, note: '',
      });
      result.added++;
    }
    res.bitmap.close?.();
    await db.update('files', f.id, null, x => ({ ...x, proc: { state: 'done', at: nowIso(), result } }));
    if (result.added) await resetBillCheck(rs.id, 'ชุดรายการซิมเปลี่ยน (เพิ่มจากภาพ)');
    return result;
  } catch (e) {
    await db.update('files', f.id, null, x => ({ ...x, proc: { state: 'error', at: nowIso(), error: String(e.message || e) } }));
    throw e;
  }
}

/**
 * เพิ่มภาพให้ร้าน — ผูกร้านตั้งแต่ตอนกดปุ่ม (rsBound) ไม่ใช่ร้านที่เปิดอยู่ตอนประมวลผลเสร็จ
 * จึงไม่ย้ายร้านหรือใส่ลายน้ำผิดร้าน แม้ผู้ใช้เปลี่ยนหน้าระหว่างบันทึก
 */
async function addImages(rsBound, kind, capture) {
  const files = await pickFiles({ capture, multiple: true });
  const saved = [];
  for (const file of files) {
    const err = checkImageFile(file); if (err) { toast(err, true); continue; }
    const r = await saveOriginal(file, { roundId: rsBound.roundId, rsId: rsBound.id, kind, captureSource: capture ? 'camera' : 'upload' });
    if (r.duplicate) { toast(`ภาพ ${file.name} เคยแนบกับร้านนี้แล้ว — ไม่เพิ่มซ้ำ`); continue; }
    const fresh = await db.get('roundStores', rsBound.id); // ตัวเลือกแสดงเวลาล่าสุดของร้านนี้
    await makeDerived(r.file, { storeCode: rsBound.storeCodeSnap, storeName: rsBound.storeNameSnap, showTime: kind === 'field' && !!fresh.fieldShowTime });
    saved.push(r.file);
  }
  if (saved.length) await db.audit({ entity: 'roundStore', entityId: rsBound.id, roundId: rsBound.roundId, action: `add_${kind}`, after: saved.map(f => f.name) });
  return saved;
}

function procBadge(f) {
  const p = f.proc || { state: 'none' };
  if (p.state === 'running') return '<span class="badge warn">กำลังอ่าน</span>';
  if (p.state === 'error') return `<span class="badge bad">อ่านไม่สำเร็จ</span>`;
  if (p.state === 'done') return `<span class="badge ok">อ่านได้ ${p.result.found}${p.result.failed.length ? ` · อ่านไม่ได้ ${p.result.failed.length} จุด` : ''}</span>`;
  return '<span class="badge">ยังไม่อ่าน</span>';
}

async function drawOverlay(canvas, f, sims) {
  const bmp = await loadBitmap(f.blob); const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  canvas.width = Math.round(bmp.width * sc); canvas.height = Math.round(bmp.height * sc);
  const g = canvas.getContext('2d'); g.drawImage(bmp, 0, 0, canvas.width, canvas.height); bmp.close?.();
  g.lineWidth = Math.max(2, canvas.width / 400); g.font = `700 ${Math.max(14, canvas.width / 45)}px "IBM Plex Sans Thai"`;
  const poly = (q, color) => { g.strokeStyle = color; g.beginPath(); g.moveTo(q.topLeft.x * sc, q.topLeft.y * sc); g.lineTo(q.topRight.x * sc, q.topRight.y * sc); g.lineTo(q.bottomRight.x * sc, q.bottomRight.y * sc); g.lineTo(q.bottomLeft.x * sc, q.bottomLeft.y * sc); g.closePath(); g.stroke(); };
  sims.filter(s => s.sourceFileId === f.id && s.quad).forEach(s => {
    poly(s.quad, '#1d7a46');
    const n = String(s._n); const x = s.quad.topLeft.x * sc, y = s.quad.topLeft.y * sc; const w = g.measureText(n).width + 8;
    g.fillStyle = '#1d7a46'; g.fillRect(x - 2, y - 22, w, 22); g.fillStyle = '#fff'; g.fillText(n, x + 2, y - 5);
  });
  (f.proc?.result?.failed || []).forEach(q => { g.setLineDash([8, 6]); poly(q, '#ff9800'); g.setLineDash([]); g.fillStyle = '#ff9800'; g.fillText('?', q.topLeft.x * sc, q.topLeft.y * sc - 4); });
  (f.proc?.result?.boxes || []).filter(b => b.dup === 'other').forEach(b => poly(b.quad, '#6a1b9a'));
}

async function softDeleteFileWithDerived(f, reason) {
  for (const x of [f, ...(await db.derivedOf(f.id))]) await db.update('files', x.id, null, y => ({ ...y, deletedAt: nowIso(), deleteReason: reason || '' }));
  await db.audit({ entity: 'file', entityId: f.id, roundId: f.roundId, action: 'delete', reason: reason || '' });
}

// ======================= หน้าเตรียมเอกสาร =======================
async function prepPage(el, ctx) {
  const { rs, data, ev } = ctx;
  const bcFiles = data.files.filter(f => f.kind === 'barcode' && f.role === 'original');
  const billFiles = data.files.filter(f => f.kind === 'bill' && f.role === 'original');
  const billDerived = data.files.filter(f => f.kind === 'bill' && f.role === 'derived');
  const sims = data.sims; sims.forEach((s, i) => s._n = i + 1);
  const all = await db.simsOfRound(rs.roundId);
  const dupMap = new Map(); for (const s of all) if (s.serial) dupMap.set(s.serial, (dupMap.get(s.serial) || 0) + 1);
  const n = uniqueSimCount(sims);
  const canCheck = n > 0 && billFiles.length > 0;
  const nxt = await nextStore(rs);
  el.innerHTML = `
    <div class="card"><div class="row between"><h2 style="margin:0">1 · Barcode</h2><span class="badge ${n ? 'ok' : ''}">ซิม ${n} รายการ</span></div>
      <button class="btn primary big" id="live" style="margin-top:10px">สแกนสด</button>
      <div class="btn-grid" style="margin-top:8px"><button class="btn" id="cam">ถ่ายภาพ</button><button class="btn" id="up">เลือกภาพ (หลายภาพได้)</button></div>
      <div class="list" style="margin-top:10px">${bcFiles.map(f => `<div class="item" style="align-items:flex-start"><img src="${blobSrc(f.id, f.blob)}" style="width:64px;height:64px;object-fit:cover;border-radius:8px" data-zoom-src>
        <div class="grow"><div class="statusline">${procBadge(f)}</div>
        ${f.proc?.result ? `<div class="muted small">เพิ่มใหม่ ${f.proc.result.added} · ซ้ำในร้าน ${f.proc.result.dupSame}${f.proc.result.dupOther.length ? ` · <b style="color:var(--red)">ซ้ำร้านอื่น ${f.proc.result.dupOther.length}: ${esc([...new Set(f.proc.result.dupOther.map(d => d.store))].join(', '))}</b>` : ''}</div>` : ''}
        ${f.proc?.state === 'error' ? `<div class="small" style="color:var(--red)">${esc(f.proc.error)}</div>` : ''}</div>
        <div class="row" style="flex-direction:column;gap:4px"><button class="btn sm" data-view="${f.id}">ดูตำแหน่ง</button><button class="btn sm" data-proc="${f.id}">อ่านใหม่</button><button class="btn sm ghost" data-rmf="${f.id}">ลบภาพ</button></div></div>`).join('')}</div>
      <div id="ov" class="hidden" style="margin-top:10px"><div class="imgwrap"><canvas id="ovc"></canvas></div></div>
      <div class="row" style="margin-top:10px"><label class="f" style="margin:0">จำนวนที่คาด</label><input type="text" inputmode="numeric" id="exp" style="width:90px" value="${rs.expectedCount ?? ''}">
        ${rs.expectedCount != null ? `<span class="small">บันทึกแล้ว ${n} / คาด ${rs.expectedCount}</span>` : ''}</div>
      <details style="margin-top:10px" ${sims.length <= 6 ? 'open' : ''}><summary class="small" style="cursor:pointer">รายการซิม ${n} รายการ · ${RELATION_TEXT}</summary>
      <div class="list" style="margin-top:8px">${sims.map(s => { const dup = (dupMap.get(s.serial) || 0) > 1; const warn = s.check === 'mismatch' || s.check === 'printed_unreadable'; return `<div class="item" style="flex-direction:column;align-items:stretch;${dup ? 'border-color:var(--red);background:var(--red-l)' : warn ? 'border-color:#f0b46a' : ''}">
        <div class="row" style="gap:8px"><span class="badge">#${s._n}</span><span class="mono" style="font-size:15px;font-weight:600">${esc(s.serial || '—')}</span></div>
        <div class="row small" style="gap:12px"><span>เบอร์ <b class="mono">${esc(s.msisdn || '—')}</b></span><span>Part <b class="mono">${esc(s.partNo || '—')}</b></span></div>
        <div class="statusline"><span class="badge ${s.check === 'match' ? 'ok' : warn ? 'warn' : ''}">${esc(CHECK_TEXT[s.check] || '')}</span>${dup ? '<span class="badge bad">S/N ซ้ำ</span>' : ''}${s.entry === 'manual' ? '<span class="badge">กรอกมือ</span>' : ''}${s.movedFrom ? `<span class="badge">ย้ายจาก ${esc(s.movedFrom)}</span>` : ''}</div>
        ${s.edited ? `<div class="muted small">อ่านครั้งแรก: <span class="mono">${esc(s.barcodeRaw || '—')}</span></div>` : ''}
        ${s.cropBlob ? `<img class="crop" style="max-width:100%;max-height:110px" src="${blobSrc('c' + s.id, s.cropBlob)}" data-zoom-src>` : ''}
        <div class="row"><button class="btn sm" data-ed="${s.id}">แก้</button><button class="btn sm" data-mv="${s.id}">ย้ายร้าน</button><button class="btn sm ghost" data-del="${s.id}">ลบ</button></div></div>`; }).join('')}</div>
      <button class="btn sm" id="addm" style="margin-top:8px">+ กรอกเอง</button></details>
    </div>

    <div class="card"><div class="row between"><h2 style="margin:0">2 · บิล</h2><span class="badge ${billFiles.length ? 'ok' : ''}">${billFiles.length} ภาพ</span></div>
      <div class="btn-grid" style="margin-top:10px"><button class="btn" id="bcam">ถ่ายบิล</button><button class="btn" id="bup">เลือกภาพบิล</button></div>
      <div class="thumbs" style="margin-top:10px">${billFiles.map(o => { const d = billDerived.find(x => x.parentId === o.id) || o; return `<div class="thumb"><img src="${blobSrc(d.id, d.blob)}" data-zoom-src><button class="btn sm" style="position:absolute;top:4px;right:4px;min-height:28px;padding:0 8px" data-rmb="${o.id}">ลบ</button></div>`; }).join('')}</div>
      <div class="kv" style="margin-top:10px"><div><div class="k">รายการซิมที่บันทึกไว้ของร้านนี้</div><div class="v num">${n}</div></div></div>
      <label class="cb" style="margin-top:8px;${canCheck ? '' : 'opacity:.5'}"><input type="checkbox" id="bchk" ${ev.billChecked ? 'checked' : ''} ${canCheck ? '' : 'disabled'}> ตรวจสอบแล้ว จำนวนซิมในบิลตรงกับจำนวนรายการซิมที่บันทึกไว้ของร้านนี้</label>
      ${ev.billChecked ? `<div class="small muted">ยืนยันโดย ${esc(rs.billCheck.by || '')} · ${fmtDateTime(rs.billCheck.at)}</div>` : ''}
    </div>

    <div class="card">${ev.docsReady ? '<b style="color:var(--ok)">เตรียมเอกสารแล้ว</b>' : `<b>ยังขาด:</b> ${esc(ev.missingDocs.join(' · '))}`}<div class="small muted">บันทึกในเครื่องแล้ว</div></div>
    <div class="bottombar"><button class="btn" id="save">บันทึก</button><button class="btn primary" id="next">${nxt ? 'เตรียมร้านถัดไป' : 'กลับหน้าสรุป'}</button></div>`;

  const runFiles = async (list, rsBound) => {
    for (const f of list) {
      try { const r = await processBarcodeFile(f, rsBound, ctx.prog); if (r.dupOther.length) toast(`พบ S/N ซ้ำกับร้านอื่น ${r.dupOther.length} รายการ — ไม่ได้เพิ่ม`, true); }
      catch (e) { toast(`อ่านภาพไม่สำเร็จ: ${e.message || e} — กด "อ่านใหม่"`, true); }
    }
    ctx.reload();
  };
  $('#cam').onclick = guard(async () => { const b = rs; runFiles(await addImages(b, 'barcode', true), b); });
  $('#up').onclick = guard(async () => { const b = rs; runFiles(await addImages(b, 'barcode', false), b); });
  $('#live').onclick = guard(async () => {
    const b = rs;
    const known = new Set((await db.simsOfRound(b.roundId)).map(x => x.serial).filter(Boolean));
    const res = await liveScan({ title: `${b.storeCodeSnap} · ${b.storeNameSnap}`, knownSerials: known, expected: b.expectedCount });
    if (!res || !res.frames.length) return;
    let added = 0, dupOther = 0, k = 0;
    for (const fr of res.frames) {
      ctx.prog(`บันทึกภาพสแกน ${++k}/${res.frames.length}`, k / res.frames.length);
      const file = new File([fr.blob], `scan-${Date.now()}-${k}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      const sv = await saveOriginal(file, { roundId: b.roundId, rsId: b.id, kind: 'barcode', captureSource: 'camera' });
      await makeDerived(sv.file, { storeCode: b.storeCodeSnap, storeName: b.storeNameSnap });
      const r = await processBarcodeFile(sv.file, b, ctx.prog, { found: fr.found, failed: [], bitmap: fr.bitmap, width: fr.bitmap.width, height: fr.bitmap.height });
      added += r.added; dupOther += r.dupOther.length;
    }
    await db.audit({ entity: 'roundStore', entityId: b.id, roundId: b.roundId, action: 'live_scan', after: { frames: res.frames.length, added } });
    toast(`สแกนสด: เพิ่ม ${added} รายการ${dupOther ? ` · ซ้ำร้านอื่น ${dupOther}` : ''}`); ctx.reload();
  });
  $$('[data-proc]').forEach(b => b.onclick = guard(async () => runFiles([bcFiles.find(f => f.id === b.dataset.proc)], rs)));
  $$('[data-rmf]').forEach(b => b.onclick = guard(async () => {
    const f = bcFiles.find(x => x.id === b.dataset.rmf);
    const used = sims.filter(s => s.sourceFileId === f.id).length;
    if (used) throw new Error(`ภาพนี้มีรายการซิม ${used} รายการ — ลบรายการซิมเหล่านั้นก่อน`);
    if (!(await confirmBox('ลบภาพ Barcode นี้?', { danger: true, ok: 'ลบ' }))) return;
    await softDeleteFileWithDerived(f, 'ลบภาพ Barcode'); ctx.reload();
  }));
  $('#exp').onchange = guard(async e => { const v = e.target.value.trim(); const num = v === '' ? null : Number(v); if (v !== '' && !Number.isInteger(num)) throw new Error('จำนวนต้องเป็นจำนวนเต็ม'); const cur = await db.get('roundStores', rs.id); await db.update('roundStores', rs.id, cur.version, { expectedCount: num }); ctx.reload(); });
  $('#addm').onclick = guard(() => simForm(ctx, null));
  $$('[data-ed]').forEach(b => b.onclick = guard(() => simForm(ctx, sims.find(s => s.id === b.dataset.ed))));
  $$('[data-del]').forEach(b => b.onclick = guard(async () => {
    const s = sims.find(x => x.id === b.dataset.del);
    if (!(await confirmBox(`ลบรายการ ${s.serial || ''}?`, { danger: true, ok: 'ลบ' }))) return;
    await db.update('sims', s.id, s.version, { deletedAt: nowIso(), deletedBy: USER.name });
    await db.audit({ entity: 'sim', entityId: s.id, roundId: rs.roundId, action: 'delete', before: { serial: s.serial } });
    await resetBillCheck(rs.id, 'ชุดรายการซิมเปลี่ยน (ลบ)'); ctx.reload();
  }));
  $$('[data-mv]').forEach(b => b.onclick = guard(() => moveSim(ctx, sims.find(s => s.id === b.dataset.mv))));
  $$('[data-zoom-src]').forEach(i => i.onclick = () => zoomImage(i.src));
  $$('[data-view]').forEach(b => b.onclick = guard(async () => { $('#ov').classList.remove('hidden'); await drawOverlay($('#ovc'), bcFiles.find(f => f.id === b.dataset.view), sims); $('#ov').scrollIntoView({ behavior: 'smooth' }); }));

  // บิล
  const addBill = guard(async cap => {
    const b = rs; const s = await addImages(b, 'bill', cap);
    if (s.length) { await resetBillCheck(b.id, 'เพิ่มภาพบิล'); toast(`เพิ่มภาพบิล ${s.length} ภาพ`); }
    ctx.reload();
  });
  $('#bcam').onclick = () => addBill(true); $('#bup').onclick = () => addBill(false);
  $$('[data-rmb]').forEach(b => b.onclick = guard(async () => {
    if (!(await confirmBox('ลบภาพบิลนี้?', { danger: true, ok: 'ลบ' }))) return;
    await softDeleteFileWithDerived(billFiles.find(f => f.id === b.dataset.rmb), 'ลบภาพบิล');
    await resetBillCheck(rs.id, 'ลบภาพบิล'); ctx.reload();
  }));
  $('#bchk').onchange = guard(async e => {
    const cur = await db.get('roundStores', rs.id);
    const fresh = await loadStoreData(cur);
    const bills = fresh.files.filter(f => f.kind === 'bill' && f.role === 'original');
    if (e.target.checked && (!uniqueSimCount(fresh.sims) || !bills.length)) { e.target.checked = false; throw new Error('ต้องมีรายการซิมและภาพบิลก่อน'); }
    const billCheck = e.target.checked
      ? { checked: true, at: nowIso(), by: USER.name, simKey: simKey(fresh.sims), billKey: billKey(bills), simCount: uniqueSimCount(fresh.sims) }
      : { checked: false, at: nowIso(), by: USER.name };
    await db.update('roundStores', rs.id, cur.version, { billCheck });
    await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: e.target.checked ? 'bill_check' : 'bill_uncheck', after: { simCount: billCheck.simCount ?? null } });
    ctx.reload();
  });
  $('#save').onclick = () => toast(ev.docsReady ? 'บันทึกในเครื่องแล้ว · เตรียมเอกสารแล้ว' : 'บันทึกในเครื่องแล้ว (ฉบับร่าง)');
  $('#next').onclick = () => nav(nxt ? `#/s/${nxt.id}/prep` : `#/r/${rs.roundId}`);
}

async function simForm(ctx, s) {
  const { rs } = ctx;
  const v = await modal(`<h2>${s ? 'แก้ไขรายการซิม' : 'กรอกรายการซิมเอง'}</h2>
    ${s?.barcodeRaw ? `<p class="small muted">ค่าที่อ่านจาก Barcode ครั้งแรก: <span class="mono">${esc(s.barcodeRaw)}</span></p>` : ''}
    ${s?.cropBlob ? `<img class="crop" style="max-width:100%;max-height:none" src="${blobSrc('c' + s.id, s.cropBlob)}">` : ''}
    <label class="f">S/N (รหัสเฉพาะซิม)</label><input type="text" inputmode="numeric" id="sn" class="mono" value="${esc(s?.serial || '')}">
    <label class="f">เบอร์ที่พิมพ์กำกับ</label><input type="text" inputmode="numeric" id="ms" class="mono" value="${esc(s?.msisdn || '')}">
    <label class="f">Part no.</label><input type="text" id="pn" class="mono" value="${esc(s?.partNo || '')}">
    <label class="f">หมายเหตุ</label><input type="text" id="nt" value="${esc(s?.note || '')}">
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">บันทึก</button></div>`,
  { onMount: (m, close) => m.querySelector('#ok').onclick = () => {
    const sn = m.querySelector('#sn').value.replace(/\s/g, ''); if (!sn) return toast('ต้องมี S/N', true);
    close({ serial: sn, msisdn: m.querySelector('#ms').value.replace(/\s/g, '') || null, partNo: m.querySelector('#pn').value.trim() || null, note: m.querySelector('#nt').value.trim() });
  } });
  if (!v) return;
  const dup = await db.findSimBySerial(rs.roundId, v.serial);
  if (dup && dup.id !== s?.id) { const o = await db.get('roundStores', dup.rsId); throw new Error(`S/N นี้มีอยู่แล้วที่ร้าน ${o.storeCodeSnap} — ใช้ "ย้ายร้าน" แทนการเพิ่มซ้ำ`); }
  if (s) {
    const after = await db.update('sims', s.id, s.version, x => ({ ...x, serial: v.serial, msisdn: v.msisdn, partNo: v.partNo, note: v.note, edited: true,
      check: x.barcodeRaw ? (x.barcodeRaw === v.serial ? compareBarcodeVsPrinted(x.barcodeRaw, x.printedSn) : 'mismatch') : 'manual' }));
    await db.audit({ entity: 'sim', entityId: s.id, roundId: rs.roundId, action: 'edit', before: { serial: s.serial, msisdn: s.msisdn, partNo: s.partNo }, after: { serial: after.serial, msisdn: after.msisdn, partNo: after.partNo } });
    if (after.serial !== s.serial) await resetBillCheck(rs.id, 'ชุดรายการซิมเปลี่ยน (แก้ S/N)');
  } else {
    const n = (await db.simsOfRs(rs.id)).length;
    const sim = await db.insert('sims', { roundId: rs.roundId, rsId: rs.id, order: n, entry: 'manual', sourceFileId: null, quad: null, barcodeRaw: null, ocrRaw: null, printedSn: null,
      serial: v.serial, msisdn: v.msisdn, partNo: v.partNo, check: 'manual', relation: RELATION_TEXT, edited: false, note: v.note });
    await db.audit({ entity: 'sim', entityId: sim.id, roundId: rs.roundId, action: 'create_manual', after: { serial: v.serial } });
    await resetBillCheck(rs.id, 'ชุดรายการซิมเปลี่ยน (กรอกเอง)');
  }
  ctx.reload();
}

async function moveSim(ctx, s) {
  const { rs } = ctx;
  const others = (await db.roundStoresOf(rs.roundId)).filter(x => x.id !== rs.id);
  if (!others.length) throw new Error('รอบงานนี้มีร้านเดียว');
  const v = await modal(`<h2>ย้ายซิมไปร้านอื่น</h2><p class="mono">${esc(s.serial)}</p>
    <label class="f">ร้านปลายทาง</label><select id="to">${others.map(o => `<option value="${o.id}">${esc(o.storeCodeSnap)} · ${esc(o.storeNameSnap)}</option>`).join('')}</select>
    <label class="f">เหตุผล</label><input type="text" id="rs">
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">ย้าย</button></div>`,
  { onMount: (m, close) => m.querySelector('#ok').onclick = () => close({ to: m.querySelector('#to').value, reason: m.querySelector('#rs').value.trim() }) });
  if (!v) return;
  const to = await db.get('roundStores', v.to);
  await db.update('sims', s.id, s.version, x => ({ ...x, rsId: to.id, movedFrom: rs.storeCodeSnap }));
  await db.insert('moves', { simId: s.id, roundId: rs.roundId, fromRs: rs.id, toRs: to.id, fromCode: rs.storeCodeSnap, toCode: to.storeCodeSnap, reason: v.reason, by: USER.name, at: nowIso() });
  await db.audit({ entity: 'sim', entityId: s.id, roundId: rs.roundId, action: 'move', before: { store: rs.storeCodeSnap }, after: { store: to.storeCodeSnap }, reason: v.reason });
  await resetBillCheck(rs.id, 'ชุดรายการซิมเปลี่ยน (ย้ายออก)'); await resetBillCheck(to.id, 'ชุดรายการซิมเปลี่ยน (ย้ายเข้า)');
  toast(`ย้ายไปร้าน ${to.storeCodeSnap} แล้ว`); ctx.reload();
}

// ======================= หน้าลงพื้นที่ =======================
async function fieldPage(el, ctx) {
  const { rs, data, ev } = ctx;
  const origs = data.files.filter(f => f.kind === 'field' && f.role === 'original');
  // ภาพรุ่นเก่าหรือภาพที่ตัวเลือกไม่ตรง: สร้างใหม่จากต้นฉบับ เพื่อให้หน้าจอตรงกับ PDF
  const shown = [];
  for (const o of origs) shown.push({ o, d: await ensureDerived(o, rs) });
  el.innerHTML = `
    ${ev.docsReady ? '' : `<div class="card small" style="border-color:#f0b46a;background:#fffaf2"><b>เอกสารร้านนี้ยังไม่ครบ:</b> ${esc(ev.missingDocs.join(' · '))}</div>`}
    <div class="btn-grid"><button class="btn primary big" id="cam">ถ่ายรูป</button><button class="btn big" id="up">เลือกรูปที่ถ่ายไว้</button></div>
    <label class="cb" style="margin-top:8px"><input type="checkbox" id="showt" ${rs.fieldShowTime ? 'checked' : ''}> แสดงวันที่และเวลาบนรูป</label>
    <div class="card" style="margin-top:6px"><h2>รูปลงพื้นที่ (${origs.length})</h2>
      <div class="thumbs">${shown.map(({ o, d }) => `<div><div class="thumb"><img src="${blobSrc(d.id, d.blob)}" data-zoom-src><button class="btn sm" style="position:absolute;top:4px;right:4px;min-height:28px;padding:0 8px" data-rm="${o.id}">ลบ</button></div><div class="small muted" style="margin-top:2px">${esc(timeNote(o))}</div></div>`).join('') || '<div class="muted">ยังไม่มีรูป</div>'}</div>
      ${origs.length ? '<div class="small muted" style="margin-top:6px">บันทึกในเครื่องแล้ว</div>' : ''}</div>
    <div class="bottombar"><button class="btn primary" id="done">เสร็จร้านนี้ / เลือกร้านถัดไป</button></div>`;
  const add = guard(async cap => { const b = rs; const s = await addImages(b, 'field', cap); if (s.length) toast(`เพิ่ม ${s.length} รูป · ร้าน ${b.storeCodeSnap}`); ctx.reload(); });
  $('#cam').onclick = () => add(true); $('#up').onclick = () => add(false);
  $('#showt').onchange = guard(async e => {
    const cur = await db.get('roundStores', rs.id);
    const upd = await db.update('roundStores', rs.id, cur.version, { fieldShowTime: e.target.checked });
    let k = 0; for (const o of origs) { ctx.prog(`ปรับรูป ${++k}/${origs.length}`, k / origs.length); await ensureDerived(o, upd); }
    ctx.reload();
  });
  $$('[data-zoom-src]').forEach(i => i.onclick = () => zoomImage(i.src));
  $$('[data-rm]').forEach(b => b.onclick = guard(async () => {
    if (!(await confirmBox('ลบรูปนี้?', { danger: true, ok: 'ลบ' }))) return;
    await softDeleteFileWithDerived(origs.find(o => o.id === b.dataset.rm), 'ลบรูปลงพื้นที่'); ctx.reload();
  }));
  $('#done').onclick = () => nav(`#/r/${rs.roundId}/field`);
}
