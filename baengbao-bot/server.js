const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const flex = require('./flex');
const xlsx = require('./export-xlsx');
const richmenu = require('./richmenu');

const app = express();

// กันไม่ให้ error จาก request เดียวทำให้ทั้งเซิร์ฟเวอร์ล่ม (log ไว้แทนที่จะ crash)
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message ? e.message : e));
const PORT = process.env.PORT || 3000;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LIFF_ID = process.env.LIFF_ID || '';
const liffUrl = () => (LIFF_ID ? `https://liff.line.me/${LIFF_ID}` : null);

// เฟส 10: base URL สำหรับลิงก์ดาวน์โหลด (ตั้งเองได้ หรือเดาจาก request webhook)
let detectedBaseUrl = process.env.PUBLIC_BASE_URL || '';
function baseUrl() { return detectedBaseUrl.replace(/\/$/, ''); }

// โทเคนลิงก์ดาวน์โหลด: เซ็นด้วย CHANNEL_SECRET หมดอายุใน 1 ชม.
function signExport(userId, ym) {
  const exp = Date.now() + 60 * 60 * 1000;
  const payload = Buffer.from(`${userId}|${ym}|${exp}`).toString('base64url');
  const sig = crypto.createHmac('sha256', CHANNEL_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyExport(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', CHANNEL_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [userId, ym, exp] = Buffer.from(payload, 'base64url').toString().split('|');
  if (!userId || !ym || Date.now() > +exp) return null;
  return { userId, ym };
}
// เฟส 35: ลิงก์ใบเสร็จ (ไม่หมดอายุ — เก็บไว้เปิดซ้ำได้)
function signReceipt(accountId, receiptNo) {
  const payload = Buffer.from(`${accountId}|${receiptNo}`).toString('base64url');
  const sig = crypto.createHmac('sha256', CHANNEL_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyReceipt(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', CHANNEL_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [accountId, receiptNo] = Buffer.from(payload, 'base64url').toString().split('|');
  if (!accountId || !receiptNo) return null;
  return { accountId, receiptNo: +receiptNo };
}
const FREE_AI_LIMIT = +process.env.FREE_AI_LIMIT || +process.env.DAILY_AI_LIMIT || 30;
const PRO_AI_LIMIT = +process.env.PRO_AI_LIMIT || 500;
function aiLimitFor(tier) { return tier === 'pro' ? PRO_AI_LIMIT : FREE_AI_LIMIT; }

// นับการเรียก AI ต่อวัน คืนสถานะโควตา (รู้ tier ด้วย)
async function overQuota(userId) {
  try {
    const today = bkkDate();
    const mem = await db.getMembership(userId, today);
    const limit = aiLimitFor(mem.effective);
    const n = await db.bumpUsage(userId, today);
    return { over: n > limit, tier: mem.effective, used: n, limit };
  } catch (e) { console.error('[quota]', e.message); return { over: false }; }
}
function quotaMessage(q) {
  if (q.tier === 'pro') {
    return `วันนี้ใช้ผู้ช่วย AI ครบโควตาแล้วครับ (${q.limit} ครั้ง/วัน) 🙏\nคำสั่งดูข้อมูลอย่าง "สรุป" "รายงาน" ยังใช้ได้ พรุ่งนี้ค่อยจดต่อได้เลย`;
  }
  return `วันนี้ใช้ผู้ช่วย AI ครบโควตาฟรีแล้วครับ (${q.limit} ครั้ง/วัน) 🙏\n` +
    `คำสั่งดูข้อมูลอย่าง "สรุป" "รายงาน" "เมนู" ยังใช้ได้ปกติ พรุ่งนี้รีเซ็ตใหม่\n\n` +
    `อยากจดได้ไม่อั้นกว่านี้ พิมพ์คำว่า  สมาชิก  เพื่อดูแพ็กเกจ Pro`;
}

// ---------- helpers ----------
function bkkDate(d = new Date()) {
  // YYYY-MM-DD ตามเวลาไทย
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function bkkHour(d = new Date()) {
  return +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }).format(d);
}
function bkkYesterday() {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return bkkDate(d);
}
function bkkDaysAgo(n) {
  return bkkDate(new Date(Date.now() - n * 24 * 3600 * 1000));
}
const TH_MON = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function monthCompareRanges(today) {
  const ym = today.slice(0, 7), day = +today.slice(8, 10);
  const [y, m] = ym.split('-').map(Number);
  let py = y, pm = m - 1; if (pm < 1) { pm = 12; py--; }
  const pym = `${py}-${String(pm).padStart(2, '0')}`;
  const prevLast = new Date(py, pm, 0).getDate();
  const pday = Math.min(day, prevLast);
  return {
    thisStart: `${ym}-01`, thisEnd: today,
    prevStart: `${pym}-01`, prevEnd: `${pym}-${String(pday).padStart(2, '0')}`,
    label: `เทียบ 1–${day} ${TH_MON[m]} กับ 1–${pday} ${TH_MON[pm]}`,
  };
}
async function linePush(to, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) throw new Error('push ' + res.status + ' ' + (await res.text()).slice(0, 120));
}
const baht = n => Number(n).toLocaleString('th-TH');

// ปุ่มกดลัด (Quick Reply) — ให้คนที่พิมพ์ไม่คล่อง/สูงวัย กดแทนพิมพ์ได้ทุกข้อความ
const QR_MAIN = {
  items: [
    { type: 'action', action: { type: 'message', label: '📊 ยอดวันนี้', text: 'สรุป' } },
    { type: 'action', action: { type: 'message', label: '📅 ทั้งเดือน', text: 'รายงาน' } },
    { type: 'action', action: { type: 'message', label: '✏️ วิธีจด', text: 'วิธีจด' } },
    { type: 'action', action: { type: 'message', label: '🎯 เป้า', text: 'เป้า' } },
    { type: 'action', action: { type: 'message', label: '☰ ดูทั้งหมด', text: 'ช่วย' } },
  ],
};
function attachQR(messages, qr) {
  if (!qr || !Array.isArray(messages) || !messages.length) return messages;
  const last = messages[messages.length - 1];
  if (last && typeof last === 'object' && !last.quickReply) last.quickReply = qr;
  return messages;
}
async function lineReply(replyToken, messages, qr = QR_MAIN) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: attachQR(messages, qr) }),
  });
  if (!res.ok) console.error('[line] reply failed', res.status, await res.text());
}
const replyText = (token, text, qr = QR_MAIN) => lineReply(token, [{ type: 'text', text }], qr);
const replyFlex = (token, altText, contents, qr = QR_MAIN) => lineReply(token, [{ type: 'flex', altText, contents }], qr);

async function getImageBase64(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` },
  });
  if (!res.ok) throw new Error('image fetch failed ' + res.status);
  const mediaType = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString('base64'), mediaType };
}

// โหลดไฟล์สื่อจากไลน์เป็น Buffer (ใช้กับเสียง)
async function getMessageContent(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` },
  });
  if (!res.ok) throw new Error('content fetch failed ' + res.status);
  return { buf: Buffer.from(await res.arrayBuffer()), mediaType: res.headers.get('content-type') || 'audio/m4a' };
}

function summaryLine(t) {
  return `รายรับ ${baht(t.income)} / รายจ่าย ${baht(t.expense)}\nกำไรสุทธิ ${t.profit >= 0 ? '+' : ''}${baht(t.profit)} ฿`;
}

// กำไรต่อจานของเมนู
const menuProfit = m => m.price - m.material_cost - m.labor_cost;
const menuMargin = m => (m.price > 0 ? (menuProfit(m) / m.price) * 100 : 0);

// เฟส 17: ประกอบงบกำไร-ขาดทุนของเดือน (ใช้ทั้งการ์ดและ Excel)
async function buildPL(userId, ym) {
  const [tot, split, cats, recs] = await Promise.all([
    db.monthTotals(userId, ym),
    db.incomeSplitForMonth(userId, ym),
    db.categoryBreakdown(userId, ym, 'expense'),
    db.listRecurring(userId),
  ]);
  const recurNames = new Set(recs.filter(r => r.active).map(r => r.name));
  let gpFees = 0, fixed = 0, variable = 0;
  for (const c of cats) {
    if (/^ค่า GP/.test(c.category)) gpFees += c.amount;
    else if (recurNames.has(c.category)) fixed += c.amount;
    else variable += c.amount;
  }
  const revenue = tot.income;
  const grossProfit = revenue - variable - gpFees;
  const netProfit = grossProfit - fixed;
  const marginPct = revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;
  return {
    revenue, storefront: split.storefront, delivery: split.delivery,
    variable, gpFees, fixed, grossProfit, netProfit, marginPct, count: tot.count,
  };
}
const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();

// จับคู่ชื่อรายการที่ขาย กับเมนูที่ตั้งไว้ (match แบบ contains)
function matchMenu(menus, itemName) {
  const n = norm(itemName);
  if (!n) return null;
  return menus.find(m => {
    const mn = norm(m.name);
    return mn && (mn.includes(n) || n.includes(mn));
  }) || null;
}

// เฟส 23: โหมดมือใหม่ — คำชม + ขั้นถัดไป (คืน null ถ้าไม่ได้อยู่ในโหมดสอน)
async function onboardNudge(identityId) {
  const step = await db.getOnboard(identityId);
  if (!step) return null;
  if (step === 1) {
    await db.setOnboard(identityId, 2);
    return 'เก่งมากครับ! 🎉 จดให้เรียบร้อยแล้ว\n\nลองอีกสักครั้ง — คราวนี้ลองจดรายจ่ายที่ซื้อของดูครับ\nเช่น  ซื้อหมู 800';
  }
  if (step === 2) {
    await db.setOnboard(identityId, 0);
    return 'สุดยอดเลยครับ! 🎊 คุณใช้เป็นแล้ว\n\nต่อไปก็แค่จดทุกครั้งที่ขายหรือซื้อของ เดี๋ยวผมสรุปยอด-กำไรให้เองทุกวัน\n\nอยากดูยอดเมื่อไหร่ กดปุ่ม 📊 ยอดวันนี้ ข้างล่างได้เลยครับ 😊';
  }
  return null;
}

async function confirmAndSummary(userId, parsed, source) {
  const date = bkkDate();
  await db.insertTxn({
    lineUserId: userId,
    type: parsed.type,
    amount: parsed.amount,
    category: parsed.category,
    note: parsed.note,
    items: parsed.items && parsed.items.length ? parsed.items : null,
    source,
    txnDate: date,
  });
  const day = await db.dayTotals(userId, date);

  let menuProfitEst = null;
  if (parsed.type === 'income' && parsed.items && parsed.items.length) {
    try {
      const menus = await db.listMenus(userId);
      if (menus.length) {
        const it = parsed.items[0];
        const m = matchMenu(menus, it.name);
        const qty = Number(it.qty) || null;
        if (m && qty) menuProfitEst = parsed.amount - (m.material_cost + m.labor_cost) * qty;
      }
    } catch (e) { console.error('[menuProfit]', e.message); }
  }

  const card = flex.confirmCard({
    type: parsed.type,
    amount: parsed.amount,
    note: parsed.note,
    menuProfitEst,
    day,
    link: liffUrl(),
  });
  const messages = [{ type: 'flex', altText: card.altText, contents: card.contents }];

  // เฟส 31: ตัดสต๊อกอัตโนมัติตามสูตร (เฉพาะการขายที่มีเมนู)
  if (parsed.type === 'income' && parsed.items && parsed.items.length) {
    try {
      const lines = []; const lowSet = new Set(); let totalCost = 0; let matched = false;
      for (const it of parsed.items) {
        const r = await db.applySaleToStock(userId, it.name, Number(it.qty) || 1);
        if (!r) continue;
        matched = true;
        for (const d of r.deducted) {
          if (d.noStock) continue;
          const u = d.unit ? ' ' + d.unit : '';
          lines.push(`${d.ingredient} −${baht(d.used)}${u} (เหลือ ${baht(d.remaining)}${u})`);
          if (d.low) lowSet.add(d.ingredient);
        }
        totalCost += r.cost || 0;
      }
      if (matched && lines.length) {
        let txt = '📦 ตัดสต๊อกอัตโนมัติ\n' + lines.join('\n');
        if (lowSet.size) txt += `\n🔔 ใกล้หมด: ${[...lowSet].join(', ')} — พิมพ์ ต้องซื้อ`;
        if (totalCost > 0) {
          const gross = parsed.amount - totalCost;
          txt += `\n💰 ต้นทุนวัตถุดิบ ~${baht(Math.round(totalCost))} บาท · กำไรขั้นต้น ~${baht(Math.round(gross))} บาท`;
        }
        messages.push({ type: 'text', text: txt });
      }
    } catch (e) { console.error('[autoDeduct]', e.message); }
  }

  // เฟส 8: เชียร์เมื่อยอดขายเพิ่งแตะเป้า
  if (parsed.type === 'income') {
    try {
      const goals = await db.getGoals(userId);
      if (goals.daily) {
        const before = day.income - parsed.amount;
        if (before < goals.daily && day.income >= goals.daily) {
          const g = flex.goalReachedCard({ period: 'day', current: day.income });
          messages.push({ type: 'flex', altText: g.altText, contents: g.contents });
        }
      }
      if (goals.monthly) {
        const month = await db.monthTotals(userId, date.slice(0, 7));
        const before = month.income - parsed.amount;
        if (before < goals.monthly && month.income >= goals.monthly) {
          const g = flex.goalReachedCard({ period: 'month', current: month.income });
          messages.push({ type: 'flex', altText: g.altText, contents: g.contents });
        }
      }
    } catch (e) { console.error('[goal]', e.message); }
  }

  // เฟส 27: เชียร์สตรีค (เฉพาะรายการแรกของวัน + ครบหลักสำคัญ)
  if (day.count === 1) {
    try {
      const streak = await db.currentStreak(userId, date);
      const msg = streakMilestone(streak);
      if (msg) messages.push({ type: 'text', text: msg });
    } catch (e) { console.error('[streak]', e.message); }
  }

  return { messages };
}

function streakMilestone(n) {
  const m = {
    3: 'จดติดต่อกัน 3 วันแล้ว เก่งมากครับ 🔥',
    7: 'ครบ 7 วันติด! เริ่มเป็นนิสัยที่ดีแล้ว 🔥🔥',
    14: '2 สัปดาห์ติดต่อกัน สุดยอดไปเลยครับ 🔥',
    30: 'จดครบ 30 วันติด! เป็นเจ้าของร้านมือโปรแล้ว 🏆',
    60: '60 วันติดต่อกัน! วินัยขั้นเทพ 🏆',
    100: '100 วันติด! คุณคือสุดยอดแม่ค้า/พ่อค้า 🏆🎉',
  };
  return m[n] || null;
}

