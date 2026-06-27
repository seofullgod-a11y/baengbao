# แบ่งเบา — LINE Bot (เฟส 1)

บอทไลน์ผู้ช่วยบัญชีร้านอาหาร: พิมพ์รายรับ-รายจ่าย หรือถ่ายรูปบิล แล้ว Claude แปลงเป็นรายการบัญชี เก็บลง PostgreSQL และตอบยอดสรุปรายวันกลับทันที

## สิ่งที่บอททำได้ตอนนี้

- พิมพ์ภาษาไทยธรรมชาติ → ลงบัญชีให้ (เช่น `ขายกะเพรา 5 จาน 250`, `ซื้อหมู 800`, `จ่ายค่าแก๊ส 450`)
- ถ่ายรูปบิล/ใบเสร็จ → Claude อ่านยอด แยกรายการ ลงบัญชีให้
- คำสั่ง `สรุป` / `วันนี้` → ยอดวันนี้ • `เดือนนี้` → ยอดทั้งเดือน
- ตอบกลับด้วย reply message (ไม่กินโควตา push ของ LINE = ฟรี)

## โครงสร้าง

```
baengbao-bot/
├── server.js      ← webhook, verify signature, รับ event, ตอบกลับ
├── ai.js          ← เรียก Claude แปลงข้อความ/รูปบิล เป็น JSON
├── db.js          ← PostgreSQL: schema + query helpers
├── package.json
├── .env.example
└── README.md
```

## Environment variables ที่ต้องตั้ง

| ตัวแปร | เอามาจาก |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE Developers Console → channel → Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → Messaging API → Issue token (long-lived) |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `DATABASE_URL` | Railway ใส่ให้อัตโนมัติเมื่อเพิ่ม Postgres |

## Deploy ขึ้น Railway

1. push โค้ดนี้ขึ้น GitHub repo
2. Railway → New Project → Deploy from GitHub repo → เลือก repo
3. ในโปรเจกต์เดียวกัน กด **+ New → Database → PostgreSQL** (Railway จะ inject `DATABASE_URL` ให้บริการ web อัตโนมัติ ถ้าไม่ได้ ให้ไปที่ Variables ของ service แล้ว reference ตัวแปรจาก Postgres)
4. ไปที่ service ของบอท → **Variables** → ใส่ `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`
5. Railway รัน `npm start` ให้เอง (ไม่ต้องมี `railway.json`) — schema ตารางสร้างเองตอน start
6. เปิด **Settings → Networking → Generate Domain** เพื่อได้ public URL เช่น `https://baengbao-bot-production.up.railway.app`

> ลองเปิด `https://<your-domain>/health` ควรเห็น `{"ok":true}` ก่อนไปต่อ

## ตั้งค่า Webhook ฝั่ง LINE (ทำหลัง deploy)

**ใน LINE Developers Console** (developers.line.biz/console → channel → แท็บ Messaging API):
1. **Webhook URL** = `https://<your-domain>/webhook` → Update
2. เปิด **Use webhook** = ON
3. กด **Verify** → ควรขึ้น Success (เป็น POST ว่างๆ บอทตอบ 200)

**ใน LINE Official Account Manager** (manager.line.biz → ตั้งค่า → การตอบกลับ / Response settings):
1. ปิด **การตอบกลับอัตโนมัติ (Auto-reply)** — ไม่งั้นมันจะแย่งตอบทับบอท
2. ปิด **ข้อความทักทายเพื่อนใหม่ (Greeting)** ก็ได้ (บอทมี follow event ทักเองอยู่แล้ว)
3. **โหมดการตอบกลับ / Chat** ตั้งให้ใช้ Webhook/Bot ได้ (ถ้ามีตัวเลือก ให้เปิดเป็น Bot)

## ทดสอบ

แอดเพื่อน OA "แบ่งเบา" แล้วพิมพ์ `ขายกะเพรา 5 จาน 250` ควรได้:

```
✅ บันทึกแล้ว
รายรับ +250 ฿ (กะเพรา x5)
━━━━━━━
วันนี้: รายรับ 250 / รายจ่าย 0
กำไรสุทธิ +250 ฿
```

## รันในเครื่อง (ออปชัน)

```bash
cp .env.example .env   # แล้วเติมค่าจริง
npm install
npm start
```
local ต้องเปิด tunnel (เช่น ngrok/cloudflared) เพื่อให้ LINE ยิง webhook เข้ามาได้ — ขึ้น Railway ตรงๆ ง่ายกว่า

## ต้นทุนคร่าวๆ

- LINE: reply message **ไม่กินโควตา** — ฟรี ส่วน push (สรุปอัตโนมัติประจำวัน ถ้าทำในเฟสถัดไป) ใช้โควตา 200/เดือนของ free plan
- Claude: ต่อ 1 ข้อความใช้ haiku (ถูกมาก) / รูปบิลใช้ sonnet เปลี่ยนรุ่นได้ที่ env `TEXT_MODEL`/`VISION_MODEL`

## เฟสถัดไป (ยังไม่รวมในนี้)

- เมนู + สูตรต้นทุน → กำไรต่อจาน (LIFF)
- Dashboard กราฟรายวัน/รายเดือน (LINE Login)
- ดึงยอดเดลิเวอรี่ (forward อีเมล payout / อ่านรูปสรุปยอด)
