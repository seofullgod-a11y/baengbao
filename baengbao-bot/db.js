const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
// Railway internal URL ไม่ต้องใช้ SSL, ถ้าต่อจากภายนอก (มี sslmode=require) หรือ set PG_SSL=true ค่อยเปิด
const useSSL = /sslmode=require/.test(url) || process.env.PG_SSL === 'true';

const pool = new Pool({
  connectionString: url,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      line_user_id TEXT PRIMARY KEY,
      display_name TEXT,
      created_at   TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id           BIGSERIAL PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      type         TEXT NOT NULL CHECK (type IN ('income','expense')),
      amount       NUMERIC(12,2) NOT NULL,
      category     TEXT,
      note         TEXT,
      items        JSONB,
      source       TEXT DEFAULT 'text',
      txn_date     DATE NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_txn_user_date ON transactions (line_user_id, txn_date);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS menus (
      id            BIGSERIAL PRIMARY KEY,
      line_user_id  TEXT NOT NULL,
      name          TEXT NOT NULL,
      price         NUMERIC(12,2) NOT NULL DEFAULT 0,
      material_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      labor_cost    NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_menu_user ON menus (line_user_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      line_user_id TEXT NOT NULL,
      usage_date   DATE NOT NULL,
      ai_calls     INT  NOT NULL DEFAULT 0,
      PRIMARY KEY (line_user_id, usage_date)
    );
  `);
  // เฟส 7: ตั้งค่าแจ้งเตือนรายวัน + เก็บสถานะระบบ
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_summary BOOLEAN DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_daily NUMERIC(12,2);`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS goal_monthly NUMERIC(12,2);`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS cash_float NUMERIC(12,2) DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'free';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_until DATE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code TEXT;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite ON users (invite_code) WHERE invite_code IS NOT NULL;`);
  // เฟส 20: ระบบร้าน/พนักงาน (ใช้บัญชีข้อมูลร่วมกัน)
  // เฟส 23: โหมดมือใหม่ (สอนทีละขั้น) — 0/NULL=ไม่อยู่ในโหมดสอน, 1..=ขั้นที่กำลังสอน
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboard_step INT DEFAULT 0;`);
  // เฟส 34: ภาษีมูลค่าเพิ่ม (VAT)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vat_enabled BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vat_rate NUMERIC NOT NULL DEFAULT 7;`);
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vat SMALLINT NOT NULL DEFAULT 0;`);
  // เฟส 35: ข้อมูลร้าน (สำหรับใบเสร็จ) + ตารางใบเสร็จ
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_name TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_address TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_id TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS receipts (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      receipt_no INT NOT NULL,
      txn_id BIGINT,
      total NUMERIC NOT NULL DEFAULT 0,
      items JSONB,
      vat_amount NUMERIC NOT NULL DEFAULT 0,
      note TEXT,
      rdate DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // เฟส 28: ลูกหนี้-เจ้าหนี้ (บิลเชื่อ / ค้างจ่ายซัพพลายเออร์)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS debts (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      direction TEXT NOT NULL,          -- 'receivable' (ลูกค้าติดเรา) | 'payable' (เราติดคนอื่น)
      party TEXT NOT NULL,              -- ชื่อลูกค้า/ซัพพลายเออร์
      amount NUMERIC NOT NULL DEFAULT 0,-- ยอดรวมที่ติด
      paid NUMERIC NOT NULL DEFAULT 0,  -- จ่าย/รับคืนแล้วเท่าไหร่
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'settled'
      created_date DATE,
      settled_date DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // เฟส 29: สต๊อกวัตถุดิบ + เตือนของใกล้หมด
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_items (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      unit TEXT DEFAULT '',
      qty NUMERIC NOT NULL DEFAULT 0,
      low_threshold NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // เฟส 31: ต้นทุนต่อหน่วยของวัตถุดิบ (ไว้คิดต้นทุนจริงต่อจาน)
  await pool.query(`ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC NOT NULL DEFAULT 0;`);
  // เฟส 31: สูตรอาหาร (เมนู -> วัตถุดิบที่ใช้ต่อ 1 จาน) เพื่อตัดสต๊อก+คิดต้นทุนอัตโนมัติ
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      menu_name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recipe_items (
      id SERIAL PRIMARY KEY,
      recipe_id INT NOT NULL,
      ingredient TEXT NOT NULL,
      qty NUMERIC NOT NULL DEFAULT 0,
      unit TEXT DEFAULT ''
    );
  `);
  // เฟส 32: จัดการพนักงาน (ค่าแรง/ลงเวลา/เบิกเงิน)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      day_wage NUMERIC NOT NULL DEFAULT 0,
      active INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_logs (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      staff_id INT NOT NULL,
      kind TEXT NOT NULL,          -- 'work' (ลงเวลา) | 'advance' (เบิก) | 'pay' (จ่ายค่าแรง)
      amount NUMERIC NOT NULL DEFAULT 0, -- work: จำนวนวัน, advance/pay: บาท
      note TEXT,
      log_date DATE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);
  // เฟส 13: รายจ่ายประจำ (ค่าเช่า เงินเดือน ฯลฯ)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id           BIGSERIAL PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      amount       NUMERIC(12,2) NOT NULL,
      day_of_month INT NOT NULL DEFAULT 1,
      active       BOOLEAN DEFAULT TRUE,
      last_run_ym  TEXT,
      created_at   TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('[db] schema ready');
}

async function setDailySummary(lineUserId, on) {
  await pool.query(`UPDATE users SET daily_summary=$2 WHERE line_user_id=$1`, [lineUserId, !!on]);
}

