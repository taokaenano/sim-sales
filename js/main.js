// ===== แอปหลัก: เส้นทาง + หน้ารอบงาน / ร้านค้า / ส่วนกลาง / Export =====
import './compat.js';
import * as db from './db.js';
import { esc, fmtDate, fmtDateTime, todayYmd, download, nowIso, parseIntStrict } from './util.js';
import { $, $$, toast, guard, modal, confirmBox, blobSrc, pickFiles, errMsg, nav, onRoute, currentRoute, zoomImage } from './ui.js';
import { checkImageFile, saveOriginal } from './image.js';
import { evaluate, loadStoreData, buildSnapshot, statusBadge } from './logic.js';
import { simsCsv, storesCsv } from './csv.js';
import { renderStore } from './store.js';

const app = document.getElementById('app');
export let USER = { name: '', role: 'sales' };

async function refreshWho() {
  USER = await db.currentUser();
  $('#who').textContent = `${USER.name || 'ตั้งชื่อผู้ใช้'} · ${USER.role === 'central' ? 'ส่วนกลาง' : 'พนักงานขาย'}`;
}
async function askWho() {
  const r = await modal(`<h2>ผู้ใช้งาน</h2>
    <label class="f">ชื่อ</label><input type="text" id="un" value="${esc(USER.name)}">
    <label class="f">บทบาท</label><select id="ur"><option value="sales">พนักงานขาย</option><option value="central">ส่วนกลาง</option></select>
    <div class="row" style="margin-top:14px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">บันทึก</button></div>
    ${USER.name ? '<button class="btn danger" id="logout" style="width:100%;margin-top:10px">ออกจากระบบ</button>' : ''}`,
  { onMount: (m, close) => {
    m.querySelector('#ur').value = USER.role;
    m.querySelector('#ok').onclick = () => { const n = m.querySelector('#un').value.trim(); if (!n) return toast('ต้องใส่ชื่อ', true); close({ n, r: m.querySelector('#ur').value }); };
    const lo = m.querySelector('#logout'); if (lo) lo.onclick = () => close('logout');
  } });
  if (r === 'logout') {
    await db.audit({ entity: 'user', entityId: USER.name, action: 'logout' });
    await db.setSetting('userName', ''); await db.setSetting('role', 'sales'); await refreshWho(); nav(''); toast('ออกจากระบบแล้ว · ข้อมูลยังอยู่ในเครื่อง'); return;
  }
  if (r) { await db.setSetting('userName', r.n); await db.setSetting('role', r.r); await refreshWho(); route(); }
}

// ---------- Router ----------
async function route() {
  const h = currentRoute();
  const [p0, p1, p2] = h.split('/');
  window.scrollTo(0, 0);
  try {
    if (!USER.name) { app.innerHTML = '<div class="card"><h2>เริ่มใช้งาน</h2><p class="muted">ตั้งชื่อผู้ใช้ก่อน</p><button class="btn primary big" id="setu">ตั้งชื่อผู้ใช้</button></div>'; $('#setu').onclick = askWho; return; }
    if (!p0) return await home();
    if (p0 === 'stores') return await storesPage();
    if (p0 === 'r') return await roundPage(p1, p2 || 'summary');
    if (p0 === 's') return await renderStore(app, p1, p2 === 'photos' || p2 === 'field' ? 'field' : 'prep', USER); // เส้นทางรุ่นเก่า barcode/bill/review → prep
    if (p0 === 'central') return await centralPage();
    app.innerHTML = '<div class="card">ไม่พบหน้า</div>';
  } catch (e) { console.error(e); app.innerHTML = `<div class="card"><h2>เกิดข้อผิดพลาด</h2><p>${esc(errMsg(e))}</p><a class="btn" href="#/">กลับหน้าหลัก</a></div>`; }
}
onRoute(route);
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#/')) nav(location.hash); });
export function rerender() { route(); }

