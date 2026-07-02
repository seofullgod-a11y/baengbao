// richmenu.js — สร้าง/อัปโหลด/ตั้งเป็นค่าเริ่มต้นของ Rich Menu (ปุ่มลัดล่างแชท)
'use strict';
const fs = require('fs');

const AUTH = token => ({ Authorization: `Bearer ${token}` });

// ปุ่มทั้ง 6 ส่งเป็นข้อความ ตรงกับคำสั่งที่บอทรองรับอยู่แล้ว
function menuDefinition() {
  return {
    size: { width: 2500, height: 1667 },
    selected: true,
    name: 'baengbao-main',
    chatBarText: 'เมนูแบ่งเบา',
    areas: [
      // แบนเนอร์ด้านบน (พื้นที่ใหญ่ กดดูยอดวันนี้)
      { bounds: { x: 0, y: 0, width: 2500, height: 700 }, action: { type: 'message', text: 'สรุป' } },
      // 4 การ์ดด้านล่าง
      { bounds: { x: 0,    y: 700, width: 625, height: 967 }, action: { type: 'message', text: 'วิธีจด' } },
      { bounds: { x: 625,  y: 700, width: 625, height: 967 }, action: { type: 'message', text: 'ช่วย' } },
      { bounds: { x: 1250, y: 700, width: 625, height: 967 }, action: { type: 'message', text: 'รายงาน' } },
      { bounds: { x: 1875, y: 700, width: 625, height: 967 }, action: { type: 'message', text: 'เมนู' } },
    ],
  };
}

async function setupRichMenu(token, imagePath) {
  if (!fs.existsSync(imagePath)) throw new Error('ไม่พบไฟล์รูป ' + imagePath);
  return setupRichMenuFromBuffer(token, fs.readFileSync(imagePath), 'image/png');
}

// เฟส 33: ตั้ง Rich Menu จาก buffer (รองรับอัปโหลดผ่านหน้า /admin)
async function setupRichMenuFromBuffer(token, imgBuffer, contentType) {
  if (!token) throw new Error('ไม่มี channel access token');
  if (!imgBuffer || !imgBuffer.length) throw new Error('ไม่มีข้อมูลรูป');
  if (imgBuffer.length > 1024 * 1024) throw new Error('รูปใหญ่เกิน 1MB (LINE จำกัด 1MB) — ลองบีบอัดก่อนครับ');

  // ลบ rich menu เก่าทั้งหมดก่อน (กันซ้ำเวลากดหลายครั้ง)
  const list = await fetch('https://api.line.me/v2/bot/richmenu/list', { headers: AUTH(token) }).then(r => r.json()).catch(() => ({}));
  for (const m of (list.richmenus || [])) {
    await fetch('https://api.line.me/v2/bot/richmenu/' + m.richMenuId, { method: 'DELETE', headers: AUTH(token) });
  }

  // สร้าง rich menu
  const cr = await fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'POST', headers: { ...AUTH(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(menuDefinition()),
  });
  if (!cr.ok) throw new Error('create ' + cr.status + ' ' + (await cr.text()).slice(0, 200));
  const { richMenuId } = await cr.json();

  // อัปโหลดรูป
  const up = await fetch('https://api-data.line.me/v2/bot/richmenu/' + richMenuId + '/content', {
    method: 'POST', headers: { ...AUTH(token), 'Content-Type': contentType || 'image/png' }, body: imgBuffer,
  });
  if (!up.ok) throw new Error('upload ' + up.status + ' ' + (await up.text()).slice(0, 200));

  // ตั้งเป็นค่าเริ่มต้นให้ผู้ใช้ทุกคน
  const sd = await fetch('https://api.line.me/v2/bot/user/all/richmenu/' + richMenuId, { method: 'POST', headers: AUTH(token) });
  if (!sd.ok) throw new Error('setdefault ' + sd.status + ' ' + (await sd.text()).slice(0, 200));

  return richMenuId;
}

module.exports = { setupRichMenu, setupRichMenuFromBuffer };