// เฟส 8: เป้ายอดขาย
async function setGoal(lineUserId, { daily, monthly }) {
  const sets = [], vals = [lineUserId];
  if (daily !== undefined) { vals.push(daily); sets.push(`goal_daily=$${vals.length}`); }
  if (monthly !== undefined) { vals.push(monthly); sets.push(`goal_monthly=$${vals.length}`); }
  if (!sets.length) return;
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE line_user_id=$1`, vals);
}
async function getGoals(lineUserId) {
  const { rows } = await pool.query(
    `SELECT goal_daily, goal_monthly FROM users WHERE line_user_id=$1`, [lineUserId]
  );
  const r = rows[0] || {};
  return {
    daily: r.goal_daily != null ? +r.goal_daily : null,
    monthly: r.goal_monthly != null ? +r.goal_monthly : null,
  };
}

// เฟส 16: เงินทอนตั้งต้น + ปิดยอดเงินสด
async function setCashFloat(lineUserId, amount) {
  await pool.query(`UPDATE users SET cash_float=$2 WHERE line_user_id=$1`, [lineUserId, amount]);
}
async function getCashFloat(lineUserId) {
  const { rows } = await pool.query(`SELECT COALESCE(cash_float,0) AS f FROM users WHERE line_user_id=$1`, [lineUserId]);
  return rows[0] ? +rows[0].f : 0;
}
// ยอดเงินสดของวัน (ตัดเดลิเวอรี่และค่า GP ออก เพราะไม่ใช่เงินสดในลิ้นชัก)
async function cashTotalsForDay(lineUserId, dateStr) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type='income'  AND COALESCE(category,'') NOT LIKE 'ขายเดลิเวอรี่%'), 0) AS cash_in,
       COALESCE(SUM(amount) FILTER (WHERE type='expense' AND COALESCE(category,'') NOT LIKE 'ค่า GP%'), 0)        AS cash_out
     FROM transactions WHERE line_user_id=$1 AND txn_date=$2`,
    [lineUserId, dateStr]
  );
  const r = rows[0];
  return { cashIn: +r.cash_in, cashOut: +r.cash_out };
}
// รวมรายจ่ายประจำที่เปิดอยู่ (ต้นทุนคงที่ต่อเดือน)
async function recurringMonthlyTotal(lineUserId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM recurring_expenses WHERE line_user_id=$1 AND active=TRUE`,
    [lineUserId]
  );
  return +rows[0].s;
}

// เฟส 18: ระบบสมาชิก (Free/Pro)
async function getMembership(lineUserId, today) {
  const { rows } = await pool.query(
    `SELECT COALESCE(tier,'free') AS tier, tier_until::text AS until FROM users WHERE line_user_id=$1`,
    [lineUserId]
  );
  const r = rows[0] || { tier: 'free', until: null };
  const effective = (r.tier === 'pro' && (!r.until || r.until >= today)) ? 'pro' : 'free';
  return { tier: r.tier, until: r.until, effective };
}
async function setMembership(lineUserId, tier, until) {
  await pool.query(`UPDATE users SET tier=$2, tier_until=$3 WHERE line_user_id=$1`, [lineUserId, tier, until || null]);
}
// อ่านจำนวนการใช้ AI วันนี้ (ไม่ +1)
async function usageToday(lineUserId, dateStr) {
  const { rows } = await pool.query(
    `SELECT COALESCE(ai_calls,0) AS n FROM usage_daily WHERE line_user_id=$1 AND usage_date=$2`,
    [lineUserId, dateStr]
  );
  return rows[0] ? +rows[0].n : 0;
}

// เฟส 23: โหมดมือใหม่
async function getOnboard(lineUserId) {
  const { rows } = await pool.query(`SELECT COALESCE(onboard_step,0) AS s FROM users WHERE line_user_id=$1`, [lineUserId]);
  return rows[0] ? +rows[0].s : 0;
}
async function setOnboard(lineUserId, step) {
  await pool.query(`UPDATE users SET onboard_step=$2 WHERE line_user_id=$1`, [lineUserId, step]);
}

// เฟส 20: เพิ่มพนักงาน (แชร์บัญชีร้าน)
// บัญชีข้อมูลของผู้ใช้คนนี้ = account_id (ถ้าเป็นพนักงาน) หรือ line_user_id ของตัวเอง (ถ้าเป็นเจ้าของ)
// ===== เฟส 28: ลูกหนี้-เจ้าหนี้ =====
// เพิ่มยอดหนี้ (สะสมต่อชื่อ+ทิศทาง: ถ้ามีรายการเปิดอยู่แล้ว บวกเพิ่ม)
async function upsertDebt(accountId, direction, party, addAmount, note, date) {
  party = (party || '').trim();
  const { rows } = await pool.query(
    `SELECT * FROM debts WHERE account_id=$1 AND direction=$2 AND status='open' AND lower(party)=lower($3) ORDER BY id ASC LIMIT 1`,
    [accountId, direction, party]
  );
  if (rows[0]) {
    const r = rows[0];
    const newAmount = Number(r.amount) + Number(addAmount);
    await pool.query(`UPDATE debts SET amount=$2, note=COALESCE($3,note) WHERE id=$1`, [r.id, newAmount, note || null]);
    return { isNew: false, party, remaining: newAmount - Number(r.paid) };
  }
  await pool.query(
    `INSERT INTO debts (account_id, direction, party, amount, paid, note, status, created_date) VALUES ($1,$2,$3,$4,0,$5,'open',$6)`,
    [accountId, direction, party, Number(addAmount), note || null, date]
  );
  return { isNew: true, party, remaining: Number(addAmount) };
}

async function listDebts(accountId, direction) {
  const { rows } = await pool.query(
    `SELECT * FROM debts WHERE account_id=$1 AND direction=$2 AND status='open' ORDER BY created_at ASC`,
    [accountId, direction]
  );
  return rows.map(r => ({ ...r, remaining: Number(r.amount) - Number(r.paid) })).filter(r => r.remaining > 0.0001);
}

async function debtTotals(accountId) {
  const { rows } = await pool.query(`SELECT direction, amount, paid FROM debts WHERE account_id=$1 AND status='open'`, [accountId]);
  const t = { receivable: 0, receivableCount: 0, payable: 0, payableCount: 0 };
  for (const r of rows) {
    const rem = Number(r.amount) - Number(r.paid);
    if (rem <= 0.0001) continue;
    if (r.direction === 'receivable') { t.receivable += rem; t.receivableCount++; }
    else if (r.direction === 'payable') { t.payable += rem; t.payableCount++; }
  }
  return t;
}

// ชำระ/รับคืน: จ่ายตามชื่อ (payAmount=null => ปิดยอดที่เหลือทั้งหมด). คืนยอดที่ชำระจริง
async function settleDebt(accountId, direction, party, payAmount) {
  party = (party || '').trim();
  const { rows } = await pool.query(
    `SELECT * FROM debts WHERE account_id=$1 AND direction=$2 AND status='open' AND lower(party) LIKE lower($3) ORDER BY id ASC`,
    [accountId, direction, '%' + party + '%']
  );
  if (!rows.length) return { found: false };
  const fullName = rows[0].party;
  let toPay = payAmount == null ? Infinity : Number(payAmount);
  let applied = 0;
  for (const r of rows) {
    if (toPay <= 0.0001) break;
    const rem = Number(r.amount) - Number(r.paid);
    const pay = Math.min(rem, toPay);
    const newPaid = Number(r.paid) + pay;
    const settled = newPaid >= Number(r.amount) - 0.0001;
    await pool.query(`UPDATE debts SET paid=$2, status=$3, settled_date=$4 WHERE id=$1`,
      [r.id, newPaid, settled ? 'settled' : 'open', settled ? (r.created_date || null) : null]);
    applied += pay; toPay -= pay;
  }
  // ยอดคงเหลือของชื่อนี้หลังชำระ
  const after = await pool.query(
    `SELECT amount, paid FROM debts WHERE account_id=$1 AND direction=$2 AND status='open' AND lower(party) LIKE lower($3)`,
    [accountId, direction, '%' + party + '%']
  );
  const remaining = after.rows.reduce((s, r) => s + (Number(r.amount) - Number(r.paid)), 0);
  return { found: true, party: fullName, applied, remaining };
}

// ===== เฟส 29: สต๊อกวัตถุดิบ =====
function withLow(r) { const qty = Number(r.qty), th = Number(r.low_threshold); return { ...r, qty, low_threshold: th, low: th > 0 && qty <= th }; }

async function findStock(accountId, name) {
  const { rows } = await pool.query(`SELECT * FROM stock_items WHERE account_id=$1 AND lower(name)=lower($2) LIMIT 1`, [accountId, (name || '').trim()]);
  return rows[0] || null;
}
// ตั้งยอดคงเหลือ (upsert)
async function setStock(accountId, name, qty, unit) {
  name = (name || '').trim();
  const ex = await findStock(accountId, name);
  if (ex) {
    await pool.query(`UPDATE stock_items SET qty=$2, unit=COALESCE(NULLIF($3,''),unit), updated_at=now() WHERE id=$1`, [ex.id, Number(qty), unit || '']);
    return withLow({ ...ex, qty, unit: unit || ex.unit });
  }
  const { rows } = await pool.query(
    `INSERT INTO stock_items (account_id, name, unit, qty, low_threshold) VALUES ($1,$2,$3,$4,0) RETURNING *`,
    [accountId, name, unit || '', Number(qty)]);
  return withLow(rows[0]);
}
// เพิ่ม/ลดยอด (delta) — ถ้าไม่มีและ delta>0 สร้างใหม่
async function adjustStock(accountId, name, delta) {
  name = (name || '').trim();
  const ex = await findStock(accountId, name);
  if (!ex) {
    if (delta > 0) { const created = await setStock(accountId, name, delta, ''); return { found: true, item: created }; }
    return { found: false };
  }
  const newQty = Math.max(0, Number(ex.qty) + Number(delta));
  await pool.query(`UPDATE stock_items SET qty=$2, updated_at=now() WHERE id=$1`, [ex.id, newQty]);
  return { found: true, item: withLow({ ...ex, qty: newQty }) };
}
async function setThreshold(accountId, name, threshold) {
  name = (name || '').trim();
  const ex = await findStock(accountId, name);
  if (!ex) return { found: false };
  await pool.query(`UPDATE stock_items SET low_threshold=$2, updated_at=now() WHERE id=$1`, [ex.id, Number(threshold)]);
  return { found: true, item: withLow({ ...ex, low_threshold: threshold }) };
}
async function listStock(accountId) {
  const { rows } = await pool.query(`SELECT * FROM stock_items WHERE account_id=$1 ORDER BY name ASC`, [accountId]);
  const items = rows.map(withLow);
  items.sort((a, b) => (b.low - a.low) || a.name.localeCompare(b.name, 'th'));
  return items;
}
async function lowStock(accountId) {
  return (await listStock(accountId)).filter(r => r.low);
}
async function removeStock(accountId, name) {
  const ex = await findStock(accountId, name);
  if (!ex) return { found: false };
  await pool.query(`DELETE FROM stock_items WHERE id=$1`, [ex.id]);
  return { found: true, name: ex.name };
}
// เฟส 31: ตั้งต้นทุนต่อหน่วยของวัตถุดิบ
async function setStockCost(accountId, name, unitCost) {
  const ex = await findStock(accountId, name);
  if (!ex) return { found: false };
  await pool.query(`UPDATE stock_items SET unit_cost=$2, updated_at=now() WHERE id=$1`, [ex.id, Number(unitCost)]);
  return { found: true, item: withLow({ ...ex, unit_cost: unitCost }) };
}

// ===== เฟส 31: สูตรอาหาร =====
async function findRecipe(accountId, menuName) {
  menuName = (menuName || '').trim();
  if (!menuName) return null;
  const { rows } = await pool.query(`SELECT * FROM recipes WHERE account_id=$1`, [accountId]);
  const lm = menuName.toLowerCase();
  const exact = rows.find(r => (r.menu_name || '').toLowerCase() === lm);
  if (exact) return exact;
  // จับคู่แบบ contains (เผื่อ "ขายกะเพราหมู" -> "กะเพราหมู") เลือกชื่อที่ยาวสุด (ตรงสุด)
  const cands = rows
    .filter(r => { const rn = (r.menu_name || '').toLowerCase(); return rn && (lm.includes(rn) || rn.includes(lm)); })
    .sort((a, b) => (b.menu_name || '').length - (a.menu_name || '').length);
  return cands[0] || null;
}
async function getRecipeItems(recipeId) {
  const { rows } = await pool.query(`SELECT ingredient, qty, unit FROM recipe_items WHERE recipe_id=$1 ORDER BY id ASC`, [recipeId]);
  return rows.map(r => ({ ingredient: r.ingredient, qty: Number(r.qty), unit: r.unit || '' }));
}
async function setRecipe(accountId, menuName, items) {
  menuName = (menuName || '').trim();
  let rec = (await pool.query(`SELECT * FROM recipes WHERE account_id=$1 AND lower(menu_name)=lower($2) LIMIT 1`, [accountId, menuName])).rows[0];
  if (!rec) {
    rec = (await pool.query(`INSERT INTO recipes (account_id, menu_name) VALUES ($1,$2) RETURNING *`, [accountId, menuName])).rows[0];
  } else {
    await pool.query(`DELETE FROM recipe_items WHERE recipe_id=$1`, [rec.id]);
  }
  for (const it of items) {
    await pool.query(`INSERT INTO recipe_items (recipe_id, ingredient, qty, unit) VALUES ($1,$2,$3,$4)`,
      [rec.id, it.ingredient.trim(), Number(it.qty) || 0, (it.unit || '').trim()]);
  }
  return { menuName: rec.menu_name, items };
}
async function listRecipes(accountId) {
  const { rows } = await pool.query(`SELECT * FROM recipes WHERE account_id=$1 ORDER BY menu_name ASC`, [accountId]);
  const out = [];
  for (const r of rows) out.push({ menuName: r.menu_name, items: await getRecipeItems(r.id) });
  return out;
}
async function getRecipe(accountId, menuName) {
  const rec = await findRecipe(accountId, menuName);
  if (!rec) return null;
  return { menuName: rec.menu_name, items: await getRecipeItems(rec.id) };
}
async function deleteRecipe(accountId, menuName) {
  const rec = (await pool.query(`SELECT * FROM recipes WHERE account_id=$1 AND lower(menu_name)=lower($2) LIMIT 1`, [accountId, (menuName || '').trim()])).rows[0];
  if (!rec) return { found: false };
  await pool.query(`DELETE FROM recipe_items WHERE recipe_id=$1`, [rec.id]);
  await pool.query(`DELETE FROM recipes WHERE id=$1`, [rec.id]);
  return { found: true, menuName: rec.menu_name };
}
// ต้นทุนวัตถุดิบต่อ 1 จาน จากราคาต่อหน่วยในสต๊อก
async function recipeCost(accountId, items) {
  let cost = 0; const missing = [];
  for (const it of items) {
    const s = await findStock(accountId, it.ingredient);
    const uc = s ? Number(s.unit_cost) : 0;
    if (!s || uc <= 0) missing.push(it.ingredient);
    cost += uc * Number(it.qty);
  }
  return { cost, missing, complete: missing.length === 0 };
}
// ตัดสต๊อกตามสูตร เมื่อขายเมนูนั้น count จาน (คำนวณ JS, กัน pg-mem)
async function applySaleToStock(accountId, menuName, count) {
  const rec = await findRecipe(accountId, menuName);
  if (!rec) return null;
  const items = await getRecipeItems(rec.id);
  if (!items.length) return null;
  const n = Number(count) || 1;
  const deducted = []; const nowLow = []; let cost = 0;
  for (const it of items) {
    const used = Number(it.qty) * n;
    const s = await findStock(accountId, it.ingredient);
    if (s) {
      const newQty = Math.max(0, Number(s.qty) - used);
      await pool.query(`UPDATE stock_items SET qty=$2, updated_at=now() WHERE id=$1`, [s.id, newQty]);
      const low = Number(s.low_threshold) > 0 && newQty <= Number(s.low_threshold);
      if (low) nowLow.push(it.ingredient);
      cost += Number(s.unit_cost) * used;
      deducted.push({ ingredient: it.ingredient, used, unit: it.unit || s.unit || '', remaining: newQty, low });
    } else {
      deducted.push({ ingredient: it.ingredient, used, unit: it.unit || '', remaining: null, low: false, noStock: true });
    }
  }
  return { menuName: rec.menu_name, count: n, deducted, nowLow, cost };
}

// ===== เฟส 32: จัดการพนักงาน =====
async function findStaff(accountId, name) {
  name = (name || '').trim();
  if (!name) return null;
  const { rows } = await pool.query(`SELECT * FROM staff WHERE account_id=$1 AND active=1`, [accountId]);
  const ln = name.toLowerCase();
  return rows.find(r => (r.name || '').toLowerCase() === ln)
    || rows.filter(r => { const rn = (r.name || '').toLowerCase(); return rn && (ln.includes(rn) || rn.includes(ln)); })
         .sort((a, b) => (b.name || '').length - (a.name || '').length)[0]
    || null;
}
async function addStaff(accountId, name, dayWage) {
  name = (name || '').trim();
  const ex = await findStaff(accountId, name);
  if (ex && ex.name.toLowerCase() === name.toLowerCase()) {
    await pool.query(`UPDATE staff SET day_wage=$2 WHERE id=$1`, [ex.id, Number(dayWage)]);
    return { ...ex, day_wage: Number(dayWage), isNew: false };
  }
  const { rows } = await pool.query(`INSERT INTO staff (account_id, name, day_wage, active) VALUES ($1,$2,$3,1) RETURNING *`,
    [accountId, name, Number(dayWage)]);
  return { ...rows[0], isNew: true };
}
async function listStaff(accountId) {
  const { rows } = await pool.query(`SELECT * FROM staff WHERE account_id=$1 AND active=1 ORDER BY name ASC`, [accountId]);
  return rows.map(r => ({ ...r, day_wage: Number(r.day_wage) }));
}
async function removeStaff(accountId, name) {
  const ex = await findStaff(accountId, name);
  if (!ex) return { found: false };
  await pool.query(`DELETE FROM staff_logs WHERE staff_id=$1`, [ex.id]);
  await pool.query(`DELETE FROM staff WHERE id=$1`, [ex.id]);
  return { found: true, name: ex.name };
}
async function logStaff(accountId, staffId, kind, amount, note, date) {
  await pool.query(`INSERT INTO staff_logs (account_id, staff_id, kind, amount, note, log_date) VALUES ($1,$2,$3,$4,$5,$6)`,
    [accountId, staffId, kind, Number(amount), note || null, date]);
}
// สรุปยอดพนักงานคนเดียว: earned = วันทำงาน*ค่าแรง, owed = earned - เบิก - จ่ายแล้ว
async function staffSummary(accountId, staff) {
  const { rows } = await pool.query(`SELECT kind, amount FROM staff_logs WHERE staff_id=$1`, [staff.id]);
  let days = 0, advance = 0, paid = 0;
  for (const r of rows) {
    const a = Number(r.amount);
    if (r.kind === 'work') days += a;
    else if (r.kind === 'advance') advance += a;
    else if (r.kind === 'pay') paid += a;
  }
  const earned = days * Number(staff.day_wage);
  return { id: staff.id, name: staff.name, dayWage: Number(staff.day_wage), days, earned, advance, paid, owed: earned - advance - paid };
}
async function staffAllSummary(accountId) {
  const staff = await listStaff(accountId);
  const out = [];
  for (const s of staff) out.push(await staffSummary(accountId, s));
  return out;
}

async function accountOf(lineUserId) {
  const { rows } = await pool.query(`SELECT account_id FROM users WHERE line_user_id=$1`, [lineUserId]);
  return (rows[0] && rows[0].account_id) ? rows[0].account_id : lineUserId;
}
function genCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ตัด 0/O/1/I ออกกันสับสน
  let s = ''; for (let i = 0; i < 6; i++) s += ch[Math.floor(Math.random() * ch.length)];
  return s;
}
async function ensureInvite(ownerId) {
  const { rows } = await pool.query(`SELECT invite_code FROM users WHERE line_user_id=$1`, [ownerId]);
  if (rows[0] && rows[0].invite_code) return rows[0].invite_code;
  for (let i = 0; i < 6; i++) {
    const code = genCode();
    try {
      await pool.query(`UPDATE users SET invite_code=$2 WHERE line_user_id=$1`, [ownerId, code]);
      return code;
    } catch (e) { if (i === 5) throw e; } // ชนกัน (หายาก) ลองใหม่
  }
}
async function findByInvite(code) {
  const { rows } = await pool.query(
    `SELECT line_user_id, account_id FROM users WHERE invite_code=$1`, [String(code || '').toUpperCase()]
  );
  if (!rows[0]) return null;
  if (rows[0].account_id) return null;      // เจ้าของต้องไม่ใช่พนักงานของใคร (กันซ้อนชั้น)
  return rows[0].line_user_id;
}
async function joinShop(staffId, ownerId) {
  await pool.query(`UPDATE users SET account_id=$2 WHERE line_user_id=$1`, [staffId, ownerId]);
}
async function leaveShop(staffId) {
  await pool.query(`UPDATE users SET account_id=NULL WHERE line_user_id=$1`, [staffId]);
}
async function listShopMembers(ownerId) {
  const { rows } = await pool.query(
    `SELECT line_user_id, display_name FROM users WHERE account_id=$1 ORDER BY created_at ASC`, [ownerId]
  );
  return rows.map(r => ({ userId: r.line_user_id, name: r.display_name || '' }));
}
// นับพนักงานของเจ้าของ (ไว้กันเจ้าของไปเป็นพนักงานร้านอื่น)
async function countMembers(ownerId) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM users WHERE account_id=$1`, [ownerId]);
  return +rows[0].c;
}