// ---------- หน้าหลัก ----------
async function home() {
  const rounds = (await db.all('rounds')).filter(r => USER.role === 'central' || r.owner === USER.name).sort((a, b) => b.workDate.localeCompare(a.workDate) || b.createdAt.localeCompare(a.createdAt));
  const rows = [];
  for (const r of rounds) {
    const rss = await db.roundStoresOf(r.id); let done = 0;
    for (const rs of rss) { if (evaluate(rs, await loadStoreData(rs)).status === 'complete') done++; }
    rows.push(`<a class="item" href="#/r/${r.id}"><div class="grow"><div class="t mono">${esc(r.code)}</div><div class="muted">${fmtDate(r.workDate)} · ${esc(r.owner)} · ${rss.length} ร้าน</div></div>
      <div class="right"><span class="badge ${rss.length && done === rss.length ? 'ok' : ''}">หลักฐานครบ ${done}/${rss.length}</span></div></a>`);
  }
  const est = await db.storageEstimate();
  app.innerHTML = `
    <div class="card"><h2>สร้างรอบงาน</h2>
      <div class="row"><div class="grow"><label class="f">วันที่</label><input type="date" id="wd" value="${todayYmd()}"></div>
      <div class="grow"><label class="f">ผู้รับผิดชอบ</label><input type="text" id="ow" value="${esc(USER.name)}"></div></div>
      <button class="btn primary big" id="mk" style="margin-top:10px">+ สร้างรอบงาน</button></div>
    <div class="row between"><h2 style="margin:0">รอบงาน</h2><div class="row"><a class="btn sm" href="#/stores">ร้านค้า</a>${USER.role === 'central' ? '<a class="btn sm" href="#/central">ส่วนกลาง</a>' : ''}</div></div>
    <div class="list" style="margin-top:10px">${rows.join('') || '<div class="muted">ยังไม่มีรอบงาน</div>'}</div>
    ${est ? `<p class="muted small" style="margin-top:16px">พื้นที่ในเครื่องที่ใช้ ${(est.usage / 1e6).toFixed(1)} MB จาก ${(est.quota / 1e6).toFixed(0)} MB</p>` : ''}`;
  $('#mk').onclick = guard(async () => {
    const owner = $('#ow').value.trim(); if (!owner) throw new Error('ต้องระบุผู้รับผิดชอบ');
    const r = await db.createRound({ workDate: $('#wd').value || todayYmd(), owner });
    nav(`#/r/${r.id}`);
  });
}

// ---------- ร้านค้า ----------
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

