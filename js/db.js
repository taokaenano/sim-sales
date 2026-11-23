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

// ===== เก็บไฟล์เป็นไบต์ (ArrayBuffer) ไม่ใช่ Blob =====
// Safari บน iPhone มีปัญหา Blob ที่เก็บใน IndexedDB เปิดไม่ได้ภายหลัง จึงแปลงเป็นไบต์ก่อนเก็บ และแปลงกลับตอนอ่าน
const BLOB_FIELDS = ['blob', 'cropBlob', 'warpedBlob'];
async function pack(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec };
  for (const k of BLOB_FIELDS) {
    const v = out[k];
    if (v instanceof Blob) out[k] = { __bytes: await v.arrayBuffer(), type: v.type || 'application/octet-stream', name: v.name || null };
  }
  return out;
}
function unpack(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  for (const k of BLOB_FIELDS) {
    const v = rec[k];
    if (v && v.__bytes) rec[k] = new Blob([v.__bytes], { type: v.type });
  }
  return rec;
}

export async function get(store, id) { const db = await openDb(); return unpack(await reqP(db.transaction(store).objectStore(store).get(id))); }
export async function all(store) { const db = await openDb(); return (await reqP(db.transaction(store).objectStore(store).getAll())).map(unpack); }
export async function byIndex(store, index, value) {
  const db = await openDb(); return (await reqP(db.transaction(store).objectStore(store).index(index).getAll(value))).map(unpack);
}

export class ConflictError extends Error {
  constructor(current) { super('ข้อมูลถูกแก้ไขจากหน้าจออื่นแล้ว กรุณาโหลดใหม่ก่อนบันทึก'); this.current = current; }
}

/** เพิ่มรายการใหม่ (version = 1) */
export async function insert(store, obj) {
  const db = await openDb();
  const rec = { createdAt: nowIso(), updatedAt: nowIso(), version: 1, ...obj, id: obj.id || uid() };
  const packed = await pack(rec);
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).add(packed);
  await txDone(tx);
  return rec;
}

/** แก้ไขแบบตรวจเวอร์ชัน: ถ้าเวอร์ชันในฐานข้อมูลไม่ตรงกับที่ถืออยู่ จะไม่เขียนทับ */
export async function update(store, id, expectedVersion, patchFn) {
  const db = await openDb();
  const cur = unpack(await reqP(db.transaction(store).objectStore(store).get(id)));
  if (!cur) throw new Error('ไม่พบข้อมูล');
  if (expectedVersion != null && cur.version !== expectedVersion) throw new ConflictError(cur);
  const next = typeof patchFn === 'function' ? patchFn({ ...structuredCloneSafe(cur) }) : { ...cur, ...patchFn };
  next.version = cur.version + 1; next.updatedAt = nowIso();
  const packed = await pack(next);
  // เขียนเฉพาะเมื่อเวอร์ชันยังไม่ถูกเปลี่ยนระหว่างเตรียมข้อมูล
  const tx = db.transaction(store, 'readwrite'); const os = tx.objectStore(store);
  const again = await reqP(os.get(id));
  if (!again || again.version !== cur.version) { tx.abort(); throw new ConflictError(unpack(again)); }
  os.put(packed);
  await txDone(tx);
  return next;
}

/** clone ที่คง Blob ไว้ (ไม่ copy ไบต์) */
function structuredCloneSafe(v) {
  if (v instanceof Blob || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(structuredCloneSafe);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, structuredCloneSafe(x)]));
}

export async function put(store, obj) {
  const db = await openDb(); const packed = await pack(obj); const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(packed); await txDone(tx); return obj;
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
  return unpack(await reqP(db.transaction('stores').objectStore('stores').index('code').get(normalizeStoreCode(code))));
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

/** นำเข้ารายชื่อร้านหลายร้าน: รหัสใหม่ → เพิ่ม, รหัสเดิมแต่ชื่อเปลี่ยน → อัปเดตชื่อ */
export async function upsertStoresBulk(list) {
  const byCode = new Map((await all('stores')).map(s => [s.code, s]));
  let added = 0, renamed = 0;
  for (const { code: c, name: n } of list) {
    const code = normalizeStoreCode(c), name = String(n || '').trim(); if (!code || !name) continue;
    const cur = byCode.get(code);
    if (!cur) { byCode.set(code, await insert('stores', { code, name, area: '', note: '', active: true, source: 'team' })); added++; }
    else if (cur.name !== name) { await update('stores', cur.id, cur.version, { name }); renamed++; }
  }
  await audit({ entity: 'store', entityId: 'team-list', action: 'team_sync', after: { added, renamed } });
  return { added, renamed, total: list.length };
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
  return (await byIndex('roundStores', 'roundId', roundId)).filter(x => !x.deletedAt).sort((a, b) => a.seq - b.seq);
}

/** นำร้านออกจากรอบ (เฉพาะร้านที่ยังไม่มีรูป) — ข้อมูลร้านในระบบยังอยู่ */
export async function removeStoreFromRound(rsId) {
  const rs = await get('roundStores', rsId);
  if ((await filesOf(rsId)).length) throw new Error('ร้านนี้มีรูปแล้ว ลบรูปก่อนจึงนำออกได้');
  await update('roundStores', rsId, rs.version, x => ({ ...x, deletedAt: nowIso() }));
  await audit({ entity: 'round', entityId: rs.roundId, roundId: rs.roundId, action: 'remove_store', after: rs.storeCodeSnap });
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
      billCheck: null, fieldShowTime: false, // V2
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