async function getDailySummary(lineUserId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(daily_summary, TRUE) AS on FROM users WHERE line_user_id=$1`, [lineUserId]
  );
  return rows[0] ? !!rows[0].on : true;
}

// เฟส 13: รายจ่ายประจำ
async function createRecurring(lineUserId, { name, amount, day }) {
  const { rows } = await pool.query(
    `INSERT INTO recurring_expenses (line_user_id, name, amount, day_of_month)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [lineUserId, name, amount, Math.min(Math.max(day || 1, 1), 28)]
  );
  return +rows[0].id;
}
async function listRecurring(lineUserId) {
  const { rows } = await pool.query(
    `SELECT id, name, amount, day_of_month, active, last_run_ym
     FROM recurring_expenses WHERE line_user_id=$1 ORDER BY day_of_month ASC, id ASC`,
    [lineUserId]
  );
  return rows.map(r => ({ id: +r.id, name: r.name, amount: +r.amount, day: r.day_of_month, active: r.active, lastRun: r.last_run_ym }));
}
async function deleteRecurring(lineUserId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM recurring_expenses WHERE id=$1 AND line_user_id=$2`, [id, lineUserId]
  );
  return rowCount > 0;
}
async function toggleRecurring(lineUserId, id, active) {
  await pool.query(`UPDATE recurring_expenses SET active=$3 WHERE id=$1 AND line_user_id=$2`, [id, lineUserId, !!active]);
}
// รายการที่ยังไม่ได้ลงในเดือน ym (สำหรับ scheduler)
async function recurringToRun(ym) {
  const { rows } = await pool.query(
    `SELECT id, line_user_id, name, amount, day_of_month
     FROM recurring_expenses
     WHERE active = TRUE AND (last_run_ym IS NULL OR last_run_ym <> $1)`,
    [ym]
  );
  return rows.map(r => ({ id: +r.id, userId: r.line_user_id, name: r.name, amount: +r.amount, day: r.day_of_month }));
}
async function markRecurringRun(id, ym) {
  await pool.query(`UPDATE recurring_expenses SET last_run_ym=$2 WHERE id=$1`, [id, ym]);
}

// ผู้ใช้ที่เปิดแจ้งเตือน และมีรายการในวันที่กำหนด
async function activeUsersForDaily(dateStr) {
  const { rows } = await pool.query(
    `SELECT DISTINCT t.line_user_id
       FROM transactions t
       JOIN users u ON u.line_user_id = t.line_user_id
      WHERE t.txn_date = $1 AND COALESCE(u.daily_summary, TRUE) = TRUE`,
    [dateStr]
  );
  return rows.map(r => r.line_user_id);
}

// เฟส 15: ผู้ใช้ที่เพิ่งใช้งานช่วงนี้ แต่ "วันนี้ยังไม่ได้จด" (ไว้เตือนเบา ๆ)
async function usersToRemind(today, weekAgo, yesterday) {
  const { rows } = await pool.query(
    `SELECT u.line_user_id FROM users u
      WHERE COALESCE(u.daily_summary, TRUE) = TRUE
        AND EXISTS (SELECT 1 FROM transactions t WHERE t.line_user_id=u.line_user_id AND t.txn_date BETWEEN $2 AND $3)
        AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.line_user_id=u.line_user_id AND t.txn_date = $1)`,
    [today, weekAgo, yesterday]
  );
  return rows.map(r => r.line_user_id);
}

async function getState(k) {
  const { rows } = await pool.query(`SELECT v FROM bot_state WHERE k=$1`, [k]);
  return rows[0] ? rows[0].v : null;
}
async function setState(k, v) {
  await pool.query(
    `INSERT INTO bot_state (k, v) VALUES ($1, $2)
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, v]
  );
}

