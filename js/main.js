// ===== แอปหลัก: เก็บรูปหลักฐาน + สร้างรายงาน PDF =====
import './compat.js';
import * as db from './db.js';
import { esc, fmtDate, todayYmd, download, nowIso } from './util.js';
import { $, $$, toast, guard, modal, confirmBox, blobSrc, pickFiles, errMsg, nav, onRoute, currentRoute, zoomImage } from './ui.js';
import { checkImageFile, saveOriginal } from './image.js';
import { evaluate, loadStoreData, buildSnapshot, statusBadge, coverFile } from './logic.js';
import { renderStore } from './store.js';

const app = document.getElementById('app');
export let USER = { name: '' };

async function refreshWho() {
  USER = await db.currentUser();
  $('#who').textContent = USER.name || 'ตั้งชื่อผู้ใช้';
}
async function askWho() {
  const r = await modal(`<h2>ผู้ใช้งาน</h2>
    <label class="f">ชื่อ</label><input type="text" id="un" value="${esc(USER.name)}">
    <div class="row" style="margin-top:14px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">บันทึก</button></div>
    ${USER.name ? '<button class="btn danger" id="logout" style="width:100%;margin-top:10px">ออกจากระบบ</button>' : ''}`,
  { onMount: (m, close) => {
    m.querySelector('#ok').onclick = () => { const n = m.querySelector('#un').value.trim(); if (!n) return toast('ต้องใส่ชื่อ', true); close({ n }); };
    const lo = m.querySelector('#logout'); if (lo) lo.onclick = () => close('logout');
  } });
  if (r === 'logout') {
    await db.audit({ entity: 'user', entityId: USER.name, action: 'logout' });
    await db.setSetting('userName', ''); await refreshWho(); nav(''); toast('ออกจากระบบแล้ว · ข้อมูลยังอยู่ในเครื่อง'); return;
  }
  if (r) { await db.setSetting('userName', r.n); await refreshWho(); route(); }
}

// ---------- Router ----------
async function route() {
  const [p0, p1] = currentRoute().split('/');
  window.scrollTo(0, 0);
  try {
    if (!USER.name) { app.innerHTML = '<div class="card"><h2>เริ่มใช้งาน</h2><button class="btn primary big" id="setu">ตั้งชื่อผู้ใช้</button></div>'; $('#setu').onclick = askWho; return; }
    if (!p0) return await home();
    if (p0 === 'stores') return await storesPage();
    if (p0 === 'r') return await roundPage(p1);
    if (p0 === 's') return await renderStore(app, p1, USER);
    app.innerHTML = '<div class="card">ไม่พบหน้า</div>';
  } catch (e) { console.error(e); app.innerHTML = `<div class="card"><h2>เกิดข้อผิดพลาด</h2><p>${esc(errMsg(e))}</p><a class="btn" href="#/">กลับหน้าหลัก</a></div>`; }
}
onRoute(route);
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#/')) nav(location.hash); });
export function rerender() { route(); }

