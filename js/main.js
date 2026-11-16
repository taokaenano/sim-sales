// ===== แอปหลัก: เส้นทาง + หน้ารอบงาน / ร้านค้า / ส่วนกลาง / Export =====
import './compat.js';
import * as db from './db.js';
import { esc, fmtDate, fmtDateTime, todayYmd, download, nowIso, parseIntStrict } from './util.js';
import { $, $$, toast, guard, modal, confirmBox, blobSrc, pickFiles, badgeFor, errMsg, nav, onRoute, currentRoute } from './ui.js';
import { checkImageFile, saveOriginal } from './image.js';
import { evaluate, loadStoreData, buildSnapshot, isClosedResult, OUTCOME_TEXT, REVIEW_TEXT } from './logic.js';
import { simsCsv, billsCsv } from './csv.js';
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
    if (p0 === 'r') return await roundPage(p1, p2 || 'prep');
    if (p0 === 's') return await renderStore(app, p1, p2 || 'barcode', USER);
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
    const rss = await db.roundStoresOf(r.id); let done = 0, fix = 0;
    for (const rs of rss) { const ev = evaluate(rs, await loadStoreData(rs)); if (isClosedResult(ev)) done++; if (ev.status === 'needs_fix') fix++; }
    rows.push(`<a class="item" href="#/r/${r.id}"><div class="grow"><div class="t mono">${esc(r.code)}</div><div class="muted">${fmtDate(r.workDate)} · ${esc(r.owner)} · ${rss.length} ร้าน</div></div>
      <div class="right">${r.status === 'closed' ? '<span class="badge ok">ปิดรอบแล้ว</span>' : `<span class="badge">${done}/${rss.length} มีผล</span>`}${fix ? ` <span class="badge bad">แก้ไข ${fix}</span>` : ''}</div></a>`);
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
    nav(`#/r/${r.id}/prep`);
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

