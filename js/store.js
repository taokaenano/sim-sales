// ===== หน้าร้าน =====
// 1) ก่อนเข้าร้าน: รูปบาร์โค้ด + รูปบิล/สลิป → ยืนยันข้อมูลร้าน
// 2) ที่ร้าน: ถ่ายรูปหน้าร้านหรือเซลฟี่ → ลายน้ำรหัสร้าน + วันที่ + เวลา → เสร็จ
import * as db from './db.js';
import { esc, fmtDateTime, nowIso } from './util.js';
import { $, $$, toast, guard, confirmBox, blobSrc, pickFiles, zoomImage, nav, currentRoute } from './ui.js';
import { checkImageFile, saveOriginal, makeDerived, ensureDerived, takenAt } from './image.js';
import { evaluate, loadStoreData, prepKey } from './logic.js';

let USER = { name: '' };

export async function renderStore(app, rsId, user) {
  USER = user;
  const rs = await db.get('roundStores', rsId); if (!rs) throw new Error('ไม่พบร้านในรอบงาน');
  const round = await db.get('rounds', rs.roundId);
  const data = await loadStoreData(rs); const ev = evaluate(rs, data);
  const route = currentRoute();
  const reload = () => { if (currentRoute() === route) renderStore(app, rsId, user); };
  const all = await db.roundStoresOf(rs.roundId);
  const nxt = all[all.findIndex(x => x.id === rs.id) + 1] || null;
  const orig = kind => data.files.filter(f => f.kind === kind && f.role === 'original');
  const barcode = orig('barcode'), bill = orig('bill'), field = orig('field');
  const shownField = [];
  for (const o of field) shownField.push({ o, d: await ensureDerived(o, rs) });

  const thumbs = (list, attr) => list.map(f => `<div class="thumb"><img src="${blobSrc(f.id, f.blob)}" data-zoom-src><button class="btn sm" style="position:absolute;top:4px;right:4px;min-height:28px;padding:0 8px" ${attr}="${f.id}">ลบ</button></div>`).join('');
  const box = (title, kind, list) => `<div style="margin-top:12px"><div class="row between"><b>${title}</b><span class="badge ${list.length ? 'ok' : ''}">${list.length ? list.length + ' รูป' : 'ยังไม่มี'}</span></div>
    <div class="thumbs" style="margin-top:8px">${thumbs(list, 'data-rm')}</div>
    <div class="btn-grid" style="margin-top:8px"><button class="btn" data-cam="${kind}">ถ่ายรูป</button><button class="btn" data-up="${kind}">เลือกรูป</button></div></div>`;

  app.innerHTML = `<div class="row between" style="margin-bottom:8px"><a class="btn sm" href="#/r/${round.id}">← ${esc(round.code)}</a><span class="muted small">ร้านที่ ${all.findIndex(x => x.id === rs.id) + 1}/${all.length}</span></div>
    <div class="storebar"><div><div class="code">${esc(rs.storeCodeSnap)}</div><div class="name">${esc(rs.storeNameSnap)}</div></div><span class="st">${esc(ev.statusText)}</span></div>
    <div id="progress" class="card hidden"><div id="ptext" class="small"></div></div>

    <div class="card"><h2 style="margin:0">ก่อนเข้าร้าน</h2>
      ${box('รูปบาร์โค้ด', 'barcode', barcode)}
      ${box('รูปบิล / สลิป', 'bill', bill)}
      <div style="margin-top:14px">${ev.confirmed
        ? `<div class="row between"><b style="color:var(--ok)">✓ ยืนยันข้อมูลร้านแล้ว</b><span class="small muted">${esc(rs.prepConfirm.by || '')} · ${fmtDateTime(rs.prepConfirm.at)}</span></div>`
        : `<button class="btn primary big" id="confirm" ${ev.hasPhotos ? '' : 'disabled'}>ยืนยันข้อมูลร้าน</button>`}</div>
    </div>

    <div class="card" style="${ev.confirmed ? '' : 'opacity:.5'}"><div class="row between"><h2 style="margin:0">รูปหน้าร้าน</h2>${ev.confirmed && !field.length ? '<span class="badge info">รอถ่ายรูปหน้าร้าน</span>' : ''}</div>
      ${shownField.map(({ o, d }) => `<div style="position:relative;margin-top:8px"><img src="${blobSrc(d.id, d.blob)}" data-zoom-src style="width:100%;border-radius:10px;display:block"><button class="btn sm" style="position:absolute;top:6px;right:6px;min-height:28px;padding:0 8px" data-rm="${o.id}">ลบ</button>${takenAt(o) ? '' : '<div class="small" style="color:var(--red)">ไม่พบเวลาถ่าย</div>'}</div>`).join('')}
      <div class="btn-grid" style="margin-top:8px"><button class="btn ${field.length ? '' : 'primary'} big" id="shop" ${ev.confirmed ? '' : 'disabled'}>${field.length ? 'ถ่ายใหม่ · หน้าร้าน' : 'ถ่ายรูปหน้าร้าน'}</button><button class="btn big" id="selfie" ${ev.confirmed ? '' : 'disabled'}>${field.length ? 'ถ่ายใหม่ · เซลฟี่' : 'ถ่ายเซลฟี่กับร้าน'}</button></div>
    </div>
    ${data.files.length ? '' : '<button class="btn ghost" id="rmrs" style="width:100%;margin-top:6px">นำออกจากรอบ</button>'}
    <div class="bottombar"><a class="btn" href="#/r/${round.id}">รายชื่อร้าน</a>${nxt ? `<a class="btn primary" href="#/s/${nxt.id}">ร้านถัดไป ›</a>` : `<a class="btn primary" href="#/r/${round.id}">สร้างรายงาน ›</a>`}</div>`;

  const prog = t => { if (currentRoute() !== route) return; $('#progress').classList.remove('hidden'); $('#ptext').textContent = t; };
  // ผูกร้านตั้งแต่ตอนกดปุ่ม — ถ้าผู้ใช้เปลี่ยนหน้าระหว่างบันทึก รูปก็ยังเข้าร้านนี้และลายน้ำเป็นของร้านนี้
  const bound = rs;
  const unconfirm = async reason => {
    const cur = await db.get('roundStores', bound.id);
    if (!cur.prepConfirm?.key) return;
    await db.update('roundStores', bound.id, cur.version, x => ({ ...x, prepConfirm: null }));
    await db.audit({ entity: 'roundStore', entityId: bound.id, roundId: bound.roundId, action: 'prep_unconfirm', reason });
  };
  const add = async (kind, capture) => {
    const files = await pickFiles({ accept: 'image/*', multiple: kind !== 'field', capture });
    const saved = [];
    for (const f of files) {
      const err = checkImageFile(f); if (err) { toast(err, true); continue; }
      prog('กำลังบันทึกรูป…');
      // นับเป็น "ถ่ายผ่านแอป" เฉพาะไฟล์ที่เพิ่งถูกสร้าง (กันกรณีเครื่องที่ไม่มีกล้องเปิดคลังรูปแทน แล้วได้เวลาอัปโหลดเป็นเวลาถ่าย)
      const fresh = capture && Date.now() - (f.lastModified || 0) < 5 * 60e3;
      const r = await saveOriginal(f, { roundId: bound.roundId, rsId: bound.id, kind, captureSource: fresh ? 'camera' : 'upload' });
      if (r.duplicate) { toast('รูปนี้มีอยู่แล้ว'); continue; }
      saved.push(r.file);
    }
    return saved;
  };
  $$('[data-cam],[data-up]').forEach(b => b.onclick = guard(async () => {
    const kind = b.dataset.cam || b.dataset.up;
    const saved = await add(kind, b.dataset.cam ? 'environment' : false);
    if (saved.length) {
      await unconfirm(`เพิ่มรูป${kind === 'bill' ? 'บิล' : 'บาร์โค้ด'}`);
      await db.audit({ entity: 'roundStore', entityId: bound.id, roundId: bound.roundId, action: `add_${kind}`, after: saved.map(f => f.name) });
    }
    reload();
  }));
  const shoot = facing => guard(async () => {
    const saved = await add('field', facing);
    if (!saved.length) return reload();
    const f = saved[0];
    prog('กำลังใส่ลายน้ำ…');
    await makeDerived(f, { storeCode: bound.storeCodeSnap, storeName: bound.storeNameSnap });
    // ร้านละ 1 รูป: ถ่ายใหม่แทนรูปเดิม
    for (const o of field) await softDelete(o, 'ถ่ายรูปหน้าร้านใหม่');
    await db.audit({ entity: 'roundStore', entityId: bound.id, roundId: bound.roundId, action: 'add_field', after: { name: f.name, facing } });
    toast(`บันทึกรูปหน้าร้าน ${bound.storeCodeSnap} แล้ว`);
    reload();
  });
  $('#shop').onclick = shoot('environment');
  $('#selfie').onclick = shoot('user');
  const c = $('#confirm');
  if (c) c.onclick = guard(async () => {
    const cur = await db.get('roundStores', rs.id); const fresh = await loadStoreData(cur);
    if (!evaluate(cur, fresh).hasPhotos) throw new Error('ต้องมีรูปบาร์โค้ดและรูปบิลก่อน');
    await db.update('roundStores', rs.id, cur.version, x => ({ ...x, prepConfirm: { key: prepKey(fresh.files), at: nowIso(), by: USER.name } }));
    await db.audit({ entity: 'roundStore', entityId: rs.id, roundId: rs.roundId, action: 'prep_confirm' });
    toast('ยืนยันข้อมูลร้านแล้ว'); reload();
  });
  $$('[data-rm]').forEach(b => b.onclick = guard(async () => {
    const f = data.files.find(x => x.id === b.dataset.rm);
    if (!(await confirmBox('ลบรูปนี้?', { danger: true, ok: 'ลบ' }))) return;
    await softDelete(f, 'ลบรูป');
    if (f.kind !== 'field') await unconfirm('ลบรูป');
    reload();
  }));
  $$('[data-zoom-src]').forEach(i => i.onclick = () => zoomImage(i.src));
  const rm = $('#rmrs');
  if (rm) rm.onclick = guard(async () => {
    if (!(await confirmBox(`นำร้าน ${rs.storeCodeSnap} ออกจากรอบนี้?`, { ok: 'นำออก' }))) return;
    await db.removeStoreFromRound(rs.id); toast('นำออกจากรอบแล้ว'); nav(`#/r/${rs.roundId}`);
  });
}

async function softDelete(f, reason) {
  for (const x of [f, ...(await db.derivedOf(f.id))]) await db.update('files', x.id, null, y => ({ ...y, deletedAt: nowIso(), deleteReason: reason }));
  await db.audit({ entity: 'file', entityId: f.id, roundId: f.roundId, action: 'delete', reason });
}