// ---------- หน้าหลัก ----------
async function home() {
  const rounds = (await db.all('rounds')).sort((a, b) => b.workDate.localeCompare(a.workDate) || b.createdAt.localeCompare(a.createdAt));
  const rows = [];
  for (const r of rounds) {
    const rss = await db.roundStoresOf(r.id); let done = 0;
    for (const rs of rss) { if (evaluate(rs, await loadStoreData(rs)).status === 'complete') done++; }
    rows.push(`<a class="item" href="#/r/${r.id}"><div class="grow"><div class="t mono">${esc(r.code)}</div><div class="muted">${fmtDate(r.workDate)} · ${esc(r.owner)} · ${rss.length} ร้าน</div></div>
      <div class="right"><span class="badge ${rss.length && done === rss.length ? 'ok' : ''}">เสร็จ ${done}/${rss.length}</span></div></a>`);
  }
  const est = await db.storageEstimate();
  app.innerHTML = `
    <div class="card"><h2>เริ่มงาน</h2>
      <div class="row"><div class="grow"><label class="f">วันที่</label><input type="date" id="wd" value="${todayYmd()}"></div>
      <div class="grow"><label class="f">ผู้รับผิดชอบ</label><input type="text" id="ow" value="${esc(USER.name)}"></div></div>
      <button class="btn primary big" id="mk" style="margin-top:10px">+ เริ่มงานใหม่</button></div>
    <div class="row between"><h2 style="margin:0">รอบงาน</h2><a class="btn sm" href="#/stores">ร้านค้า</a></div>
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

// ---------- รอบงาน: รูปหน้าแรก · ร้าน · สร้างรายงาน ----------
async function roundPage(id) {
  const round = await db.get('rounds', id); if (!round) throw new Error('ไม่พบรอบงาน');
  const rss = await db.roundStoresOf(id);
  const evs = new Map(); for (const rs of rss) evs.set(rs.id, evaluate(rs, await loadStoreData(rs)));
  const cover = await coverFile(id);
  const nDone = rss.filter(r => evs.get(r.id).status === 'complete').length;
  const missing = [...(cover ? [] : ['รูปหน้าแรก']), ...(rss.length ? [] : ['ยังไม่ได้เลือกร้าน']),
    ...rss.filter(rs => evs.get(rs.id).missing.length).map(rs => `${rs.storeCodeSnap}: ${evs.get(rs.id).missing.join(', ')}`)];
  const ready = !missing.length;
  const coverHtml = !cover ? '' : cover.mime === 'application/pdf'
    ? `<div class="thumb"><button class="btn" style="width:100%;height:100%;color:var(--red)" id="cpdf">PDF</button></div>`
    : `<div class="thumb"><img src="${blobSrc(cover.id, cover.blob)}" data-zoom-src></div>`;
  app.innerHTML = `<div class="row between"><div><h1 class="mono" style="margin-bottom:0">${esc(round.code)}</h1><div class="muted">${fmtDate(round.workDate)} · ${esc(round.owner)}</div></div><a class="btn sm" href="#/">รอบงานทั้งหมด</a></div>
    <div class="card" style="margin-top:10px"><div class="row between"><h2 style="margin:0">รูปหน้าแรก</h2><span class="badge ${cover ? 'ok' : 'warn'}">${cover ? 'มีแล้ว' : 'ยังไม่มี'}</span></div>
      <div class="thumbs" style="margin-top:10px">${coverHtml}</div><div id="cpv" class="pdfpages"></div>
      <div class="btn-grid" style="margin-top:10px"><button class="btn ${cover ? '' : 'primary'}" id="ccam">${cover ? 'ถ่ายใหม่' : 'ถ่ายรูป'}</button><button class="btn" id="cup">เลือกรูป</button></div></div>
    <div class="row between" style="margin:14px 0 8px"><h2 style="margin:0">ร้าน (เสร็จ ${nDone}/${rss.length})</h2><button class="btn sm" id="pick">+ เลือกร้าน</button></div>
    <div class="list">${rss.map((rs, i) => { const ev = evs.get(rs.id); return `<div class="item"><a class="grow" href="#/s/${rs.id}" style="text-decoration:none;color:inherit">
      <div class="t" style="font-size:17px"><span class="mono">${esc(rs.storeCodeSnap)}</span> · ${esc(rs.storeNameSnap)}</div>
      <div class="statusline"><span class="badge ${statusBadge(ev.status)}">${esc(ev.statusText)}</span></div></a>
      <div class="row" style="flex-direction:column;gap:2px"><button class="btn sm ghost" data-up="${rs.id}" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn sm ghost" data-dn="${rs.id}" ${i === rss.length - 1 ? 'disabled' : ''}>▼</button></div></div>`; }).join('') || '<div class="muted">ยังไม่มีร้าน</div>'}</div>
    <div class="card" style="margin-top:14px"><h2>รายงาน PDF</h2>
      ${ready ? '' : `<div class="small" style="color:var(--red)"><b>ยังไม่ครบ</b><ul style="margin:4px 0 8px;padding-left:18px">${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>`}
      <button class="btn primary big" id="gen" ${ready ? '' : 'disabled'}>Generate Report</button>
      <div id="prog" class="muted small"></div></div>
    <div class="card hidden" id="pvcard"><div class="row between"><h2 style="margin:0">ตัวอย่าง</h2><button class="btn primary sm" id="pvdl">ดาวน์โหลด PDF</button></div><div class="pdfpages" id="pv" style="margin-top:8px"></div></div>`;

  const setCover = guard(async capture => {
    const [f] = await pickFiles({ accept: 'image/*', multiple: false, capture: capture ? 'environment' : false }); if (!f) return;
    const err = checkImageFile(f); if (err) throw new Error(err);
    const fresh = capture && Date.now() - (f.lastModified || 0) < 5 * 60e3;
    const r = await saveOriginal(f, { roundId: id, kind: 'requisition', captureSource: fresh ? 'camera' : 'upload' });
    // รูปหน้าแรกมีได้ 1 รูป: เก็บรูปใหม่ แล้วซ่อนรูปเดิม
    for (const o of await db.roundFiles(id, 'requisition')) if (o.id !== r.file.id) await db.update('files', o.id, null, x => ({ ...x, deletedAt: nowIso(), deleteReason: 'เปลี่ยนรูปหน้าแรก' }));
    await db.audit({ entity: 'round', entityId: id, roundId: id, action: 'cover_set', after: f.name });
    if (currentRoute() === `r/${id}`) roundPage(id);
  });
  $('#ccam').onclick = () => setCover(true); $('#cup').onclick = () => setCover(false);
  const cp = $('#cpdf'); if (cp) cp.onclick = guard(async () => renderPdfPreview($('#cpv'), cover.blob, 1));
  $$('[data-zoom-src]').forEach(i => i.onclick = () => zoomImage(i.src));
  $('#pick').onclick = guard(() => pickStores(round, rss));
  const swap = guard(async (rsId, dir) => {
    const i = rss.findIndex(x => x.id === rsId), j = i + dir; if (j < 0 || j >= rss.length) return;
    const a = await db.get('roundStores', rss[i].id), b = await db.get('roundStores', rss[j].id);
    await db.update('roundStores', a.id, a.version, { seq: b.seq }); await db.update('roundStores', b.id, b.version, { seq: a.seq });
    roundPage(id);
  });
  $$('[data-up]').forEach(b => b.onclick = () => swap(b.dataset.up, -1));
  $$('[data-dn]').forEach(b => b.onclick = () => swap(b.dataset.dn, 1));
  let current = null;
  $('#gen').onclick = guard(async () => {
    $('#gen').disabled = true; $('#prog').textContent = 'กำลังสร้าง PDF…';
    try {
      const { createReport } = await import('./report.js');
      const snap = await buildSnapshot(id);
      if (!snap.complete) throw new Error('ข้อมูลยังไม่ครบ');
      const { file } = await createReport(snap, USER);
      current = file; $('#prog').textContent = file.name;
      $('#pvcard').classList.remove('hidden'); await renderPdfPreview($('#pv'), file.blob); $('#pvcard').scrollIntoView({ behavior: 'smooth' });
    } finally { $('#gen').disabled = false; }
  });
  // ดาวน์โหลดไฟล์เดียวกับที่แสดงตัวอย่าง
  $('#pvdl').onclick = guard(async () => { if (!current) throw new Error('กด Generate Report ก่อน'); await download(current.blob, current.name); });
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
  if (r?.length) { await db.addStoresToRound(round.id, r); roundPage(round.id); }
}

// ---------- ตัวอย่าง PDF ----------
let pdfjs;
async function renderPdfPreview(el, blob, maxPages = Infinity) {
  if (!pdfjs) { pdfjs = await import(new URL('vendor/pdf.min.mjs', location.href).href); pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  el.innerHTML = `<p class="muted small">${doc.numPages} หน้า</p>`;
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const p = await doc.getPage(i); const vp = p.getViewport({ scale: Math.min(2, (el.clientWidth || 360) * 2 / p.getViewport({ scale: 1 }).width) });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; el.appendChild(c);
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
}

// ---------- start ----------
$('#who').onclick = askWho;
await db.openDb(); db.requestPersist();
await refreshWho();
nav(location.hash.startsWith('#/') ? location.hash : '');
