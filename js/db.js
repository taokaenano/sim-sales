// ===== ชั้นข้อมูล (Repository) =====
// เวอร์ชันเดโมเก็บทุกอย่างใน IndexedDB ของเบราว์เซอร์เครื่องนี้ (ข้อมูล + ไฟล์ภาพแบบ Blob)
// ทุกฟังก์ชันที่หน้าจอเรียกใช้อยู่ในไฟล์นี้ไฟล์เดียว เพื่อให้เปลี่ยนเป็น API เซิร์ฟเวอร์ (D1/R2) ได้ภายหลัง
// โดยไม่ต้องแก้หน้าจอ — ดู schema/d1-schema.sql
import { uid, nowIso } from './util.js';

const DB_NAME = 'sim-evidence-demo';
const DB_VER = 1;
const STORES = {
  stores: { keyPath: 'id', indexes: [['code', 'code', { unique: true }]] },
  rounds: { keyPath: 'id', indexes: [['code', 'code', { unique: true }]] },
  roundStores: { keyPath: 'id', indexes: [['roundId', 'roundId']] },
  files: { keyPath: 'id', indexes: [['roundId', 'roundId'], ['rsId', 'rsId'], ['parentId', 'parentId']] },
  sims: { keyPath: 'id', indexes: [['roundId', 'roundId'], ['rsId', 'rsId']] },
  moves: { keyPath: 'id', indexes: [['simId', 'simId'], ['roundId', 'roundId']] },
  bills: { keyPath: 'id', indexes: [['rsId', 'rsId']] },
  audit: { keyPath: 'id', indexes: [['entityId', 'entityId'], ['roundId', 'roundId']] },
  reports: { keyPath: 'id', indexes: [['roundId', 'roundId']] },
  settings: { keyPath: 'key' },
};

let _db;
export function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [n, k, o] of def.indexes || []) os.createIndex(n, k, o || {});
      }
    };
    r.onsuccess = () => { _db = r.result; _db.onversionchange = () => _db.close(); res(_db); };
    r.onerror = () => rej(r.error);
  });
}

function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function txDone(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('ยกเลิกธุรกรรม')); }); }

export async function get(store, id) { const db = await openDb(); return reqP(db.transaction(store).objectStore(store).get(id)); }
export async function all(store) { const db = await openDb(); return reqP(db.transaction(store).objectStore(store).getAll()); }
export async function byIndex(store, index, value) {
  const db = await openDb(); return reqP(db.transaction(store).objectStore(store).index(index).getAll(value));
}

export class ConflictError extends Error {
  constructor(current) { super('ข้อมูลถูกแก้ไขจากหน้าจออื่นแล้ว กรุณาโหลดใหม่ก่อนบันทึก'); this.current = current; }
}

/** เพิ่มรายการใหม่ (version = 1) */
export async function insert(store, obj) {
  const db = await openDb();
  const rec = { createdAt: nowIso(), updatedAt: nowIso(), version: 1, ...obj, id: obj.id || uid() };
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).add(rec);
  await txDone(tx);
  return rec;
}

/** แก้ไขแบบตรวจเวอร์ชัน: ถ้าเวอร์ชันในฐานข้อมูลไม่ตรงกับที่ถืออยู่ จะไม่เขียนทับ */
export async function update(store, id, expectedVersion, patchFn) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  const cur = await reqP(os.get(id));
  if (!cur) { tx.abort(); throw new Error('ไม่พบข้อมูล'); }
  if (expectedVersion != null && cur.version !== expectedVersion) { tx.abort(); throw new ConflictError(cur); }
  const next = typeof patchFn === 'function' ? patchFn(structuredClone(cur)) : { ...cur, ...patchFn };
  next.version = cur.version + 1; next.updatedAt = nowIso();
  os.put(next);
  await txDone(tx);
  return next;
}

export async function put(store, obj) {
  const db = await openDb(); const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(obj); await txDone(tx); return obj;
}

export async function del(store, id) {
  const db = await openDb(); const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id); await txDone(tx);
}

// ===== ผู้ใช้ (เดโม: ยังไม่มีระบบล็อกอิน) =====
export async function getSetting(key, dflt = null) { const r = await get('settings', key); return r ? r.value : dflt; }
export async function setSetting(key, value) { return put('settings', { key, value }); }
export async function currentUser() {
  return { name: await getSetting('userName', ''), role: await getSetting('role', 'sales') };
}

// ===== Audit Log =====
export async function audit({ entity, entityId, roundId = null, action, before = null, after = null, reason = '' }) {
  const u = await currentUser();
  return insert('audit', { at: nowIso(), actor: u.name || '(ไม่ระบุชื่อ)', role: u.role, entity, entityId, roundId, action, before, after, reason });
}

// ===== ร้านค้า =====
export function normalizeStoreCode(code) { return String(code ?? '').trim(); }

