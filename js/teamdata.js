// ===== รายชื่อร้านของทีม (เข้ารหัส) =====
// ไฟล์ data/stores.enc.json เข้ารหัส AES-256-GCM ด้วยคีย์จาก "รหัสทีม" (PBKDF2-SHA256)
// ใส่รหัสถูกครั้งเดียว → เก็บคีย์ไว้ในเครื่อง → ครั้งต่อไปอัปเดตรายชื่อเองเมื่อไฟล์บนเว็บเปลี่ยน
import * as db from './db.js';

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function fetchBundle() {
  try { const r = await fetch('data/stores.enc.json', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function decrypt(bundle, rawKey) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(bundle.iv) }, key, b64(bundle.ct));
  const bytes = bundle.gzip ? await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : plain;
  return JSON.parse(new TextDecoder().decode(bytes)).stores;
}
async function apply(bundle, stores) {
  const r = await db.upsertStoresBulk(stores.map(([code, name]) => ({ code, name })));
  await db.setSetting('teamBundleVer', bundle.ver);
  return r;
}

/** สถานะ: 'none' = ไม่มีไฟล์รายชื่อ, 'locked' = ยังไม่ได้ใส่รหัส, 'ok' = ใช้งานได้ */
export async function teamStatus() {
  const bundle = await fetchBundle(); if (!bundle) return { state: 'none' };
  const k = await db.getSetting('teamKey');
  return { state: k && k.salt === bundle.salt ? 'ok' : 'locked', bundle };
}

/** ใส่รหัสทีม — ถูก: เก็บคีย์ + นำรายชื่อเข้า, ผิด: throw */
export async function unlockTeam(password) {
  const bundle = await fetchBundle(); if (!bundle) throw new Error('ไม่พบไฟล์รายชื่อร้าน');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.trim().toLowerCase()), 'PBKDF2', false, ['deriveBits']);
  const raw = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(bundle.salt), iterations: bundle.iter }, base, 256);
  let stores;
  try { stores = await decrypt(bundle, raw); } catch { throw new Error('รหัสทีมไม่ถูกต้อง'); }
  await db.setSetting('teamKey', { salt: bundle.salt, key: toB64(raw) });
  return apply(bundle, stores);
}

/** เปิดแอป: ถ้าเคยใส่รหัสแล้วและไฟล์บนเว็บเปลี่ยน → อัปเดตรายชื่อเอง */
export async function syncTeam() {
  const st = await teamStatus(); if (st.state !== 'ok') return null;
  if ((await db.getSetting('teamBundleVer')) === st.bundle.ver) return null;
  const k = await db.getSetting('teamKey');
  try { return await apply(st.bundle, await decrypt(st.bundle, b64(k.key))); } catch { return null; }
}
