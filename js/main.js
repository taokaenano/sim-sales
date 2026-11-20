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
  const stores = await db.all('stores');
  app.innerHTML = `<div class="row between"><h1>ร้านค้า (${stores.length})</h1><a class="btn sm" href="#/">กลับ</a></div>
    <div class="btn-grid"><button class="btn primary" id="add">+ เพิ่มร้าน</button><button class="btn" id="imp">นำเข้า Excel / CSV</button></div>
    <input type="search" id="q" placeholder="ค้นหารหัสหรือชื่อร้าน" style="margin-top:10px" autocomplete="off">
    <div class="list" id="sl" style="margin-top:10px"></div>`;
  const draw = () => {
    const q = $('#q').value;
    const hits = searchStores(stores, q);
    $('#sl').innerHTML = hits.map(s => `<button class="item hit" data-ed="${s.id}">${hitLine(s)}</button>`).join('')
      || `<div class="muted">ไม่พบร้าน</div>`;
    $$('[data-ed]').forEach(b => b.onclick = () => storeForm(stores.find(s => s.id === b.dataset.ed)));
  };
  $('#q').oninput = draw; draw();
  $('#add').onclick = () => storeForm(null, $('#q').value);
  $('#imp').onclick = guard(importStores);
}

// ค้นหาแบบบางส่วน (partial) ทั้งรหัสและชื่อร้าน — รหัสที่ขึ้นต้นตรงกันขึ้นก่อน
export function searchStores(stores, q, limit = 50) {
  const k = q.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!k) return [...stores].sort((a, b) => a.code.localeCompare(b.code)).slice(0, limit);
  const rank = s => { const c = s.code.toLowerCase(), n = s.name.toLowerCase();
    return c === k ? 0 : c.startsWith(k) ? 1 : n.startsWith(k) ? 2 : c.includes(k) ? 3 : n.includes(k) ? 4 : 9; };
  return stores.map(s => [rank(s), s]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0] || a[1].code.localeCompare(b[1].code)).slice(0, limit).map(x => x[1]);
}
const hitLine = s => `<span class="mono">${esc(s.code)}</span> <span class="muted">|</span> ${esc(s.name)}`;

// ---------- นำเข้าร้านจาก Excel / CSV ----------
let xlsxLib;
function loadXlsx() {
  return xlsxLib ||= new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'vendor/xlsx.full.min.js'; sc.onload = () => res(window.XLSX); sc.onerror = () => { xlsxLib = null; rej(new Error('โหลดตัวอ่าน Excel ไม่สำเร็จ')); }; document.head.appendChild(sc); });
}
async function readRows(f) {
  if (/\.csv$/i.test(f.name) || f.type === 'text/csv') return parseCsv(await f.text());
  const XLSX = await loadXlsx();
  const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // raw:false = ใช้ข้อความตามที่แสดงใน Excel (เลข 0 ข้างหน้ารหัสร้านไม่หาย)
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }).map(r => r.map(x => String(x ?? ''))).filter(r => r.some(x => x.trim()));
}
const CODE_H = /^(shop\s*code|store\s*code|code|รหัส\s*ร้าน|เลข\s*ร้าน|รหัส)$/i, NAME_H = /^(shop\s*name|store\s*name|name|ชื่อ\s*ร้าน|ชื่อ)$/i;
async function importStores() {
  const [f] = await pickFiles({ accept: '.xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel', multiple: false }); if (!f) return;
  let rows = await readRows(f);
  // หาคอลัมน์จากหัวตาราง (อยู่ลำดับไหนก็ได้) — ไม่มีหัวตาราง: คอลัมน์ 1 = รหัส, 2 = ชื่อ
  let ci = 0, ni = 1;
  const hi = rows.slice(0, 5).findIndex(r => r.some(x => CODE_H.test(x.trim())) && r.some(x => NAME_H.test(x.trim())));
  if (hi >= 0) { ci = rows[hi].findIndex(x => CODE_H.test(x.trim())); ni = rows[hi].findIndex(x => NAME_H.test(x.trim())); rows = rows.slice(hi + 1); }
  const stores = await db.all('stores');
  const existing = new Map(stores.map(s => [s.code, s])); const seen = new Set();
  const prev = rows.map(r => {
    const code = String(r[ci] ?? '').trim(), name = String(r[ni] ?? '').trim().replace(/\s+/g, ' ');
    let st = 'new';
    if (!code || !name) st = 'invalid'; else if (seen.has(code)) st = 'dup_file';
    else if (existing.has(code)) st = existing.get(code).name === name ? 'same' : 'rename';
    seen.add(code); return { code, name, st, old: existing.get(code)?.name };
  });
  const label = { new: ['เพิ่มใหม่', 'ok'], rename: ['อัปเดตชื่อ', 'info'], same: ['ไม่เปลี่ยน', ''], invalid: ['ข้อมูลไม่ครบ', 'bad'], dup_file: ['ซ้ำในไฟล์', 'bad'] };
  const nNew = prev.filter(p => p.st === 'new').length, nRen = prev.filter(p => p.st === 'rename').length;
  const ok = await modal(`<h2>ตรวจก่อนนำเข้า</h2><p class="muted">${esc(f.name)} · ${prev.length} แถว · เพิ่มใหม่ ${nNew} · อัปเดตชื่อ ${nRen}</p>
    <div class="scroll-x" style="max-height:55vh;overflow:auto"><table class="t"><tr><th>รหัสร้าน</th><th>ชื่อร้าน</th><th>ผล</th></tr>${prev.map(p => `<tr><td class="mono">${esc(p.code)}</td><td>${esc(p.name)}${p.st === 'rename' ? `<div class="muted small">เดิม: ${esc(p.old)}</div>` : ''}</td><td><span class="badge ${label[p.st][1]}">${label[p.st][0]}</span></td></tr>`).join('')}</table></div>
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" data-close="go" ${nNew + nRen ? '' : 'disabled'}>นำเข้า ${nNew + nRen} ร้าน</button></div>`);
  if (ok !== 'go') return;
  for (const p of prev) {
    if (p.st === 'new') await db.addStore(p);
    else if (p.st === 'rename') { const s = existing.get(p.code); await db.editStore(s.id, s.version, { name: p.name }); }
  }
  await db.audit({ entity: 'store', entityId: f.name, action: 'import', after: { added: nNew, renamed: nRen } });
  toast(`นำเข้าแล้ว · เพิ่มใหม่ ${nNew} · อัปเดตชื่อ ${nRen}`); route();
}

