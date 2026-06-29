// richmenu.js — สร้าง/อัปโหลด/ตั้งเป็นค่าเริ่มต้นของ Rich Menu (ปุ่มลัดล่างแชท)
'use strict';
const fs = require('fs');

const AUTH = token => ({ Authorization: `Bearer ${token}` });

// ปุ่มทั้ง 6 ส่งเป็นข้อความ ตรงกับคำสั่งที่บอทรองรับอยู่แล้ว
function menuDefinition() {
  return {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: 'baengbao-main',
    chatBarText: 'เมนูแบ่งเบา',
    areas: [
      // แถวบน (ใหญ่ ใช้ทุกวัน) สูง 1010
      { bounds: { x: 0,    y: 0,    width: 833, height: 1010 }, action: { type: 'message', text: 'สรุป' } },
      { bounds: { x: 833,  y: 0,    width: 834, height: 1010 }, action: { type: 'message', text: 'วิธีจด' } },
      { bounds: { x: 1667, y: 0,    width: 833, height: 1010 }, action: { type: 'message', text: 'รายงาน' } },
      // แถวล่าง (เสริม) สูง 676
      { bounds: { x: 0,    y: 1010, width: 833, height: 676 },  action: { type: 'message', text: 'เป้า' } },
      { bounds: { x: 833,  y: 1010, width: 834, height: 676 },  action: { type: 'message', text: 'เมนู' } },
      { bounds: { x: 1667, y: 1010, width: 833, height: 676 },  action: { type: 'message', text: 'ช่วย' } },
    ],
  };
}

async function setupRichMenu(token, imagePath) {
  if (!token) throw new Error('ไม่มี channel access token');
  if (!fs.existsSync(imagePath)) throw new Error('ไม่พบไฟล์รูป ' + imagePath);

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
  const img = fs.readFileSync(imagePath);
  const up = await fetch('https://api-data.line.me/v2/bot/richmenu/' + richMenuId + '/content', {
    method: 'POST', headers: { ...AUTH(token), 'Content-Type': 'image/png' }, body: img,
  });
  if (!up.ok) throw new Error('upload ' + up.status + ' ' + (await up.text()).slice(0, 200));

  // ตั้งเป็นค่าเริ่มต้นให้ผู้ใช้ทุกคน
  const sd = await fetch('https://api.line.me/v2/bot/user/all/richmenu/' + richMenuId, { method: 'POST', headers: AUTH(token) });
  if (!sd.ok) throw new Error('setdefault ' + sd.status + ' ' + (await sd.text()).slice(0, 200));

  return richMenuId;
}

module.exports = { setupRichMenu };
