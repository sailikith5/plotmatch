// =============================================================================
// MySQL connection pool.
//
// A module-level pool, cached on globalThis so Next.js's dev-mode hot reload
// does not open a new pool on every edit until MySQL refuses connections.
// =============================================================================

import mysql from 'mysql2/promise';

function createPool() {
  return mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'plotmatch',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Keep DECIMAL as a string through the driver, then convert explicitly.
    // Reading avg_rating as a float and writing it back is how rounding drift
    // gets into a rating column.
    decimalNumbers: false,
    timezone: 'Z',
    charset: 'utf8mb4_0900_ai_ci',
  });
}

const globalForMysql = globalThis;
export const pool = globalForMysql.__plotmatchPool ?? createPool();
if (process.env.NODE_ENV !== 'production') globalForMysql.__plotmatchPool = pool;

/**
 * Run a parameterised query.
 *
 * Every call site in this project passes values through `params`, never by
 * string concatenation. mysql2 sends them as bound parameters, so a value like
 * `'; DROP TABLE users; --` is treated as a string, not as SQL. This is the
 * project's primary defence against injection; the restricted GRANTs in
 * db/06_rbac_dcl.sql are the second layer.
 */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Convenience: first row or null. */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * Run a function inside a transaction, committing on success and rolling back
 * on any thrown error. The connection is always released.
 */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Call a stored procedure. mysql2 returns an array of result sets for CALL;
 * the final element is the OK packet, so the caller usually wants [0].
 */
export async function callProc(name, params = []) {
  const placeholders = params.map(() => '?').join(', ');
  const [sets] = await pool.query(`CALL ${name}(${placeholders})`, params);
  return sets;
}