async function upsertUser(lineUserId, displayName) {
  await pool.query(
    `INSERT INTO users (line_user_id, display_name) VALUES ($1, $2)
     ON CONFLICT (line_user_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, users.display_name)`,
    [lineUserId, displayName || null]
  );
}

// ===== เฟส 35: ใบเสร็จ / ข้อมูลร้าน =====
async function getShopProfile(lineUserId) {
  const { rows } = await pool.query(`SELECT shop_name, shop_address, tax_id, vat_enabled, vat_rate FROM users WHERE line_user_id=$1`, [lineUserId]);
  const r = rows[0] || {};
  return { shopName: r.shop_name || '', address: r.shop_address || '', taxId: r.tax_id || '', vatEnabled: !!r.vat_enabled, vatRate: +r.vat_rate || 7 };
}
async function setShopProfile(lineUserId, field, value) {
  await upsertUser(lineUserId, null);
  const col = { name: 'shop_name', address: 'shop_address', taxid: 'tax_id' }[field];
  if (!col) return;
  await pool.query(`UPDATE users SET ${col}=$2 WHERE line_user_id=$1`, [lineUserId, value || null]);
}
async function lastIncomeTxn(accountUserId) {
  const { rows } = await pool.query(
    `SELECT id, amount, items, txn_date::text AS d, vat FROM transactions
      WHERE line_user_id=$1 AND type='income' ORDER BY created_at DESC LIMIT 1`,
    [accountUserId]
  );
  if (!rows[0]) return null;
  let items = null;
  try { items = rows[0].items ? (typeof rows[0].items === 'string' ? JSON.parse(rows[0].items) : rows[0].items) : null; } catch (e) {}
  return { id: rows[0].id, amount: +rows[0].amount, items, date: rows[0].d, vat: rows[0].vat };
}
async function createReceipt(accountId, { txnId, total, items, vatAmount, note, rdate }) {
  const seq = await pool.query(`SELECT COALESCE(MAX(receipt_no),0)+1 AS n FROM receipts WHERE account_id=$1`, [accountId]);
  const no = +seq.rows[0].n;
  const { rows } = await pool.query(
    `INSERT INTO receipts (account_id, receipt_no, txn_id, total, items, vat_amount, note, rdate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [accountId, no, txnId || null, total, items ? JSON.stringify(items) : null, vatAmount || 0, note || null, rdate]
  );
  return rows[0];
}
async function getReceipt(accountId, receiptNo) {
  const { rows } = await pool.query(`SELECT * FROM receipts WHERE account_id=$1 AND receipt_no=$2 LIMIT 1`, [accountId, receiptNo]);
  if (!rows[0]) return null;
  const r = rows[0];
  let items = null;
  try { items = r.items ? (typeof r.items === 'string' ? JSON.parse(r.items) : r.items) : null; } catch (e) {}
  return { ...r, items, total: +r.total, vat_amount: +r.vat_amount };
}

async function insertTxn(t) {
  const { lineUserId, type, amount, category, note, items, source, txnDate, vat } = t;
  const { rows } = await pool.query(
    `INSERT INTO transactions (line_user_id, type, amount, category, note, items, source, txn_date, vat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [lineUserId, type, amount, category || null, note || null, items ? JSON.stringify(items) : null, source || 'text', txnDate, vat ? 1 : 0]
  );
  return rows[0].id;
}

// ===== เฟส 34: ภาษีมูลค่าเพิ่ม (VAT) =====
async function getVatConfig(lineUserId) {
  const { rows } = await pool.query(`SELECT COALESCE(vat_enabled,FALSE) AS enabled, COALESCE(vat_rate,7) AS rate FROM users WHERE line_user_id=$1`, [lineUserId]);
  const r = rows[0] || {};
  return { enabled: !!r.enabled, rate: +r.rate || 7 };
}
async function setVatConfig(lineUserId, enabled, rate) {
  await upsertUser(lineUserId, null);
  if (rate == null) await pool.query(`UPDATE users SET vat_enabled=$2 WHERE line_user_id=$1`, [lineUserId, !!enabled]);
  else await pool.query(`UPDATE users SET vat_enabled=$2, vat_rate=$3 WHERE line_user_id=$1`, [lineUserId, !!enabled, +rate]);
  return getVatConfig(lineUserId);
}
// สรุป VAT รายเดือน — ราคาถือว่ารวมภาษีแล้ว (มาตรฐานค้าปลีกไทย)
async function vatSummary(lineUserId, ym) {
  const cfg = await getVatConfig(lineUserId);
  const rate = cfg.rate || 7;
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type='income'), 0) AS sales,
       COALESCE(SUM(amount) FILTER (WHERE type='expense' AND vat=1), 0) AS vatpur
     FROM transactions WHERE line_user_id=$1 AND to_char(txn_date,'YYYY-MM')=$2`,
    [lineUserId, ym]
  );
  const sales = +rows[0].sales, vatpur = +rows[0].vatpur;
  const outputVat = sales * rate / (100 + rate);
  const inputVat = vatpur * rate / (100 + rate);
  return { rate, sales, vatPurchases: vatpur, outputVat, inputVat, payable: outputVat - inputVat };
}

async function dayTotals(lineUserId, dateStr) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type='income'), 0)  AS income,
       COALESCE(SUM(amount) FILTER (WHERE type='expense'), 0) AS expense,
       COUNT(*) AS count
     FROM transactions WHERE line_user_id=$1 AND txn_date=$2`,
    [lineUserId, dateStr]
  );
  const r = rows[0];
  return { income: +r.income, expense: +r.expense, count: +r.count, profit: +r.income - +r.expense };
}

