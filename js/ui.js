// ===== ตัวช่วยหน้าจอ =====
import { esc } from './util.js';
import { ConflictError } from './db.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let toastT;
export function toast(msg, err = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  document.body.appendChild(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), err ? 6000 : 3000);
}

export function errMsg(e) {
  if (e instanceof ConflictError) return e.message;
  if (e?.name === 'QuotaExceededError') return 'พื้นที่เก็บข้อมูลในเครื่องเต็ม — Export แล้วลบรอบงานเก่าก่อน';
  return e?.message || String(e);
}

/** ห่อ handler: แสดงข้อผิดพลาดเป็นภาษาไทย ไม่ล้มเงียบ */
export function guard(fn) {
  return async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); toast(errMsg(e), true); } };
}

export function modal(html, { onMount } = {}) {
  return new Promise(resolve => {
    const back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = `<div class="modal">${html}</div>`;
    document.body.appendChild(back);
    const close = v => { back.remove(); resolve(v); };
    back.addEventListener('click', e => { if (e.target === back) close(null); });
    back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => close(b.dataset.close === '' ? null : b.dataset.close)));
    onMount?.(back.firstElementChild, close);
  });
}

export async function confirmBox(text, { ok = 'ยืนยัน', danger = false, reason = false, reasonLabel = 'เหตุผล' } = {}) {
  return modal(`<h2>${esc(text)}</h2>${reason ? `<label class="f">${esc(reasonLabel)}</label><textarea id="mreason"></textarea>` : ''}
    <div class="row" style="margin-top:14px"><button class="btn grow" data-close>ยกเลิก</button><button class="btn grow ${danger ? 'danger' : 'primary'}" id="mok">${esc(ok)}</button></div>`,
  { onMount: (m, close) => m.querySelector('#mok').onclick = () => {
    if (reason) { const r = m.querySelector('#mreason').value.trim(); if (!r) { toast('ต้องระบุเหตุผล', true); return; } close(r); } else close(true);
  } });
}

export function zoomImage(src) {
  modal(`<img class="zoomimg" src="${src}"><div class="row" style="margin-top:10px"><button class="btn grow" data-close>ปิด</button></div>`);
}

const urls = new Map();
/** object URL ของ Blob (แคชตาม id) */
export function blobSrc(id, blob) {
  if (!blob) return '';
  let u = urls.get(id); if (!u) { u = URL.createObjectURL(blob); urls.set(id, u); } return u;
}

// ช่องรับไฟล์ตัวเดียวที่ผูกกับหน้าเว็บถาวร — Safari บน iPhone ไม่ส่งรูปจากกล้องกลับเข้าช่องที่ไม่ได้อยู่ในหน้า
let picker;
export function pickFiles({ accept = 'image/*', multiple = true, capture = false } = {}) {
  if (!picker) {
    picker = document.createElement('input'); picker.type = 'file'; picker.id = 'file-picker';
    picker.setAttribute('aria-hidden', 'true'); picker.tabIndex = -1;
    picker.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(picker);
  }
  const i = picker;
  i.value = ''; i.accept = accept; i.multiple = multiple;
  if (capture) i.setAttribute('capture', 'environment'); else i.removeAttribute('capture');
  return new Promise(res => {
    let done = false;
    const finish = f => { if (done) return; done = true; i.onchange = null; i.oncancel = null; res(f); };
    i.onchange = () => {
      const f = [...(i.files || [])];
      if (f.length && /image/.test(accept)) toast(f.length > 1 ? `กำลังบันทึกภาพ ${f.length} ภาพ…` : 'กำลังบันทึกภาพ…');
      finish(f);
    };
    i.oncancel = () => finish([]);
    i.click();
  });
}

export function badgeFor(status) {
  return { ok: 'ok', submitted: 'ok', ready: 'ok', needs_fix: 'bad', other: 'warn', collecting: 'info', prepared: 'info', preparing: 'warn', none: '' }[status] ?? '';
}

// ===== เส้นทางในหน้า (ไม่พึ่ง location.hash เพราะหน้าที่โฮสต์ในกรอบอาจไม่ส่งต่อ hash) =====
let _route = '';
const _subs = [];
export function currentRoute() { return _route; }
export function onRoute(fn) { _subs.push(fn); }
export function nav(path) {
  _route = String(path || '').replace(/^#\/?/, '');
  // จำหน้าปัจจุบันไว้ใน URL ถ้าเบราว์เซอร์โหลดหน้าใหม่ (เช่น ระหว่างเปิดกล้อง) จะกลับมาหน้าเดิม
  try { history.replaceState(null, '', '#/' + _route); } catch {}
  _subs.forEach(f => f());
}
document.addEventListener('click', e => {
  const a = e.target.closest?.('a[href^="#/"]');
  if (!a) return;
  e.preventDefault(); nav(a.getAttribute('href'));
});