// ---------- รอบงาน ----------
async function roundPage(id, tab) {
  const round = await db.get('rounds', id); if (!round) throw new Error('ไม่พบรอบงาน');
  const rss = await db.roundStoresOf(id);
  const evs = new Map(); for (const rs of rss) evs.set(rs.id, evaluate(rs, await loadStoreData(rs)));
  const closed = round.status === 'closed';
  const head = `<div class="row between"><div><h1 class="mono" style="margin-bottom:0">${esc(round.code)}</h1><div class="muted">${fmtDate(round.workDate)} · ${esc(round.owner)} ${closed ? '· <span class="badge ok">ปิดรอบแล้ว</span>' : ''}</div></div><a class="btn sm" href="#/">กลับ</a></div>
    <div class="tabs" style="margin-top:10px">${[['prep', 'เตรียมก่อนออกพื้นที่'], ['field', 'ลงพื้นที่'], ['export', 'สรุป / Export']].map(([k, t]) => `<a href="#/r/${id}/${k}" class="${tab === k ? 'on' : ''}">${t}</a>`).join('')}</div>`;
  if (tab === 'export') return exportPage(round, rss, evs, head);

  const onlyOpen = sessionStorage.getItem('onlyOpen') === '1';
  const storeList = () => rss.filter(rs => !onlyOpen || !isClosedResult(evs.get(rs.id))).map((rs, i) => {
    const ev = evs.get(rs.id);
    const target = tab === 'prep' ? 'barcode' : 'bill';
    return `<div class="item"><a class="grow" style="text-decoration:none;color:inherit" href="#/s/${rs.id}/${target}">
      <div class="t"><span class="mono">${esc(rs.storeCodeSnap)}</span> · ${esc(rs.storeNameSnap)}</div>
      <div class="statusline"><span class="badge ${badgeFor(ev.status)}">${esc(ev.statusText)}</span><span class="muted">ซิม ${ev.preparedCount}${ev.billConfirmed ? ` · บิล ${ev.billSum.simQty}` : ''} · รูป ${ev.counts.field}</span></div></a>
      ${tab === 'prep' && !closed ? `<div class="row" style="flex-direction:column;gap:2px"><button class="btn sm ghost" data-up="${rs.id}" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn sm ghost" data-dn="${rs.id}" ${i === rss.length - 1 ? 'disabled' : ''}>▼</button></div>` : ''}</div>`;
  }).join('') || '<div class="muted">ยังไม่มีร้าน</div>';

  let body = '';
  if (tab === 'prep') {
    const reqFiles = (await db.roundFiles(id, 'requisition')).filter(f => f.role === 'original');
    const lines = round.requisition?.lines || [];
    body = `<div class="card"><div class="row between"><h2 style="margin:0">ใบเบิกสินค้า</h2><span class="badge ${reqFiles.length ? 'ok' : 'warn'}">${reqFiles.length} ไฟล์</span></div>
      <div class="thumbs" style="margin-top:10px">${reqFiles.map(f => `<div class="thumb">${f.mime === 'application/pdf' ? '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-weight:700;color:var(--red)">PDF</div>' : `<img src="${blobSrc(f.id, f.blob)}">`}<div class="cap">${esc(f.name)}</div></div>`).join('')}</div>
      ${closed ? '' : `<div class="btn-grid" style="margin-top:10px"><button class="btn" id="reqcam">ถ่ายใบเบิก</button><button class="btn" id="requp">อัปโหลดภาพ/PDF</button></div>`}
      <h3>ยอดเบิก (กรอกด้วยมือ)</h3>
      <div class="scroll-x"><table class="t"><tr><th>สินค้า</th><th>Part code</th><th class="right">จำนวนเบิก</th><th></th></tr>
      ${lines.map(l => `<tr><td>${esc(l.productName)}</td><td class="mono">${esc(l.partCode)}</td><td class="right num">${l.qtyRequisition ?? '<span class="muted">ไม่มีข้อมูล</span>'}</td><td>${closed ? '' : `<button class="btn sm ghost" data-dl="${l.id}">ลบ</button>`}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">ยังไม่มี</td></tr>'}</table></div>
      ${closed ? '' : '<button class="btn sm" id="addline" style="margin-top:8px">+ เพิ่มบรรทัด</button>'}
      <p class="muted small">ยังไม่ได้กระทบยอดกับใบเบิกอัตโนมัติ</p></div>`;
  } else {
    const pending = rss.filter(rs => !isClosedResult(evs.get(rs.id))).length;
    body = `<div class="card kv"><div><div class="k">ร้านทั้งหมด</div><div class="v num">${rss.length}</div></div><div><div class="k">มีผลแล้ว</div><div class="v num">${rss.length - pending}</div></div><div><div class="k">ค้าง</div><div class="v num">${pending}</div></div></div>`;
  }
  app.innerHTML = head + body + `
    <div class="row between" style="margin:14px 0 8px"><h2 style="margin:0">ร้านในรอบงาน (${rss.length})</h2>
      <label class="cb small"><input type="checkbox" id="oo" ${onlyOpen ? 'checked' : ''}> เฉพาะที่ยังไม่เสร็จ</label></div>
    ${tab === 'prep' && !closed ? '<button class="btn primary big" id="pick" style="margin-bottom:10px">เลือกร้านเข้ารอบงาน</button>' : ''}
    <div class="list">${storeList()}</div>
    ${tab === 'field' && !closed ? '<div style="margin-top:16px"><button class="btn big" id="close">ปิดรอบงาน</button></div>' : ''}`;

  $('#oo').onchange = e => { sessionStorage.setItem('onlyOpen', e.target.checked ? '1' : '0'); roundPage(id, tab); };
  if (tab === 'prep' && !closed) {
    const addReq = guard(async (capture) => {
      const files = await pickFiles({ accept: capture ? 'image/*' : 'image/*,application/pdf', capture });
      for (const f of files) {
        const err = checkImageFile(f, { allowPdf: true }); if (err) { toast(err, true); continue; }
        const r = await saveOriginal(f, { roundId: id, kind: 'requisition', captureSource: capture ? 'camera' : 'upload' });
        if (r.duplicate) toast(`${f.name} เคยอัปโหลดแล้ว`);
      }
      await db.audit({ entity: 'round', entityId: id, roundId: id, action: 'requisition_upload', after: files.map(f => f.name) });
      roundPage(id, tab);
    });
    $('#reqcam').onclick = () => addReq(true); $('#requp').onclick = () => addReq(false);
    $('#addline').onclick = guard(async () => {
      const v = await modal(`<h2>เพิ่มยอดเบิก</h2><label class="f">ชื่อสินค้า</label><input type="text" id="pn">
        <label class="f">Part code</label><input type="text" id="pc" placeholder="เช่น PRC0005821">
        <label class="f">จำนวนเบิก (ซิม)</label><input type="text" inputmode="numeric" id="pq">
        <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" id="ok">เพิ่ม</button></div>`,
      { onMount: (m, close) => m.querySelector('#ok').onclick = () => {
        const q = m.querySelector('#pq').value.trim(); const qi = q === '' ? null : parseIntStrict(q);
        if (q !== '' && qi == null) return toast('จำนวนต้องเป็นจำนวนเต็ม', true);
        close({ productName: m.querySelector('#pn').value.trim(), partCode: m.querySelector('#pc').value.trim(), qtyRequisition: qi });
      } });
      if (!v) return;
      await db.update('rounds', id, round.version, r => { r.requisition.lines.push({ id: crypto.randomUUID(), ...v }); return r; });
      await db.audit({ entity: 'round', entityId: id, roundId: id, action: 'requisition_line_add', after: v });
      roundPage(id, tab);
    });
    $$('[data-dl]').forEach(b => b.onclick = guard(async () => {
      const r = await confirmBox('ลบบรรทัดยอดเบิกนี้?', { danger: true, ok: 'ลบ', reason: true }); if (!r) return;
      const before = lines.find(l => l.id === b.dataset.dl);
      await db.update('rounds', id, round.version, x => { x.requisition.lines = x.requisition.lines.filter(l => l.id !== b.dataset.dl); return x; });
      await db.audit({ entity: 'round', entityId: id, roundId: id, action: 'requisition_line_delete', before, reason: r });
      roundPage(id, tab);
    }));
    $('#pick').onclick = guard(() => pickStores(round, rss));
    const swap = guard(async (rsId, dir) => {
      const i = rss.findIndex(x => x.id === rsId), j = i + dir; if (j < 0 || j >= rss.length) return;
      const a = rss[i], b = rss[j];
      await db.update('roundStores', a.id, a.version, { seq: b.seq }); await db.update('roundStores', b.id, b.version, { seq: a.seq });
      roundPage(id, tab);
    });
    $$('[data-up]').forEach(b => b.onclick = () => swap(b.dataset.up, -1));
    $$('[data-dn]').forEach(b => b.onclick = () => swap(b.dataset.dn, 1));
  }
  if (tab === 'field' && !closed) $('#close').onclick = guard(() => closeRound(round, rss, evs));
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
  if (r?.length) { await db.addStoresToRound(round.id, r); roundPage(round.id, 'prep'); }
}