async function storesPage() {
  const stores = (await db.all('stores')).sort((a, b) => a.code.localeCompare(b.code));
  app.innerHTML = `<div class="row between"><h1>ร้านค้า (${stores.length})</h1><a class="btn sm" href="#/">กลับ</a></div>
    <div class="card"><div class="btn-grid"><button class="btn primary" id="add">+ เพิ่มร้าน</button><button class="btn" id="imp">นำเข้า CSV</button></div>
    <p class="muted small" style="margin:8px 0 0">CSV: คอลัมน์ เลขร้าน, ชื่อร้าน (มีหัวตารางหรือไม่ก็ได้)</p></div>
    <input type="search" id="q" placeholder="ค้นหาชื่อหรือเลขร้าน">
    <div class="list" id="sl" style="margin-top:10px"></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    $('#sl').innerHTML = stores.filter(s => !q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).map(s =>
      `<div class="item"><div class="grow"><div class="t"><span class="mono">${esc(s.code)}</span> · ${esc(s.name)}</div>${s.area ? `<div class="muted">${esc(s.area)}</div>` : ''}</div><button class="btn sm" data-ed="${s.id}">แก้ไข</button></div>`).join('') || '<div class="muted">ไม่พบร้าน</div>';
    $$('[data-ed]').forEach(b => b.onclick = () => storeForm(stores.find(s => s.id === b.dataset.ed)));
  };
  $('#q').oninput = draw; draw();
  $('#add').onclick = () => storeForm(null);
  $('#imp').onclick = guard(async () => {
    const [f] = await pickFiles({ accept: '.csv,text/csv', multiple: false }); if (!f) return;
    let rows = parseCsv(await f.text());
    if (rows.length && !/\d/.test(rows[0][0] || '')) rows = rows.slice(1); // หัวตาราง
    const existing = new Map(stores.map(s => [s.code, s])); const seen = new Set();
    const prev = rows.map(r => {
      const code = String(r[0] ?? '').trim(), name = String(r[1] ?? '').trim();
      let st = 'new';
      if (!code || !name) st = 'invalid'; else if (seen.has(code)) st = 'dup_file'; else if (existing.has(code)) st = 'exists';
      seen.add(code); return { code, name, area: (r[2] || '').trim(), st };
    });
    const label = { new: ['เพิ่มใหม่', 'ok'], invalid: ['ข้อมูลไม่ครบ', 'bad'], dup_file: ['ซ้ำในไฟล์', 'bad'], exists: ['มีอยู่แล้ว (ไม่นำเข้า)', 'warn'] };
    const nNew = prev.filter(p => p.st === 'new').length;
    const ok = await modal(`<h2>ตรวจก่อนนำเข้า</h2><p class="muted">${prev.length} แถว · นำเข้าได้ ${nNew} ร้าน</p>
      <div class="scroll-x"><table class="t"><tr><th>เลขร้าน</th><th>ชื่อร้าน</th><th>ผล</th></tr>${prev.map(p => `<tr><td class="mono">${esc(p.code)}</td><td>${esc(p.name)}</td><td><span class="badge ${label[p.st][1]}">${label[p.st][0]}</span></td></tr>`).join('')}</table></div>
      <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" data-close="go" ${nNew ? '' : 'disabled'}>นำเข้า ${nNew} ร้าน</button></div>`);
    if (ok !== 'go') return;
    for (const p of prev.filter(p => p.st === 'new')) await db.addStore(p);
    toast(`นำเข้าแล้ว ${nNew} ร้าน`); storesPage();
  });
}

async function storeForm(s) {
  const r = await modal(`<h2>${s ? 'แก้ไขร้าน' : 'เพิ่มร้าน'}</h2>
    <label class="f">เลขร้าน</label><input type="text" id="c" inputmode="numeric" value="${esc(s?.code || '')}">
    <label class="f">ชื่อร้าน</label><input type="text" id="n" value="${esc(s?.name || '')}">
    <label class="f">พื้นที่/หมายเหตุ</label><input type="text" id="a" value="${esc(s?.area || '')}">
    ${s ? '<p class="muted small">การแก้ไขไม่เปลี่ยนชื่อ/เลขร้านในรอบงานที่สร้างไปแล้ว</p>' : ''}
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">บันทึก</button></div>`,
  { onMount: (m, close) => m.querySelector('#ok').onclick = guard(async () => {
    const v = { code: m.querySelector('#c').value, name: m.querySelector('#n').value.trim(), area: m.querySelector('#a').value.trim() };
    if (s) await db.editStore(s.id, s.version, v); else await db.addStore(v);
    close(true);
  }) });
  if (r) storesPage();
}

// ---------- รอบงาน (V2) ----------
// summary = หน้าสรุปใบเบิก · prep = รายชื่อร้านสำหรับเตรียมเอกสาร · field = รายชื่อร้านสำหรับลงพื้นที่ · export = ดูตัวอย่าง/Export
async function roundPage(id, tab) {
  const round = await db.get('rounds', id); if (!round) throw new Error('ไม่พบรอบงาน');
  const rss = await db.roundStoresOf(id);
  const evs = new Map(); for (const rs of rss) evs.set(rs.id, evaluate(rs, await loadStoreData(rs)));
  if (tab === 'export') return exportPage(round, rss, evs);
  if (tab === 'prep' || tab === 'field') return storeListPage(round, rss, evs, tab);
  return summaryPage(round, rss, evs);
}

const chip = (ok, label) => `<span class="badge ${ok ? 'ok' : ''}">${ok ? '✓ ' : ''}${label}</span>`;

