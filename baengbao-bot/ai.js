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

const IMAGE_GUIDE = `
ดูรูปแล้วแยกประเภทก่อน ตอบเป็น JSON object เท่านั้น ห้ามมี markdown
{
  "doc_type": "bill" | "delivery_summary" | "other",
  // กรณี bill (ใบเสร็จ/บิลซื้อของ):
  "is_transaction": boolean,
  "type": "income" | "expense" | null,
  "amount": number | null,
  "category": string | null,
  "items": [ { "name": string, "qty": number|null, "amount": number|null } ],
  "note": string,
  // กรณี delivery_summary (หน้าสรุปยอด/รายได้จากแอปเดลิเวอรี่):
  "platform": "Grab" | "LineMan" | "Shopee" | "อื่นๆ" | null,
  "gross_sales": number | null,   // ยอดขายรวมก่อนหักค่าธรรมเนียม
  "commission": number | null,    // ค่า GP / ค่าคอมมิชชั่น / ค่าธรรมเนียมที่ถูกหัก
  "net_payout": number | null,    // ยอดเงินสุทธิที่ได้รับ/โอนเข้า
  "orders": number | null,        // จำนวนออเดอร์
  "summary_date": "YYYY-MM-DD" | null
}
กฎ:
- ถ้าเป็นหน้าสรุปยอดขาย/รายได้จาก Grab, LineMan, Shopee Food → doc_type="delivery_summary" และกรอกฟิลด์เดลิเวอรี่ (ดู logo/สี/คำว่า GP, ค่าคอมมิชชั่น, ยอดโอน)
- ถ้าเป็นบิลซื้อของ/ใบเสร็จร้านค้า → doc_type="bill", type=expense เป็นค่าเริ่มต้น, ดึง items + ยอดรวมลง amount
- ตัวเลขตัดคอมมา/บาทออก เหลือเลขล้วน
- อ่านไม่ออก/ไม่เกี่ยว → doc_type="other"
`;

async function parseImage(base64, mediaType) {
  const res = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 1500,
    system: 'คุณคือผู้ช่วยลงบัญชีร้านอาหารไทย อ่านรูป (บิลซื้อของ หรือหน้าสรุปยอดเดลิเวอรี่) แล้วสรุปเป็นข้อมูลบัญชี\n' + IMAGE_GUIDE,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'อ่านรูปนี้แล้วตอบเป็น JSON ตามโครงสร้าง' },
      ],
    }],
  });
  const text = res.content.map(b => b.text || '').join('');
  return safeJSON(text);
}

module.exports = { parseText, parseImage, transcribeThai };

// ถอดเสียงพูดเป็นข้อความภาษาไทย (ใช้ OpenAI Whisper — รองรับไทยดี)
async function transcribeThai(buffer, mimeType = 'audio/m4a') {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, reason: 'no_key', text: '' };
  try {
    const ext = /mp4|m4a|aac/.test(mimeType) ? 'm4a'
      : /mpeg|mp3/.test(mimeType) ? 'mp3'
      : /wav/.test(mimeType) ? 'wav'
      : /ogg|opus/.test(mimeType) ? 'ogg' : 'm4a';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), `audio.${ext}`);
    form.append('model', process.env.WHISPER_MODEL || 'whisper-1');
    form.append('language', 'th');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) { console.error('[whisper]', res.status, await res.text()); return { ok: false, reason: 'api', text: '' }; }
    const data = await res.json();
    return { ok: true, text: (data.text || '').trim() };
  } catch (e) {
    console.error('[whisper]', e.message);
    return { ok: false, reason: 'err', text: '' };
  }
}
