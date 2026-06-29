// export-xlsx.js — สร้างไฟล์ Excel รายงานบัญชีรายเดือนของแบ่งเบา
'use strict';
const ExcelJS = require('exceljs');

const TH_MON = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

const BLUE = 'FF1F6BFF', GREEN = 'FF00A86B', ORANGE = 'FFF0883E', INK = 'FF0A1F44', LINE = 'FFE7EEFB';

function thMonthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${TH_MON[m]} ${y + 543}`;
}

// rows: [{date,type,amount,category,note,source}], cats: [{category,amount}] (expense)
async function buildMonthlyWorkbook({ ym, rows, totals, expenseCats, pl }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'แบ่งเบา';
  wb.created = new Date();

  // ---------- ชีตรายการ ----------
  const ws = wb.addWorksheet('รายการ', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.columns = [
    { key: 'date', width: 13 },
    { key: 'type', width: 11 },
    { key: 'category', width: 22 },
    { key: 'note', width: 30 },
    { key: 'income', width: 15 },
    { key: 'expense', width: 15 },
  ];

  // หัวรายงาน
  ws.mergeCells('A1:F1');
  const t1 = ws.getCell('A1');
  t1.value = `รายงานบัญชี — แบ่งเบา`;
  t1.font = { name: 'TH Sarabun New', size: 18, bold: true, color: { argb: INK } };
  ws.mergeCells('A2:F2');
  const t2 = ws.getCell('A2');
  t2.value = `ประจำเดือน ${thMonthLabel(ym)}`;
  t2.font = { size: 12, color: { argb: 'FF67789A' } };
  ws.getRow(1).height = 24;
  ws.getRow(3).height = 6;

  // หัวตาราง (แถว 4)
  const head = ws.getRow(4);
  ['วันที่', 'ประเภท', 'หมวดหมู่', 'รายละเอียด', 'รายรับ (฿)', 'รายจ่าย (฿)'].forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    c.alignment = { vertical: 'middle', horizontal: i >= 4 ? 'right' : 'left' };
    c.border = { bottom: { style: 'thin', color: { argb: BLUE } } };
  });
  head.height = 20;

  // แถวข้อมูล
  let r = 5;
  for (const x of rows) {
    const isInc = x.type === 'income';
    const row = ws.getRow(r);
    row.getCell(1).value = x.date;
    row.getCell(2).value = isInc ? 'รายรับ' : 'รายจ่าย';
    row.getCell(2).font = { color: { argb: isInc ? GREEN : ORANGE }, bold: true };
    row.getCell(3).value = x.category;
    row.getCell(4).value = x.note;
    row.getCell(5).value = isInc ? x.amount : null;
    row.getCell(6).value = isInc ? null : x.amount;
    [5, 6].forEach(ci => { row.getCell(ci).numFmt = '#,##0.00'; });
    row.eachCell(c => { c.border = { bottom: { style: 'hair', color: { argb: LINE } } }; });
    r++;
  }
  if (!rows.length) {
    ws.mergeCells(`A5:F5`);
    ws.getCell('A5').value = 'ยังไม่มีรายการในเดือนนี้';
    ws.getCell('A5').alignment = { horizontal: 'center' };
    ws.getCell('A5').font = { color: { argb: 'FF9AA9C2' }, italic: true };
    r = 6;
  }

  // แถวสรุป
  r += 1;
  const sum = ws.getRow(r);
  sum.getCell(4).value = 'รวม';
  sum.getCell(4).font = { bold: true };
  sum.getCell(4).alignment = { horizontal: 'right' };
  sum.getCell(5).value = totals.income;
  sum.getCell(6).value = totals.expense;
  [5, 6].forEach(ci => {
    const c = sum.getCell(ci);
    c.numFmt = '#,##0.00'; c.font = { bold: true };
    c.border = { top: { style: 'thin', color: { argb: INK } } };
  });
  const profitRow = ws.getRow(r + 1);
  profitRow.getCell(4).value = 'กำไรสุทธิ';
  profitRow.getCell(4).font = { bold: true, size: 12 };
  profitRow.getCell(4).alignment = { horizontal: 'right' };
  ws.mergeCells(`E${r + 1}:F${r + 1}`);
  const pc = profitRow.getCell(5);
  pc.value = totals.profit;
  pc.numFmt = '#,##0.00 "฿"';
  pc.font = { bold: true, size: 12, color: { argb: totals.profit >= 0 ? BLUE : 'FFE5484D' } };
  pc.alignment = { horizontal: 'right' };

  // ---------- ชีตสรุปหมวดรายจ่าย ----------
  if (expenseCats && expenseCats.length) {
    const cs = wb.addWorksheet('หมวดรายจ่าย');
    cs.columns = [{ key: 'c', width: 26 }, { key: 'a', width: 16 }, { key: 'p', width: 12 }];
    const ch = cs.getRow(1);
    ['หมวดรายจ่าย', 'ยอดรวม (฿)', 'สัดส่วน'].forEach((h, i) => {
      const c = ch.getCell(i + 1);
      c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
      c.alignment = { horizontal: i ? 'right' : 'left' };
    });
    ch.height = 20;
    const totalExp = expenseCats.reduce((s, x) => s + x.amount, 0) || 1;
    expenseCats.forEach((x, i) => {
      const row = cs.getRow(i + 2);
      row.getCell(1).value = x.category;
      row.getCell(2).value = x.amount; row.getCell(2).numFmt = '#,##0.00';
      row.getCell(3).value = x.amount / totalExp; row.getCell(3).numFmt = '0.0%';
      row.getCell(3).alignment = { horizontal: 'right' };
    });
  }

  // ---------- ชีตงบกำไร-ขาดทุน ----------
  if (pl) {
    const ps = wb.addWorksheet('งบกำไร-ขาดทุน');
    ps.columns = [{ key: 'a', width: 32 }, { key: 'b', width: 18 }];
    ps.mergeCells('A1:B1');
    ps.getCell('A1').value = `งบกำไร-ขาดทุน — ${thMonthLabel(ym)}`;
    ps.getCell('A1').font = { name: 'TH Sarabun New', size: 16, bold: true, color: { argb: INK } };
    ps.getRow(2).height = 6;
    const line = (label, val, opt = {}) => {
      const row = ps.addRow([label, val]);
      row.getCell(1).font = { bold: !!opt.bold, size: opt.big ? 13 : 11, color: { argb: opt.color || INK } };
      const c = row.getCell(2);
      c.numFmt = '#,##0.00';
      c.font = { bold: !!opt.bold, size: opt.big ? 13 : 11, color: { argb: opt.vcolor || INK } };
      c.alignment = { horizontal: 'right' };
      if (opt.top) { row.getCell(1).border = { top: { style: 'thin', color: { argb: LINE } } }; c.border = { top: { style: 'thin', color: { argb: LINE } } }; }
      return row;
    };
    line('รายได้รวม', pl.revenue, { bold: true, vcolor: GREEN });
    line('   ขายหน้าร้าน', pl.storefront, { color: 'FF67789A', vcolor: 'FF67789A' });
    if (pl.delivery > 0) line('   เดลิเวอรี่', pl.delivery, { color: 'FF67789A', vcolor: 'FF67789A' });
    line('หัก ต้นทุนวัตถุดิบ/ของใช้', -pl.variable, { vcolor: ORANGE, top: true });
    if (pl.gpFees > 0) line('หัก ค่าธรรมเนียมเดลิเวอรี่', -pl.gpFees, { vcolor: ORANGE });
    line('กำไรขั้นต้น', pl.grossProfit, { bold: true, top: true });
    line('หัก ค่าใช้จ่ายประจำ', -pl.fixed, { vcolor: ORANGE });
    line('กำไรสุทธิ', pl.netProfit, { bold: true, big: true, vcolor: pl.netProfit >= 0 ? BLUE : 'FFE5484D', top: true });
    line(`อัตรากำไรสุทธิ (${pl.marginPct}%)`, pl.revenue > 0 ? pl.netProfit / pl.revenue : 0, {})
      .getCell(2).numFmt = '0.0%';
  }

  return wb.xlsx.writeBuffer(); // returns Promise<Buffer>
}

module.exports = { buildMonthlyWorkbook, thMonthLabel };
