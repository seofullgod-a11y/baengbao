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
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code TEXT;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite ON users (invite_code) WHERE invite_code IS NOT NULL;`);
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

// เฟส 20: เพิ่มพนักงาน (แชร์บัญชีร้าน)
// บัญชีข้อมูลของผู้ใช้คนนี้ = account_id (ถ้าเป็นพนักงาน) หรือ line_user_id ของตัวเอง (ถ้าเป็นเจ้าของ)
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

async function insertTxn(t) {
  const { lineUserId, type, amount, category, note, items, source, txnDate } = t;
  const { rows } = await pool.query(
    `INSERT INTO transactions (line_user_id, type, amount, category, note, items, source, txn_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [lineUserId, type, amount, category || null, note || null, items ? JSON.stringify(items) : null, source || 'text', txnDate]
  );
  return rows[0].id;
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
  dailySeries, categoryBreakdown, recentTxns, deleteTxn, updateTxn,
  bumpUsage, setDailySummary, activeUsersForDaily, usersToRemind, getState, setState,
  setGoal, getGoals, getDailySummary, categoryCompare, txnsForMonth,
  setCashFloat, getCashFloat, cashTotalsForDay, recurringMonthlyTotal, incomeSplitForMonth,
  getMembership, setMembership, usageToday, listUsersAdmin,
  accountOf, ensureInvite, findByInvite, joinShop, leaveShop, listShopMembers, countMembers,
  createRecurring, listRecurring, deleteRecurring, toggleRecurring, recurringToRun, markRecurringRun,
};
