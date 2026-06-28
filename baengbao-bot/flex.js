// flex.js — ตัวสร้างการ์ด Flex Message ของแบ่งเบา (ดีไซน์ขาว-น้ำเงิน-เขียว)
'use strict';

const C = {
  blue: '#1F6BFF', blueDeep: '#0B49C9', green: '#00A86B', warn: '#F0883E',
  danger: '#E5484D', ink: '#0A1F44', soft: '#67789A', faint: '#9AA9C2',
  line: '#E7EEFB', bgSoft: '#F4F8FF', white: '#FFFFFF', onColor: '#FFFFFFE6',
};

const baht = n => Number(n || 0).toLocaleString('th-TH');
const scol = (txt, c, extra = {}) => ({ type: 'text', text: String(txt), color: c, ...extra });

function header(title, sub, bg) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: bg,
    paddingAll: '16px', paddingBottom: '13px', spacing: 'xs',
    contents: [
      sol_icon_title(title),
      ...(sub ? [sol(sub, C.onColor, { size: 'xs' })] : []),
    ],
  };
}
function sol(txt, c, extra = {}) { return { type: 'text', text: String(txt), color: c, ...extra }; }
function sol_icon_title(title) {
  return { type: 'text', text: title, color: C.white, weight: 'bold', size: 'md' };
}

// แถวสรุป: ป้ายซ้าย ค่าตัวเลขขวา
function statRow(label, value, color, big) {
  return {
    type: 'box', layout: 'horizontal', contents: [
      sol(label, C.soft, { size: 'sm', gravity: 'center', flex: 0 }),
      sol(value, color || C.ink, { size: big ? 'lg' : 'sm', weight: 'bold', align: 'end', gravity: 'center' }),
    ],
  };
}
const sep = (m = 'md') => ({ type: 'separator', margin: m, color: C.line });

function linkButton(label, url) {
  if (!url) return null;
  return {
    type: 'button', style: 'primary', color: C.blue, height: 'sm',
    action: { type: 'uri', label, uri: url },
  };
}

function bubble({ headerBox, bodyContents, footerButton, size = 'mega' }) {
  const b = {
    type: 'bubble', size,
    body: {
      type: 'box', layout: 'vertical', paddingAll: '0px',
      contents: [
        headerBox,
        { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: bodyContents },
      ],
    },
  };
  if (footerButton) {
    b.footer = {
      type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px',
      contents: [footerButton],
    };
  }
  return b;
}

// ---------- การ์ดบันทึกรายรับ/รายจ่าย ----------
function confirmCard({ type, amount, note, menuProfitEst, day, link }) {
  const income = type === 'income';
  const sign = income ? '+' : '−';
  const accent = income ? C.green : C.warn;
  const title = income ? 'บันทึกรายรับแล้ว' : 'บันทึกรายจ่ายแล้ว';

  const body = [
    { type: 'box', layout: 'baseline', contents: [
      sol(`${sign}${baht(amount)}`, accent, { size: '3xl', weight: 'bold', flex: 0 }),
      sol(' ฿', accent, { size: 'lg', weight: 'bold', gravity: 'center' }),
    ] },
  ];
  if (note) body.push(sol(note, C.soft, { size: 'sm', wrap: true, margin: 'xs' }));
  if (menuProfitEst != null) {
    body.push({
      type: 'box', layout: 'horizontal', margin: 'md', backgroundColor: '#E3F8EF',
      cornerRadius: '10px', paddingAll: '10px', contents: [
        sol('💰 กำไรเมนูนี้', C.green, { size: 'sm', flex: 0, gravity: 'center' }),
        sol(`~${baht(menuProfitEst)} ฿`, C.green, { size: 'sm', weight: 'bold', align: 'end', gravity: 'center' }),
      ],
    });
  }
  body.push(sep('lg'));
  body.push(sol('สรุปวันนี้', C.faint, { size: 'xs', margin: 'md' }));
  body.push(statRow('รายรับ', `${baht(day.income)} ฿`, C.green));
  body.push(statRow('รายจ่าย', `${baht(day.expense)} ฿`, C.warn));
  body.push(statRow('กำไรสุทธิ', `${day.profit >= 0 ? '+' : '−'}${baht(Math.abs(day.profit))} ฿`, day.profit >= 0 ? C.blue : C.danger, true));

  return {
    altText: `${title} ${sign}${baht(amount)} ฿`,
    contents: bubble({
      headerBox: header(title, null, accent),
      bodyContents: body,
      footerButton: linkButton('ดูรายงาน', link ? `${link}?tab=report` : null),
    }),
  };
}