async function summaryPage(round, rss, evs) {
  const id = round.id;
  const reqFiles = (await db.roundFiles(id, 'requisition')).filter(f => f.role === 'original');
  const nDocs = rss.filter(r => evs.get(r.id).docsReady).length, nField = rss.filter(r => evs.get(r.id).hasField).length, nDone = rss.filter(r => evs.get(r.id).status === 'complete').length;
  app.innerHTML = `<div class="row between"><div><h1 class="mono" style="margin-bottom:0">${esc(round.code)}</h1><div class="muted">${fmtDate(round.workDate)} · ${esc(round.owner)}</div></div><a class="btn sm" href="#/">รอบงานทั้งหมด</a></div>
    <div class="card" style="margin-top:10px"><div class="row between"><h2 style="margin:0">ใบเบิก</h2><span class="badge ${reqFiles.length ? 'ok' : 'warn'}">${reqFiles.length ? reqFiles.length + ' ไฟล์' : 'ยังไม่มี'}</span></div>
      <div class="thumbs" style="margin-top:10px">${reqFiles.map(f => `<div class="thumb">${f.mime === 'application/pdf' ? `<button class="btn" style="width:100%;height:100%;color:var(--red)" data-pdf="${f.id}">PDF</button>` : `<img src="${blobSrc(f.id, f.blob)}" data-zoom-src>`}<button class="btn sm" style="position:absolute;top:4px;right:4px;min-height:28px;padding:0 8px" data-rmr="${f.id}">ลบ</button></div>`).join('')}</div>
      <div class="btn-grid" style="margin-top:10px"><button class="btn" id="reqcam">ถ่ายใบเบิก</button><button class="btn" id="requp">อัปโหลดภาพ/PDF</button></div>
      <div id="reqpv" class="pdfpages" style="margin-top:8px"></div></div>
    <div class="kv"><div><div class="k">ร้าน</div><div class="v num">${rss.length}</div></div><div><div class="k">เตรียมเอกสารแล้ว</div><div class="v num">${nDocs}</div></div><div><div class="k">มีรูปลงพื้นที่</div><div class="v num">${nField}</div></div><div><div class="k">หลักฐานครบ</div><div class="v num">${nDone}</div></div></div>
    <div style="display:grid;gap:8px;margin:12px 0"><a class="btn primary big" href="#/r/${id}/prep">เตรียมเอกสารรายร้าน</a><a class="btn primary big" href="#/r/${id}/field">ลงพื้นที่</a><a class="btn big" href="#/r/${id}/export">ดูตัวอย่าง / Export PDF</a></div>
    <div class="row between" style="margin:14px 0 8px"><h2 style="margin:0">ร้านในรอบงาน (${rss.length})</h2><button class="btn sm" id="pick">+ เลือกร้าน</button></div>
    <div class="list">${rss.map((rs, i) => { const ev = evs.get(rs.id); return `<div class="item"><div class="grow"><div class="t"><span class="mono">${esc(rs.storeCodeSnap)}</span> · ${esc(rs.storeNameSnap)}</div>
      <div class="statusline">${chip(ev.docsReady, 'เอกสาร')}${chip(ev.hasField, 'รูปลงพื้นที่')}<span class="muted">ซิม ${ev.simCount}</span></div></div>
      <div class="row" style="flex-direction:column;gap:2px"><button class="btn sm ghost" data-up="${rs.id}" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn sm ghost" data-dn="${rs.id}" ${i === rss.length - 1 ? 'disabled' : ''}>▼</button></div></div>`; }).join('') || '<div class="muted">ยังไม่มีร้าน</div>'}</div>`;

  const addReq = guard(async capture => {
    const files = await pickFiles({ accept: capture ? 'image/*' : 'image/*,application/pdf', capture });
    for (const f of files) {
      const err = checkImageFile(f, { allowPdf: true }); if (err) { toast(err, true); continue; }
      const r = await saveOriginal(f, { roundId: id, kind: 'requisition', captureSource: capture ? 'camera' : 'upload' });
      if (r.duplicate) toast(`${f.name} เคยอัปโหลดแล้ว`);
    }
    if (files.length) await db.audit({ entity: 'round', entityId: id, roundId: id, action: 'requisition_upload', after: files.map(f => f.name) });
    if (currentRoute() === `r/${id}`) summaryPage(round, rss, evs);
  });
  $('#reqcam').onclick = () => addReq(true); $('#requp').onclick = () => addReq(false);
  $$('[data-zoom-src]').forEach(i => i.onclick = () => zoomImage(i.src));
  $$('[data-pdf]').forEach(b => b.onclick = guard(async () => { const f = await db.get('files', b.dataset.pdf); await renderPdfPreview($('#reqpv'), f.blob); }));
  $$('[data-rmr]').forEach(b => b.onclick = guard(async () => {
    if (!(await confirmBox('ลบไฟล์ใบเบิกนี้?', { danger: true, ok: 'ลบ' }))) return;
    await db.update('files', b.dataset.rmr, null, x => ({ ...x, deletedAt: nowIso() }));
    await db.audit({ entity: 'file', entityId: b.dataset.rmr, roundId: id, action: 'delete' });
    summaryPage(round, rss, evs);
  }));
  $('#pick').onclick = guard(() => pickStores(round, rss));
  const swap = guard(async (rsId, dir) => {
    const i = rss.findIndex(x => x.id === rsId), j = i + dir; if (j < 0 || j >= rss.length) return;
    const a = await db.get('roundStores', rss[i].id), b = await db.get('roundStores', rss[j].id);
    await db.update('roundStores', a.id, a.version, { seq: b.seq }); await db.update('roundStores', b.id, b.version, { seq: a.seq });
    roundPage(id, 'summary');
  });
  $$('[data-up]').forEach(b => b.onclick = () => swap(b.dataset.up, -1));
  $$('[data-dn]').forEach(b => b.onclick = () => swap(b.dataset.dn, 1));
}

