const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const flex = require('./flex');
const xlsx = require('./export-xlsx');
const richmenu = require('./richmenu');

const app = express();
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
    `อยากจดได้ไม่อั้นกว่านี้? พิมพ์ "สมาชิก" เพื่อดูแพ็กเกจ Pro`;
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

async function lineReply(replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CHANNEL_TOKEN}` },
    body: JSON.stringify({ replyToken, messages }),
  });
  if (!res.ok) console.error('[line] reply failed', res.status, await res.text());
}
const replyText = (token, text) => lineReply(token, [{ type: 'text', text }]);
const replyFlex = (token, altText, contents) => lineReply(token, [{ type: 'flex', altText, contents }]);

async function getImageBase64(messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` },
  });
  if (!res.ok) throw new Error('image fetch failed ' + res.status);
  const mediaType = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString('base64'), mediaType };
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

  return { messages };
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

const HELP =
`สวัสดีครับ ผม "แบ่งเบา" ผู้ช่วยบัญชีร้านอาหาร 🧾

พิมพ์บอกได้เลย เช่น
• ขายกะเพรา 5 จาน 250
• ซื้อหมู 800
• จ่ายค่าแก๊ส 450
หรือถ่ายรูปบิลส่งมา เดี๋ยวผมอ่านให้
📱 แคปหน้าสรุปยอด Grab/LineMan/Shopee ส่งมาได้ ผมลงให้พร้อมหักค่า GP

คำสั่ง:
• "สรุป" หรือ "วันนี้" — ดูยอดวันนี้
• "เดือนนี้" — ดูยอดทั้งเดือน
• "เมนู" — ตั้งเมนู + ดูกำไรต่อจาน
• "กำไรเมนู" — ดูกำไรต่อจานของทุกเมนู
• "รายงาน" — เปิดแดชบอร์ดกราฟ + แก้/ลบรายการ
• "ปิดสรุป" / "เปิดสรุป" — ปิด/เปิดแจ้งเตือนสรุปรายวัน
• "เป้าวันละ 5000" — ตั้งเป้ายอดขาย, พิมพ์ "เป้า" เพื่อดูความคืบหน้า
• "ต้นทุน" — เทียบรายจ่ายแต่ละหมวดกับเดือนก่อน (เตือนของขึ้นราคา)
• "สัปดาห์" — สรุป 7 วันล่าสุด + เทียบสัปดาห์ก่อน
• "จุดคุ้มทุน" — ต้องขายวันละเท่าไหร่ถึงไม่ขาดทุน
• "งบ" — งบกำไร-ขาดทุนรายเดือน (รายได้ → ต้นทุน → กำไรสุทธิ)
• "ปิดยอด 3500" — เช็กเงินสดในลิ้นชักขาด/เกิน (ตั้งเงินทอนด้วย "ตั้งเงินทอน 1000")
• "ออกรายงาน" — ดาวน์โหลดไฟล์ Excel ส่งบัญชี/ยื่นภาษี (เพิ่ม "เดือนก่อน" ได้)
• "สมาชิก" — ดูแพ็กเกจ + โควตา AI วันนี้`;