// ---------- การ์ดสรุป วันนี้/เดือนนี้ ----------
function summaryCard({ title, sub, totals, link, period }) {
  const body = [
    statRow('รายรับ', `${baht(totals.income)} ฿`, C.green),
    statRow('รายจ่าย', `${baht(totals.expense)} ฿`, C.warn),
    sep('md'),
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      sol('กำไรสุทธิ', C.ink, { size: 'md', weight: 'bold', gravity: 'center', flex: 0 }),
      sol(`${totals.profit >= 0 ? '+' : '−'}${baht(Math.abs(totals.profit))} ฿`,
        totals.profit >= 0 ? C.blue : C.danger, { size: 'xl', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
  ];
  return {
    altText: `${title}: กำไรสุทธิ ${totals.profit >= 0 ? '+' : '−'}${baht(Math.abs(totals.profit))} ฿`,
    contents: bubble({
      headerBox: header(title, sub, C.blue),
      bodyContents: body,
      footerButton: linkButton('ดูรายงานเต็ม', link ? `${link}?tab=report` : null),
    }),
  };
}

// ---------- การ์ดเดลิเวอรี่ ----------
function deliveryCard({ platform, gross, commission, net, day, dateLabel, ordersTxt }) {
  const body = [];
  if (gross != null) {
    body.push(statRow('ยอดขาย', `+${baht(gross)} ฿`, C.green));
    if (commission && commission > 0) body.push(statRow('ค่า GP', `−${baht(commission)} ฿`, C.warn));
    body.push(sep('sm'));
    body.push(statRow('สุทธิ', `${baht(net)} ฿`, C.blue, true));
  } else {
    body.push(statRow('รายรับสุทธิ', `+${baht(net)} ฿`, C.green, true));
  }
  if (ordersTxt) body.push(sol(ordersTxt, C.faint, { size: 'xs', margin: 'sm' }));
  body.push(sep('lg'));
  body.push(sol(`สรุปวันที่ ${dateLabel}`, C.faint, { size: 'xs', margin: 'md' }));
  body.push(statRow('รายรับ', `${baht(day.income)} ฿`, C.green));
  body.push(statRow('รายจ่าย', `${baht(day.expense)} ฿`, C.warn));
  body.push(statRow('กำไรสุทธิ', `${day.profit >= 0 ? '+' : '−'}${baht(Math.abs(day.profit))} ฿`, day.profit >= 0 ? C.blue : C.danger, true));

  return {
    altText: `บันทึกยอด ${platform} แล้ว`,
    contents: bubble({
      headerBox: header(`ยอด ${platform}`, 'บันทึกจากหน้าสรุปเดลิเวอรี่', C.green),
      bodyContents: body,
    }),
  };
}

// ---------- การ์ดกำไรต่อจาน (ลิสต์เมนู) ----------
function menuProfitCard(rows, link) {
  const body = [];
  rows.forEach((r, i) => {
    if (i > 0) body.push(sep('sm'));
    body.push({
      type: 'box', layout: 'horizontal', contents: [
        { type: 'box', layout: 'vertical', flex: 1, contents: [
          sol(r.name, C.ink, { size: 'sm', weight: 'bold', wrap: true }),
          sol(`มาร์จิน ${r.margin}%`, C.faint, { size: 'xxs', margin: 'xs' }),
        ] },
        sol(`${r.profit < 0 ? '−' : ''}${baht(Math.abs(r.profit))} ฿`,
          r.profit < 0 ? C.danger : C.green, { size: 'md', weight: 'bold', align: 'end', gravity: 'center', flex: 0 }),
      ],
    });
  });
  return {
    altText: 'กำไรต่อจานของเมนู',
    contents: bubble({
      headerBox: header('กำไรต่อจาน', `${rows.length} เมนู`, C.blue),
      bodyContents: body,
      footerButton: linkButton('จัดการเมนู', link),
    }),
  };
}

// ---------- การ์ดเปิดเมนู / ลิงก์ LIFF ----------
function menuLinkCard({ link, menus }) {
  const body = [
    sol('ตั้งเมนู ราคา และต้นทุน เพื่อดูกำไรต่อจานแบบเรียลไทม์', C.soft, { size: 'sm', wrap: true }),
  ];
  if (menus && menus.length) {
    body.push(sep('lg'));
    body.push(sol('เมนูตอนนี้', C.faint, { size: 'xs', margin: 'sm' }));
    menus.slice(0, 5).forEach(m => body.push(statRow(m.name, `${baht(m.profit)} ฿`, C.green)));
  }
  return {
    altText: 'จัดการเมนู + ดูกำไรต่อจาน',
    contents: bubble({
      headerBox: header('เมนูของร้าน', null, C.blue),
      bodyContents: body,
      footerButton: linkButton('จัดการเมนู', link),
    }),
  };
}

// ---------- การ์ดแจ้งเตือนสรุปรายวัน (push ตอนเย็น) ----------
function dailyPushCard({ dateLabel, today, yest, link }) {
  const diff = today.profit - (yest ? yest.profit : 0);
  const up = diff >= 0;
  const cmp = yest
    ? `${up ? '▲' : '▼'} ${up ? '+' : '−'}${baht(Math.abs(diff))} ฿ จากเมื่อวาน`
    : 'วันแรกที่จด สู้ ๆ นะครับ';

  const body = [
    statRow('รายรับ', `${baht(today.income)} ฿`, C.green),
    statRow('รายจ่าย', `${baht(today.expense)} ฿`, C.warn),
    sep('md'),
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      sol('กำไรสุทธิ', C.ink, { size: 'md', weight: 'bold', gravity: 'center', flex: 0 }),
      sol(`${today.profit >= 0 ? '+' : '−'}${baht(Math.abs(today.profit))} ฿`,
        today.profit >= 0 ? C.blue : C.danger, { size: 'xl', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    { type: 'box', layout: 'vertical', margin: 'md', backgroundColor: up ? '#E3F8EF' : '#FDEBE8',
      cornerRadius: '10px', paddingAll: '10px', contents: [
        sol(cmp, up ? C.green : C.danger, { size: 'sm', weight: 'bold', align: 'center' }),
      ] },
    sol(`${today.count} รายการวันนี้`, C.faint, { size: 'xxs', align: 'center', margin: 'sm' }),
  ];
  return {
    altText: `สรุปวันนี้: กำไรสุทธิ ${today.profit >= 0 ? '+' : '−'}${baht(Math.abs(today.profit))} ฿`,
    contents: bubble({
      headerBox: header('สรุปยอดวันนี้', dateLabel, C.blueDeep),
      bodyContents: body,
      footerButton: linkButton('ดูรายงานเต็ม', link ? `${link}?tab=report` : null),
    }),
  };
}

// ---------- เฟส 8: เป้ายอดขาย ----------
function progressBar(pct, color) {
  const w = Math.max(2, Math.min(100, Math.round(pct)));
  return {
    type: 'box', layout: 'vertical', height: '10px', backgroundColor: '#EDF2FB',
    cornerRadius: '6px', margin: 'sm', contents: [
      { type: 'box', layout: 'vertical', width: `${w}%`, backgroundColor: color, cornerRadius: '6px', contents: [{ type: 'filler' }] },
    ],
  };
}

function goalBlock(label, current, goal) {
  const pct = goal > 0 ? (current / goal) * 100 : 0;
  const done = current >= goal;
  const color = done ? C.green : C.blue;
  return [
    { type: 'box', layout: 'horizontal', contents: [
      sol(label, C.soft, { size: 'sm', flex: 0, gravity: 'center' }),
      sol(`${baht(current)} / ${baht(goal)} ฿`, C.ink, { size: 'sm', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    progressBar(pct, color),
    sol(done ? `🎉 ถึงเป้าแล้ว! (${Math.round(pct)}%)` : `อีก ${baht(goal - current)} ฿ ถึงเป้า (${Math.round(pct)}%)`,
      done ? C.green : C.faint, { size: 'xs', margin: 'xs' }),
  ];
}

function goalCard({ todayIncome, dailyGoal, monthIncome, monthlyGoal, link }) {
  const body = [];
  if (dailyGoal) {
    body.push(sol('เป้าวันนี้', C.faint, { size: 'xs' }));
    body.push(...goalBlock('ยอดขายวันนี้', todayIncome, dailyGoal));
  }
  if (monthlyGoal) {
    if (dailyGoal) body.push(sep('lg'));
    body.push(sol('เป้าเดือนนี้', C.faint, { size: 'xs' }));
    body.push(...goalBlock('ยอดขายเดือนนี้', monthIncome, monthlyGoal));
  }
  if (!dailyGoal && !monthlyGoal) {
    body.push(sol('ยังไม่ได้ตั้งเป้าเลยครับ', C.ink, { size: 'sm', weight: 'bold' }));
    body.push(sol('ตั้งเป้าได้ เช่น พิมพ์ว่า\n“เป้าวันละ 5000” หรือ “เป้าเดือนละ 120000”', C.soft, { size: 'sm', wrap: true, margin: 'sm' }));
  }
  return {
    altText: 'เป้ายอดขาย',
    contents: bubble({
      headerBox: header('เป้ายอดขาย', null, C.blue),
      bodyContents: body,
      footerButton: linkButton('ดูรายงาน', link ? `${link}?tab=report` : null),
    }),
  };
}

// การ์ดเชียร์ตอนถึงเป้า (ส่งตามหลังการ์ดบันทึก)
function goalReachedCard({ period, current }) {
  const txt = period === 'month' ? 'ถึงเป้ายอดขายเดือนนี้แล้ว!' : 'ถึงเป้ายอดขายวันนี้แล้ว!';
  return {
    altText: '🎉 ' + txt,
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', backgroundColor: C.green, paddingAll: '20px', spacing: 'sm',
        contents: [
          sol('🎉', '#FFFFFF', { size: 'xxl', align: 'center' }),
          sol(txt, '#FFFFFF', { size: 'lg', weight: 'bold', align: 'center', wrap: true }),
          sol(`ยอดขายแตะ ${baht(current)} ฿ แล้ว เก่งมากครับ`, '#FFFFFFE6', { size: 'sm', align: 'center', wrap: true }),
        ],
      },
    },
  };
}

// ---------- เฟส 9: เทียบต้นทุนเดือนนี้ vs เดือนก่อน ----------
function costCompareCard({ rows, periodLabel, topSpike }) {
  const body = [
    sol(periodLabel, C.faint, { size: 'xs', wrap: true }),
  ];
  if (topSpike) {
    body.push({
      type: 'box', layout: 'vertical', margin: 'sm', backgroundColor: '#FDEBE8',
      cornerRadius: '10px', paddingAll: '10px', contents: [
        sol(`⚠️ ${topSpike.category} ขึ้น ${topSpike.pct}% จากเดือนก่อน`, C.danger, { size: 'sm', weight: 'bold', wrap: true }),
      ],
    });
  }
  body.push(sep('md'));
  rows.forEach((r, i) => {
    if (i > 0) body.push(sep('sm'));
    let badge, bcolor;
    if (r.status === 'new') { badge = 'ใหม่'; bcolor = C.warn; }
    else if (r.status === 'up') { badge = `▲ +${r.pct}%`; bcolor = C.danger; }
    else if (r.status === 'down') { badge = `▼ −${Math.abs(r.pct)}%`; bcolor = C.green; }
    else { badge = '— เท่าเดิม'; bcolor = C.faint; }
    body.push({
      type: 'box', layout: 'horizontal', contents: [
        { type: 'box', layout: 'vertical', flex: 1, contents: [
          sol(r.category, C.ink, { size: 'sm', weight: 'bold', wrap: true }),
          sol(`${baht(r.cur)} ฿  •  เดือนก่อน ${baht(r.prev)} ฿`, C.faint, { size: 'xxs', margin: 'xs', wrap: true }),
        ] },
        sol(badge, bcolor, { size: 'sm', weight: 'bold', align: 'end', gravity: 'center', flex: 0 }),
      ],
    });
  });
  return {
    altText: 'เทียบต้นทุนเดือนนี้กับเดือนก่อน',
    contents: bubble({
      headerBox: header('เทียบต้นทุน', 'เดือนนี้ vs เดือนก่อน', C.blue),
      bodyContents: body,
    }),
  };
}

module.exports = {
  confirmCard, summaryCard, deliveryCard, menuProfitCard, menuLinkCard, dailyPushCard,
  goalCard, goalReachedCard, costCompareCard,
};