async function storeListPage(round, rss, evs, tab) {
  const isPrep = tab === 'prep';
  app.innerHTML = `<div class="row between"><div><h1 style="margin-bottom:0">${isPrep ? 'เตรียมเอกสารรายร้าน' : 'ลงพื้นที่ · เลือกร้านที่อยู่ตอนนี้'}</h1><div class="muted mono">${esc(round.code)}</div></div><a class="btn sm" href="#/r/${round.id}">หน้าสรุป</a></div>
    <div class="list" style="margin-top:12px">${rss.map(rs => { const ev = evs.get(rs.id); return `<a class="item" href="#/s/${rs.id}/${tab}"><div class="grow">
      <div class="t" style="font-size:17px"><span class="mono">${esc(rs.storeCodeSnap)}</span> · ${esc(rs.storeNameSnap)}</div>
      <div class="statusline"><span class="badge ${statusBadge(ev.status)}">${esc(ev.statusText)}</span>${isPrep ? `<span class="muted">ซิม ${ev.simCount} · บิล ${ev.counts.bill} ภาพ${ev.billChecked ? ' · ติ๊กแล้ว' : ''}</span>` : `<span class="muted">รูป ${ev.counts.field}${ev.docsReady ? '' : ' · เอกสารยังไม่ครบ'}</span>`}</div></div><span style="font-size:22px;color:var(--g5)">›</span></a>`; }).join('') || '<div class="muted">ยังไม่มีร้าน — เพิ่มที่หน้าสรุป</div>'}</div>`;
}