async function closeRound(round, rss, evs) {
  const notDone = rss.filter(rs => !isClosedResult(evs.get(rs.id)));
  if (!rss.length) throw new Error('รอบงานยังไม่มีร้าน');
  if (notDone.length) throw new Error(`ยังปิดรอบไม่ได้: มี ${notDone.length} ร้านที่ยังไม่มีผลชัดเจน (${notDone.map(r => r.storeCodeSnap).join(', ')})`);
  const exAll = rss.flatMap(rs => evs.get(rs.id).exceptions.map(e => `${rs.storeCodeSnap}: ${e.text}${e.reason ? ' — ' + e.reason : ''}`));
  const others = rss.filter(rs => evs.get(rs.id).status === 'other').map(rs => `${rs.storeCodeSnap}: ${OUTCOME_TEXT[rs.outcome]} — ${rs.outcomeReason}`);
  const ok = await modal(`<h2>ปิดรอบงาน ${esc(round.code)}</h2>
    <h3>ข้อยกเว้น (${exAll.length})</h3><ul class="small">${exAll.map(x => `<li>${esc(x)}</li>`).join('') || '<li>ไม่มี</li>'}</ul>
    <h3>ร้านที่ไม่ได้ส่ง (${others.length})</h3><ul class="small">${others.map(x => `<li>${esc(x)}</li>`).join('') || '<li>ไม่มี</li>'}</ul>
    <p class="muted small">ไฟล์ทั้งหมดบันทึกในเครื่องแล้ว</p>
    <div class="row" style="margin-top:12px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn primary grow" data-close="go">ยืนยันปิดรอบงาน</button></div>`);
  if (ok !== 'go') return;
  await db.update('rounds', round.id, round.version, { status: 'closed', closedAt: nowIso(), closedBy: USER.name });
  await db.audit({ entity: 'round', entityId: round.id, roundId: round.id, action: 'close', after: { exceptions: exAll.length } });
  toast('ปิดรอบงานแล้ว'); nav(`#/r/${round.id}/export`);
}

