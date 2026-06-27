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

module.exports = { pool, init, upsertUser, insertTxn, dayTotals, monthTotals };