async function monthTotals(lineUserId, ym) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type='income'), 0)  AS income,
       COALESCE(SUM(amount) FILTER (WHERE type='expense'), 0) AS expense,
       COUNT(*) AS count
     FROM transactions WHERE line_user_id=$1 AND to_char(txn_date,'YYYY-MM')=$2`,
    [lineUserId, ym]
  );
  const r = rows[0];
  return { income: +r.income, expense: +r.expense, count: +r.count, profit: +r.income - +r.expense };
}

// รวมยอดในช่วงวันที่ [start, end] (สำหรับสรุปสัปดาห์)
async function rangeTotals(lineUserId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type='income'), 0)  AS income,
       COALESCE(SUM(amount) FILTER (WHERE type='expense'), 0) AS expense,
       COUNT(*) AS count
     FROM transactions WHERE line_user_id=$1 AND txn_date BETWEEN $2 AND $3`,
    [lineUserId, start, end]
  );
  const r = rows[0];
  return { income: +r.income, expense: +r.expense, count: +r.count, profit: +r.income - +r.expense };
}

async function listMenus(lineUserId) {
  const { rows } = await pool.query(
    `SELECT id, name, price, material_cost, labor_cost
     FROM menus WHERE line_user_id=$1 ORDER BY created_at ASC`,
    [lineUserId]
  );
  return rows.map(r => ({
    id: +r.id, name: r.name,
    price: +r.price, material_cost: +r.material_cost, labor_cost: +r.labor_cost,
  }));
}

