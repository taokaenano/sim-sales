// ===== OCR ตัวพิมพ์ (tesseract.js ทำงานในเครื่อง ไม่ต้องใช้ API key) =====
// ใช้อ่านเลขที่พิมพ์กำกับบาร์โค้ด (เบอร์ / S/N / Part no.) — ไม่ใช้กับลายมือ
const pool = []; let ready; let rr = 0;
const base = () => new URL('vendor/tess/', location.href).href;

async function init() {
  const T = window.Tesseract;
  const n = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < n; i++) {
    const w = await T.createWorker('eng', 1, {
      workerPath: base() + 'worker.min.js', corePath: base() + 'tesseract-core-simd-lstm.js', langPath: base(), gzip: true,
      workerBlobURL: false, cacheMethod: 'none',
    });
    pool.push({ w, chain: Promise.resolve(), params: '' });
  }
}

export function ocrReady() { if (!ready) ready = init().catch(e => { ready = null; throw e; }); return ready; }

/** อ่านข้อความจาก canvas (OffscreenCanvas หรือ HTMLCanvasElement) */
export async function ocrLine(canvas, { whitelist = '', psm = 7 } = {}) {
  await ocrReady();
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(r => canvas.toBlob(r, 'image/png'));
  const slot = pool[rr++ % pool.length];
  const job = slot.chain.then(async () => {
    const key = whitelist + '|' + psm;
    if (slot.params !== key) {
      await slot.w.setParameters({ tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: String(psm) });
      slot.params = key;
    }
    const r = await slot.w.recognize(blob);
    return r.data.text || '';
  });
  slot.chain = job.catch(() => {});
  return job;
}