/** ฟอร์มเพิ่ม/แก้ไขร้าน — คืนค่าร้านที่บันทึกแล้ว; prefill = คำที่พิมพ์ค้นหาไว้ */
async function storeForm(s, prefill = '', { reload = true } = {}) {
  const pf = prefill.trim(), isCode = /^[0-9A-Za-z-]+$/.test(pf) && /\d/.test(pf);
  const r = await modal(`<h2>${s ? 'แก้ไขร้าน' : 'เพิ่มร้านใหม่'}</h2>
    <label class="f">Shop Code</label><input type="text" id="c" value="${esc(s?.code || (isCode ? pf : ''))}" autocomplete="off">
    <label class="f">Shop Name</label><input type="text" id="n" value="${esc(s?.name || (!isCode ? pf : ''))}" autocomplete="off">
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">บันทึก</button></div>`,
  { onMount: (m, close) => {
    setTimeout(() => (m.querySelector(isCode || s ? '#n' : '#c')).focus(), 50);
    m.querySelector('#ok').onclick = guard(async () => {
      const v = { code: m.querySelector('#c').value, name: m.querySelector('#n').value.trim().replace(/\s+/g, ' ') };
      close(s ? await db.editStore(s.id, s.version, v) : await db.addStore(v));
    });
  } });
  if (r && reload) storesPage();
  return r;
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
    <input type="search" id="rq" placeholder="ค้นหาร้าน: รหัสหรือชื่อ" style="margin-top:14px;font-size:17px" autocomplete="off" enterkeyhint="search">
    <div class="list" id="hits" style="margin-top:8px"></div>
    <div class="row between" style="margin:14px 0 8px"><h2 style="margin:0">ร้านในรอบนี้ (เสร็จ ${nDone}/${rss.length})</h2></div>
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
  // ค้นหาร้าน: ร้านในรอบนี้แตะแล้วเปิดเลย · ร้านในระบบแตะแล้วเพิ่มเข้ารอบและเปิด · ไม่พบ → เพิ่มร้านใหม่
  const allStores = await db.all('stores');
  const inRound = new Map(rss.map(rs => [rs.storeId, rs]));
  const openNew = async storeId => { const [rs] = await db.addStoresToRound(id, [storeId]); nav(`#/s/${rs.id}`); };
  const drawHits = () => {
    const q = $('#rq').value.trim();
    if (!q) { $('#hits').innerHTML = ''; return; }
    const hits = searchStores(allStores, q, 30);
    $('#hits').innerHTML = hits.map(st => { const rs = inRound.get(st.id);
      return rs ? `<a class="item hit" href="#/s/${rs.id}"><div class="grow">${hitLine(st)}</div><span class="badge ${statusBadge(evs.get(rs.id).status)}">${esc(evs.get(rs.id).statusText)}</span></a>`
        : `<button class="item hit" data-add="${st.id}"><div class="grow">${hitLine(st)}</div><span class="muted">+</span></button>`; }).join('')
      + `<button class="btn ${hits.length ? '' : 'primary big'}" id="newshop" style="width:100%">+ เพิ่มร้านใหม่</button>`;
    $$('[data-add]').forEach(b => b.onclick = guard(() => openNew(b.dataset.add)));
    $('#newshop').onclick = guard(async () => { const st = await storeForm(null, $('#rq').value, { reload: false }); if (st) await openNew(st.id); });
  };
  $('#rq').oninput = drawHits;
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