// บันทึกยอดจากหน้าสรุปเดลิเวอรี่ (Grab/LineMan/Shopee)
async function recordDelivery(userId, p) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p.summary_date || '') ? p.summary_date : bkkDate();
  const platform = p.platform || 'เดลิเวอรี่';
  const ordersTxt = p.orders ? `${p.orders} ออเดอร์` : '';
  let gross = p.gross_sales, commission = p.commission, net = p.net_payout;

  const dateLabel = `${date.slice(8)}/${date.slice(5, 7)}`;

  // ไม่มียอดเลย จับไม่ได้
  if (gross == null && net == null) {
    return { text: `อ่านหน้าสรุป ${platform} แล้วแต่จับยอดไม่ชัดครับ ลองแคปให้เห็นยอดขายรวม/ยอดโอนชัด ๆ หรือพิมพ์ยอดมาก็ได้` };
  }

  // ถ้าไม่มียอดรวม ใช้ยอดสุทธิเป็นรายรับ (ถือว่า GP หักไปแล้ว)
  if (gross == null) {
    await db.insertTxn({
      lineUserId: userId, type: 'income', amount: net,
      category: `ขายเดลิเวอรี่·${platform}`, note: `${platform} (สุทธิ) ${ordersTxt}`.trim(),
      items: null, source: 'image', txnDate: date,
    });
    const day = await db.dayTotals(userId, date);
    return flex.deliveryCard({ platform, gross: null, commission: null, net, day, dateLabel, ordersTxt });
  }

  // มียอดขายรวม → ลงรายรับ = ยอดรวม, รายจ่าย = ค่า GP
  await db.insertTxn({
    lineUserId: userId, type: 'income', amount: gross,
    category: `ขายเดลิเวอรี่·${platform}`, note: `${platform} ${ordersTxt}`.trim(),
    items: null, source: 'image', txnDate: date,
  });
  if (commission && commission > 0) {
    await db.insertTxn({
      lineUserId: userId, type: 'expense', amount: commission,
      category: `ค่า GP·${platform}`, note: `ค่าธรรมเนียม ${platform}`,
      items: null, source: 'image', txnDate: date,
    });
  }
  const netShown = net != null ? net : gross - (commission || 0);
  const day = await db.dayTotals(userId, date);
  return flex.deliveryCard({ platform, gross, commission, net: netShown, day, dateLabel, ordersTxt });
}

// ---------- event handling ----------
// เฟส 36: คำสั่งที่สงวนให้เจ้าของร้าน (พนักงานใช้ไม่ได้)
function ownerOnlyCommand(raw, t) {
  const s = (raw || '').trim();
  const exact = new Set([
    // รายงาน/การเงิน
    'สรุป', 'สรุปวันนี้', 'สรุปเดือน', 'รายงาน', 'กำไร', 'ขาดทุน', 'กำไรขาดทุน', 'กำไร-ขาดทุน',
    'คงเหลือ', 'เงินคงเหลือ', 'สุขภาพร้าน', 'ฐานะ', 'ฐานะร้าน', 'เงินจริง',
    'เป้า', 'เป้าหมาย', 'จุดคุ้มทุน', 'คุ้มทุน', 'ปิดยอด', 'ปิดร้าน', 'เงินสด', 'ปิดบัญชี',
    'ออกรายงาน', 'excel', 'เอกเซล', 'ดาวน์โหลด', ' export',
    // ภาษี
    'ภาษี', 'vat', 'แวต', 'ภพ30', 'ภ.พ.30', 'ภ.พ. 30', 'เปิดภาษี', 'ปิดภาษี',
    // หนี้
    'ลูกหนี้', 'เจ้าหนี้', 'ค้างจ่าย', 'ดูลูกหนี้', 'ดูเจ้าหนี้', 'ใครติดเงิน', 'ใครติดบ้าง', 'ติดใครบ้าง',
    // คน/ตั้งค่า
    'พนักงาน', 'ลูกจ้าง', 'ทีมงาน', 'ดูพนักงาน', 'สมาชิก', 'เชิญ', 'โค้ด', 'รหัสเชิญ', 'ออกจากร้าน',
    'ตั้งค่า', 'อัปเกรด', 'โปร', 'pro', 'สมัครโปร', 'แพ็กเกจ',
    // สูตร (แก้ต้นทุน = ข้อมูลการเงิน)
    'สูตร', 'สูตรอาหาร', 'ดูสูตร',
  ].map(x => x.toLowerCase()));
  if (exact.has(s.toLowerCase())) return true;

  const prefixes = [
    'ตั้งภาษี', 'ภาษีซื้อ', 'vatซื้อ', 'ซื้อมีใบกำกับ',
    'ลูกหนี้ ', 'เจ้าหนี้ ', 'เชื่อ ', 'ติดเงิน', 'ติดไว้', 'ค้างเงิน', 'ค้างจ่าย ', 'ติดหนี้', 'ค้างเขา',
    'รับเงิน', 'เก็บเงิน', 'รับคืน', 'เก็บหนี้', 'จ่ายหนี้', 'ชำระหนี้', 'จ่ายเจ้าหนี้', 'ใช้หนี้',
    'พนักงาน ', 'ลงเวลา', 'เข้างาน', 'มาทำงาน', 'เบิก', 'จ่ายค่าแรง', 'จ่ายเงินเดือน', 'จ่ายลูกจ้าง', 'ลบพนักงาน',
    'ตั้งเป้า', 'เป้า ', 'ชื่อร้าน', 'ที่อยู่ร้าน', 'ที่อยู่ ', 'เลขภาษี', 'เลขผู้เสียภาษี',
    'สูตร ', 'ลบสูตร', 'ต้นทุน ', 'ราคาทุน',
  ].map(x => x.toLowerCase());
  const low = s.toLowerCase();
  return prefixes.some(p => low.startsWith(p));
}

