// flex.js — ตัวสร้างการ์ด Flex Message ของแบ่งเบา (ดีไซน์ขาว-น้ำเงิน-เขียว)
'use strict';

const C = {
  blue: '#1F6BFF', blueDeep: '#0B49C9', green: '#00A86B', warn: '#F0883E',
  danger: '#E5484D', ink: '#0A1F44', soft: '#67789A', faint: '#9AA9C2',
  line: '#E7EEFB', bgSoft: '#F4F8FF', white: '#FFFFFF', onColor: '#FFFFFFE6',
  gold: '#C8920A',
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

// ---------- เฟส 10: การ์ดดาวน์โหลดรายงาน Excel ----------
function exportCard({ monthLabel, url, totals }) {
  const body = [
    sol(`รายงานบัญชีเดือน ${monthLabel} พร้อมแล้ว`, C.ink, { size: 'sm', weight: 'bold', wrap: true }),
    sol('ไฟล์ Excel มีรายการทั้งหมด + สรุปรายรับ-รายจ่าย + กำไรสุทธิ + หมวดรายจ่าย ส่งให้บัญชีหรือใช้ยื่นภาษีได้เลย', C.soft, { size: 'xs', wrap: true, margin: 'sm' }),
    sep('md'),
    statRow('รายรับ', `${baht(totals.income)} ฿`, C.green),
    statRow('รายจ่าย', `${baht(totals.expense)} ฿`, C.warn),
    statRow('กำไรสุทธิ', `${totals.profit >= 0 ? '+' : '−'}${baht(Math.abs(totals.profit))} ฿`, totals.profit >= 0 ? C.blue : C.danger, true),
    sol('ลิงก์ใช้ได้ภายใน 1 ชั่วโมง', C.faint, { size: 'xxs', margin: 'md' }),
  ];
  return {
    altText: `รายงาน Excel เดือน ${monthLabel}`,
    contents: bubble({
      headerBox: header('รายงาน Excel', monthLabel, C.green),
      bodyContents: body,
      footerButton: {
        type: 'button', style: 'primary', color: C.green, height: 'sm',
        action: { type: 'uri', label: 'ดาวน์โหลด Excel', uri: url },
      },
    }),
  };
}

// ---------- สรุปรายสัปดาห์ (7 วันล่าสุด vs 7 วันก่อนหน้า) ----------
function weeklyCard({ rangeLabel, thisWeek, lastWeek, link }) {
  const diff = thisWeek.profit - lastWeek.profit;
  const up = diff >= 0;
  const cmp = (lastWeek.count || thisWeek.count)
    ? `${up ? '▲' : '▼'} ${up ? '+' : '−'}${baht(Math.abs(diff))} ฿ จากสัปดาห์ก่อน`
    : 'เริ่มเก็บสถิติสัปดาห์นี้';
  const avg = thisWeek.income / 7;
  const body = [
    sol('7 วันล่าสุด', C.faint, { size: 'xs' }),
    statRow('ยอดขายรวม', `${baht(thisWeek.income)} ฿`, C.green),
    statRow('รายจ่ายรวม', `${baht(thisWeek.expense)} ฿`, C.warn),
    sep('md'),
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      sol('กำไรสุทธิ', C.ink, { size: 'md', weight: 'bold', gravity: 'center', flex: 0 }),
      sol(`${thisWeek.profit >= 0 ? '+' : '−'}${baht(Math.abs(thisWeek.profit))} ฿`,
        thisWeek.profit >= 0 ? C.blue : C.danger, { size: 'xl', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    { type: 'box', layout: 'vertical', margin: 'md', backgroundColor: up ? '#E3F8EF' : '#FDEBE8',
      cornerRadius: '10px', paddingAll: '10px', contents: [
        sol(cmp, up ? C.green : C.danger, { size: 'sm', weight: 'bold', align: 'center', wrap: true }),
      ] },
    sol(`เฉลี่ยขายวันละ ~${baht(avg)} ฿ • ${thisWeek.count} รายการ`, C.faint, { size: 'xxs', align: 'center', margin: 'sm' }),
  ];
  return {
    altText: `สรุปสัปดาห์: กำไร ${thisWeek.profit >= 0 ? '+' : '−'}${baht(Math.abs(thisWeek.profit))} ฿`,
    contents: bubble({
      headerBox: header('สรุปรายสัปดาห์', rangeLabel, C.blueDeep),
      bodyContents: body,
      footerButton: linkButton('ดูรายงานเต็ม', link ? `${link}?tab=report` : null),
    }),
  };
}

// ---------- เฟส 15: การ์ดต้อนรับ (onboarding) ----------
function welcomeCarousel(link) {
  const li = (txt) => ({
    type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      sol('•', C.blue, { size: 'sm', flex: 0 }),
      sol(txt, C.soft, { size: 'sm', wrap: true, flex: 1 }),
    ],
  });
  const b1 = {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: [
      header('ยินดีต้อนรับ! 🙏', 'ผู้ช่วยบัญชีร้านอาหาร', C.green),
      { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: [
        sol('ผมคือแบ่งเบา ผู้ช่วยจดรายรับ-รายจ่าย ดูกำไรต่อจาน และสรุปให้อัตโนมัติ', C.ink, { size: 'sm', wrap: true }),
        sol('แค่พิมพ์หรือถ่ายรูป ไม่ต้องลงแอปเพิ่ม ไม่ต้องตั้งค่าอะไรเลย', C.soft, { size: 'xs', wrap: true, margin: 'sm' }),
      ] },
    ] },
  };
  const b2 = {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: [
      header('เริ่มจดง่าย ๆ ✍️', 'ลองพิมพ์ดูเลย', C.blue),
      { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md', contents: [
        { type: 'box', layout: 'vertical', backgroundColor: C.bgSoft, cornerRadius: '10px', paddingAll: '12px', contents: [
          sol('เช่น  ขายกะเพรา 5 จาน 250', C.blueDeep, { size: 'sm', weight: 'bold', wrap: true }),
        ] },
        li('ถ่ายรูปบิล/ใบเสร็จ ส่งมาได้ ผมอ่านให้'),
        li('แคปหน้าสรุปยอด Grab / LineMan / Shopee'),
      ] },
    ] },
  };
  const b3 = {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: [
      header('ทำอะไรได้อีก 🚀', 'พิมพ์คำสั่งสั้น ๆ', C.blueDeep),
      { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm', contents: [
        li('"เป้าวันละ 5000" ตั้งเป้า + เชียร์เมื่อถึง'),
        li('"ต้นทุน" เทียบรายจ่ายกับเดือนก่อน'),
        li('"ออกรายงาน" ได้ไฟล์ Excel ส่งบัญชี'),
        li('ปุ่มลัดด้านล่างกดได้เลย'),
      ] },
    ] },
    footer: link ? { type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px', contents: [
      { type: 'button', style: 'primary', color: C.blue, height: 'sm', action: { type: 'uri', label: 'เปิดแอปจัดการ', uri: link } },
    ] } : undefined,
  };
  return {
    altText: 'ยินดีต้อนรับสู่แบ่งเบา 🙏 ผู้ช่วยบัญชีร้านอาหาร',
    contents: { type: 'carousel', contents: [b1, b2, b3] },
  };
}