async function pickStores(round, rss) {
  const stores = (await db.all('stores')).sort((a, b) => a.code.localeCompare(b.code));
  if (!stores.length) { toast('ยังไม่มีร้านในระบบ — เพิ่มที่หน้า "ร้านค้า" ก่อน', true); nav('#/stores'); return; }
  const inRound = new Set(rss.map(r => r.storeId));
  const r = await modal(`<h2>เลือกร้าน</h2><input type="search" id="q" placeholder="ค้นหาชื่อหรือเลขร้าน"><div id="pl" style="margin-top:8px;max-height:55vh;overflow:auto"></div>
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">เพิ่มร้านที่เลือก</button></div>`,
  { onMount: (m, close) => {
    const sel = new Set();
    const draw = () => { const q = m.querySelector('#q').value.trim().toLowerCase();
      m.querySelector('#pl').innerHTML = stores.filter(s => !q || s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).map(s =>
        `<label class="cb"><input type="checkbox" value="${s.id}" ${inRound.has(s.id) ? 'checked disabled' : sel.has(s.id) ? 'checked' : ''}><span><span class="mono">${esc(s.code)}</span> · ${esc(s.name)}${inRound.has(s.id) ? ' <span class="badge">อยู่ในรอบแล้ว</span>' : ''}</span></label>`).join('');
      m.querySelectorAll('#pl input').forEach(i => i.onchange = () => i.checked ? sel.add(i.value) : sel.delete(i.value)); };
    m.querySelector('#q').oninput = draw; draw();
    m.querySelector('#ok').onclick = () => close([...sel]);
  } });
  if (r?.length) { await db.addStoresToRound(round.id, r); roundPage(round.id, 'summary'); }
}

// ---------- ดูตัวอย่าง / Export ----------
let pdfjs;
async function renderPdfPreview(el, blob) {
  if (!pdfjs) { pdfjs = await import(new URL('vendor/pdf.min.mjs', location.href).href); pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  el.innerHTML = `<p class="muted small">${doc.numPages} หน้า</p>`;
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i); const vp = p.getViewport({ scale: Math.min(2, (el.clientWidth || 360) * 2 / p.getViewport({ scale: 1 }).width) });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; el.appendChild(c);
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
}

