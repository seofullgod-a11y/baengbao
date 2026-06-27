const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LIFF_ID = process.env.LIFF_ID || '';
const liffUrl = () => (LIFF_ID ? `https://liff.line.me/${LIFF_ID}` : null);

// ---------- helpers ----------
function bkkDate(d = new Date()) {
  // YYYY-MM-DD ตามเวลาไทย
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
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
  const sign = parsed.type === 'income' ? '+' : '−';
  let head = `✅ บันทึกแล้ว\n${parsed.type === 'income' ? 'รายรับ' : 'รายจ่าย'} ${sign}${baht(parsed.amount)} ฿` +
    (parsed.note ? ` (${parsed.note})` : '');

  // ถ้าเป็นการขายและตรงกับเมนูที่ตั้งไว้ → โชว์กำไรโดยประมาณ
  if (parsed.type === 'income' && parsed.items && parsed.items.length) {
    try {
      const menus = await db.listMenus(userId);
      if (menus.length) {
        const it = parsed.items[0];
        const m = matchMenu(menus, it.name);
        const qty = Number(it.qty) || null;
        if (m && qty) {
          const est = parsed.amount - (m.material_cost + m.labor_cost) * qty;
          head += `\n💰 กำไรเมนูนี้ ~${baht(est)} ฿`;
        }
      }
    } catch (e) { console.error('[menuProfit]', e.message); }
  }

  return `${head}\n━━━━━━━\nวันนี้: ${summaryLine(day)}`;
}

const HELP =
`สวัสดีครับ ผม "แบ่งเบา" ผู้ช่วยบัญชีร้านอาหาร 🧾

พิมพ์บอกได้เลย เช่น
• ขายกะเพรา 5 จาน 250
• ซื้อหมู 800
• จ่ายค่าแก๊ส 450
หรือถ่ายรูปบิลส่งมา เดี๋ยวผมอ่านให้

คำสั่ง:
• "สรุป" หรือ "วันนี้" — ดูยอดวันนี้
• "เดือนนี้" — ดูยอดทั้งเดือน
• "เมนู" — ตั้งเมนู + ดูกำไรต่อจาน
• "กำไรเมนู" — ดูกำไรต่อจานของทุกเมนู`;

// ---------- event handling ----------
async function handleEvent(ev) {
  if (ev.type === 'follow') {
    return replyText(ev.replyToken, HELP);
  }
  if (ev.type !== 'message' || !ev.source || ev.source.type !== 'user') return;

  const userId = ev.source.userId;
  await db.upsertUser(userId);

  // ----- text -----
  if (ev.message.type === 'text') {
    const raw = ev.message.text.trim();
    const t = raw.toLowerCase();

    if (['ช่วย', 'help', 'วิธีใช้', 'เริ่ม', 'start'].some(k => t.includes(k)))
      return replyText(ev.replyToken, HELP);

    if (['สรุป', 'วันนี้', 'ยอดวันนี้'].some(k => raw.includes(k))) {
      const day = await db.dayTotals(userId, bkkDate());
      return replyText(ev.replyToken, `📊 สรุปวันนี้ (${day.count} รายการ)\n${summaryLine(day)}`);
    }
    if (['เดือนนี้', 'สรุปเดือน', 'ยอดเดือน'].some(k => raw.includes(k))) {
      const ym = bkkDate().slice(0, 7);
      const m = await db.monthTotals(userId, ym);
      return replyText(ev.replyToken, `📅 สรุปเดือนนี้ (${m.count} รายการ)\n${summaryLine(m)}`);
    }
    if (['กำไรเมนู', 'กำไรต่อจาน'].some(k => raw.includes(k))) {
      const menus = await db.listMenus(userId);
      if (!menus.length) {
        const u = liffUrl();
        return replyText(ev.replyToken, 'ยังไม่มีเมนูเลยครับ ตั้งเมนูแรกได้ที่นี่' + (u ? `\n${u}` : ' (พิมพ์ "เมนู")'));
      }
      const lines = menus
        .slice()
        .sort((a, b) => menuProfit(b) - menuProfit(a))
        .map(m => `• ${m.name}: กำไร ${baht(menuProfit(m))} ฿/จาน (มาร์จิน ${menuMargin(m).toFixed(0)}%)`);
      return replyText(ev.replyToken, `🍳 กำไรต่อจาน\n${lines.join('\n')}`);
    }
    if (raw.includes('เมนู')) {
      const u = liffUrl();
      const menus = await db.listMenus(userId);
      let msg = u ? `จัดการเมนู + ดูกำไรต่อจานที่นี่ครับ 👇\n${u}` : 'ยังไม่ได้ตั้งค่า LIFF (ตั้ง LIFF_ID ใน env ก่อนครับ)';
      if (menus.length) {
        const top = menus.slice(0, 5).map(m => `• ${m.name}: ${baht(menuProfit(m))} ฿/จาน`).join('\n');
        msg += `\n━━━━━━━\nเมนูตอนนี้:\n${top}`;
      }
      return replyText(ev.replyToken, msg);
    }

    try {
      const parsed = await ai.parseText(raw);
      if (!parsed.is_transaction)
        return replyText(ev.replyToken, parsed.reply_hint || HELP);
      if (parsed.amount == null)
        return replyText(ev.replyToken, 'รับทราบว่าเป็นรายการ แต่ยังไม่เห็นยอดเงินเลยครับ ลองพิมพ์ยอดมาด้วยนะ เช่น "ซื้อหมู 800"');
      return replyText(ev.replyToken, await confirmAndSummary(userId, parsed, 'text'));
    } catch (e) {
      console.error('[parseText]', e.message);
      return replyText(ev.replyToken, 'ขอโทษครับ ตอนนี้ประมวลผลไม่ได้ ลองพิมพ์ใหม่อีกครั้งนะ');
    }
  }

  // ----- image (bill) -----
  if (ev.message.type === 'image') {
    try {
      const { base64, mediaType } = await getImageBase64(ev.message.id);
      const parsed = await ai.parseImage(base64, mediaType);
      if (!parsed.is_transaction || parsed.amount == null)
        return replyText(ev.replyToken, 'อ่านบิลแล้วแต่จับยอดรวมไม่ชัดครับ ลองถ่ายให้เห็นยอดรวมชัดๆ หรือพิมพ์ยอดมาก็ได้');
      return replyText(ev.replyToken, await confirmAndSummary(userId, parsed, 'image'));
    } catch (e) {
      console.error('[parseImage]', e.message);
      return replyText(ev.replyToken, 'ขอโทษครับ อ่านรูปบิลไม่สำเร็จ ลองส่งใหม่อีกครั้งนะ');
    }
  }
}

// ---------- routes ----------
// เก็บ raw body ไว้ verify ลายเซ็น แล้ว parse json
app.use('/webhook', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.post('/webhook', (req, res) => {
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

app.use('/api/menus', express.json(), liffAuth);

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

db.init()
  .then(() => app.listen(PORT, () => console.log(`แบ่งเบา bot running on :${PORT}`)))
  .catch(e => { console.error('[startup] db init failed', e); process.exit(1); });