// ---------- เฟส 16: จุดคุ้มทุน ----------
function breakEvenCard({ fixedMonthly, marginPct, beMonthly, beDaily, avgDaily, link }) {
  const above = avgDaily >= beDaily;
  const body = [
    statRow('ต้นทุนคงที่/เดือน', `${baht(fixedMonthly)} ฿`, C.ink),
    statRow('กำไรขั้นต้นเฉลี่ย', `${marginPct}%`, C.green),
    sep('md'),
    sol('ต้องขายให้ถึง (ถึงไม่ขาดทุน)', C.faint, { size: 'xs', margin: 'sm' }),
    { type: 'box', layout: 'horizontal', contents: [
      sol('ต่อเดือน', C.soft, { size: 'sm', gravity: 'center', flex: 0 }),
      sol(`${baht(beMonthly)} ฿`, C.blueDeep, { size: 'md', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    { type: 'box', layout: 'horizontal', contents: [
      sol('ต่อวัน', C.soft, { size: 'sm', gravity: 'center', flex: 0 }),
      sol(`${baht(beDaily)} ฿`, C.blue, { size: 'xl', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    { type: 'box', layout: 'vertical', margin: 'md', backgroundColor: above ? '#E3F8EF' : '#FFF3E9',
      cornerRadius: '10px', paddingAll: '11px', contents: [
        sol(above
          ? `ตอนนี้ขายเฉลี่ยวันละ ${baht(avgDaily)} ฿ — เลยจุดคุ้มทุนแล้ว 👍`
          : `ตอนนี้ขายเฉลี่ยวันละ ${baht(avgDaily)} ฿ — ยังขาดอีก ${baht(beDaily - avgDaily)} ฿/วัน`,
          above ? C.green : C.warn, { size: 'sm', weight: 'bold', wrap: true, align: 'center' }),
      ] },
    sol('* ประมาณการจากต้นทุนคงที่และกำไรขั้นต้นเฉลี่ย', C.faint, { size: 'xxs', margin: 'sm', wrap: true }),
  ];
  return {
    altText: `จุดคุ้มทุน ~${baht(beDaily)} ฿/วัน`,
    contents: bubble({
      headerBox: header('จุดคุ้มทุน', 'ต้องขายเท่าไหร่ถึงไม่ขาดทุน', C.blueDeep),
      bodyContents: body,
      footerButton: linkButton('ดูรายงาน', link ? `${link}?tab=report` : null),
    }),
  };
}

// ---------- ปิดยอดเงินสด ----------
function cashCloseCard({ openingFloat, cashIn, cashOut, expected, actual, dateLabel }) {
  const diff = actual - expected;
  const exact = Math.abs(diff) < 0.5;
  const accent = exact ? C.green : (diff > 0 ? C.blue : C.danger);
  const statusTxt = exact ? 'พอดีเป๊ะ! 🎉' : (diff > 0 ? `เงินเกิน +${baht(diff)} ฿` : `เงินขาด −${baht(Math.abs(diff))} ฿`);
  const body = [
    statRow('เงินทอนตั้งต้น', `${baht(openingFloat)} ฿`, C.soft),
    statRow('+ ขายเงินสด', `${baht(cashIn)} ฿`, C.green),
    statRow('− จ่ายเงินสด', `${baht(cashOut)} ฿`, C.warn),
    sep('sm'),
    statRow('ควรมีในลิ้นชัก', `${baht(expected)} ฿`, C.ink, true),
    statRow('นับจริง', `${baht(actual)} ฿`, C.ink, true),
    { type: 'box', layout: 'vertical', margin: 'md', backgroundColor: exact ? '#E3F8EF' : (diff > 0 ? '#EAF1FF' : '#FDEBE8'),
      cornerRadius: '10px', paddingAll: '12px', contents: [
        sol(statusTxt, accent, { size: 'lg', weight: 'bold', align: 'center' }),
      ] },
    ...(exact ? [] : [sol('ลองเช็กว่ามีรายการที่ยังไม่ได้จด หรือทอนเงินผิดไหมครับ', C.faint, { size: 'xxs', margin: 'sm', wrap: true, align: 'center' })]),
  ];
  return {
    altText: `ปิดยอดเงินสด: ${statusTxt}`,
    contents: bubble({
      headerBox: header('ปิดยอดเงินสด', dateLabel, accent === C.danger ? C.danger : C.green),
      bodyContents: body,
    }),
  };
}

// ---------- เฟส 17: งบกำไร-ขาดทุน (P&L) ----------
function plCard({ monthLabel, pl, link }) {
  const subRow = (label, val) => ({
    type: 'box', layout: 'horizontal', contents: [
      sol(label, C.faint, { size: 'xs', flex: 0, gravity: 'center' }),
      sol(`${baht(val)} ฿`, C.faint, { size: 'xs', align: 'end', gravity: 'center' }),
    ],
  });
  const body = [
    { type: 'box', layout: 'horizontal', contents: [
      sol('รายได้รวม', C.ink, { size: 'sm', weight: 'bold', flex: 0, gravity: 'center' }),
      sol(`${baht(pl.revenue)} ฿`, C.green, { size: 'md', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    subRow('• ขายหน้าร้าน', pl.storefront),
    ...(pl.delivery > 0 ? [subRow('• เดลิเวอรี่', pl.delivery)] : []),
    sep('md'),
    statRow('หัก ต้นทุนวัตถุดิบ/ของใช้', `−${baht(pl.variable)}`, C.warn),
    ...(pl.gpFees > 0 ? [statRow('หัก ค่าธรรมเนียมเดลิเวอรี่', `−${baht(pl.gpFees)}`, C.warn)] : []),
    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      sol('= กำไรขั้นต้น', C.soft, { size: 'sm', weight: 'bold', flex: 0, gravity: 'center' }),
      sol(`${baht(pl.grossProfit)} ฿`, C.ink, { size: 'sm', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    statRow('หัก ค่าใช้จ่ายประจำ', `−${baht(pl.fixed)}`, C.warn),
    sep('md'),
    { type: 'box', layout: 'horizontal', contents: [
      sol('กำไรสุทธิ', C.ink, { size: 'md', weight: 'bold', flex: 0, gravity: 'center' }),
      sol(`${pl.netProfit >= 0 ? '' : '−'}${baht(Math.abs(pl.netProfit))} ฿`,
        pl.netProfit >= 0 ? C.blue : C.danger, { size: 'xl', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    sol(`อัตรากำไรสุทธิ ${pl.marginPct}% ของรายได้`, C.faint, { size: 'xxs', margin: 'sm', align: 'end' }),
  ];
  return {
    altText: `งบกำไรขาดทุน ${monthLabel}: กำไรสุทธิ ${pl.netProfit >= 0 ? '' : '−'}${baht(Math.abs(pl.netProfit))} ฿`,
    contents: bubble({
      headerBox: header('งบกำไร-ขาดทุน', monthLabel, C.blueDeep),
      bodyContents: body,
      footerButton: linkButton('ดูรายงาน', link ? `${link}?tab=report` : null),
    }),
  };
}

// ---------- เฟส 18: ระบบสมาชิก ----------
function membershipCard({ effective, until, used, limit, freeLimit, proLimit, contact }) {
  const isPro = effective === 'pro';
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const body = [
    { type: 'box', layout: 'horizontal', contents: [
      sol('แพ็กเกจปัจจุบัน', C.soft, { size: 'sm', flex: 0, gravity: 'center' }),
      { type: 'box', layout: 'vertical', backgroundColor: isPro ? C.gold : C.bgSoft, cornerRadius: '14px',
        paddingAll: '6px', paddingStart: '14px', paddingEnd: '14px', flex: 0, contents: [
          sol(isPro ? 'PRO' : 'FREE', isPro ? C.white : C.soft, { size: 'sm', weight: 'bold', align: 'center' }),
        ] },
    ], justifyContent: 'space-between' },
    ...(isPro && until ? [sol(`ใช้ได้ถึง ${until}`, C.faint, { size: 'xs', align: 'end' })] : []),
    sep('lg'),
    sol('การใช้ AI วันนี้', C.faint, { size: 'xs' }),
    { type: 'box', layout: 'horizontal', contents: [
      sol('จด/อ่านบิลด้วย AI', C.ink, { size: 'sm', flex: 0, gravity: 'center' }),
      sol(`${used} / ${limit} ครั้ง`, used >= limit ? C.danger : C.ink, { size: 'sm', weight: 'bold', align: 'end', gravity: 'center' }),
    ] },
    { type: 'box', layout: 'vertical', height: '8px', backgroundColor: '#EDF2FB', cornerRadius: '4px', margin: 'sm',
      contents: [{ type: 'box', layout: 'vertical', width: `${Math.max(2, pct)}%`, backgroundColor: used >= limit ? C.danger : C.blue, cornerRadius: '4px', contents: [{ type: 'filler' }] }] },
    sol('คำสั่งดูข้อมูล (สรุป/รายงาน/งบ) ใช้ได้ไม่จำกัด', C.faint, { size: 'xxs', margin: 'sm', wrap: true }),
  ];
  if (!isPro) {
    body.push(sep('lg'));
    body.push(sol('อัปเกรดเป็น Pro ได้อะไร', C.ink, { size: 'sm', weight: 'bold' }));
    body.push({ type: 'box', layout: 'vertical', margin: 'sm', spacing: 'sm', contents: [
      { type: 'box', layout: 'baseline', contents: [sol('✓', C.green, { size: 'sm', flex: 0 }), sol(` จด/อ่านบิลด้วย AI ${proLimit} ครั้ง/วัน (จาก ${freeLimit})`, C.soft, { size: 'sm', wrap: true })] },
      { type: 'box', layout: 'baseline', contents: [sol('✓', C.green, { size: 'sm', flex: 0 }), sol(' รองรับร้านที่จดเยอะทุกวัน', C.soft, { size: 'sm', wrap: true })] },
    ] });
    if (contact) body.push(sol(`สนใจอัปเกรด ทักแอดมินได้ที่ ${contact}`, C.blue, { size: 'xs', margin: 'md', wrap: true }));
  }
  return {
    altText: isPro ? 'คุณเป็นสมาชิก Pro' : `แพ็กเกจ Free • ใช้ AI ${used}/${limit} วันนี้`,
    contents: bubble({
      headerBox: header(isPro ? 'สมาชิก Pro ⭐' : 'แพ็กเกจของคุณ', isPro ? 'ขอบคุณที่สนับสนุนครับ' : null, isPro ? C.gold : C.blue),
      bodyContents: body,
    }),
  };
}

// ---------- เฟส 24: การ์ดวิธีใช้งาน (แทนข้อความยาว ๆ) ----------
function helpCarousel(link) {
  const secHead = (txt) => ({ type: 'text', text: txt, size: 'xs', weight: 'bold', color: C.blue, margin: 'lg' });
  const cmdLine = (cmd, desc) => ({
    type: 'text', wrap: true, size: 'sm', margin: 'md', contents: [
      { type: 'span', text: cmd + '   ', weight: 'bold', color: C.ink },
      { type: 'span', text: desc, color: C.soft },
    ],
  });
  const bub = (title, sub, color, rows, footer) => {
    const b = {
      type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: [
        header(title, sub, color),
        { type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '8px', contents: rows },
      ] },
    };
    if (footer) b.footer = { type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px', contents: [footer] };
    return b;
  };

  const b1 = bub('วิธีใช้งาน', 'แบ่งเบา ผู้ช่วยบัญชี', C.green, [
    secHead('จดบัญชี'),
    cmdLine('พิมพ์เลย', 'เช่น  ขายกะเพรา 250 · ซื้อหมู 800'),
    cmdLine('ถ่ายรูป', 'บิล สลิป หรือยอด Grab/LineMan ส่งมาได้'),
    sep('lg'),
    secHead('ดูยอด'),
    cmdLine('วันนี้', 'ยอดขาย–กำไรของวันนี้'),
    cmdLine('เดือนนี้', 'สรุปทั้งเดือน'),
    cmdLine('รายงาน', 'กราฟ + แดชบอร์ด'),
  ], link ? { type: 'button', style: 'primary', color: C.blue, height: 'sm', action: { type: 'uri', label: 'เปิดแอปจัดการ', uri: link } } : null);

  const b2 = bub('เครื่องมือร้าน', 'พิมพ์คำสั่งสั้น ๆ', C.blueDeep, [
    secHead('ขายของ'),
    cmdLine('เมนู', 'ตั้งเมนู + ดูกำไรต่อจาน'),
    cmdLine('เป้า', 'ตั้งเป้ายอดขาย'),
    sep('lg'),
    secHead('เงิน & กำไร'),
    cmdLine('จุดคุ้มทุน', 'ต้องขายเท่าไหร่ถึงไม่ขาดทุน'),
    cmdLine('ปิดยอด', 'เช็กเงินสดในลิ้นชัก'),
    cmdLine('งบ', 'กำไร–ขาดทุนรายเดือน'),
    sep('lg'),
    secHead('สต๊อกวัตถุดิบ'),
    cmdLine('สต๊อก', 'ดู/ตั้งของ เช่น สต๊อก หมู 10 กก'),
    cmdLine('เติม / ใช้', 'เติมหมู 5 · ใช้หมู 2'),
    cmdLine('ต้องซื้อ', 'ดูรายการของใกล้หมด'),
    sep('lg'),
    secHead('ลูกหนี้ & เจ้าหนี้'),
    cmdLine('ลูกหนี้', 'ดู/เพิ่มบิลเชื่อ เช่น ลูกหนี้ ป้าแดง 120'),
    cmdLine('เจ้าหนี้', 'ดู/เพิ่มค้างจ่าย เช่น เจ้าหนี้ เจ๊ผัก 2000'),
    cmdLine('คงเหลือ', 'ดูสุขภาพร้าน + เงินคงเหลือจริง'),
    sep('lg'),
    secHead('อื่น ๆ'),
    cmdLine('ลบล่าสุด', 'ลบรายการที่จดผิด'),
    cmdLine('ออกรายงาน', 'ไฟล์ Excel ส่งบัญชี'),
    cmdLine('เพิ่มพนักงาน', 'ให้ลูกน้องช่วยจด'),
  ]);

  return { altText: 'วิธีใช้งานแบ่งเบา 📖', contents: { type: 'carousel', contents: [b1, b2] } };
}

// ---------- เฟส 25: การ์ดวิธีจดบัญชี ----------
function howToCard(link) {
  const exBox = (bg, color, lines) => ({
    type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: '8px',
    paddingAll: '11px', spacing: 'xs', margin: 'sm',
    contents: lines.map(t => sol(t, color, { size: 'sm', weight: 'bold', wrap: true })),
  });
  const titleLine = (icon, name, desc) => ({
    type: 'text', size: 'sm', wrap: true, margin: 'lg', contents: [
      { type: 'span', text: `${icon} ${name}`, weight: 'bold', color: C.ink },
      { type: 'span', text: `   ${desc}`, color: C.soft },
    ],
  });
  const body = [
    titleLine('🟢', 'ขายของ', 'พิมพ์ของที่ขาย + ราคา'),
    exBox('#EAF7F0', C.green, ['ขายข้าวกะเพรา 50', 'ขายก๋วยเตี๋ยว 3 ชาม 150']),
    titleLine('🟠', 'จ่ายเงิน', 'พิมพ์ของที่ซื้อ + ราคา'),
    exBox('#FFF3E9', C.warn, ['ซื้อหมู 800', 'จ่ายค่าน้ำแข็ง 60']),
    titleLine('📸', 'ถ่ายรูปก็ได้', 'บิล สลิป หรือยอด Grab/LineMan ส่งมาได้ เดี๋ยวผมอ่านให้'),
  ];
  return {
    altText: 'วิธีจดบัญชี ✍️ ง่าย ๆ แค่พิมพ์หรือถ่ายรูป',
    contents: bubble({
      headerBox: header('วิธีจดบัญชี', 'ง่าย ๆ แค่พิมพ์หรือถ่ายรูป', C.green),
      bodyContents: body,
      footerButton: linkButton('เปิดแอปจัดการ', link),
    }),
  };
}

// ===== เฟส 28: ลูกหนี้-เจ้าหนี้ + สุขภาพร้าน =====
function debtAddedCard(direction, party, added, remaining, link) {
  const isRecv = direction === 'receivable';
  const title = isRecv ? 'บันทึกลูกหนี้แล้ว' : 'บันทึกเจ้าหนี้แล้ว';
  const hint = isRecv
    ? `พอเก็บเงินได้ พิมพ์  รับเงิน ${party}`
    : `พอจ่ายแล้ว พิมพ์  จ่ายหนี้ ${party}`;
  const body = [
    statRow(party, `+${baht(added)} ฿`, isRecv ? C.green : C.warn, true),
    sol(`ยอดค้างรวมของ ${party}: ${baht(remaining)} ฿`, C.soft, { size: 'xs', wrap: true }),
    sep('md'),
    sol(hint, C.blueDeep, { size: 'sm', wrap: true }),
  ];
  return {
    altText: `${title} ${party} ${baht(added)} ฿`,
    contents: bubble({ headerBox: header(title, isRecv ? 'ลูกค้าติดเรา' : 'เราติดร้านอื่น', isRecv ? C.green : C.warn), bodyContents: body, footerButton: linkButton('เปิดแอปดูทั้งหมด', link) }),
  };
}

function debtSettledCard(direction, party, applied, remaining) {
  const isRecv = direction === 'receivable';
  const title = isRecv ? 'รับเงินแล้ว ✅' : 'จ่ายหนี้แล้ว ✅';
  const money = isRecv ? 'บันทึกเป็นรายรับให้แล้ว' : 'บันทึกเป็นรายจ่ายให้แล้ว';
  const remLine = remaining > 0.0001
    ? sol(`เหลือค้างอีก ${baht(remaining)} ฿`, C.soft, { size: 'sm' })
    : sol('เคลียร์ครบแล้ว 🎉', C.green, { size: 'sm', weight: 'bold' });
  const body = [
    statRow(party, `${baht(applied)} ฿`, isRecv ? C.green : C.warn, true),
    remLine,
    sep('md'),
    sol(money, C.soft, { size: 'xs' }),
  ];
  return {
    altText: `${title} ${party} ${baht(applied)} ฿`,
    contents: bubble({ headerBox: header(title, isRecv ? 'รับชำระจากลูกค้า' : 'ชำระให้ร้านค้า', C.green), bodyContents: body }),
  };
}

function debtListCard(direction, rows, link) {
  const isRecv = direction === 'receivable';
  const title = isRecv ? 'ลูกค้าที่ติดเงินเรา' : 'เราติดร้านอื่น';
  const color = isRecv ? C.green : C.warn;
  let body;
  if (!rows.length) {
    body = [sol('ยังไม่มียอดค้างครับ 👍', C.soft, { size: 'sm', wrap: true })];
  } else {
    const total = rows.reduce((s, r) => s + r.remaining, 0);
    const settleHint = isRecv ? 'เก็บเงินได้แล้ว พิมพ์  รับเงิน ตามด้วยชื่อ' : 'จ่ายแล้ว พิมพ์  จ่ายหนี้ ตามด้วยชื่อ';
    body = [
      ...rows.slice(0, 12).map(r => statRow(r.party, `${baht(r.remaining)} ฿`, color)),
      sep('md'),
      statRow('รวมค้าง', `${baht(total)} ฿`, color, true),
      sol(settleHint, C.blueDeep, { size: 'xs', wrap: true, margin: 'md' }),
    ];
  }
  return {
    altText: `${title} (${rows.length} ราย)`,
    contents: bubble({ headerBox: header(title, `${rows.length} ราย`, color), bodyContents: body, footerButton: linkButton('เปิดแอปจัดการ', link) }),
  };
}

function healthCard({ monthLabel, month, debt }) {
  const net = (debt.receivable || 0) - (debt.payable || 0);
  const body = [
    sol('เดือนนี้ (เงินสดที่จดจริง)', C.blue, { size: 'xs', weight: 'bold' }),
    statRow('รายรับ', `+${baht(month.income)} ฿`, C.green),
    statRow('รายจ่าย', `−${baht(month.expense)} ฿`, C.danger),
    statRow('กำไร', `${month.profit >= 0 ? '+' : '−'}${baht(Math.abs(month.profit))} ฿`, month.profit >= 0 ? C.green : C.danger, true),
    sep('lg'),
    sol('หนี้คงค้าง', C.blue, { size: 'xs', weight: 'bold', margin: 'md' }),
    statRow(`ลูกค้าติดเรา (${debt.receivableCount || 0} ราย)`, `+${baht(debt.receivable)} ฿`, C.green),
    statRow(`เราติดร้านอื่น (${debt.payableCount || 0} ราย)`, `−${baht(debt.payable)} ฿`, C.warn),
    sep('md'),
    statRow('สุทธิหนี้', `${net >= 0 ? '+' : '−'}${baht(Math.abs(net))} ฿`, net >= 0 ? C.green : C.danger, true),
    sol(net >= 0 ? 'ถ้าเก็บ-จ่ายหนี้ครบ จะมีเงินไหลเข้าสุทธิ' : 'ระวัง: หนี้ที่ต้องจ่ายมากกว่าที่จะได้คืน', C.soft, { size: 'xs', wrap: true, margin: 'md' }),
  ];
  return {
    altText: `สุขภาพร้าน ${monthLabel}`,
    contents: bubble({ headerBox: header('สุขภาพร้าน', monthLabel, C.blueDeep), bodyContents: body }),
  };
}

// ===== เฟส 29: สต๊อกวัตถุดิบ =====
function stockUpdatedCard(mode, item, delta) {
  const unit = item.unit ? ' ' + item.unit : '';
  const title = mode === 'add' ? 'เติมของแล้ว ✅' : mode === 'use' ? 'ตัดสต๊อกแล้ว ✅' : 'ตั้งสต๊อกแล้ว ✅';
  const headColor = item.low ? C.warn : C.green;
  const body = [
    statRow(item.name, `${baht(item.qty)}${unit}`, item.low ? C.warn : C.ink, true),
  ];
  if (delta != null) body.push(sol(`${mode === 'add' ? 'เพิ่ม' : 'ตัด'} ${baht(delta)}${unit}`, C.soft, { size: 'xs' }));
  if (item.low) {
    body.push(sep('md'));
    body.push(sol(`🔔 เหลือน้อยแล้ว (เตือนที่ ${baht(item.low_threshold)}${unit}) — ควรซื้อเพิ่ม`, C.warn, { size: 'sm', wrap: true }));
  }
  return {
    altText: `${title} ${item.name} ${baht(item.qty)}${unit}`,
    contents: bubble({ headerBox: header(title, 'สต๊อกวัตถุดิบ', headColor), bodyContents: body }),
  };
}

function stockListCard(rows, link) {
  let body;
  if (!rows.length) {
    body = [sol('ยังไม่มีวัตถุดิบในระบบครับ', C.soft, { size: 'sm', wrap: true }),
      sol('เพิ่มได้เลย เช่น  สต๊อก หมู 10 กก', C.blueDeep, { size: 'sm', wrap: true, margin: 'sm' })];
  } else {
    const lowN = rows.filter(r => r.low).length;
    body = rows.slice(0, 14).map(r => statRow(
      `${r.low ? '🔴 ' : ''}${r.name}`,
      `${baht(r.qty)}${r.unit ? ' ' + r.unit : ''}`,
      r.low ? C.warn : C.ink
    ));
    if (lowN) {
      body.push(sep('md'));
      body.push(sol(`🔔 ใกล้หมด ${lowN} อย่าง — พิมพ์  ต้องซื้อ  เพื่อดูรายการ`, C.warn, { size: 'xs', wrap: true }));
    }
  }
  return {
    altText: `สต๊อกวัตถุดิบ (${rows.length} อย่าง)`,
    contents: bubble({ headerBox: header('สต๊อกวัตถุดิบ', `${rows.length} อย่าง`, C.blueDeep), bodyContents: body, footerButton: linkButton('เปิดแอปจัดการ', link) }),
  };
}

function lowStockCard(rows, link) {
  let body;
  if (!rows.length) {
    body = [sol('ของครบ ไม่มีอะไรใกล้หมดครับ 👍', C.green, { size: 'sm', weight: 'bold', wrap: true })];
  } else {
    body = [
      sol('ควรซื้อเพิ่มก่อนหมด', C.soft, { size: 'xs', margin: 'none' }),
      ...rows.slice(0, 16).map(r => statRow(r.name, `เหลือ ${baht(r.qty)}${r.unit ? ' ' + r.unit : ''}`, C.warn)),
      sep('md'),
      sol('ซื้อมาแล้วเติมสต๊อกด้วย  เติม ตามด้วยชื่อ+จำนวน', C.blueDeep, { size: 'xs', wrap: true }),
    ];
  }
  return {
    altText: `รายการต้องซื้อ (${rows.length} อย่าง)`,
    contents: bubble({ headerBox: header('รายการต้องซื้อ 🛒', `${rows.length} อย่าง`, rows.length ? C.warn : C.green), bodyContents: body, footerButton: linkButton('เปิดแอปจัดการ', link) }),
  };
}

module.exports = {
  confirmCard, summaryCard, deliveryCard, menuProfitCard, menuLinkCard, dailyPushCard,
  goalCard, goalReachedCard, costCompareCard, exportCard, weeklyCard, welcomeCarousel,
  breakEvenCard, cashCloseCard, plCard, membershipCard, helpCarousel, howToCard,
  debtAddedCard, debtSettledCard, debtListCard, healthCard,
  stockUpdatedCard, stockListCard, lowStockCard,
};
