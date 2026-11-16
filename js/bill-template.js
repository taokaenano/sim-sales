// เทมเพลต "ใบส่งสินค้า / ใบเสร็จรับเงินชั่วคราว" (รหัสพิมพ์ข้างบิล AB-2915)
// พิกัดอยู่ในระบบ canonical: มุมซ้ายบนของตารางรายการสินค้า = (0,0),
// มุมขวาล่างของกรอบลายเซ็นผู้ส่ง/ผู้รับ = (1000,1456)
// วัดจากบิลตัวอย่างในไฟล์ Manual (AP_Baht.pdf หน้า 3) — ปรับค่าได้ที่ไฟล์นี้ไฟล์เดียว
export const BILL_TEMPLATE = {
  id: 'true-delivery-receipt-AB2915',
  version: 1,
  name: 'ใบส่งสินค้า/ใบเสร็จรับเงินชั่วคราว (AB-2915)',
  anchors: ['มุมซ้ายบนของตารางรายการสินค้า', 'มุมขวาบนของตารางรายการสินค้า',
            'มุมขวาล่างของกรอบลายเซ็น', 'มุมซ้ายล่างของกรอบลายเซ็น'],
  W: 1000, H: 1456,
  view: { x0: -90, y0: -500, x1: 1070, y1: 1500 },
  cols: { item: [0, 377], qty: [377, 522], price: [522, 714], amount: [714, 1000] },
  rows: [
    { key: 'dol',   label: 'DOL',            y: [128, 202], printedPrice: null, kind: 'other' },
    { key: 'cc60',  label: 'Cash Card 60',   y: [202, 279], printedPrice: '59', kind: 'other' },
    { key: 'cc100', label: 'Cash Card 100',  y: [279, 354], printedPrice: '98', kind: 'other' },
    { key: 'cc',    label: 'Cash Card',      y: [354, 429], printedPrice: null, kind: 'other' },
    { key: 'sim1',  label: 'SIM',            y: [429, 503], printedPrice: '30', kind: 'sim' },
    { key: 'sim2',  label: 'SIM',            y: [503, 579], printedPrice: '30', kind: 'sim' },
    { key: 'sim3',  label: 'SIM',            y: [579, 650], printedPrice: null, kind: 'sim' },
    { key: 'free1', label: '(บรรทัดว่าง 1)', y: [650, 724], printedPrice: null, kind: 'blank' },
    { key: 'free2', label: '(บรรทัดว่าง 2)', y: [724, 797], printedPrice: null, kind: 'blank' },
  ],
  totals: [
    { key: 'gross',    label: 'จำนวนเงินรวม',        y: [797, 868] },
    { key: 'fee',      label: 'ค่าบริการการขาย',      y: [868, 942] },
    { key: 'net',      label: 'ยอดสุทธิ',             y: [942, 1016] },
    { key: 'wht',      label: 'ภาษีหัก ณ ที่จ่าย',     y: [1016, 1087] },
    { key: 'received', label: 'ยอดรับเงินทั้งสิ้น',     y: [1087, 1160] },
  ],
  totalsValueX: [714, 1000],
  header: {
    billNo:    { label: 'เลขที่',       x: [800, 1000], y: [-485, -420] },
    storeCode: { label: 'รหัสร้านค้า',  x: [120, 700],  y: [-160, -92] },
    storeName: { label: 'ชื่อร้านค้า',  x: [120, 700],  y: [-80, -5] },
    date:      { label: 'วันที่',       x: [700, 1000], y: [-100, -8] },
  },
  signature: {
    receiver:     { label: 'ลายเซ็นผู้รับสินค้า', x: [640, 1000], y: [1285, 1385] },
    receiverDate: { label: 'วันที่ผู้รับ',        x: [520, 1000], y: [1385, 1450] },
    sender:       { label: 'ผู้ส่งสินค้า',        x: [130, 515],  y: [1285, 1385] },
  },
};