async function createMenu(lineUserId, m) {
  const { rows } = await pool.query(
    `INSERT INTO menus (line_user_id, name, price, material_cost, labor_cost)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [lineUserId, m.name, m.price || 0, m.material_cost || 0, m.labor_cost || 0]
  );
  return rows[0].id;
}

async function updateMenu(lineUserId, id, m) {
  const { rowCount } = await pool.query(
    `UPDATE menus SET name=$3, price=$4, material_cost=$5, labor_cost=$6
     WHERE id=$1 AND line_user_id=$2`,
    [id, lineUserId, m.name, m.price || 0, m.material_cost || 0, m.labor_cost || 0]
  );
  return rowCount > 0;
}

async function deleteMenu(lineUserId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM menus WHERE id=$1 AND line_user_id=$2`, [id, lineUserId]
  );
  return rowCount > 0;
}

// ---- เฟส 3: dashboard ----
async function dailySeries(lineUserId, ym) {
  const { rows } = await pool.query(
    `SELECT txn_date::text AS d,
       COALESCE(SUM(amount) FILTER (WHERE type='income'),0)  AS income,
       COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS expense
     FROM transactions WHERE line_user_id=$1 AND to_char(txn_date,'YYYY-MM')=$2
     GROUP BY txn_date ORDER BY txn_date`,
    [lineUserId, ym]
  );
  return rows.map(r => ({ date: r.d, income: +r.income, expense: +r.expense }));
}