export async function findStoreByCode(code) {
  const db = await openDb();
  return reqP(db.transaction('stores').objectStore('stores').index('code').get(normalizeStoreCode(code)));
}

export async function addStore({ code, name, area = '', note = '' }) {
  code = normalizeStoreCode(code); name = String(name || '').trim();
  if (!code) throw new Error('ต้องมีเลขร้าน');
  if (!name) throw new Error('ต้องมีชื่อร้าน');
  if (await findStoreByCode(code)) throw new Error(`เลขร้าน ${code} มีอยู่แล้ว`);
  const s = await insert('stores', { code, name, area, note, active: true });
  await audit({ entity: 'store', entityId: s.id, action: 'create', after: { code, name } });
  return s;
}

export async function editStore(id, version, patch, reason = '') {
  if (patch.code != null) {
    patch.code = normalizeStoreCode(patch.code);
    const other = await findStoreByCode(patch.code);
    if (other && other.id !== id) throw new Error(`เลขร้าน ${patch.code} ซ้ำกับร้าน ${other.name}`);
  }
  const before = await get('stores', id);
  const s = await update('stores', id, version, patch);
  await audit({ entity: 'store', entityId: id, action: 'edit', before: { code: before.code, name: before.name }, after: { code: s.code, name: s.name }, reason });
  return s;
}

// ===== รอบงาน =====
export async function createRound({ workDate, owner }) {
  const ymd = workDate.replace(/-/g, '');
  const existing = (await all('rounds')).filter(r => r.code.startsWith('R' + ymd));
  let n = existing.length + 1, code;
  do { code = `R${ymd}-${String(n).padStart(2, '0')}`; n++; } while (existing.some(r => r.code === code));
  const r = await insert('rounds', {
    code, workDate, owner, status: 'open',
    requisition: { lines: [], reconciled: false, note: '' },
  });
  await audit({ entity: 'round', entityId: r.id, roundId: r.id, action: 'create', after: { code, workDate, owner } });
  return r;
}

export async function roundStoresOf(roundId) {
  return (await byIndex('roundStores', 'roundId', roundId)).sort((a, b) => a.seq - b.seq);
}

/** เพิ่มร้านเข้ารอบงาน — เก็บชื่อ/เลขร้าน ณ เวลานั้นไว้ (snapshot) */
export async function addStoresToRound(roundId, storeIds) {
  const cur = await roundStoresOf(roundId);
  let seq = cur.length ? Math.max(...cur.map(x => x.seq)) + 1 : 1;
  const added = [];
  for (const sid of storeIds) {
    if (cur.some(x => x.storeId === sid)) continue;
    const s = await get('stores', sid);
    const rs = await insert('roundStores', {
      roundId, storeId: sid, seq: seq++, storeCodeSnap: s.code, storeNameSnap: s.name,
      stage: 'none', outcome: null, outcomeReason: '', expectedCount: null,
      prep: { checkedAgainstImage: false, confirmedBy: null, confirmedAt: null },
      delivery: { selectionMode: null, confirmedBy: null, confirmedAt: null },
      exceptionReasons: {}, review: null, submittedAt: null, submittedBy: null,
    });
    added.push(rs);
  }
  if (added.length) await audit({ entity: 'round', entityId: roundId, roundId, action: 'add_stores', after: added.map(a => a.storeCodeSnap) });
  return added;
}

// ===== ไฟล์ =====
export async function filesOf(rsId, kind) {
  return (await byIndex('files', 'rsId', rsId)).filter(f => !f.deletedAt && (!kind || f.kind === kind)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function roundFiles(roundId, kind) {
  return (await byIndex('files', 'roundId', roundId)).filter(f => !f.deletedAt && (!kind || f.kind === kind)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function derivedOf(fileId) { return (await byIndex('files', 'parentId', fileId)).filter(f => !f.deletedAt); }

// ===== ซิม =====
export async function simsOfRs(rsId) {
  return (await byIndex('sims', 'rsId', rsId)).filter(s => !s.deletedAt).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt));
}
export async function simsOfRound(roundId) { return (await byIndex('sims', 'roundId', roundId)).filter(s => !s.deletedAt); }

/** หา S/N ซ้ำในรอบงาน (ใช้ S/N ซึ่งเป็นรหัสเฉพาะซิม ไม่ใช้ Part no.) */
export async function findSimBySerial(roundId, serial) {
  if (!serial) return null;
  return (await simsOfRound(roundId)).find(s => s.serial === serial) || null;
}

// ===== บิล =====
export async function billOf(rsId) {
  return (await byIndex('bills', 'rsId', rsId)).filter(b => !b.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage, quota: e.quota, free: e.quota - e.usage };
}
export async function requestPersist() { try { return await navigator.storage?.persist?.(); } catch { return false; } }
