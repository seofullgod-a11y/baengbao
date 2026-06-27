const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// haiku = ถูก+เร็ว สำหรับ parse ข้อความปริมาณมาก / sonnet = อ่านรูปบิลแม่นกว่า
const TEXT_MODEL = process.env.TEXT_MODEL || 'claude-haiku-4-5-20251001';
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-6';

const SCHEMA_GUIDE = `
ตอบกลับเป็น JSON object เท่านั้น ห้ามมีข้อความอื่น ห้ามมี markdown code fence
โครงสร้าง:
{
  "is_transaction": boolean,        // เป็นรายการเงินเข้า/ออกของร้านหรือไม่
  "type": "income" | "expense" | null,  // ขาย/รับเงิน = income, ซื้อ/จ่าย = expense
  "amount": number | null,          // ยอดรวมเป็นบาท (ตัวเลขล้วน)
  "category": string | null,        // เช่น "ขายอาหาร","วัตถุดิบ","ค่าแก๊ส","ค่าแรง","ค่าเช่า","อื่นๆ"
  "items": [ { "name": string, "qty": number|null, "amount": number|null } ],
  "note": string,                   // สรุปสั้นๆ ของรายการ
  "reply_hint": string              // ถ้า is_transaction=false ให้ใส่ข้อความตอบผู้ใช้สั้นๆ
}
กฎ:
- คำว่า ขาย/ได้/รับ/เข้า = income | ซื้อ/จ่าย/ค่า... = expense
- ถ้าไม่ใช่เรื่องเงิน (ทักทาย/ถาม/คุยเล่น) ให้ is_transaction=false แล้วใส่ reply_hint
- ถ้าเป็นรายการเงินแต่ไม่มีตัวเลขยอด ให้ is_transaction=true, amount=null
- ตัวเลขเงินตัดคอมมา/บาท ออก ให้เหลือเลขล้วน
`;

function safeJSON(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no json found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function parseText(message) {
  const res = await anthropic.messages.create({
    model: TEXT_MODEL,
    max_tokens: 600,
    system: 'คุณคือผู้ช่วยลงบัญชีร้านอาหารไทย แปลงข้อความเป็นรายการบัญชี\n' + SCHEMA_GUIDE,
    messages: [{ role: 'user', content: message }],
  });
  const text = res.content.map(b => b.text || '').join('');
  return safeJSON(text);
}

async function parseImage(base64, mediaType) {
  const res = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 1500,
    system: 'คุณคือผู้ช่วยลงบัญชีร้านอาหารไทย อ่านบิล/ใบเสร็จในรูปแล้วสรุปเป็นรายการบัญชี\n' + SCHEMA_GUIDE +
      '\nสำหรับรูปบิลซื้อของให้ type=expense เป็นค่าเริ่มต้น เว้นแต่เป็นสรุปยอดขายให้ type=income\nดึงรายการสินค้าลง items และยอดรวมลง amount',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'อ่านบิลนี้แล้วตอบเป็น JSON ตามโครงสร้าง' },
      ],
    }],
  });
  const text = res.content.map(b => b.text || '').join('');
  return safeJSON(text);
}

module.exports = { parseText, parseImage };