async function categoryBreakdown(lineUserId, ym, type = 'expense') {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(category,''),'อื่นๆ') AS category, SUM(amount) AS amount
     FROM transactions WHERE line_user_id=$1 AND to_char(txn_date,'YYYY-MM')=$2 AND type=$3
     GROUP BY 1 ORDER BY amount DESC`,
    [lineUserId, ym, type]
  );
  return rows.map(r => ({ category: r.category, amount: +r.amount }));
}

// เฟส 17: แยกรายได้ขายหน้าร้าน vs เดลิเวอรี่ (สำหรับงบกำไรขาดทุน)
async function incomeSplitForMonth(lineUserId, ym) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE COALESCE(category,'') LIKE 'ขายเดลิเวอรี่%'), 0) AS delivery,
       COALESCE(SUM(amount) FILTER (WHERE COALESCE(category,'') NOT LIKE 'ขายเดลิเวอรี่%'), 0) AS storefront
     FROM transactions WHERE line_user_id=$1 AND type='income' AND to_char(txn_date,'YYYY-MM')=$2`,
    [lineUserId, ym]
  );
  const r = rows[0];
  return { delivery: +r.delivery, storefront: +r.storefront };
}
async function categoryCompare(lineUserId, thisStart, thisEnd, prevStart, prevEnd) {
  const { rows } = await pool.query(
    `WITH cur AS (
       SELECT COALESCE(NULLIF(category,''),'อื่นๆ') cat, SUM(amount) amt
       FROM transactions WHERE line_user_id=$1 AND type='expense' AND txn_date BETWEEN $2 AND $3 GROUP BY 1
     ), prev AS (
       SELECT COALESCE(NULLIF(category,''),'อื่นๆ') cat, SUM(amount) amt
       FROM transactions WHERE line_user_id=$1 AND type='expense' AND txn_date BETWEEN $4 AND $5 GROUP BY 1
     )
     SELECT COALESCE(cur.cat, prev.cat) AS category,
            COALESCE(cur.amt, 0) AS cur,
            COALESCE(prev.amt, 0) AS prev
     FROM cur FULL OUTER JOIN prev ON cur.cat = prev.cat
     ORDER BY cur DESC`,
    [lineUserId, thisStart, thisEnd, prevStart, prevEnd]
  );
  return rows.map(r => ({ category: r.category, cur: +r.cur, prev: +r.prev }));
}