// ---------- event handling ----------
async function handleEvent(ev) {
  if (ev.type === 'follow') {
    const w = flex.welcomeCarousel(liffUrl());
    return lineReply(ev.replyToken, [
      { type: 'flex', altText: w.altText, contents: w.contents },
      { type: 'text', text: 'พิมพ์ "ช่วย" เมื่อไหร่ก็ได้ เพื่อดูวิธีใช้ทั้งหมดนะครับ 🙌' },
    ]);
  }
  if (ev.type !== 'message' || !ev.source || ev.source.type !== 'user') return;

  const userId = ev.source.userId;
  await db.upsertUser(userId);

  // ----- text -----
  if (ev.message.type === 'text') {
    const raw = ev.message.text.trim();
    const t = raw.toLowerCase();

    try {
      if (['ช่วย', 'help', 'วิธีใช้', 'เริ่ม', 'start'].some(k => t.includes(k)))
        return replyText(ev.replyToken, HELP);

      if (['ปิดสรุป', 'ปิดแจ้งเตือน', 'ปิดเตือน'].some(k => raw.includes(k))) {
        await db.setDailySummary(userId, false);
        return replyText(ev.replyToken, 'ปิดแจ้งเตือนสรุปรายวันแล้วครับ 🔕\nพิมพ์ "เปิดสรุป" เมื่อไหร่ก็เปิดใหม่ได้');
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
            return replyText(ev.replyToken, `ตั้งเป้ายอดขายเดือนละ ${baht(amt)} ฿ แล้วครับ 🎯\nพิมพ์ "เป้า" เพื่อดูความคืบหน้าได้ตลอด`);
          }
          await db.setGoal(userId, { daily: amt });
          return replyText(ev.replyToken, `ตั้งเป้ายอดขายวันละ ${baht(amt)} ฿ แล้วครับ 🎯\nพิมพ์ "เป้า" เพื่อดูความคืบหน้าได้ตลอด`);
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
          return replyText(ev.replyToken, 'ยังไม่มีเมนูเลยครับ ตั้งเมนูแรกได้ที่นี่' + (u ? `\n${u}` : ' (พิมพ์ "เมนู")'));
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
          return replyText(ev.replyToken, 'คำนวณจุดคุ้มทุนต้องรู้ "ต้นทุนคงที่" ก่อนครับ\nไปตั้งรายจ่ายประจำ (ค่าเช่า/เงินเดือน) ในแอป แท็บ "ตั้งค่า"' + (u ? `\n${u}` : '') + '\nแล้วพิมพ์ "จุดคุ้มทุน" อีกที');
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
          return replyText(ev.replyToken, 'ข้อมูลยังไม่พอคำนวณกำไรขั้นต้นครับ ลองตั้งเมนู+ราคาต้นทุน (พิมพ์ "เมนู") หรือจดรายรับ-รายจ่ายสักพักแล้วลองใหม่');
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
        if (!m) return replyText(ev.replyToken, 'พิมพ์ เช่น "ตั้งเงินทอน 1000" ครับ (เงินที่ใส่ลิ้นชักไว้ตอนเปิดร้าน)');
        const amt = Math.round(parseFloat(m[0]) * 100) / 100;
        await db.setCashFloat(userId, amt);
        return replyText(ev.replyToken, `ตั้งเงินทอนตั้งต้น ${baht(amt)} ฿ แล้วครับ\nสิ้นวันพิมพ์ "ปิดยอด <เงินที่นับได้>" เพื่อเช็กเงินขาด-เกิน`);
      }

      if (raw.includes('ปิดยอด')) {
        const today = bkkDate();
        const openingFloat = await db.getCashFloat(userId);
        const { cashIn, cashOut } = await db.cashTotalsForDay(userId, today);
        const expected = openingFloat + cashIn - cashOut;
        const m = raw.replace(/,/g, '').match(/\d+(\.\d+)?/);
        if (!m) {
          return replyText(ev.replyToken,
            `ปิดยอดเงินสดวันนี้ 💵\nตอนนี้ในลิ้นชักควรมี ${baht(expected)} ฿\n(เงินทอนตั้งต้น ${baht(openingFloat)} + ขายสด ${baht(cashIn)} − จ่ายสด ${baht(cashOut)})\n\nนับเงินจริงแล้วพิมพ์ "ปิดยอด <จำนวน>" เพื่อเทียบครับ\nถ้าเงินทอนตั้งต้นไม่ตรง พิมพ์ "ตั้งเงินทอน <จำนวน>"`);
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

      { const q = await overQuota(userId); if (q.over) return replyText(ev.replyToken, quotaMessage(q)); }
      const parsed = await ai.parseText(raw);
      if (!parsed.is_transaction)
        return replyText(ev.replyToken, parsed.reply_hint || HELP);
      if (parsed.amount == null)
        return replyText(ev.replyToken, 'รับทราบว่าเป็นรายการ แต่ยังไม่เห็นยอดเงินเลยครับ ลองพิมพ์ยอดมาด้วยนะ เช่น "ซื้อหมู 800"');
      const r = await confirmAndSummary(userId, parsed, 'text');
      return lineReply(ev.replyToken, r.messages);
    } catch (e) {
      console.error('[text]', e.message);
      return replyText(ev.replyToken, 'ขอโทษครับ ตอนนี้ประมวลผลไม่ได้ ลองพิมพ์ใหม่อีกครั้งนะ');
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
      return lineReply(ev.replyToken, r.messages);
    } catch (e) {
      console.error('[parseImage]', e.message);
      return replyText(ev.replyToken, 'ขอโทษครับ อ่านรูปไม่สำเร็จ ลองส่งใหม่อีกครั้งนะ');
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

// เฟส 10: ดาวน์โหลดรายงาน Excel (ตรวจโทเคนที่เซ็นไว้)
app.get('/export.xlsx', async (req, res) => {
  try {
    const v = verifyExport(req.query.t);
    if (!v) return res.status(403).send('ลิงก์หมดอายุหรือไม่ถูกต้อง — พิมพ์ "ออกรายงาน" ในไลน์เพื่อขอลิงก์ใหม่');
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
    req.userId = profile.userId;
    req.displayName = profile.displayName;
    next();
  } catch (e) {
    console.error('[liffAuth]', e.message);
    res.status(401).json({ error: 'auth failed' });
  }
}

app.use(['/api/menus', '/api/stats', '/api/transactions', '/api/goals', '/api/cost-compare', '/api/settings', '/api/export-link', '/api/recurring'], express.json(), liffAuth);

app.get('/api/menus', async (req, res) => {
  await db.upsertUser(req.userId, req.displayName);
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

// ---- เฟส 8: เป้ายอดขาย ----
app.get('/api/goals', async (req, res) => {
  await db.upsertUser(req.userId, req.displayName);
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
      await linePush(uid, [{ type: 'text', text: '🌙 วันนี้ยังไม่ได้จดรายการเลยนะครับ\nถ้ามีขายหรือซื้ออะไรวันนี้ พิมพ์บอกผมได้เลย เดี๋ยวจดให้ (ไม่อยากให้ลืม 😊)\n\n(ไม่อยากรับเตือนนี้ พิมพ์ "ปิดสรุป" ได้)' }]);
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
      await linePush(uid, [{ type: 'flex', altText: card.altText, contents: card.contents }]);
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