async function handleEvent(ev) {
  if (ev.type === 'follow') {
    const newUserId = ev.source && ev.source.userId;
    if (newUserId) { await db.upsertUser(newUserId); await db.setOnboard(newUserId, 1); }
    const w = flex.welcomeCarousel(liffUrl());
    return lineReply(ev.replyToken, [
      { type: 'flex', altText: w.altText, contents: w.contents },
      { type: 'text', text: 'มาลองใช้ด้วยกันเลยครับ 😊\n\nขั้นแรก ลองพิมพ์ยอดขายล่าสุดของวันนี้มาดูครับ\nเช่น  ขายข้าว 50\n\n(พิมพ์ของจริงได้เลย เดี๋ยวผมจดให้ — หรือพิมพ์คำว่า ข้าม ถ้าไม่อยากให้สอน)' },
    ]);
  }
  if (ev.type !== 'message' || !ev.source || ev.source.type !== 'user') return;

  const identityId = ev.source.userId;        // ตัวตนของคนที่พิมพ์ (เจ้าของหรือพนักงาน)
  await db.upsertUser(identityId);
  const userId = await db.accountOf(identityId); // บัญชีข้อมูลร้าน (แชร์กันในร้าน)
  const isOwner = identityId === userId;         // เจ้าของ = ตัวตนตรงกับบัญชีร้าน (account_id ว่าง)

  // ----- text -----
  if (ev.message.type === 'text') {
    const raw = ev.message.text.trim();
    const t = raw.toLowerCase();

    try {
      if (['ช่วย', 'help', 'วิธีใช้', 'เริ่ม', 'start'].some(k => t.includes(k))) {
        const h = flex.helpCarousel(liffUrl());
        return replyFlex(ev.replyToken, h.altText, h.contents);
      }

      // เฟส 36: สิทธิ์ตามบทบาท — พนักงานจดรายรับ-รายจ่าย + ดู/จัดการสต๊อก + ออกใบเสร็จได้
      // แต่ข้อมูลการเงิน/รายงาน/ตั้งค่า/จัดการคน เป็นของเจ้าของร้านเท่านั้น
      if (!isOwner && ownerOnlyCommand(raw, t)) {
        return replyText(ev.replyToken,
          'ส่วนนี้เฉพาะเจ้าของร้านครับ 🔒\n\nคุณเข้าใช้ในฐานะ "พนักงาน" ทำได้:\n• จดรายรับ-รายจ่าย (พิมพ์/พูด/ถ่ายบิล)\n• ดู/เติม/ใช้ สต๊อก · ดูของต้องซื้อ\n• ออกใบเสร็จให้ลูกค้า\n\nรายงานกำไร ตั้งค่า และจัดการต่าง ๆ ให้เจ้าของร้านเป็นคนดูนะครับ');
      }

      if (raw === 'ข้าม' || raw.includes('ข้ามการสอน') || t === 'skip') {
        if (await db.getOnboard(identityId) > 0) {
          await db.setOnboard(identityId, 0);
          return replyText(ev.replyToken, 'ได้เลยครับ ข้ามการสอนแล้ว 👌\nอยากดูวิธีจด กดปุ่ม ✏️ วิธีจด ข้างล่างได้ตลอดนะครับ');
        }
      }

      if (['ลบล่าสุด', 'ยกเลิกล่าสุด', 'ลบรายการล่าสุด', 'ลบอันล่าสุด'].some(k => raw.includes(k))) {
        const last = (await db.recentTxns(userId, 1))[0];
        if (!last) return replyText(ev.replyToken, 'ยังไม่มีรายการให้ลบครับ');
        await db.deleteTxn(userId, last.id);
        const sign = last.type === 'income' ? 'รายรับ +' : 'รายจ่าย −';
        const desc = last.note || last.category || '';
        return replyText(ev.replyToken, `ลบรายการล่าสุดแล้วครับ ✅\n${sign}${baht(last.amount)} ฿${desc ? '  (' + desc + ')' : ''}\n\nถ้าลบผิด จดเข้าไปใหม่ได้เลยครับ`);
      }
      if (['แก้ล่าสุด', 'แก้รายการล่าสุด', 'แก้อันล่าสุด'].some(k => raw.includes(k))) {
        const last = (await db.recentTxns(userId, 1))[0];
        if (!last) return replyText(ev.replyToken, 'ยังไม่มีรายการให้แก้ครับ');
        const u = liffUrl();
        const sign = last.type === 'income' ? 'รายรับ +' : 'รายจ่าย −';
        return replyText(ev.replyToken, `รายการล่าสุดคือ\n${sign}${baht(last.amount)} ฿${last.note ? '  (' + last.note + ')' : ''}\n\nแก้ได้ในแอป แตะรูปดินสอที่รายการนั้น${u ? '\n' + u : ''}\nหรือพิมพ์  ลบล่าสุด  แล้วจดใหม่ก็ได้ครับ`);
      }

      if (['วิธีจด', 'จดยังไง', 'จดยังไ', 'สอนจด', 'จดอย่างไร', 'จดไง'].some(k => raw.includes(k))) {
        const h = flex.howToCard(liffUrl());
        return replyFlex(ev.replyToken, h.altText, h.contents);
      }

      // ===== เฟส 20: ระบบเพิ่มพนักงาน (แชร์บัญชีร้าน) — ใช้ identityId =====
      const isStaff = userId !== identityId; // ถ้าบัญชีข้อมูล != ตัวเอง แปลว่าเป็นพนักงาน
      if (['เพิ่มพนักงาน', 'เพิ่มลูกน้อง', 'เพิ่มทีม', 'invite'].some(k => raw.includes(k))) {
        if (isStaff) return replyText(ev.replyToken, 'ตอนนี้คุณเป็นพนักงานของร้านอื่นอยู่ครับ\nถ้าจะเปิดร้านของตัวเอง พิมพ์คำว่า  ออกจากร้าน  ก่อนนะครับ');
        const code = await db.ensureInvite(identityId);
        return replyText(ev.replyToken,
          `เพิ่มพนักงานได้เลยครับ 👥\n\nรหัสร้านของคุณคือ\n👉 ${code}\n\nให้พนักงาน:\n1) แอดเพื่อนบอทแบ่งเบา\n2) พิมพ์ว่า  เข้าร้าน ${code}\n\nหลังจากนั้นที่พนักงานจด จะเข้าบัญชีร้านเดียวกับคุณ\nดูรายชื่อทีม พิมพ์คำว่า พนักงาน`);
      }
      if (raw.startsWith('เข้าร้าน') || /^join\s/i.test(raw)) {
        const code = raw.replace(/^เข้าร้าน|^join/i, '').trim().toUpperCase();
        if (!code) return replyText(ev.replyToken, 'พิมพ์รหัสร้านแบบนี้ครับ\nเข้าร้าน ABC123\n(ขอรหัสจากเจ้าของร้าน)');
        if (await db.countMembers(identityId) > 0)
          return replyText(ev.replyToken, 'ร้านของคุณมีพนักงานอยู่ จึงย้ายไปเป็นพนักงานร้านอื่นไม่ได้ครับ');
        const owner = await db.findByInvite(code);
        if (!owner) return replyText(ev.replyToken, 'ไม่พบรหัสร้านนี้ครับ ลองเช็กตัวอักษรอีกที (พิมพ์ใหญ่-เล็กไม่สำคัญ)');
        if (owner === identityId) return replyText(ev.replyToken, 'นี่คือรหัสร้านของคุณเองครับ 😄');
        await db.joinShop(identityId, owner);
        return replyText(ev.replyToken, 'เข้าร้านสำเร็จ! 🎉\nตั้งแต่นี้ที่คุณจด/ถ่ายบิล จะเข้าบัญชีร้านเดียวกับเจ้าของ\nรายการเก่าที่เคยจดด้วยบัญชีตัวเองจะแยกไว้ ไม่หาย\n\nอยากเลิกช่วยจด พิมพ์คำว่า  ออกจากร้าน');
      }
      if (raw.includes('ออกจากร้าน') || raw === 'leave') {
        if (!isStaff) return replyText(ev.replyToken, 'ตอนนี้คุณใช้บัญชีของตัวเองอยู่ ไม่ได้เป็นพนักงานร้านไหนครับ');
        await db.leaveShop(identityId);
        return replyText(ev.replyToken, 'ออกจากร้านแล้วครับ กลับมาใช้บัญชีของตัวเองตามเดิม');
      }
      if (['พนักงาน', 'ลูกน้อง', 'ทีมงาน', 'ดูทีม'].some(k => raw.includes(k))) {
        if (isStaff) return replyText(ev.replyToken, 'คุณกำลังช่วยจดให้ร้าน (บัญชีของเจ้าของ) อยู่ครับ 👍\nอยากกลับไปใช้บัญชีตัวเอง พิมพ์คำว่า  ออกจากร้าน');
        const members = await db.listShopMembers(identityId);
        if (!members.length)
          return replyText(ev.replyToken, 'ยังไม่มีพนักงานในร้านครับ\nพิมพ์คำว่า  เพิ่มพนักงาน  เพื่อสร้างรหัสเชิญได้เลย');
        const code = await db.ensureInvite(identityId);
        const list = members.map((m, i) => `${i + 1}. ${m.name || '(ไม่มีชื่อ)'}`).join('\n');
        return replyText(ev.replyToken, `พนักงานในร้าน (${members.length} คน) 👥\n${list}\n\nรหัสเชิญเพิ่ม: ${code}`);
      }

      if (['ปิดสรุป', 'ปิดแจ้งเตือน', 'ปิดเตือน'].some(k => raw.includes(k))) {
        await db.setDailySummary(userId, false);
        return replyText(ev.replyToken, 'ปิดแจ้งเตือนสรุปรายวันแล้วครับ 🔕\nอยากเปิดใหม่ พิมพ์คำว่า  เปิดสรุป  ได้ทุกเมื่อ');
      }
      if (['เปิดสรุป', 'เปิดแจ้งเตือน', 'เปิดเตือน'].some(k => raw.includes(k))) {
        await db.setDailySummary(userId, true);
        return replyText(ev.replyToken, `เปิดแจ้งเตือนแล้วครับ 🔔\nทุกวันประมาณ ${DAILY_SUMMARY_HOUR} โมง ผมจะสรุปยอดวันนั้นให้ (เฉพาะวันที่มีการจด)`);
      }

      if (raw.includes('เป้า')) {
        if (['ลบเป้า', 'ยกเลิกเป้า', 'เอาเป้าออก'].some(k => raw.includes(k))) {
          await db.setGoal(userId, { daily: null, monthly: null });
          return replyText(ev.replyToken, 'ลบเป้ายอดขายทั้งหมดแล้วครับ');
        }
        const numMatch = raw.replace(/,/g, '').match(/\d+(\.\d+)?/);
        if (numMatch) {
          const amt = Math.round(parseFloat(numMatch[0]));
          if (/เดือน/.test(raw)) {
            await db.setGoal(userId, { monthly: amt });
            return replyText(ev.replyToken, `ตั้งเป้ายอดขายเดือนละ ${baht(amt)} ฿ แล้วครับ 🎯\nดูความคืบหน้าได้ที่ปุ่ม 🎯 เป้า ข้างล่าง`);
          }
          await db.setGoal(userId, { daily: amt });
          return replyText(ev.replyToken, `ตั้งเป้ายอดขายวันละ ${baht(amt)} ฿ แล้วครับ 🎯\nดูความคืบหน้าได้ที่ปุ่ม 🎯 เป้า ข้างล่าง`);
        }
        // ไม่มีตัวเลข → โชว์ความคืบหน้า
        const goals = await db.getGoals(userId);
        const today = bkkDate();
        const [day, month] = await Promise.all([
          db.dayTotals(userId, today),
          db.monthTotals(userId, today.slice(0, 7)),
        ]);
        const c = flex.goalCard({
          todayIncome: day.income, dailyGoal: goals.daily,
          monthIncome: month.income, monthlyGoal: goals.monthly, link: liffUrl(),
        });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }

      if (['สรุป', 'วันนี้', 'ยอดวันนี้'].some(k => raw.includes(k))) {
        const day = await db.dayTotals(userId, bkkDate());
        const c = flex.summaryCard({ title: 'สรุปวันนี้', sub: `${day.count} รายการ`, totals: day, link: liffUrl() });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }
      if (['เดือนนี้', 'สรุปเดือน', 'ยอดเดือน'].some(k => raw.includes(k))) {
        const ym = bkkDate().slice(0, 7);
        const m = await db.monthTotals(userId, ym);
        const c = flex.summaryCard({ title: 'สรุปเดือนนี้', sub: `${m.count} รายการ`, totals: m, link: liffUrl() });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }
      if (['กำไรเมนู', 'กำไรต่อจาน'].some(k => raw.includes(k))) {
        const menus = await db.listMenus(userId);
        if (!menus.length) {
          const u = liffUrl();
          return replyText(ev.replyToken, 'ยังไม่มีเมนูเลยครับ ตั้งเมนูแรกได้ที่นี่' + (u ? `\n${u}` : ' ครับ'));
        }
        const rows = menus
          .slice()
          .sort((a, b) => menuProfit(b) - menuProfit(a))
          .slice(0, 10)
          .map(m => ({ name: m.name, profit: menuProfit(m), margin: menuMargin(m).toFixed(0) }));
        const c = flex.menuProfitCard(rows, liffUrl());
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }
      if (raw.includes('เมนู')) {
        const u = liffUrl();
        if (!u) return replyText(ev.replyToken, 'ยังไม่ได้ตั้งค่า LIFF (ตั้ง LIFF_ID ใน env ก่อนครับ)');
        const menus = await db.listMenus(userId);
        const c = flex.menuLinkCard({
          link: u,
          menus: menus.map(m => ({ name: m.name, profit: menuProfit(m) })),
        });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }
      if (['รายงาน', 'แดชบอร์ด', 'กราฟ', 'dashboard'].some(k => t.includes(k))) {
        const ym = bkkDate().slice(0, 7);
        const m = await db.monthTotals(userId, ym);
        const c = flex.summaryCard({ title: 'รายงานเดือนนี้', sub: `${m.count} รายการ • ดูกราฟเต็มได้ในแดชบอร์ด`, totals: m, link: liffUrl() });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }
      if (['ต้นทุน', 'เทียบต้นทุน', 'เทียบรายจ่าย', 'ค่าใช้จ่ายเดือน'].some(k => raw.includes(k))) {
        const today = bkkDate();
        const R = monthCompareRanges(today);
        const cmp = await db.categoryCompare(userId, R.thisStart, R.thisEnd, R.prevStart, R.prevEnd);
        const filtered = cmp.filter(r => r.cur > 0 || r.prev > 0);
        if (!filtered.length) return replyText(ev.replyToken, 'ยังไม่มีข้อมูลรายจ่ายให้เทียบเลยครับ ลองจดรายจ่ายสักพักแล้วกลับมาดูใหม่นะ');
        const rows = filtered.map(r => {
          let status = 'flat', pct = 0;
          if (r.prev === 0 && r.cur > 0) status = 'new';
          else if (r.prev > 0) { pct = Math.round(((r.cur - r.prev) / r.prev) * 100); status = pct >= 5 ? 'up' : (pct <= -5 ? 'down' : 'flat'); }
          return { category: r.category, cur: r.cur, prev: r.prev, pct, status };
        }).slice(0, 8);
        const topSpike = rows.filter(r => r.status === 'up' && r.cur >= 100).sort((a, b) => b.pct - a.pct)[0] || null;
        const c = flex.costCompareCard({ rows, periodLabel: R.label, topSpike });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }

      if (['สัปดาห์', 'รายสัปดาห์', '7วัน', '7 วัน', 'อาทิตย์'].some(k => raw.includes(k))) {
        const today = bkkDate();
        const tStart = bkkDaysAgo(6), lStart = bkkDaysAgo(13), lEnd = bkkDaysAgo(7);
        const [thisWeek, lastWeek] = await Promise.all([
          db.rangeTotals(userId, tStart, today),
          db.rangeTotals(userId, lStart, lEnd),
        ]);
        const dlabel = s => `${+s.slice(8)} ${TH_MON[+s.slice(5, 7)]}`;
        const c = flex.weeklyCard({ rangeLabel: `${dlabel(tStart)} – ${dlabel(today)}`, thisWeek, lastWeek, link: liffUrl() });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }

      if (['จุดคุ้มทุน', 'คุ้มทุน', 'breakeven', 'break even'].some(k => raw.includes(k))) {
        const fixedMonthly = await db.recurringMonthlyTotal(userId);
        if (!fixedMonthly) {
          const u = liffUrl();
          return replyText(ev.replyToken, 'ขอข้อมูลเพิ่มอีกนิดครับ 🙏\nจุดคุ้มทุนต้องรู้ค่าใช้จ่ายประจำก่อน เช่น ค่าเช่า เงินเดือน\nไปตั้งได้ในแอป แท็บตั้งค่า' + (u ? `\n${u}` : '') + '\nแล้วลองใหม่อีกครั้งนะครับ');
        }
        // กำไรขั้นต้นเฉลี่ย: จากเมนูก่อน ถ้าไม่มีค่อยประเมินจากข้อมูล 30 วัน
        const menus = await db.listMenus(userId);
        const sumPrice = menus.reduce((s, m) => s + m.price, 0);
        const today = bkkDate();
        const r30 = await db.rangeTotals(userId, bkkDaysAgo(29), today);
        let marginRatio = null;
        if (sumPrice > 0) {
          const sumCost = menus.reduce((s, m) => s + m.material_cost + m.labor_cost, 0);
          marginRatio = (sumPrice - sumCost) / sumPrice;
        } else if (r30.income > 0) {
          const variable = Math.max(0, r30.expense - fixedMonthly);
          marginRatio = (r30.income - variable) / r30.income;
        }
        if (!marginRatio || marginRatio <= 0) {
          return replyText(ev.replyToken, 'ข้อมูลยังไม่พอคำนวณกำไรครับ 🙏\nลองตั้งเมนูพร้อมราคาต้นทุน หรือจดรายรับ-รายจ่ายสักพัก แล้วลองใหม่นะครับ');
        }
        const beMonthly = Math.round(fixedMonthly / marginRatio);
        const beDaily = Math.round(beMonthly / 30);
        const avgDaily = Math.round(r30.income / 30);
        const c = flex.breakEvenCard({
          fixedMonthly, marginPct: Math.round(marginRatio * 100),
          beMonthly, beDaily, avgDaily, link: liffUrl(),
        });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }

      if (['งบกำไรขาดทุน', 'งบกำไร', 'กำไรขาดทุน', 'งบเดือน', 'p&l', 'pl', 'งบ '].some(k => raw.includes(k)) || raw.trim() === 'งบ') {
        const ym = bkkDate().slice(0, 7);
        const pl = await buildPL(userId, ym);
        if (!pl.count) return replyText(ev.replyToken, `เดือน ${xlsx.thMonthLabel(ym)} ยังไม่มีรายการให้ทำงบครับ`);
        const c = flex.plCard({ monthLabel: xlsx.thMonthLabel(ym), pl, link: liffUrl() });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }

      if (['สมาชิก', 'แพ็กเกจ', 'แพคเกจ', 'upgrade', 'อัปเกรด', 'โควตา'].some(k => raw.includes(k))) {
        const today = bkkDate();
        const mem = await db.getMembership(userId, today);
        const used = await db.usageToday(userId, today);
        const c = flex.membershipCard({
          effective: mem.effective, until: mem.until, used, limit: aiLimitFor(mem.effective),
          freeLimit: FREE_AI_LIMIT, proLimit: PRO_AI_LIMIT, contact: process.env.ADMIN_CONTACT || '@952dxvdb',
        });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }

      if (raw.includes('ตั้งเงินทอน') || raw.includes('เงินทอนตั้งต้น')) {
        const m = raw.replace(/,/g, '').match(/\d+(\.\d+)?/);
        if (!m) return replyText(ev.replyToken, 'พิมพ์แบบนี้ครับ\nตั้งเงินทอน 1000\n(เงินที่ใส่ลิ้นชักไว้ตอนเปิดร้าน)');
        const amt = Math.round(parseFloat(m[0]) * 100) / 100;
        await db.setCashFloat(userId, amt);
        return replyText(ev.replyToken, `ตั้งเงินทอนตั้งต้น ${baht(amt)} ฿ แล้วครับ\nสิ้นวันพิมพ์  ปิดยอด  ตามด้วยเงินที่นับได้ เช่น ปิดยอด 3500`);
      }

      if (raw.includes('ปิดยอด')) {
        const today = bkkDate();
        const openingFloat = await db.getCashFloat(userId);
        const { cashIn, cashOut } = await db.cashTotalsForDay(userId, today);
        const expected = openingFloat + cashIn - cashOut;
        const m = raw.replace(/,/g, '').match(/\d+(\.\d+)?/);
        if (!m) {
          return replyText(ev.replyToken,
            `ปิดยอดเงินสดวันนี้ 💵\nตอนนี้ในลิ้นชักควรมี ${baht(expected)} ฿\n(เงินทอนตั้งต้น ${baht(openingFloat)} + ขายสด ${baht(cashIn)} − จ่ายสด ${baht(cashOut)})\n\nนับเงินจริงแล้วพิมพ์  ปิดยอด  ตามด้วยจำนวน เช่น ปิดยอด 3500\nถ้าเงินทอนตั้งต้นไม่ตรง พิมพ์  ตั้งเงินทอน  ตามด้วยจำนวน`);
        }
        const actual = Math.round(parseFloat(m[0]) * 100) / 100;
        const c = flex.cashCloseCard({
          openingFloat, cashIn, cashOut, expected, actual,
          dateLabel: `${today.slice(8)}/${today.slice(5, 7)}`,
        });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }

      if (['ออกรายงาน', 'export', 'excel', 'ดาวน์โหลด', 'ไฟล์บัญชี', 'ส่งบัญชี', 'ยื่นภาษี'].some(k => raw.includes(k))) {
        if (!baseUrl()) return replyText(ev.replyToken, 'ยังตั้งค่าลิงก์ดาวน์โหลดไม่เสร็จครับ ลองพิมพ์อีกครั้งในอีกสักครู่');
        // เลือกเดือน: "เดือนก่อน"/"เดือนที่แล้ว" = เดือนก่อน, รูปแบบ YYYY-MM, ไม่งั้นเดือนนี้
        let ym = bkkDate().slice(0, 7);
        const ymMatch = raw.match(/20\d{2}-\d{2}/);
        if (ymMatch) ym = ymMatch[0];
        else if (/เดือนก่อน|เดือนที่แล้ว/.test(raw)) {
          const [y, m] = ym.split('-').map(Number);
          let py = y, pm = m - 1; if (pm < 1) { pm = 12; py--; }
          ym = `${py}-${String(pm).padStart(2, '0')}`;
        }
        const totals = await db.monthTotals(userId, ym);
        if (!totals.count) return replyText(ev.replyToken, `เดือน ${xlsx.thMonthLabel(ym)} ยังไม่มีรายการให้ออกรายงานครับ`);
        const url = `${baseUrl()}/export.xlsx?t=${signExport(userId, ym)}`;
        const c = flex.exportCard({ monthLabel: xlsx.thMonthLabel(ym), url, totals });
        return replyFlex(ev.replyToken, c.altText, c.contents);
      }

      // ===== เฟส 28: ลูกหนี้-เจ้าหนี้ =====
      {
        const parseNameAmount = (str) => {
          const m = str.match(/(-?[\d,]+(?:\.\d+)?)\s*(?:บาท|฿)?\s*$/);
          if (!m) return { name: str.trim(), amount: null };
          const amount = Number(m[1].replace(/,/g, ''));
          const name = str.slice(0, m.index).trim();
          return { name, amount: isFinite(amount) ? amount : null };
        };
        // เพิ่มลูกหนี้ (ลูกค้าติดเรา)
        let m = raw.match(/^(?:ลูกหนี้|เชื่อ|ติดเงิน|ติดไว้|ค้างเงิน)\s+(.+)$/);
        if (m) {
          const { name, amount } = parseNameAmount(m[1]);
          if (!name || amount == null || amount <= 0)
            return replyText(ev.replyToken, 'บอกชื่อกับยอดด้วยครับ เช่น  ลูกหนี้ ป้าแดง 120');
          const r = await db.upsertDebt(userId, 'receivable', name, amount, null, bkkDate());
          const c = flex.debtAddedCard('receivable', name, amount, r.remaining, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // เพิ่มเจ้าหนี้ (เราติดคนอื่น)
        m = raw.match(/^(?:เจ้าหนี้|ค้างจ่าย|ติดหนี้|ค้างเขา)\s+(.+)$/);
        if (m) {
          const { name, amount } = parseNameAmount(m[1]);
          if (!name || amount == null || amount <= 0)
            return replyText(ev.replyToken, 'บอกชื่อกับยอดด้วยครับ เช่น  เจ้าหนี้ เจ๊ผักสด 2000');
          const r = await db.upsertDebt(userId, 'payable', name, amount, null, bkkDate());
          const c = flex.debtAddedCard('payable', name, amount, r.remaining, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // รับเงินคืนจากลูกค้า (ลูกหนี้ชำระ) -> บันทึกเป็นรายรับ
        m = raw.match(/^(?:รับเงิน|เก็บเงิน|รับคืน|เก็บหนี้)\s+(.+)$/);
        if (m) {
          const { name, amount } = parseNameAmount(m[1]);
          const s = await db.settleDebt(userId, 'receivable', name, amount);
          if (!s.found) return replyText(ev.replyToken, `ไม่เจอลูกหนี้ชื่อ ${name.trim()} ครับ\nพิมพ์คำว่า  ลูกหนี้  เพื่อดูรายชื่อทั้งหมด`);
          await db.insertTxn({ lineUserId: userId, type: 'income', amount: s.applied, category: 'รับชำระหนี้', note: `รับเงินจาก ${s.party}`, items: null, source: 'debt', txnDate: bkkDate() });
          const c = flex.debtSettledCard('receivable', s.party, s.applied, s.remaining);
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // จ่ายหนี้ให้ซัพพลายเออร์ (เจ้าหนี้) -> บันทึกเป็นรายจ่าย
        m = raw.match(/^(?:จ่ายหนี้|ชำระหนี้|จ่ายเจ้าหนี้|ใช้หนี้)\s+(.+)$/);
        if (m) {
          const { name, amount } = parseNameAmount(m[1]);
          const s = await db.settleDebt(userId, 'payable', name, amount);
          if (!s.found) return replyText(ev.replyToken, `ไม่เจอเจ้าหนี้ชื่อ ${name.trim()} ครับ\nพิมพ์คำว่า  เจ้าหนี้  เพื่อดูรายชื่อทั้งหมด`);
          await db.insertTxn({ lineUserId: userId, type: 'expense', amount: s.applied, category: 'จ่ายชำระหนี้', note: `จ่ายให้ ${s.party}`, items: null, source: 'debt', txnDate: bkkDate() });
          const c = flex.debtSettledCard('payable', s.party, s.applied, s.remaining);
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // ดูรายชื่อลูกหนี้ / เจ้าหนี้
        if (raw === 'ลูกหนี้' || raw === 'ดูลูกหนี้' || raw === 'ใครติดเงิน' || raw === 'ใครติดบ้าง') {
          const rows = await db.listDebts(userId, 'receivable');
          const c = flex.debtListCard('receivable', rows, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        if (raw === 'เจ้าหนี้' || raw === 'ดูเจ้าหนี้' || raw === 'ค้างจ่าย' || raw === 'ติดใครบ้าง') {
          const rows = await db.listDebts(userId, 'payable');
          const c = flex.debtListCard('payable', rows, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // เงินคงเหลือจริง / สุขภาพร้าน
        if (['คงเหลือ', 'เงินคงเหลือ', 'สุขภาพร้าน', 'ฐานะร้าน', 'ฐานะ', 'เงินจริง'].some(k => raw === k)) {
          const ym = bkkDate().slice(0, 7);
          const mt = await db.monthTotals(userId, ym);
          const dt = await db.debtTotals(userId);
          const c = flex.healthCard({ monthLabel: xlsx.thMonthLabel(ym), month: mt, debt: dt });
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
      }

      // ===== เฟส 29: สต๊อกวัตถุดิบ =====
      {
        const trailNum = (str) => {
          const m = str.match(/(-?[\d,]+(?:\.\d+)?)\s*(.*)$/);
          if (!m) return null;
          const qty = Number(m[1].replace(/,/g, ''));
          const name = str.slice(0, m.index).trim();
          const unit = (m[2] || '').trim();
          return isFinite(qty) ? { name, qty, unit } : null;
        };
        // ตั้งยอดคงเหลือ: สต๊อก <ชื่อ> <จำนวน> [หน่วย]
        let m = raw.match(/^(?:สต๊อก|สต็อก|สตอก)\s+(.+)$/);
        if (m) {
          const p = trailNum(m[1]);
          if (!p || !p.name) return replyText(ev.replyToken, 'บอกชื่อกับจำนวนด้วยครับ เช่น  สต๊อก หมู 10 กก');
          const it = await db.setStock(userId, p.name, p.qty, p.unit);
          const c = flex.stockUpdatedCard('set', it);
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // ดูสต๊อกทั้งหมด
        if (['สต๊อก', 'สต็อก', 'ดูสต๊อก', 'วัตถุดิบ', 'ของในร้าน', 'คลัง'].includes(raw)) {
          const rows = await db.listStock(userId);
          const c = flex.stockListCard(rows, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // เติมของเข้า (+)
        m = raw.match(/^(?:เติม|รับของ|เพิ่มสต๊อก|เข้าของ)\s*(.+)$/);
        if (m) {
          const p = trailNum(m[1]);
          if (p && p.name && p.qty > 0) {
            const r = await db.adjustStock(userId, p.name, p.qty);
            const c = flex.stockUpdatedCard('add', r.item, p.qty);
            return replyFlex(ev.replyToken, c.altText, c.contents);
          }
        }
        // ตัดของที่ใช้ (−)
        m = raw.match(/^(?:ใช้ไป|ใช้|ตัดสต๊อก|ตัดของ|หมดไป)\s*(.+)$/);
        if (m) {
          const p = trailNum(m[1]);
          if (p && p.name && p.qty > 0) {
            const r = await db.adjustStock(userId, p.name, -p.qty);
            if (!r.found) return replyText(ev.replyToken, `ยังไม่มี ${p.name} ในสต๊อกครับ\nตั้งก่อนด้วย  สต๊อก ${p.name} <จำนวน>`);
            const c = flex.stockUpdatedCard('use', r.item, p.qty);
            return replyFlex(ev.replyToken, c.altText, c.contents);
          }
        }
        // ตั้งจุดเตือนของใกล้หมด
        m = raw.match(/^(?:เตือน|ตั้งเตือน|แจ้งเตือน)\s*(.+)$/);
        if (m) {
          const p = trailNum(m[1]);
          if (p && p.name && p.qty >= 0) {
            const r = await db.setThreshold(userId, p.name, p.qty);
            if (!r.found) return replyText(ev.replyToken, `ยังไม่มี ${p.name} ในสต๊อกครับ\nตั้งก่อนด้วย  สต๊อก ${p.name} <จำนวน>`);
            return replyText(ev.replyToken, `ตั้งเตือนแล้วครับ 🔔\nถ้า ${r.item.name} เหลือน้อยกว่าหรือเท่ากับ ${baht(p.qty)}${r.item.unit ? ' ' + r.item.unit : ''} ผมจะเตือนให้ซื้อ`);
          }
        }
        // รายการที่ต้องซื้อ (ของใกล้หมด)
        if (['ของใกล้หมด', 'ต้องซื้อ', 'รายการซื้อ', 'ของหมด', 'ใกล้หมด', 'ต้องซื้ออะไร'].includes(raw)) {
          const rows = await db.lowStock(userId);
          const c = flex.lowStockCard(rows, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // ลบวัตถุดิบ
        m = raw.match(/^(?:ลบสต๊อก|ลบวัตถุดิบ|เอาออก)\s+(.+)$/);
        if (m) {
          const r = await db.removeStock(userId, m[1].trim());
          if (!r.found) return replyText(ev.replyToken, `ไม่เจอ ${m[1].trim()} ในสต๊อกครับ`);
          return replyText(ev.replyToken, `ลบ ${r.name} ออกจากสต๊อกแล้วครับ ✅`);
        }
        // ตั้งต้นทุนต่อหน่วย: ต้นทุน หมู 120
        m = raw.match(/^(?:ต้นทุน|ราคาทุน)\s+(.+)$/);
        if (m) {
          const p = trailNum(m[1]);
          if (p && p.name && p.qty >= 0) {
            const r = await db.setStockCost(userId, p.name, p.qty);
            if (!r.found) return replyText(ev.replyToken, `ยังไม่มี ${p.name} ในสต๊อกครับ\nตั้งของก่อนด้วย  สต๊อก ${p.name} <จำนวน>`);
            return replyText(ev.replyToken, `ตั้งต้นทุนแล้วครับ 💰\n${r.item.name} = ${baht(p.qty)} บาท/${r.item.unit || 'หน่วย'}`);
          }
        }
      }

      // ===== เฟส 31: สูตรอาหาร =====
      {
        // ตั้งสูตร: สูตร กะเพราหมู = หมู 0.1 กก, ไข่ 1 ฟอง, ข้าว 1 จาน
        let m = raw.match(/^สูตร\s+(.+?)\s*=\s*(.+)$/);
        if (m) {
          const menuName = m[1].trim();
          const parts = m[2].split(/[,，]/).map(s => s.trim()).filter(Boolean);
          const items = [];
          for (const p of parts) {
            const mm = p.match(/^(.+?)\s+([\d.]+)\s*(.*)$/);
            if (mm) items.push({ ingredient: mm[1].trim(), qty: parseFloat(mm[2]), unit: (mm[3] || '').trim() });
          }
          if (!menuName || !items.length)
            return replyText(ev.replyToken, 'พิมพ์แบบนี้ครับ:\nสูตร กะเพราหมู = หมู 0.1 กก, ไข่ 1 ฟอง, ข้าว 1 จาน');
          await db.setRecipe(userId, menuName, items);
          const cost = await db.recipeCost(userId, items);
          const c = flex.recipeCard(menuName, items, cost, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // ดูสูตรทั้งหมด
        if (['สูตร', 'สูตรอาหาร', 'ดูสูตร'].includes(raw)) {
          const recipes = await db.listRecipes(userId);
          const c = flex.recipeListCard(recipes, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // ลบสูตร
        m = raw.match(/^ลบสูตร\s+(.+)$/);
        if (m) {
          const r = await db.deleteRecipe(userId, m[1].trim());
          if (!r.found) return replyText(ev.replyToken, `ไม่เจอสูตร ${m[1].trim()} ครับ`);
          return replyText(ev.replyToken, `ลบสูตร ${r.menuName} แล้วครับ ✅`);
        }
        // ดูสูตรเมนูเดียว: สูตร <เมนู>
        m = raw.match(/^สูตร\s+(.+)$/);
        if (m) {
          const rc = await db.getRecipe(userId, m[1].trim());
          if (!rc) return replyText(ev.replyToken, `ยังไม่มีสูตร ${m[1].trim()} ครับ\nตั้งได้เลย เช่น  สูตร ${m[1].trim()} = หมู 0.1 กก, ไข่ 1 ฟอง`);
          const cost = await db.recipeCost(userId, rc.items);
          const c = flex.recipeCard(rc.menuName, rc.items, cost, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
      }

      // ===== เฟส 32: จัดการพนักงาน =====
      {
        const tail = (str) => {
          const mm = str.match(/(-?[\d,]+(?:\.\d+)?)\s*(?:บาท|฿|วัน)?\s*$/);
          if (!mm) return { name: str.trim(), num: null };
          return { name: str.slice(0, mm.index).trim(), num: Number(mm[1].replace(/,/g, '')) };
        };
        // เพิ่มพนักงาน: พนักงาน สมชาย 350
        let m = raw.match(/^(?:พนักงาน|ลูกจ้าง|เพิ่มพนักงาน)\s+(.+)$/);
        if (m) {
          const { name, num } = tail(m[1]);
          if (name && num != null && num > 0) {
            const s = await db.addStaff(userId, name, num);
            const c = flex.staffAddedCard(s);
            return replyFlex(ev.replyToken, c.altText, c.contents);
          }
          // พนักงาน <ชื่อ> (ไม่มีเลข) -> ดูสรุปคนนั้น
          const st = await db.findStaff(userId, m[1].trim());
          if (st) {
            const sum = await db.staffSummary(userId, st);
            const c = flex.staffDetailCard(sum, liffUrl());
            return replyFlex(ev.replyToken, c.altText, c.contents);
          }
          return replyText(ev.replyToken, `ยังไม่มีพนักงานชื่อ ${m[1].trim()} ครับ\nเพิ่มได้เลย เช่น  พนักงาน ${m[1].trim()} 350`);
        }
        // ดูพนักงานทั้งหมด
        if (['พนักงาน', 'ลูกจ้าง', 'ดูพนักงาน', 'ทีมงาน'].includes(raw)) {
          const rows = await db.staffAllSummary(userId);
          const c = flex.staffListCard(rows, liffUrl());
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
        // ลงเวลา: ลงเวลา สมชาย [จำนวนวัน=1]
        m = raw.match(/^(?:ลงเวลา|เข้างาน|มาทำงาน)\s+(.+)$/);
        if (m) {
          const { name, num } = tail(m[1]);
          const st = await db.findStaff(userId, name || m[1].trim());
          if (!st) return replyText(ev.replyToken, `ไม่เจอพนักงาน ${(name || m[1]).trim()} ครับ\nพิมพ์  พนักงาน  เพื่อดูรายชื่อ`);
          const days = num != null && num > 0 ? num : 1;
          await db.logStaff(userId, st.id, 'work', days, null, bkkDate());
          const sum = await db.staffSummary(userId, st);
          return replyText(ev.replyToken, `บันทึกแล้ว ✅\n${st.name} ทำงานเพิ่ม ${baht(days)} วัน\nรวมเดือนนี้ ${baht(sum.days)} วัน · ค้างจ่าย ${baht(Math.round(sum.owed))} บาท`);
        }
        // เบิกเงิน: เบิก สมชาย 500
        m = raw.match(/^(?:เบิก|เบิกเงิน|เบิกล่วงหน้า)\s+(.+)$/);
        if (m) {
          const { name, num } = tail(m[1]);
          if (name && num != null && num > 0) {
            const st = await db.findStaff(userId, name);
            if (!st) return replyText(ev.replyToken, `ไม่เจอพนักงาน ${name} ครับ`);
            await db.logStaff(userId, st.id, 'advance', num, null, bkkDate());
            await db.insertTxn({ lineUserId: userId, type: 'expense', amount: num, category: 'ค่าแรง', note: `เบิกเงิน ${st.name}`, items: null, source: 'staff', txnDate: bkkDate() });
            const sum = await db.staffSummary(userId, st);
            const c = flex.staffPayCard('advance', st.name, num, sum);
            return replyFlex(ev.replyToken, c.altText, c.contents);
          }
        }
        // จ่ายค่าแรง: จ่ายค่าแรง สมชาย 2000
        m = raw.match(/^(?:จ่ายค่าแรง|จ่ายเงินเดือน|จ่ายลูกจ้าง)\s+(.+)$/);
        if (m) {
          const { name, num } = tail(m[1]);
          if (name && num != null && num > 0) {
            const st = await db.findStaff(userId, name);
            if (!st) return replyText(ev.replyToken, `ไม่เจอพนักงาน ${name} ครับ`);
            await db.logStaff(userId, st.id, 'pay', num, null, bkkDate());
            await db.insertTxn({ lineUserId: userId, type: 'expense', amount: num, category: 'ค่าแรง', note: `จ่ายค่าแรง ${st.name}`, items: null, source: 'staff', txnDate: bkkDate() });
            const sum = await db.staffSummary(userId, st);
            const c = flex.staffPayCard('pay', st.name, num, sum);
            return replyFlex(ev.replyToken, c.altText, c.contents);
          }
        }
        // ลบพนักงาน
        m = raw.match(/^ลบพนักงาน\s+(.+)$/);
        if (m) {
          const r = await db.removeStaff(userId, m[1].trim());
          if (!r.found) return replyText(ev.replyToken, `ไม่เจอพนักงาน ${m[1].trim()} ครับ`);
          return replyText(ev.replyToken, `ลบพนักงาน ${r.name} แล้วครับ ✅`);
        }
      }

      // ===== เฟส 34: ภาษีมูลค่าเพิ่ม (VAT) =====
      {
        // เปิด/ปิด ระบบภาษี
        if (['เปิดภาษี', 'เปิด vat', 'เปิดVAT', 'เปิดแวต'].includes(raw)) {
          const c = await db.setVatConfig(userId, true, null);
          return replyText(ev.replyToken, `เปิดระบบภาษีมูลค่าเพิ่มแล้วครับ ✅ (${c.rate}%)\nพิมพ์  ภาษี  เพื่อดูสรุปภาษีเดือนนี้\nซื้อของที่มีใบกำกับ ให้พิมพ์  ภาษีซื้อ <ยอด>  เพื่อเก็บภาษีซื้อไปหักได้`);
        }
        if (['ปิดภาษี', 'ปิด vat', 'ปิดVAT', 'ปิดแวต'].includes(raw)) {
          await db.setVatConfig(userId, false, null);
          return replyText(ev.replyToken, 'ปิดระบบภาษีมูลค่าเพิ่มแล้วครับ');
        }
        // ตั้งอัตราภาษี
        let m = raw.match(/^ตั้งภาษี\s*([\d.]+)\s*%?$/);
        if (m) {
          const rate = parseFloat(m[1]);
          if (rate >= 0 && rate <= 30) {
            const c = await db.setVatConfig(userId, true, rate);
            return replyText(ev.replyToken, `ตั้งอัตราภาษีเป็น ${c.rate}% และเปิดใช้งานแล้วครับ ✅`);
          }
        }
        // บันทึกภาษีซื้อ (ค่าใช้จ่ายที่มีใบกำกับภาษี)
        m = raw.match(/^(?:ภาษีซื้อ|ซื้อมีใบกำกับ|vatซื้อ)\s+(.+)$/i);
        if (m) {
          const mm = m[1].match(/([\d,]+(?:\.\d+)?)\s*(?:บาท|฿)?\s*(.*)$/);
          const amount = mm ? Number(mm[1].replace(/,/g, '')) : NaN;
          if (isFinite(amount) && amount > 0) {
            const note = (mm[2] || '').trim() || 'ซื้อของ (มีใบกำกับ)';
            const cfg = await db.getVatConfig(userId);
            await db.insertTxn({ lineUserId: userId, type: 'expense', amount, category: 'ซื้อของ', note, items: null, source: 'vat', txnDate: bkkDate(), vat: 1 });
            const vatPart = amount * (cfg.rate || 7) / (100 + (cfg.rate || 7));
            return replyText(ev.replyToken, `บันทึกภาษีซื้อแล้วครับ ✅\n${note} ${baht(amount)} บาท\nภาษีซื้อที่หักได้ ~${baht(Math.round(vatPart * 100) / 100)} บาท (${cfg.rate}%)`);
          }
        }
        // สรุปภาษีเดือนนี้
        if (['ภาษี', 'vat', 'VAT', 'แวต', 'ภพ30', 'ภ.พ.30', 'ภ.พ. 30'].includes(raw)) {
          const cfg = await db.getVatConfig(userId);
          if (!cfg.enabled) {
            return replyText(ev.replyToken, 'ยังไม่ได้เปิดระบบภาษีครับ\nถ้าร้านจดทะเบียน VAT แล้ว พิมพ์  เปิดภาษี  เพื่อเริ่มสรุปภาษีขาย-ภาษีซื้อรายเดือน\n(ปกติร้านที่รายได้เกิน 1.8 ล้าน/ปี ต้องจด VAT)');
          }
          const ym = bkkDate().slice(0, 7);
          const s = await db.vatSummary(userId, ym);
          const c = flex.vatCard(xlsx.thMonthLabel(ym), s);
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
      }

      // ===== เฟส 35: ใบเสร็จ / ข้อมูลร้าน =====
      {
        let m = raw.match(/^ชื่อร้าน\s+(.+)$/);
        if (m) { await db.setShopProfile(userId, 'name', m[1].trim()); return replyText(ev.replyToken, `ตั้งชื่อร้านเป็น "${m[1].trim()}" แล้วครับ ✅\nจะขึ้นบนใบเสร็จ`); }
        m = raw.match(/^(?:ที่อยู่ร้าน|ที่อยู่)\s+(.+)$/);
        if (m) { await db.setShopProfile(userId, 'address', m[1].trim()); return replyText(ev.replyToken, 'บันทึกที่อยู่ร้านแล้วครับ ✅'); }
        m = raw.match(/^(?:เลขภาษี|เลขผู้เสียภาษี|taxid)\s+(.+)$/i);
        if (m) { await db.setShopProfile(userId, 'taxid', m[1].trim().replace(/\s/g, '')); return replyText(ev.replyToken, 'บันทึกเลขประจำตัวผู้เสียภาษีแล้วครับ ✅'); }

        // ออกใบเสร็จจากบิลล่าสุด
        if (['ใบเสร็จ', 'ออกใบเสร็จ', 'ใบกำกับ', 'ใบกำกับภาษี', 'receipt'].includes(raw)) {
          const last = await db.lastIncomeTxn(userId);
          if (!last) return replyText(ev.replyToken, 'ยังไม่มีรายการขายให้ออกใบเสร็จครับ\nบันทึกการขายก่อน เช่น  ขายข้าว 3 จาน 150');
          const prof = await db.getShopProfile(userId);
          const vatAmount = prof.vatEnabled ? last.amount * prof.vatRate / (100 + prof.vatRate) : 0;
          const rec = await db.createReceipt(userId, {
            txnId: last.id, total: last.amount, items: last.items || null,
            vatAmount, note: null, rdate: last.date || bkkDate(),
          });
          const url = `${baseUrl()}/receipt?t=${signReceipt(userId, rec.receipt_no)}`;
          const c = flex.receiptCard(rec, prof, url);
          return replyFlex(ev.replyToken, c.altText, c.contents);
        }
      }

      { const q = await overQuota(userId); if (q.over) return replyText(ev.replyToken, quotaMessage(q)); }
        return replyText(ev.replyToken, parsed.reply_hint ||
          'ขอโทษครับ ผมไม่ค่อยแน่ใจว่าหมายถึงอะไร 🙏\n\n' +
          'จะจดขาย พิมพ์ เช่น  ขายข้าว 50\n' +
          'จะจดจ่าย พิมพ์ เช่น  ซื้อหมู 800\n' +
          'หรือกดปุ่มข้างล่างได้เลยครับ 👇');
      if (parsed.amount == null)
        return replyText(ev.replyToken, 'รับทราบว่าเป็นรายการ แต่ยังไม่เห็นยอดเงินครับ 🙏\nลองใส่ยอดมาด้วยนะ เช่น ซื้อหมู 800');
      const r = await confirmAndSummary(userId, parsed, 'text');
      const nudge = await onboardNudge(identityId);
      if (nudge) r.messages.push({ type: 'text', text: nudge });
      return lineReply(ev.replyToken, r.messages);
    } catch (e) {
      console.error('[text]', e.message);
      return replyText(ev.replyToken, 'ขอโทษครับ ตอนนี้ผมงง ๆ นิดหน่อย 🙏 ลองพิมพ์ใหม่อีกครั้ง หรือกดปุ่มข้างล่างได้เลยครับ');
    }
  }

  // ----- image (bill / delivery summary) -----
  if (ev.message.type === 'image') {
    try {
      { const q = await overQuota(userId); if (q.over) return replyText(ev.replyToken, quotaMessage(q)); }
      const { base64, mediaType } = await getImageBase64(ev.message.id);
      const parsed = await ai.parseImage(base64, mediaType);

      if (parsed.doc_type === 'delivery_summary') {
        const dcard = await recordDelivery(userId, parsed);
        return dcard.contents
          ? replyFlex(ev.replyToken, dcard.altText, dcard.contents)
          : replyText(ev.replyToken, dcard.text);
      }
      // bill ปกติ
      if (!parsed.is_transaction || parsed.amount == null)
        return replyText(ev.replyToken, 'อ่านรูปแล้วแต่จับยอดไม่ชัดครับ ลองถ่ายให้เห็นยอดรวมชัดๆ หรือพิมพ์ยอดมาก็ได้');
      const r = await confirmAndSummary(userId, parsed, 'image');
      const nudge = await onboardNudge(identityId);
      if (nudge) r.messages.push({ type: 'text', text: nudge });
      return lineReply(ev.replyToken, r.messages);
    } catch (e) {
      console.error('[parseImage]', e.message);
      return replyText(ev.replyToken, 'ขอโทษครับ อ่านรูปไม่สำเร็จ ลองส่งใหม่อีกครั้งนะ');
    }
  }

  // ----- เสียงพูด (พูดแทนพิมพ์) -----
  if (ev.message.type === 'audio') {
    try {
      if (!process.env.OPENAI_API_KEY)
        return replyText(ev.replyToken, 'ตอนนี้ยังฟังเสียงไม่ได้ครับ 🙏 พิมพ์มาได้เลย เช่น  ขายข้าว 50');
      // เฟส 42: กันเสียงยาวเกิน 2 นาที (เปลืองและมักฟังไม่ชัด)
      if (ev.message.duration && ev.message.duration > 120000)
        return replyText(ev.replyToken, 'เสียงยาวเกิน 2 นาทีครับ 🙏 ลองพูดสั้น ๆ ทีละรายการ เช่น  ขายกะเพรา 3 จาน 150');
      { const q = await overQuota(userId); if (q.over) return replyText(ev.replyToken, quotaMessage(q)); }
      const { buf, mediaType } = await getMessageContent(ev.message.id);
      const tr = await ai.transcribeThai(buf, mediaType);
      if (!tr.ok || !tr.text)
        return replyText(ev.replyToken, 'ขอโทษครับ ฟังไม่ค่อยชัด 🙏 ลองพูดอีกครั้งช้า ๆ หรือพิมพ์มาก็ได้ เช่น  ขายข้าว 50');
      const heard = { type: 'text', text: `🎤 ได้ยินว่า: ${tr.text}` };
      const parsed = await ai.parseText(tr.text);
      if (!parsed.is_transaction || parsed.amount == null)
        return lineReply(ev.replyToken, [heard, { type: 'text',
          text: 'ยังจับเป็นรายการไม่ได้ครับ 🙏\nลองพูดให้มีของ + ยอดเงิน เช่น  ขายข้าวกะเพรา 50  หรือ  ซื้อหมู 800' }]);
      const r = await confirmAndSummary(userId, parsed, 'voice');
      const nudge = await onboardNudge(identityId);
      const msgs = [heard, ...r.messages];
      if (nudge) msgs.push({ type: 'text', text: nudge });
      return lineReply(ev.replyToken, msgs);
    } catch (e) {
      console.error('[audio]', e.message);
      return replyText(ev.replyToken, 'ขอโทษครับ ฟังเสียงไม่สำเร็จ ลองอีกครั้ง หรือพิมพ์มาก็ได้ครับ');
    }
  }
}

// ---------- routes ----------
// เก็บ raw body ไว้ verify ลายเซ็น แล้ว parse json
app.use('/webhook', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.post('/webhook', (req, res) => {
  if (!detectedBaseUrl && req.headers.host) {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    detectedBaseUrl = `${proto}://${req.headers.host}`;
  }
  const signature = req.get('x-line-signature') || '';
  const expected = crypto.createHmac('SHA256', CHANNEL_SECRET).update(req.rawBody || Buffer.from('')).digest('base64');
  if (signature !== expected) {
    console.warn('[webhook] bad signature');
    return res.status(401).send('bad signature');
  }
  // ตอบ 200 ทันที แล้วค่อยประมวลผล events
  res.status(200).end();
  const events = req.body.events || [];
  events.forEach(ev => handleEvent(ev).catch(e => console.error('[handleEvent]', e)));
});

app.get('/', (_req, res) => res.send('แบ่งเบา bot ok'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// เฟส 14: ตั้ง Rich Menu (กดครั้งเดียว) — ต้องตั้ง ADMIN_KEY ก่อน
app.get('/admin/setup-richmenu', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(404).send('ปิดอยู่ — ตั้ง ADMIN_KEY ใน env ก่อนครับ');
  if (req.query.key !== key) return res.status(403).send('คีย์ไม่ถูกต้อง');
  try {
    const id = await richmenu.setupRichMenu(CHANNEL_TOKEN, path.join(__dirname, 'richmenu.png'));
    res.send('ตั้ง Rich Menu สำเร็จ! richMenuId = ' + id + '\nเปิดแชทแบ่งเบาในมือถือ จะเห็นปุ่มลัดด้านล่างแล้ว (อาจต้องปิด-เปิดแชทใหม่)');
  } catch (e) {
    console.error('[richmenu]', e.message);
    res.status(500).send('ตั้งไม่สำเร็จ: ' + e.message);
  }
});

// เฟส 18: อัปเกรด/ปรับแพ็กเกจสมาชิก (แอดมินกดเอง จนกว่าจะต่อระบบจ่ายเงิน)
app.get('/admin/set-tier', async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(404).send('ปิดอยู่ — ตั้ง ADMIN_KEY ก่อนครับ');
  if (req.query.key !== key) return res.status(403).send('คีย์ไม่ถูกต้อง');
  const u = req.query.user;
  if (!u) return res.status(400).send('ใส่ ?user=<lineUserId> ด้วยครับ');
  const tier = req.query.tier === 'pro' ? 'pro' : 'free';
  let until = null;
  if (tier === 'pro') until = bkkDaysAgo(-Math.max(1, +req.query.days || 30)); // วันในอนาคต
  try {
    await db.upsertUser(u, null);
    await db.setMembership(u, tier, until);
    res.send(`ตั้งแพ็กเกจ ${tier.toUpperCase()} ให้ ${u.slice(0, 12)}... สำเร็จ` + (until ? ` (ถึง ${until})` : ''));
  } catch (e) {
    console.error('[set-tier]', e.message);
    res.status(500).send('ไม่สำเร็จ: ' + e.message);
  }
});

// เฟส 19: หน้า Admin (กดอัปเกรด Pro ได้ด้วยปุ่ม)
function adminKeyOk(req) {
  const key = process.env.ADMIN_KEY;
  return key && (req.query.key === key || (req.body && req.body.key === key) || req.get('x-admin-key') === key);
}
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/api/users', async (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(404).json({ error: 'ตั้ง ADMIN_KEY ก่อน' });
  if (!adminKeyOk(req)) return res.status(403).json({ error: 'คีย์ไม่ถูกต้อง' });
  try { res.json({ users: await db.listUsersAdmin(bkkDate()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/admin/api/set-tier', express.json(), async (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(404).json({ error: 'ตั้ง ADMIN_KEY ก่อน' });
  if (!adminKeyOk(req)) return res.status(403).json({ error: 'คีย์ไม่ถูกต้อง' });
  const u = (req.body || {}).user;
  if (!u) return res.status(400).json({ error: 'missing user' });
  const tier = req.body.tier === 'pro' ? 'pro' : 'free';
  const until = tier === 'pro' ? bkkDaysAgo(-Math.max(1, +req.body.days || 30)) : null;
  try {
    await db.upsertUser(u, null);
    await db.setMembership(u, tier, until);
    res.json({ ok: true, tier, until });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// เฟส 33: อัปโหลดรูป Rich Menu ใหม่ผ่านหน้า /admin (สลับให้ทุกคนทันที)
app.post('/admin/api/richmenu',
  express.raw({ type: ['image/png', 'image/jpeg'], limit: '2mb' }),
  async (req, res) => {
    if (!process.env.ADMIN_KEY) return res.status(404).json({ error: 'ตั้ง ADMIN_KEY ก่อน' });
    if (!adminKeyOk(req)) return res.status(403).json({ error: 'คีย์ไม่ถูกต้อง' });
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'ไม่พบไฟล์รูป (ต้องเป็น PNG หรือ JPEG)' });
    // ตรวจขนาดภาพจาก header ของไฟล์ (LINE ต้องการ 2500x1667 ตาม areas ที่ตั้งไว้)
    const dim = imageSize(buf);
    if (dim && !(dim.width === 2500 && dim.height === 1667)) {
      return res.status(400).json({ error: `ขนาดรูปต้องเป็น 2500×1667 พิกเซล (ไฟล์นี้ ${dim.width}×${dim.height})` });
    }
    try {
      const ct = req.get('content-type') && req.get('content-type').includes('jpeg') ? 'image/jpeg' : 'image/png';
      const id = await richmenu.setupRichMenuFromBuffer(CHANNEL_TOKEN, buf, ct);
      res.json({ ok: true, richMenuId: id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

// อ่านขนาดภาพจากไบต์ต้นไฟล์ (PNG/JPEG) แบบไม่ง้อไลบรารี
function imageSize(buf) {
  try {
    // PNG: 8-byte signature แล้ว IHDR (width/height ที่ byte 16..23)
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: วนหา SOF0/SOF2 marker
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (e) { /* อ่านไม่ได้ก็ข้ามการตรวจ */ }
  return null;
}

// เฟส 35: หน้าใบเสร็จ (พร้อมพิมพ์) — เปิดจากลิงก์ที่เซ็นไว้
app.get('/receipt', async (req, res) => {
  const v = verifyReceipt(req.query.t);
  if (!v) return res.status(403).send('ลิงก์ไม่ถูกต้องหรือหมดอายุ');
  const rec = await db.getReceipt(v.accountId, v.receiptNo);
  if (!rec) return res.status(404).send('ไม่พบใบเสร็จ');
  const prof = await db.getShopProfile(v.accountId);
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderReceiptHtml(rec, prof));
});

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderReceiptHtml(rec, prof) {
  const money = n => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isVat = prof.vatEnabled && rec.vat_amount > 0;
  const docTitle = isVat ? 'ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ' : 'ใบเสร็จรับเงิน';
  const items = Array.isArray(rec.items) ? rec.items : [];
  const preVat = rec.total - (rec.vat_amount || 0);
  const d = rec.rdate ? new Date(rec.rdate) : new Date();
  const dateTh = d.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
  const rows = items.length
    ? items.map(it => `<tr><td>${esc(it.name || '-')}</td><td class="c">${esc(it.qty || 1)}</td></tr>`).join('')
    : `<tr><td>ขายสินค้า/บริการ</td><td class="c">-</td></tr>`;
  return `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ใบเสร็จ #${rec.receipt_no}</title>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Sarabun',sans-serif;background:#eef2f7;color:#1a2233;padding:20px;display:flex;flex-direction:column;align-items:center}
.paper{background:#fff;width:100%;max-width:380px;padding:26px 24px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.12)}
.shop{text-align:center;border-bottom:1px dashed #c9d3e0;padding-bottom:14px;margin-bottom:14px}
.shop h1{font-size:19px;font-weight:700}
.shop p{font-size:12.5px;color:#5a6b82;margin-top:3px;line-height:1.5}
.doctype{text-align:center;font-weight:600;font-size:13.5px;color:#0b49c9;margin-bottom:14px}
.meta{display:flex;justify-content:space-between;font-size:12.5px;color:#5a6b82;margin-bottom:12px}
table{width:100%;border-collapse:collapse;margin-bottom:12px}
th,td{text-align:left;font-size:13.5px;padding:7px 0;border-bottom:1px solid #eef2f7}
th{color:#5a6b82;font-weight:600;font-size:12px}
td.c,th.c{text-align:center;width:60px}
.totals{border-top:1px dashed #c9d3e0;padding-top:12px}
.trow{display:flex;justify-content:space-between;font-size:13.5px;padding:3px 0;color:#5a6b82}
.trow.grand{font-size:18px;font-weight:700;color:#1a2233;margin-top:6px}
.foot{text-align:center;font-size:12px;color:#8a97a8;margin-top:18px;border-top:1px dashed #c9d3e0;padding-top:14px}
.btns{max-width:380px;width:100%;display:flex;gap:10px;margin-top:16px}
.btns button{flex:1;border:none;border-radius:9px;padding:12px;font-family:inherit;font-weight:600;font-size:14px;cursor:pointer}
.print{background:#1f6bff;color:#fff}
@media print{body{background:#fff;padding:0}.paper{box-shadow:none;max-width:100%}.btns{display:none}}
</style></head><body>
<div class="paper">
  <div class="shop">
    <h1>${esc(prof.shopName || 'ร้านของฉัน')}</h1>
    ${prof.address ? `<p>${esc(prof.address)}</p>` : ''}
    ${prof.taxId ? `<p>เลขประจำตัวผู้เสียภาษี ${esc(prof.taxId)}</p>` : ''}
  </div>
  <div class="doctype">${docTitle}</div>
  <div class="meta"><span>เลขที่ #${String(rec.receipt_no).padStart(4, '0')}</span><span>${dateTh}</span></div>
  <table><thead><tr><th>รายการ</th><th class="c">จำนวน</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals">
    ${isVat ? `<div class="trow"><span>มูลค่าก่อนภาษี</span><span>${money(preVat)} ฿</span></div>
    <div class="trow"><span>ภาษีมูลค่าเพิ่ม ${prof.vatRate}%</span><span>${money(rec.vat_amount)} ฿</span></div>` : ''}
    <div class="trow grand"><span>รวมทั้งสิ้น</span><span>${money(rec.total)} ฿</span></div>
  </div>
  <div class="foot">ขอบคุณที่ใช้บริการ 🙏<br>ออกโดย แบ่งเบา · baengbao.app</div>
</div>
<div class="btns"><button class="print" onclick="window.print()">🖨 พิมพ์ / บันทึกเป็นรูป</button></div>
</body></html>`;
}

// เฟส 10: ดาวน์โหลดรายงาน Excel (ตรวจโทเคนที่เซ็นไว้)
app.get('/export.xlsx', async (req, res) => {
  try {
    const v = verifyExport(req.query.t);
    if (!v) return res.status(403).send('ลิงก์หมดอายุหรือไม่ถูกต้อง — พิมพ์คำว่า ออกรายงาน ในไลน์เพื่อขอลิงก์ใหม่');
    const [rows, totals, expenseCats] = await Promise.all([
      db.txnsForMonth(v.userId, v.ym),
      db.monthTotals(v.userId, v.ym),
      db.categoryBreakdown(v.userId, v.ym, 'expense'),
    ]);
    const pl = await buildPL(v.userId, v.ym);
    const buf = await xlsx.buildMonthlyWorkbook({ ym: v.ym, rows, totals, expenseCats, pl });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="baengbao-${v.ym}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[export]', e.message);
    res.status(500).send('สร้างไฟล์ไม่สำเร็จ ลองใหม่อีกครั้งนะครับ');
  }
});

// ---------- mini-app (LIFF) ----------
// เสิร์ฟหน้าเว็บจัดการเมนู
app.use('/app', express.static(path.join(__dirname, 'public')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// config สำหรับ frontend (ส่ง LIFF_ID ออกไป ไม่ต้อง hardcode)
app.get('/api/config', (_req, res) => res.json({ liffId: LIFF_ID }));

// ตรวจ access token ของ LIFF → ดึง userId
async function liffAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    const r = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return res.status(401).json({ error: 'invalid token' });
    const profile = await r.json();
    req.identityId = profile.userId;
    req.displayName = profile.displayName;
    await db.upsertUser(profile.userId, profile.displayName);
    req.userId = await db.accountOf(profile.userId); // บัญชีข้อมูลร้าน
    next();
  } catch (e) {
    console.error('[liffAuth]', e.message);
    res.status(401).json({ error: 'auth failed' });
  }
}

app.use(['/api/menus', '/api/stats', '/api/transactions', '/api/goals', '/api/cost-compare', '/api/settings', '/api/export-link', '/api/recurring', '/api/stock', '/api/debts', '/api/recipes', '/api/staff', '/api/vat', '/api/me', '/api/today', '/api/menu-rank', '/api/doctor', '/api/forecast', '/api/shopping-list'], express.json(), liffAuth);

// เฟส 36: API ที่สงวนให้เจ้าของร้าน — พนักงาน (identityId ≠ userId) เข้าไม่ได้
app.use(['/api/stats', '/api/goals', '/api/cost-compare', '/api/settings', '/api/export-link', '/api/debts', '/api/staff', '/api/vat', '/api/recipes', '/api/today', '/api/menu-rank', '/api/doctor', '/api/forecast', '/api/shopping-list'], (req, res, next) => {
  if (req.identityId && req.userId && req.identityId !== req.userId) {
    return res.status(403).json({ error: 'staff_forbidden', role: 'staff' });
  }
  next();
});

// ใครกำลังใช้งาน (เจ้าของ/พนักงาน) — ให้ mini app ปรับเมนูตามสิทธิ์
app.get('/api/me', (req, res) => {
  res.json({ role: req.identityId === req.userId ? 'owner' : 'staff', name: req.displayName || '' });
});

// ===== เฟส 37: หน้า "วันนี้" (Today Pulse) + จัดอันดับเมนู =====
function minusDays(dateStr, n) {
  const dt = new Date(dateStr + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}
// รวมยอดขายรายเมนูจาก items ของรายการ income (นับใน JS — items เป็น JSONB [{name,qty,amount}])
function aggregateSoldItems(txns) {
  const map = new Map();
  for (const t of txns) {
    if (t.type !== 'income' || !Array.isArray(t.items)) continue;
    for (const it of t.items) {
      const name = String(it && it.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const cur = map.get(key) || { name, qty: 0, amount: 0 };
      cur.qty += Number(it.qty) || 1;
      cur.amount += Number(it.amount) || 0;
      map.set(key, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty || b.amount - a.amount);
}

app.get('/api/today', async (req, res) => {
  await db.upsertUser(req.identityId, req.displayName);
  const today = bkkDate();
  const yesterday = minusDays(today, 1);
  const lastWeekSameDay = minusDays(today, 7);
  const [day, yday, lastWeek, goals, streak, month, todayTxns, shop] = await Promise.all([
    db.dayTotals(req.userId, today),
    db.dayTotals(req.userId, yesterday),
    db.dayTotals(req.userId, lastWeekSameDay),
    db.getGoals(req.userId),
    db.currentStreak(req.userId, today),
    db.monthTotals(req.userId, today.slice(0, 7)),
    db.txnsBetween(req.userId, today, today),
    db.getShopProfile(req.userId).catch(() => null),
  ]);
  res.json({
    date: today,
    today: day, yesterday: yday, lastWeekSameDay: lastWeek,
    goalDaily: goals.daily || null, streak, month,
    bestSellers: aggregateSoldItems(todayTxns).slice(0, 3),
    shopName: (shop && shop.shopName) || '',
    contact: process.env.ADMIN_CONTACT || '@952dxvdb',
  });
});

app.get('/api/menu-rank', async (req, res) => {
  const today = bkkDate();
  const days = 30;
  const start = minusDays(today, days - 1);
  const [txns, menus, recipes] = await Promise.all([
    db.txnsBetween(req.userId, start, today),
    db.listMenus(req.userId),
    db.listRecipes(req.userId).catch(() => []),
  ]);
  const sold = aggregateSoldItems(txns);
  const menuByName = new Map(menus.map(m => [m.name.trim().toLowerCase(), m]));
  // ต้นทุนจริงจากสูตร (เฟส 31) ถ้ามี — ใช้แทน material_cost ของเมนู
  const recipeCostByName = new Map();
  for (const r of (recipes || [])) {
    try {
      if (!r.items || !r.items.length) continue;
      const c = await db.recipeCost(req.userId, r.items);
      if (c && c.complete) recipeCostByName.set(String(r.menuName || '').trim().toLowerCase(), c.cost);
    } catch (e) { /* ข้ามสูตรที่คำนวณไม่ได้ */ }
  }
  const items = sold.map(s => {
    const key = s.name.trim().toLowerCase();
    // จับคู่ชื่อ: ตรงกันก่อน ไม่งั้นลองแบบชื่อเมนูเป็นส่วนหนึ่งของชื่อที่จด
    let m = menuByName.get(key);
    if (!m) { for (const [k, v] of menuByName) { if (key.includes(k) || k.includes(key)) { m = v; break; } } }
    const price = m ? m.price : (s.qty > 0 && s.amount > 0 ? s.amount / s.qty : 0);
    const rc = m ? recipeCostByName.get(m.name.trim().toLowerCase()) : undefined;
    const costPerDish = rc !== undefined ? rc + (m ? m.labor_cost : 0)
      : (m ? m.material_cost + m.labor_cost : null);
    const revenue = s.amount > 0 ? s.amount : price * s.qty;
    const profitPerDish = (costPerDish !== null && price > 0) ? price - costPerDish : null;
    const totalProfit = profitPerDish !== null ? profitPerDish * s.qty : null;
    return {
      name: m ? m.name : s.name, sold: s.qty, revenue: Math.round(revenue * 100) / 100,
      price: price || null, costPerDish, profitPerDish, totalProfit,
      hasCost: profitPerDish !== null, fromRecipe: rc !== undefined,
    };
  });
  // เรียง: เมนูที่รู้กำไรจริงมาก่อน (กำไรรวมมาก→น้อย) แล้วตามด้วยเมนูไม่รู้ต้นทุน (ยอดขายมาก→น้อย)
  items.sort((a, b) => {
    if (a.hasCost !== b.hasCost) return a.hasCost ? -1 : 1;
    return a.hasCost ? b.totalProfit - a.totalProfit : b.revenue - a.revenue;
  });
  res.json({ days, start, end: today, items });
});

// ===== เฟส 43: พยากรณ์เงินสดสิ้นเดือน + รายการต้องซื้อพรุ่งนี้ =====
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
app.get('/api/forecast', async (req, res) => {
  const today = bkkDate();
  const ym = today.slice(0, 7);
  const day = +today.slice(8, 10);
  const dim = daysInMonth(ym);
  const daysLeft = dim - day;
  const [base, month, due, debts] = await Promise.all([
    db.forecastBase(req.userId, minusDays(today, 27), today),
    db.monthTotals(req.userId, ym),
    db.recurringDue(req.userId, day, ym),
    db.debtTotals(req.userId),
  ]);
  if (base.activeDays < 3) {
    return res.json({ ready: false, activeDays: base.activeDays,
      message: 'จดต่อเนื่องสัก 3 วันขึ้นไป แล้วผมจะพยากรณ์สิ้นเดือนให้ได้ครับ' });
  }
  const avgIncome = base.income / 28;
  const avgVarExpense = base.varExpense / 28;
  const dueSum = due.reduce((s, d) => s + d.amount, 0);
  const projIncome = month.income + avgIncome * daysLeft;
  const projExpense = month.expense + avgVarExpense * daysLeft + dueSum;
  const projProfit = projIncome - projExpense;
  const warnings = [];
  for (const d of due) warnings.push({ type: 'recurring', text: `${d.name} ${Math.round(d.amount).toLocaleString()} ฿ (วันที่ ${d.day})` });
  if (debts.payable > 0) warnings.push({ type: 'payable', text: `หนี้ค้างจ่ายร้านอื่น ${Math.round(debts.payable).toLocaleString()} ฿ (${debts.payableCount} ราย)` });
  res.json({
    ready: true, ym, daysLeft, activeDays: base.activeDays,
    monthSoFar: month,
    avgDailyIncome: Math.round(avgIncome), avgDailyVarExpense: Math.round(avgVarExpense),
    upcomingRecurring: due, upcomingRecurringSum: Math.round(dueSum),
    projected: { income: Math.round(projIncome), expense: Math.round(projExpense), profit: Math.round(projProfit) },
    receivable: Math.round(debts.receivable), warnings,
    lowConfidence: base.activeDays < 7,
  });
});

app.get('/api/shopping-list', async (req, res) => {
  const today = bkkDate();
  const tomorrow = minusDays(today, -1);
  const w = new Date(tomorrow + 'T00:00:00Z').getUTCDay();
  const [txns, recipes, stock] = await Promise.all([
    db.txnsBetween(req.userId, minusDays(today, 27), today),
    db.listRecipes(req.userId).catch(() => []),
    db.listStock(req.userId).catch(() => []),
  ]);
  // จำนวนขายต่อเมนู: เฉลี่ยตามวันในสัปดาห์เดียวกับพรุ่งนี้ หารด้วยจำนวนครั้งจริงของวันนั้น "ในช่วงที่มีข้อมูล"
  // (ร้านเพิ่งจดไม่กี่วันจะได้ค่าที่สมจริง ไม่โดนหาร 4 สัปดาห์คงที่จนต่ำเกิน)
  const byItemW = new Map(), byItemAll = new Map();
  let firstDate = null;
  for (const t of txns) {
    if (t.type !== 'income' || !Array.isArray(t.items)) continue;
    if (!firstDate || t.date < firstDate) firstDate = t.date;
    const dw = new Date(t.date + 'T00:00:00Z').getUTCDay();
    for (const it of t.items) {
      const name = String(it && it.name || '').trim(); if (!name) continue;
      const key = name.toLowerCase(), qty = Number(it.qty) || 1;
      byItemAll.set(key, (byItemAll.get(key) || 0) + qty);
      if (dw === w) byItemW.set(key, (byItemW.get(key) || 0) + qty);
    }
  }
  // นับจำนวนวันในช่วงข้อมูล และจำนวนครั้งของ weekday เดียวกับพรุ่งนี้
  let spanDays = 0, weekdayOcc = 0;
  if (firstDate) {
    for (let d = firstDate; d <= today; d = minusDays(d, -1)) {
      spanDays++;
      if (new Date(d + 'T00:00:00Z').getUTCDay() === w) weekdayOcc++;
      if (spanDays > 40) break; // กันลูปเกิน
    }
  }
  const expectedQty = key => {
    const wk = byItemW.get(key);
    if (wk && weekdayOcc > 0) return wk / weekdayOcc;
    return spanDays > 0 ? (byItemAll.get(key) || 0) / spanDays : 0;
  };
  const BUFFER = 1.15; // เผื่อ 15%
  const reqByIng = new Map();
  for (const r of (recipes || [])) {
    const mkey = String(r.menuName || '').trim().toLowerCase();
    let exp = expectedQty(mkey);
    if (!exp) { for (const [k] of byItemAll) { if (k.includes(mkey) || mkey.includes(k)) { exp = expectedQty(k); break; } } }
    if (!exp || !r.items) continue;
    for (const ing of r.items) {
      const ikey = String(ing.ingredient || '').trim().toLowerCase(); if (!ikey) continue;
      const cur = reqByIng.get(ikey) || { name: ing.ingredient, need: 0, unit: ing.unit || '', menus: new Set() };
      cur.need += (Number(ing.qty) || 0) * exp;
      cur.menus.add(r.menuName);
      reqByIng.set(ikey, cur);
    }
  }
  const stockByName = new Map(stock.map(s => [s.name.trim().toLowerCase(), s]));
  const items = [];
  for (const [ikey, r] of reqByIng) {
    const s = stockByName.get(ikey);
    const have = s ? Number(s.qty) : 0;
    const need = r.need * BUFFER;
    const buy = Math.max(0, need - have);
    if (buy <= 0.0001) continue;
    const buyR = Math.ceil(buy * 10) / 10;
    const unitCost = s && s.unit_cost != null ? Number(s.unit_cost) : null;
    items.push({
      name: s ? s.name : r.name, unit: (s && s.unit) || r.unit || '',
      need: Math.round(need * 10) / 10, have: Math.round(have * 10) / 10, buy: buyR,
      estCost: unitCost != null ? Math.round(buyR * unitCost) : null,
      forMenus: [...r.menus].slice(0, 3),
    });
  }
  // ของใกล้หมดที่ไม่โดนสูตรครอบ → เตือนแยก
  const covered = new Set(items.map(i => i.name.trim().toLowerCase()));
  const lowExtra = stock.filter(s => s.low && !covered.has(s.name.trim().toLowerCase()) && !reqByIng.has(s.name.trim().toLowerCase()))
    .map(s => ({ name: s.name, qty: Number(s.qty), unit: s.unit || '' }));
  items.sort((a, b) => (b.estCost || 0) - (a.estCost || 0) || b.buy - a.buy);
  const totalEst = items.reduce((s, i) => s + (i.estCost || 0), 0);
  res.json({ tomorrow, weekday: w, items, lowExtra, totalEst, hasRecipes: (recipes || []).length > 0 });
});

// ===== เฟส 38: หมอร้าน (AI วิเคราะห์สุขภาพร้าน) =====
const DOCTOR_FREE_COOLDOWN = 30; // Free ตรวจได้ทุก 30 วัน
function doctorAvailability(mem, last, today) {
  if (!last) return { canGenerate: true, nextDate: today };
  if (mem.effective === 'pro') {
    const next = minusDays(last.date, -1); // last.date + 1 วัน
    return { canGenerate: last.date < today, nextDate: next };
  }
  const next = minusDays(last.date, -DOCTOR_FREE_COOLDOWN);
  return { canGenerate: next <= today, nextDate: next };
}
app.get('/api/doctor', async (req, res) => {
  const today = bkkDate();
  const [mem, last] = await Promise.all([
    db.getMembership(req.userId, today), db.getInsight(req.userId),
  ]);
  const avail = doctorAvailability(mem, last, today);
  res.json({ tier: mem.effective, insight: last, ...avail, freeCooldown: DOCTOR_FREE_COOLDOWN });
});
app.post('/api/doctor', async (req, res) => {
  const today = bkkDate();
  const [mem, last] = await Promise.all([
    db.getMembership(req.userId, today), db.getInsight(req.userId),
  ]);
  const avail = doctorAvailability(mem, last, today);
  if (!avail.canGenerate) {
    return res.status(429).json({
      error: mem.effective === 'pro'
        ? 'วันนี้ตรวจไปแล้วครับ พรุ่งนี้ตรวจใหม่ได้เลย'
        : `แพ็กฟรีตรวจได้ทุก ${DOCTOR_FREE_COOLDOWN} วันครับ ตรวจครั้งถัดไปได้วันที่ ${avail.nextDate} (Pro ตรวจได้ทุกวัน)`,
      nextDate: avail.nextDate,
    });
  }
  try {
    // เตรียมข้อมูลให้หมอ: 7 วันล่าสุด vs 7 วันก่อนหน้า + เมนูขายดี 14 วัน + หมวดรายจ่ายเดือนนี้ + สต๊อกใกล้หมด + หนี้ + เป้า
    const wk1Start = minusDays(today, 6);
    const wk2Start = minusDays(today, 13);
    const wk2End = minusDays(today, 7);
    const ym = today.slice(0, 7);
    const [thisWeek, prevWeek, txns14, cats, low, debts, goals, month] = await Promise.all([
      db.rangeTotals(req.userId, wk1Start, today),
      db.rangeTotals(req.userId, wk2Start, wk2End),
      db.txnsBetween(req.userId, minusDays(today, 13), today),
      db.categoryBreakdown(req.userId, ym, 'expense'),
      db.lowStock(req.userId).catch(() => []),
      db.debtTotals(req.userId).catch(() => null),
      db.getGoals(req.userId),
      db.monthTotals(req.userId, ym),
    ]);
    const data = {
      วันนี้: today,
      สัปดาห์นี้_7วัน: thisWeek, สัปดาห์ก่อน_7วัน: prevWeek,
      เดือนนี้: month,
      เมนูขายดี_14วัน: aggregateSoldItems(txns14).slice(0, 5),
      รายจ่ายตามหมวด_เดือนนี้: (cats || []).slice(0, 6),
      ของใกล้หมด: (low || []).map(s => `${s.name} เหลือ ${s.qty}${s.unit || ''}`),
      หนี้คงค้าง: debts,
      เป้ายอดขาย: { รายวัน: goals.daily || null, รายเดือน: goals.monthly || null },
    };
    const content = await ai.analyzeShop(data);
    if (!content) throw new Error('ไม่ได้ผลวิเคราะห์');
    await db.saveInsight(req.userId, today, content);
    res.json({ ok: true, insight: { date: today, content } });
  } catch (e) {
    console.error('[doctor]', e.message);
    res.status(500).json({ error: 'หมอร้านไม่ว่างชั่วคราว ลองใหม่อีกครั้งนะครับ' });
  }
});

app.get('/api/menus', async (req, res) => {
  await db.upsertUser(req.identityId, req.displayName);
  res.json(await db.listMenus(req.userId));
});

app.post('/api/menus', async (req, res) => {
  const { name, price, material_cost, labor_cost } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'ต้องมีชื่อเมนู' });
  const id = await db.createMenu(req.userId, {
    name: String(name).trim(), price: +price || 0, material_cost: +material_cost || 0, labor_cost: +labor_cost || 0,
  });
  res.json({ id });
});

app.put('/api/menus/:id', async (req, res) => {
  const { name, price, material_cost, labor_cost } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'ต้องมีชื่อเมนู' });
  const ok = await db.updateMenu(req.userId, +req.params.id, {
    name: String(name).trim(), price: +price || 0, material_cost: +material_cost || 0, labor_cost: +labor_cost || 0,
  });
  res.json({ ok });
});

app.delete('/api/menus/:id', async (req, res) => {
  res.json({ ok: await db.deleteMenu(req.userId, +req.params.id) });
});

// ---- เฟส 3: dashboard data ----
const YM_RE = /^\d{4}-\d{2}$/;
app.get('/api/stats', async (req, res) => {
  const ym = YM_RE.test(req.query.month) ? req.query.month : bkkDate().slice(0, 7);
  const [days, categories, totals] = await Promise.all([
    db.dailySeries(req.userId, ym),
    db.categoryBreakdown(req.userId, ym, 'expense'),
    db.monthTotals(req.userId, ym),
  ]);
  res.json({ month: ym, days, categories, totals });
});

app.get('/api/transactions', async (req, res) => {
  const limit = Math.min(Math.max(+req.query.limit || 20, 1), 50);
  res.json(await db.recentTxns(req.userId, limit));
});

app.delete('/api/transactions/:id', async (req, res) => {
  res.json({ ok: await db.deleteTxn(req.userId, +req.params.id) });
});
app.put('/api/transactions/:id', async (req, res) => {
  const b = req.body || {};
  const type = b.type === 'income' ? 'income' : 'expense';
  const amount = Math.round((+b.amount || 0) * 100) / 100;
  if (!(amount > 0)) return res.status(400).json({ error: 'ยอดต้องมากกว่า 0' });
  const ok = await db.updateTxn(req.userId, +req.params.id, {
    type, amount, category: (b.category || '').trim(), note: (b.note || '').trim(),
  });
  res.json({ ok });
});

// ---- เฟส 29: สต๊อกวัตถุดิบ ----
app.get('/api/stock', async (req, res) => {
  const items = await db.listStock(req.userId);
  res.json({ items, low: items.filter(i => i.low) });
});
app.post('/api/stock', async (req, res) => {
  const { name, qty, unit } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'ต้องมีชื่อวัตถุดิบ' });
  const it = await db.setStock(req.userId, String(name).trim(), +qty || 0, (unit || '').trim());
  res.json({ ok: true, item: it });
});
app.post('/api/stock/adjust', async (req, res) => {
  const { name, delta } = req.body || {};
  if (!name || !isFinite(+delta)) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const r = await db.adjustStock(req.userId, String(name).trim(), +delta);
  if (!r.found) return res.status(404).json({ error: 'ไม่พบวัตถุดิบ' });
  res.json({ ok: true, item: r.item });
});
app.post('/api/stock/threshold', async (req, res) => {
  const { name, threshold } = req.body || {};
  const r = await db.setThreshold(req.userId, String(name || '').trim(), +threshold || 0);
  if (!r.found) return res.status(404).json({ error: 'ไม่พบวัตถุดิบ' });
  res.json({ ok: true, item: r.item });
});
app.post('/api/stock/remove', async (req, res) => {
  const r = await db.removeStock(req.userId, String((req.body || {}).name || '').trim());
  res.json({ ok: r.found });
});

// ---- เฟส 28: ลูกหนี้-เจ้าหนี้ ----
app.get('/api/debts', async (req, res) => {
  const ym = bkkDate().slice(0, 7);
  const [receivable, payable, totals, month] = await Promise.all([
    db.listDebts(req.userId, 'receivable'),
    db.listDebts(req.userId, 'payable'),
    db.debtTotals(req.userId),
    db.monthTotals(req.userId, ym),
  ]);
  const shop = await db.getShopProfile(req.userId).catch(() => null);
  res.json({ receivable, payable, totals, month, shopName: (shop && shop.shopName) || '' });
});
// เฟส 42: ประวัติหนี้รายคน
app.get('/api/debts/history', async (req, res) => {
  const dir = req.query.direction === 'payable' ? 'payable' : 'receivable';
  const party = String(req.query.party || '').trim();
  if (!party) return res.status(400).json({ error: 'ต้องระบุชื่อ' });
  res.json({ party, direction: dir, logs: await db.debtHistory(req.userId, dir, party) });
});
app.post('/api/debts', async (req, res) => {
  const { direction, party, amount } = req.body || {};
  const dir = direction === 'payable' ? 'payable' : 'receivable';
  if (!party || !String(party).trim() || !(+amount > 0)) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  await db.upsertDebt(req.userId, dir, String(party).trim(), +amount, null, bkkDate());
  res.json({ ok: true });
});
app.post('/api/debts/settle', async (req, res) => {
  const { direction, party, amount } = req.body || {};
  const dir = direction === 'payable' ? 'payable' : 'receivable';
  const pay = amount == null || amount === '' ? null : +amount;
  const s = await db.settleDebt(req.userId, dir, String(party || '').trim(), pay);
  if (!s.found) return res.status(404).json({ error: 'ไม่พบรายการ' });
  if (s.applied > 0) {
    await db.insertTxn({
      lineUserId: req.userId,
      type: dir === 'receivable' ? 'income' : 'expense',
      amount: s.applied,
      category: dir === 'receivable' ? 'รับชำระหนี้' : 'จ่ายชำระหนี้',
      note: (dir === 'receivable' ? 'รับเงินจาก ' : 'จ่ายให้ ') + s.party,
      items: null, source: 'app', txnDate: bkkDate(),
    });
  }
  res.json({ ok: true, applied: s.applied, remaining: s.remaining, party: s.party });
});

// ---- เฟส 31: สูตรอาหาร ----
app.get('/api/recipes', async (req, res) => {
  const [recipes, stock] = await Promise.all([db.listRecipes(req.userId), db.listStock(req.userId)]);
  const withCost = [];
  for (const r of recipes) withCost.push({ ...r, cost: await db.recipeCost(req.userId, r.items) });
  res.json({ recipes: withCost, stock });
});
app.post('/api/recipes', async (req, res) => {
  const { menuName, items } = req.body || {};
  if (!menuName || !String(menuName).trim() || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const clean = items.filter(it => it && it.ingredient && String(it.ingredient).trim() && +it.qty > 0)
    .map(it => ({ ingredient: String(it.ingredient).trim(), qty: +it.qty, unit: (it.unit || '').trim() }));
  if (!clean.length) return res.status(400).json({ error: 'ต้องมีวัตถุดิบอย่างน้อย 1 อย่าง' });
  await db.setRecipe(req.userId, String(menuName).trim(), clean);
  const cost = await db.recipeCost(req.userId, clean);
  res.json({ ok: true, cost });
});
app.post('/api/recipes/delete', async (req, res) => {
  const r = await db.deleteRecipe(req.userId, String((req.body || {}).menuName || '').trim());
  res.json({ ok: r.found });
});
app.post('/api/stock/cost', async (req, res) => {
  const { name, cost } = req.body || {};
  const r = await db.setStockCost(req.userId, String(name || '').trim(), +cost || 0);
  if (!r.found) return res.status(404).json({ error: 'ไม่พบวัตถุดิบ' });
  res.json({ ok: true, item: r.item });
});

// ---- เฟส 32: จัดการพนักงาน ----
app.get('/api/staff', async (req, res) => {
  const staff = await db.staffAllSummary(req.userId);
  res.json({ staff });
});
app.post('/api/staff', async (req, res) => {
  const { name, dayWage } = req.body || {};
  if (!name || !String(name).trim() || !(+dayWage >= 0)) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const s = await db.addStaff(req.userId, String(name).trim(), +dayWage);
  res.json({ ok: true, staff: s });
});
app.post('/api/staff/log', async (req, res) => {
  const { name, kind, amount } = req.body || {};
  const k = ['work', 'advance', 'pay'].includes(kind) ? kind : null;
  if (!k) return res.status(400).json({ error: 'kind ไม่ถูกต้อง' });
  const st = await db.findStaff(req.userId, String(name || '').trim());
  if (!st) return res.status(404).json({ error: 'ไม่พบพนักงาน' });
  const amt = k === 'work' ? (+amount > 0 ? +amount : 1) : +amount;
  if (k !== 'work' && !(amt > 0)) return res.status(400).json({ error: 'ยอดต้องมากกว่า 0' });
  await db.logStaff(req.userId, st.id, k, amt, null, bkkDate());
  if (k === 'advance' || k === 'pay') {
    await db.insertTxn({
      lineUserId: req.userId, type: 'expense', amount: amt, category: 'ค่าแรง',
      note: (k === 'advance' ? 'เบิกเงิน ' : 'จ่ายค่าแรง ') + st.name, items: null, source: 'app', txnDate: bkkDate(),
    });
  }
  const sum = await db.staffSummary(req.userId, st);
  res.json({ ok: true, summary: sum });
});
app.post('/api/staff/remove', async (req, res) => {
  const r = await db.removeStaff(req.userId, String((req.body || {}).name || '').trim());
  res.json({ ok: r.found });
});

// ---- เฟส 34: ภาษีมูลค่าเพิ่ม (VAT) ----
app.get('/api/vat', async (req, res) => {
  const ym = bkkDate().slice(0, 7);
  const [config, summary] = await Promise.all([db.getVatConfig(req.userId), db.vatSummary(req.userId, ym)]);
  res.json({ config, summary, month: xlsx.thMonthLabel(ym) });
});
app.post('/api/vat/config', async (req, res) => {
  const { enabled, rate } = req.body || {};
  const r = rate == null || rate === '' ? null : +rate;
  if (r != null && (!(r >= 0) || r > 30)) return res.status(400).json({ error: 'อัตราไม่ถูกต้อง' });
  const config = await db.setVatConfig(req.userId, !!enabled, r);
  res.json({ ok: true, config });
});
app.post('/api/vat/purchase', async (req, res) => {
  const { amount, note } = req.body || {};
  if (!(+amount > 0)) return res.status(400).json({ error: 'ยอดต้องมากกว่า 0' });
  await db.insertTxn({
    lineUserId: req.userId, type: 'expense', amount: +amount, category: 'ซื้อของ',
    note: (note || '').trim() || 'ซื้อของ (มีใบกำกับ)', items: null, source: 'app', txnDate: bkkDate(), vat: 1,
  });
  const ym = bkkDate().slice(0, 7);
  const summary = await db.vatSummary(req.userId, ym);
  res.json({ ok: true, summary });
});

// ---- เฟส 8: เป้ายอดขาย ----
app.get('/api/goals', async (req, res) => {
  await db.upsertUser(req.identityId, req.displayName);
  const today = bkkDate();
  const [g, day, month] = await Promise.all([
    db.getGoals(req.userId), db.dayTotals(req.userId, today), db.monthTotals(req.userId, today.slice(0, 7)),
  ]);
  res.json({ daily: g.daily, monthly: g.monthly, todayIncome: day.income, monthIncome: month.income });
});
app.post('/api/goals', async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if ('daily' in b) patch.daily = b.daily == null || +b.daily <= 0 ? null : Math.round(+b.daily);
  if ('monthly' in b) patch.monthly = b.monthly == null || +b.monthly <= 0 ? null : Math.round(+b.monthly);
  await db.setGoal(req.userId, patch);
  res.json({ ok: true });
});

// ---- เฟส 9: เทียบต้นทุน ----
app.get('/api/cost-compare', async (req, res) => {
  const today = bkkDate();
  const R = monthCompareRanges(today);
  const cmp = await db.categoryCompare(req.userId, R.thisStart, R.thisEnd, R.prevStart, R.prevEnd);
  const rows = cmp.filter(r => r.cur > 0 || r.prev > 0).map(r => {
    let status = 'flat', pct = 0;
    if (r.prev === 0 && r.cur > 0) status = 'new';
    else if (r.prev > 0) { pct = Math.round(((r.cur - r.prev) / r.prev) * 100); status = pct >= 5 ? 'up' : (pct <= -5 ? 'down' : 'flat'); }
    return { category: r.category, cur: r.cur, prev: r.prev, pct, status };
  });
  res.json({ period: R.label, rows });
});

// ---- ตั้งค่า + export ----
app.get('/api/settings', async (req, res) => {
  const today = bkkDate();
  const [dailySummary, mem, used] = await Promise.all([
    db.getDailySummary(req.userId), db.getMembership(req.userId, today), db.usageToday(req.userId, today),
  ]);
  res.json({
    dailySummary,
    tier: mem.effective, tierUntil: mem.until,
    aiUsed: used, aiLimit: aiLimitFor(mem.effective),
  });
});
app.post('/api/settings', async (req, res) => {
  if (typeof (req.body || {}).dailySummary === 'boolean') await db.setDailySummary(req.userId, req.body.dailySummary);
  res.json({ ok: true });
});
app.get('/api/export-link', async (req, res) => {
  if (!baseUrl()) return res.status(503).json({ error: 'ลิงก์ยังไม่พร้อม' });
  const ym = YM_RE.test(req.query.month) ? req.query.month : bkkDate().slice(0, 7);
  res.json({ url: `${baseUrl()}/export.xlsx?t=${signExport(req.userId, ym)}`, month: ym });
});

// ---- เฟส 13: รายจ่ายประจำ ----
app.get('/api/recurring', async (req, res) => {
  res.json(await db.listRecurring(req.userId));
});
app.post('/api/recurring', async (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  const amount = Math.round((+b.amount || 0) * 100) / 100;
  const day = Math.min(Math.max(parseInt(b.day, 10) || 1, 1), 28);
  if (!name) return res.status(400).json({ error: 'ต้องมีชื่อรายการ' });
  if (!(amount > 0)) return res.status(400).json({ error: 'ยอดต้องมากกว่า 0' });
  const id = await db.createRecurring(req.userId, { name, amount, day });
  res.json({ id });
});
app.post('/api/recurring/:id/toggle', async (req, res) => {
  await db.toggleRecurring(req.userId, +req.params.id, !!(req.body || {}).active);
  res.json({ ok: true });
});
app.delete('/api/recurring/:id', async (req, res) => {
  res.json({ ok: await db.deleteRecurring(req.userId, +req.params.id) });
});

// ---------- เฟส 7: แจ้งเตือนสรุปรายวันอัตโนมัติ ----------
const DAILY_SUMMARY_ENABLED = (process.env.DAILY_SUMMARY_ENABLED || 'true') !== 'false';
const DAILY_SUMMARY_HOUR = Math.min(Math.max(+process.env.DAILY_SUMMARY_HOUR || 21, 0), 23);
const FORGOT_REMIND_ENABLED = (process.env.FORGOT_REMIND_ENABLED || 'true') !== 'false';
const REMIND_HOUR = Math.min(Math.max(+process.env.REMIND_HOUR || 20, 0), 23);

async function sendJotReminders() {
  const today = bkkDate();
  const users = await db.usersToRemind(today, bkkDaysAgo(7), bkkYesterday());
  let sent = 0;
  for (const uid of users) {
    try {
      await linePush(uid, [{ type: 'text', text: '🌙 วันนี้ยังไม่ได้จดรายการเลยนะครับ\nถ้ามีขายหรือซื้ออะไรวันนี้ พิมพ์บอกผมได้เลย เดี๋ยวจดให้ (ไม่อยากให้ลืม 😊)\n\n(ไม่อยากรับเตือนนี้ พิมพ์คำว่า ปิดสรุป ได้)' }]);
      sent++;
      await new Promise(r => setTimeout(r, 120));
    } catch (e) { console.error('[jotRemind]', uid.slice(0, 6), e.message); }
  }
  if (sent) console.log(`[jotRemind] sent ${sent}/${users.length} for ${today}`);
}
async function forgotJotTick() {
  if (!FORGOT_REMIND_ENABLED) return;
  try {
    if (bkkHour() !== REMIND_HOUR) return;
    const today = bkkDate();
    if (await db.getState('last_jot_remind') === today) return;
    await db.setState('last_jot_remind', today);
    await sendJotReminders();
  } catch (e) { console.error('[forgotJotTick]', e.message); }
}

async function sendDailySummaries() {
  const today = bkkDate();
  const yest = bkkYesterday();
  const link = liffUrl();
  const users = await db.activeUsersForDaily(today);
  let sent = 0;
  for (const uid of users) {
    try {
      const [t, y] = await Promise.all([db.dayTotals(uid, today), db.dayTotals(uid, yest)]);
      const card = flex.dailyPushCard({
        dateLabel: `${today.slice(8)}/${today.slice(5, 7)}`,
        today: t, yest: y.count ? y : null, link,
      });
      const msgs = [{ type: 'flex', altText: card.altText, contents: card.contents }];
      try {
        const low = await db.lowStock(uid);
        if (low.length) {
          const names = low.slice(0, 8).map(r => r.name).join(', ');
          msgs.push({ type: 'text', text: `🛒 ของใกล้หมด: ${names}\nพิมพ์คำว่า  ต้องซื้อ  เพื่อดูรายการทั้งหมด` });
        }
      } catch (e) { /* สต๊อกยังไม่ตั้ง ก็ข้ามไป */ }
      await linePush(uid, msgs);
      sent++;
      await new Promise(r => setTimeout(r, 120)); // กันยิงถี่เกิน
    } catch (e) { console.error('[dailyPush]', uid.slice(0, 6), e.message); }
  }
  console.log(`[dailyPush] sent ${sent}/${users.length} for ${today}`);
}

async function dailySummaryTick() {
  if (!DAILY_SUMMARY_ENABLED) return;
  try {
    if (bkkHour() !== DAILY_SUMMARY_HOUR) return;
    const today = bkkDate();
    const last = await db.getState('last_daily_push');
    if (last === today) return;            // ส่งไปแล้ววันนี้
    await db.setState('last_daily_push', today); // จองก่อน กันยิงซ้ำตอน restart
    await sendDailySummaries();
  } catch (e) { console.error('[dailyTick]', e.message); }
}

// เฟส 13: ลงรายจ่ายประจำที่ถึงกำหนดในเดือนนี้
async function scanRecurring() {
  const today = bkkDate(), ym = today.slice(0, 7), day = +today.slice(8, 10);
  const due = await db.recurringToRun(ym);
  let n = 0;
  for (const r of due) {
    if (day < r.day) continue; // ยังไม่ถึงวันของเดือนนี้
    try {
      await db.insertTxn({
        lineUserId: r.userId, type: 'expense', amount: r.amount,
        category: r.name, note: 'รายจ่ายประจำ', items: null, source: 'recurring',
        txnDate: `${ym}-${String(Math.min(r.day, 28)).padStart(2, '0')}`,
      });
      await db.markRecurringRun(r.id, ym);
      n++;
    } catch (e) { console.error('[recurring]', r.id, e.message); }
  }
  if (n) console.log(`[recurring] posted ${n} item(s) for ${ym}`);
}
async function recurringTick() {
  try {
    const today = bkkDate();
    if (await db.getState('last_recurring_scan') === today) return;
    await db.setState('last_recurring_scan', today);
    await scanRecurring();
  } catch (e) { console.error('[recurringTick]', e.message); }
}

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`แบ่งเบา bot running on :${PORT}`));
    recurringTick(); // เช็กรายจ่ายประจำตอนเริ่ม
    setInterval(recurringTick, 60 * 1000);
    if (FORGOT_REMIND_ENABLED) {
      console.log(`[jotRemind] enabled, will nudge around ${REMIND_HOUR}:00 (Asia/Bangkok)`);
      setInterval(forgotJotTick, 60 * 1000);
    }
    if (DAILY_SUMMARY_ENABLED) {
      console.log(`[dailyPush] enabled, will send around ${DAILY_SUMMARY_HOUR}:00 (Asia/Bangkok)`);
      setInterval(dailySummaryTick, 60 * 1000); // เช็กทุกนาที
    }
  })
  .catch(e => { console.error('[startup] db init failed', e); process.exit(1); });