// ---------- Export ----------
let pdfjs;
async function renderPdfPreview(el, blob) {
  if (!pdfjs) { pdfjs = await import(new URL('vendor/pdf.min.mjs', location.href).href); pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href; }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  el.innerHTML = `<p class="muted small">ตัวอย่างจากไฟล์ PDF ที่สร้างจริง · ${doc.numPages} หน้า</p>`;
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i); const vp = p.getViewport({ scale: Math.min(2, (el.clientWidth || 360) * 2 / p.getViewport({ scale: 1 }).width) });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; el.appendChild(c);
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
}

async function exportPage(round, rss, evs, head) {
  const reports = (await db.byIndex('reports', 'roundId', round.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const snapAll = await buildSnapshot(round.id);
  const latestRound = reports.find(r => r.scope === 'round');
  app.innerHTML = head + `
    <div class="card"><h2>สรุปรอบงาน</h2>
      <div class="kv">${[['ร้าน', rss.length], ['ส่งแล้ว', rss.filter(r => evs.get(r.id).status === 'submitted').length], ['ไม่ได้ส่ง', rss.filter(r => evs.get(r.id).status === 'other').length], ['ค้าง', rss.filter(r => !isClosedResult(evs.get(r.id))).length], ['ข้อยกเว้น', rss.reduce((a, r) => a + evs.get(r.id).exceptions.length, 0)]].map(([k, v]) => `<div><div class="k">${k}</div><div class="v num">${v}</div></div>`).join('')}</div>
      <h3>รายการค้าง / ข้อยกเว้น</h3><ul class="small">${rss.flatMap(rs => { const ev = evs.get(rs.id); return [...ev.checks.filter(c => !c.ok && !isClosedResult(ev)).map(c => `<li><b class="mono">${esc(rs.storeCodeSnap)}</b> ยังขาด: ${esc(c.label)}</li>`), ...ev.exceptions.map(e => `<li><b class="mono">${esc(rs.storeCodeSnap)}</b> ข้อยกเว้น: ${esc(e.text)}${e.reason ? ' — ' + esc(e.reason) : ''}</li>`)]; }).join('') || '<li>ไม่มี</li>'}</ul></div>
    <div class="card"><h2>Export</h2>
      <label class="f">ขอบเขต</label><select id="scope"><option value="">ทั้งรอบงาน</option>${rss.map(rs => `<option value="${rs.id}">ร้าน ${esc(rs.storeCodeSnap)} · ${esc(rs.storeNameSnap)}</option>`).join('')}</select>
      ${!snapAll.complete ? '<p class="small" style="color:var(--red)">หลักฐานยังไม่ครบ — PDF จะติดป้าย "ฉบับร่าง / หลักฐานไม่ครบ"</p>' : ''}
      ${latestRound && latestRound.snapshotHash !== snapAll.hash ? `<p class="small" style="color:var(--warn)">รายงานล่าสุด ${esc(latestRound.code)} v${latestRound.version} ไม่ใช่ข้อมูลล่าสุดแล้ว (ข้อมูลถูกแก้หลังสร้าง)</p>` : ''}
      <div class="btn-grid" style="margin-top:10px"><button class="btn primary" id="mkpdf">สร้าง PDF</button><button class="btn" id="csv1">CSV รายการซิม</button><button class="btn" id="csv2">CSV สรุปบิล</button></div>
      <p class="muted small">เปิด CSV ใน Excel: ใช้ Data › From Text/CSV แล้วตั้งคอลัมน์รหัส (S/N, เบอร์, เลขร้าน) เป็น Text เพื่อไม่ให้เลขศูนย์หน้า/เลขยาวเพี้ยน</p>
      <div id="prog" class="muted small"></div></div>
    <div class="card"><h2>รายงานที่สร้างแล้ว</h2><div class="list">${reports.map(r => `<div class="item"><div class="grow"><div class="t mono">${esc(r.code)} v${r.version}</div><div class="muted">${fmtDateTime(r.createdAt)} · ${esc(r.createdBy)} ${r.isDraft ? '<span class="badge warn">ฉบับร่าง</span>' : '<span class="badge ok">ครบ</span>'} ${r.scope === 'round' && r.snapshotHash !== snapAll.hash ? '<span class="badge">ไม่ใช่ข้อมูลล่าสุด</span>' : ''}</div></div><button class="btn sm" data-dlr="${r.fileId}">ดาวน์โหลด</button><button class="btn sm" data-pv="${r.fileId}">ดู</button></div>`).join('') || '<div class="muted">ยังไม่มี</div>'}</div></div>
    <div class="card hidden" id="pvcard"><div class="row between"><h2 style="margin:0">Preview</h2><button class="btn sm" id="pvdl">ดาวน์โหลด PDF</button></div><div class="pdfpages" id="pv" style="margin-top:8px"></div></div>`;

  const scopeSnap = async () => { const v = $('#scope').value; return v ? buildSnapshot(round.id, { rsIds: [v] }) : snapAll; };
  const showPv = async (file) => { $('#pvcard').classList.remove('hidden'); $('#pvdl').onclick = guard(() => download(file.blob, file.name)); await renderPdfPreview($('#pv'), file.blob); $('#pvcard').scrollIntoView({ behavior: 'smooth' }); };
  $('#mkpdf').onclick = guard(async () => {
    $('#mkpdf').disabled = true; $('#prog').textContent = 'กำลังสร้าง PDF…';
    try {
      const { createReport } = await import('./report.js');
      const snap = await scopeSnap(); const { file } = await createReport(snap, USER);
      $('#prog').textContent = `สร้างแล้ว: ${file.name}`; await showPv(file);
    } finally { $('#mkpdf').disabled = false; }
  });
  $('#csv1').onclick = guard(async () => { const s = await scopeSnap(); await download(new Blob([simsCsv(s)], { type: 'text/csv;charset=utf-8' }), `${round.code}-sims${s.scope === 'store' ? '-' + s.stores[0].code : ''}.csv`); });
  $('#csv2').onclick = guard(async () => { const s = await scopeSnap(); await download(new Blob([billsCsv(s)], { type: 'text/csv;charset=utf-8' }), `${round.code}-bills${s.scope === 'store' ? '-' + s.stores[0].code : ''}.csv`); });
  $$('[data-dlr]').forEach(b => b.onclick = guard(async () => { const f = await db.get('files', b.dataset.dlr); await download(f.blob, f.name); }));
  $$('[data-pv]').forEach(b => b.onclick = guard(async () => showPv(await db.get('files', b.dataset.pv))));
}

// ---------- ส่วนกลาง ----------
async function centralPage() {
  if (USER.role !== 'central') { app.innerHTML = '<div class="card">หน้านี้สำหรับบทบาทส่วนกลาง</div>'; return; }
  const rounds = (await db.all('rounds')).sort((a, b) => b.workDate.localeCompare(a.workDate));
  const filter = sessionStorage.getItem('cf') || 'all';
  let html = '';
  for (const r of rounds) {
    const rss = await db.roundStoresOf(r.id); const items = [];
    for (const rs of rss) {
      const ev = evaluate(rs, await loadStoreData(rs));
      if (filter === 'ex' && !ev.exceptions.length && ev.status !== 'needs_fix') continue;
      if (filter === 'submitted' && ev.status !== 'submitted') continue;
      items.push(`<a class="item" href="#/s/${rs.id}/review"><div class="grow"><div class="t"><span class="mono">${esc(rs.storeCodeSnap)}</span> · ${esc(rs.storeNameSnap)}</div>
        <div class="statusline"><span class="badge ${badgeFor(ev.status)}">${esc(ev.statusText)}</span>${ev.exceptions.length ? `<span class="badge bad">ข้อยกเว้น ${ev.exceptions.length}</span>` : ''}${rs.review ? `<span class="badge ${rs.review.status === 'returned' ? 'bad' : rs.review.status === 'reviewed' ? 'ok' : 'warn'}">${REVIEW_TEXT[rs.review.status]}</span>` : ''}</div></div></a>`);
    }
    if (items.length) html += `<h3><a href="#/r/${r.id}/export" class="mono">${esc(r.code)}</a> · ${fmtDate(r.workDate)} · ${esc(r.owner)}</h3><div class="list">${items.join('')}</div>`;
  }
  app.innerHTML = `<div class="row between"><h1>ส่วนกลางตรวจหลักฐาน</h1><a class="btn sm" href="#/">กลับ</a></div>
    <select id="cf"><option value="all">ทุกร้าน</option><option value="ex">มีข้อยกเว้น / ต้องแก้ไข</option><option value="submitted">ส่งแล้ว</option></select>
    <div style="margin-top:8px">${html || '<p class="muted">ไม่มีรายการ</p>'}</div>`;
  $('#cf').value = filter; $('#cf').onchange = e => { sessionStorage.setItem('cf', e.target.value); centralPage(); };
}

// ---------- start ----------
$('#who').onclick = askWho;
await db.openDb(); db.requestPersist();
await refreshWho();
nav(location.hash.startsWith('#/') ? location.hash : '');