async function exportPage(round, rss, evs) {
  const reqN = (await db.roundFiles(round.id, 'requisition')).filter(f => f.role === 'original').length;
  const missing = [...(reqN ? [] : ['ใบเบิก']), ...rss.filter(rs => evs.get(rs.id).missing.length).map(rs => `${rs.storeCodeSnap}: ${evs.get(rs.id).missing.join(', ')}`)];
  // ช่อง "เพิ่มหน้าสรุปข้อมูล" เริ่มต้นไม่เลือกทุกครั้งที่เปิดหน้านี้ (ไม่จำค่าเดิม)
  app.innerHTML = `<div class="row between"><div><h1 style="margin-bottom:0">ดูตัวอย่าง / Export</h1><div class="muted mono">${esc(round.code)}</div></div><a class="btn sm" href="#/r/${round.id}">หน้าสรุป</a></div>
    <div class="card" style="margin-top:10px">
      ${missing.length ? `<div class="small" style="color:var(--red)"><b>หลักฐานยังไม่ครบ — PDF จะเป็นฉบับร่าง</b><ul style="margin:4px 0 0;padding-left:18px">${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>` : '<b style="color:var(--ok)">หลักฐานครบทุกร้าน</b>'}
      <label class="f">ขอบเขต</label><select id="scope"><option value="">ทั้งรอบงาน</option>${rss.map(rs => `<option value="${rs.id}">ร้าน ${esc(rs.storeCodeSnap)} · ${esc(rs.storeNameSnap)}</option>`).join('')}</select>
      <label class="cb" style="margin-top:8px"><input type="checkbox" id="sum"> เพิ่มหน้าสรุปข้อมูล</label>
      <button class="btn primary big" id="mkpdf" style="margin-top:8px">ดูตัวอย่าง PDF</button>
      <div id="prog" class="muted small"></div></div>
    <div class="card hidden" id="pvcard"><div class="row between"><h2 style="margin:0">ตัวอย่าง</h2><button class="btn primary sm" id="pvdl">ดาวน์โหลด PDF</button></div><div class="pdfpages" id="pv" style="margin-top:8px"></div></div>
    <div class="card"><h2>CSV</h2><div class="btn-grid"><button class="btn" id="csv1">รายการซิม</button><button class="btn" id="csv2">สรุปรายร้าน</button></div></div>`;
  const scopeSnap = async () => { const v = $('#scope').value; return v ? buildSnapshot(round.id, { rsIds: [v] }) : buildSnapshot(round.id); };
  let current = null;
  const invalidate = () => { current = null; $('#pvcard').classList.add('hidden'); $('#pv').innerHTML = ''; };
  $('#scope').onchange = invalidate; $('#sum').onchange = invalidate;
  $('#mkpdf').onclick = guard(async () => {
    $('#mkpdf').disabled = true; $('#prog').textContent = 'กำลังสร้าง PDF…';
    try {
      const { createReport } = await import('./report.js');
      const snap = await scopeSnap(); const { file } = await createReport(snap, USER, { includeSummary: $('#sum').checked });
      current = file; $('#prog').textContent = file.name;
      $('#pvcard').classList.remove('hidden'); await renderPdfPreview($('#pv'), file.blob); $('#pvcard').scrollIntoView({ behavior: 'smooth' });
    } finally { $('#mkpdf').disabled = false; }
  });
  // ดาวน์โหลดไฟล์เดียวกับที่แสดงตัวอย่าง (ไม่สร้างใหม่)
  $('#pvdl').onclick = guard(async () => { if (!current) throw new Error('กด "ดูตัวอย่าง PDF" ก่อน'); await download(current.blob, current.name); });
  $('#csv1').onclick = guard(async () => { const s = await scopeSnap(); await download(new Blob([simsCsv(s)], { type: 'text/csv;charset=utf-8' }), `${round.code}-sims${s.scope === 'store' ? '-' + s.stores[0].code : ''}.csv`); });
  $('#csv2').onclick = guard(async () => { const s = await scopeSnap(); await download(new Blob([storesCsv(s)], { type: 'text/csv;charset=utf-8' }), `${round.code}-stores${s.scope === 'store' ? '-' + s.stores[0].code : ''}.csv`); });
}

// ---------- ส่วนกลาง (ดูอย่างเดียว · ข้อมูลในเครื่องนี้) ----------
async function centralPage() {
  if (USER.role !== 'central') { app.innerHTML = '<div class="card">หน้านี้สำหรับบทบาทส่วนกลาง</div>'; return; }
  const rounds = (await db.all('rounds')).sort((a, b) => b.workDate.localeCompare(a.workDate));
  let html = '';
  for (const r of rounds) {
    const rss = await db.roundStoresOf(r.id); const items = [];
    for (const rs of rss) {
      const ev = evaluate(rs, await loadStoreData(rs));
      items.push(`<a class="item" href="#/s/${rs.id}/prep"><div class="grow"><div class="t"><span class="mono">${esc(rs.storeCodeSnap)}</span> · ${esc(rs.storeNameSnap)}</div>
        <div class="statusline"><span class="badge ${statusBadge(ev.status)}">${esc(ev.statusText)}</span>${ev.missing.length ? `<span class="muted">ขาด: ${esc(ev.missing.join(', '))}</span>` : ''}</div></div></a>`);
    }
    if (items.length) html += `<h3><a href="#/r/${r.id}" class="mono">${esc(r.code)}</a> · ${fmtDate(r.workDate)} · ${esc(r.owner)}</h3><div class="list">${items.join('')}</div>`;
  }
  app.innerHTML = `<div class="row between"><h1>ส่วนกลาง</h1><a class="btn sm" href="#/">กลับ</a></div><p class="muted small">ข้อมูลในเครื่องนี้เท่านั้น ยังไม่มีระบบส่งส่วนกลาง</p>${html || '<p class="muted">ไม่มีรายการ</p>'}`;
}

// ---------- start ----------
$('#who').onclick = askWho;
await db.openDb(); db.requestPersist();
await refreshWho();
nav(location.hash.startsWith('#/') ? location.hash : '');