// เฟส 10: ดึงทุกรายการในเดือน (สำหรับ export)
async function txnsForMonth(lineUserId, ym) {
  const { rows } = await pool.query(
    `SELECT txn_date::text AS d, type, amount, category, note, source, created_at
       FROM transactions
      WHERE line_user_id=$1 AND to_char(txn_date,'YYYY-MM')=$2
      ORDER BY txn_date ASC, created_at ASC`,
    [lineUserId, ym]
  );
  return rows.map(r => ({
    date: r.d, type: r.type, amount: +r.amount,
    category: r.category || '', note: r.note || '', source: r.source || '',
  }));
}

// เฟส 27: สตรีค (จดติดต่อกันกี่วัน) — นับวันที่มีรายการต่อเนื่องถึงวันนี้/เมื่อวาน
async function currentStreak(lineUserId, today) {
  const { rows } = await pool.query(
    `SELECT DISTINCT txn_date::text AS d FROM transactions WHERE line_user_id=$1 ORDER BY d DESC LIMIT 400`,
    [lineUserId]
  );
  const set = new Set(rows.map(r => r.d));
  if (!set.size) return 0;
  const minus = (ds) => { const dt = new Date(ds + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); };
  let cur = today;
  if (!set.has(cur)) cur = minus(cur); // ยังไม่ขาด ถ้าวันนี้ยังไม่จด ให้เริ่มนับจากเมื่อวาน
  let streak = 0;
  while (set.has(cur)) { streak++; cur = minus(cur); }
  return streak;
}

async function recentTxns(lineUserId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, type, amount, category, note, txn_date::text AS d, created_at
     FROM transactions WHERE line_user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [lineUserId, limit]
  );
  return rows.map(r => ({
    id: +r.id, type: r.type, amount: +r.amount,
    category: r.category, note: r.note, date: r.d, created_at: r.created_at,
  }));
}

// เฟส 19: รายชื่อผู้ใช้สำหรับหน้า admin (พร้อมยอดใช้งาน)
async function listUsersAdmin(today) {
  const { rows } = await pool.query(
    `SELECT u.line_user_id, u.display_name, COALESCE(u.tier,'free') AS tier, u.tier_until::text AS until,
            u.created_at::date::text AS joined,
            (SELECT COUNT(*) FROM transactions t WHERE t.line_user_id=u.line_user_id) AS txns,
            (SELECT MAX(t.txn_date)::text FROM transactions t WHERE t.line_user_id=u.line_user_id) AS last_txn,
            COALESCE((SELECT ai_calls FROM usage_daily ud WHERE ud.line_user_id=u.line_user_id AND ud.usage_date=$1),0) AS ai_today
       FROM users u
      ORDER BY u.created_at DESC NULLS LAST
      LIMIT 500`,
    [today]
  );
  return rows.map(r => ({
    userId: r.line_user_id, name: r.display_name || '', tier: r.tier, until: r.until,
    joined: r.joined, txns: +r.txns, lastTxn: r.last_txn, aiToday: +r.ai_today,
    effective: (r.tier === 'pro' && (!r.until || r.until >= today)) ? 'pro' : 'free',
  }));
}

async function deleteTxn(lineUserId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM transactions WHERE id=$1 AND line_user_id=$2`, [id, lineUserId]
  );
  return rowCount > 0;
}

// แก้ไขรายการ (ประเภท/ยอด/หมวด/โน้ต)
async function updateTxn(lineUserId, id, { type, amount, category, note }) {
  const { rowCount } = await pool.query(
    `UPDATE transactions SET type=$3, amount=$4, category=$5, note=$6
     WHERE id=$1 AND line_user_id=$2`,
    [id, lineUserId, type, amount, category || null, note || null]
  );
  return rowCount > 0;
}

// เพิ่มตัวนับการเรียก AI ต่อผู้ใช้ต่อวัน แล้วคืนค่าจำนวนล่าสุด (atomic)
async function bumpUsage(lineUserId, dateStr) {
  const { rows } = await pool.query(
    `INSERT INTO usage_daily (line_user_id, usage_date, ai_calls) VALUES ($1,$2,1)
     ON CONFLICT (line_user_id, usage_date) DO UPDATE SET ai_calls = usage_daily.ai_calls + 1
     RETURNING ai_calls`,
    [lineUserId, dateStr]
  );
  return rows[0].ai_calls;
}

module.exports = {
  pool, init, upsertUser, insertTxn, dayTotals, monthTotals, rangeTotals,
  listMenus, createMenu, updateMenu, deleteMenu,
  dailySeries, categoryBreakdown, recentTxns, deleteTxn, updateTxn, currentStreak,
  bumpUsage, setDailySummary, activeUsersForDaily, usersToRemind, getState, setState,
  setGoal, getGoals, getDailySummary, categoryCompare, txnsForMonth,
  getVatConfig, setVatConfig, vatSummary,
  getShopProfile, setShopProfile, lastIncomeTxn, createReceipt, getReceipt,
  setCashFloat, getCashFloat, cashTotalsForDay, recurringMonthlyTotal, incomeSplitForMonth,
  getMembership, setMembership, usageToday, listUsersAdmin,
  accountOf, ensureInvite, findByInvite, joinShop, leaveShop, listShopMembers, countMembers,
  getOnboard, setOnboard,
  upsertDebt, listDebts, debtTotals, settleDebt,
  setStock, adjustStock, setThreshold, listStock, lowStock, removeStock, findStock,
  setStockCost, setRecipe, getRecipe, listRecipes, deleteRecipe, recipeCost, applySaleToStock,
  findStaff, addStaff, listStaff, removeStaff, logStaff, staffSummary, staffAllSummary,
  createRecurring, listRecurring, deleteRecurring, toggleRecurring, recurringToRun, markRecurringRun,
};
