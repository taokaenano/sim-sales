// ===== ความเข้ากันได้กับเบราว์เซอร์รุ่นเก่า (เช่น Safari บน iPhone ก่อน iOS 16.4) =====
if (typeof window.OffscreenCanvas === 'undefined') {
  window.OffscreenCanvas = class {
    constructor(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; c.convertToBlob = ({ type = 'image/png', quality } = {}) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('สร้างภาพไม่สำเร็จ')), type, quality)); return c; }
  };
}
if (typeof structuredClone === 'undefined') {
  const clone = v => v instanceof Blob || v instanceof Date || v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(clone) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  window.structuredClone = clone;
}
if (!crypto.randomUUID) crypto.randomUUID = () => ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
