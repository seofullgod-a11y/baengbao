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
  console.log('[db] schema ready');
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

async function deleteTxn(lineUserId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM transactions WHERE id=$1 AND line_user_id=$2`, [id, lineUserId]
  );
  return rowCount > 0;
}

module.exports = {
  pool, init, upsertUser, insertTxn, dayTotals, monthTotals,
  listMenus, createMenu, updateMenu, deleteMenu,
  dailySeries, categoryBreakdown, recentTxns, deleteTxn,
};
