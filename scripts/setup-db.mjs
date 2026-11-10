#!/usr/bin/env node
/**
 * Build the MySQL database from the numbered SQL files.
 *
 *   node scripts/setup-db.mjs             # schema + programmability + seed
 *   node scripts/setup-db.mjs --with-dcl  # also create the MySQL accounts
 *
 * Connects as MYSQL_ROOT_USER because CREATE DATABASE, CREATE TRIGGER and
 * GRANT are beyond what the application account is allowed to do — which is
 * the point of the privilege separation in db/06_rbac_dcl.sql.
 *
 * `multipleStatements: true` is set here and ONLY here. The application pool
 * in src/lib/mysql.js deliberately leaves it off: with it on, a single
 * injected semicolon turns one query into two.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const WITH_DCL = process.argv.includes('--with-dcl');

const FILES = [
  '01_schema.sql',
  '02_programmability.sql',
  '03_seed.sql',
  ...(WITH_DCL ? ['06_rbac_dcl.sql'] : []),
];

/**
 * Split a file on DELIMITER directives.
 *
 * DELIMITER is a mysql-CLI command, not SQL — the server has never heard of
 * it. Sending a file containing it straight to the driver is a syntax error,
 * which is the usual reason a trigger file "works in Workbench but not in
 * code". This splits the file into chunks and strips the directives.
 */
function splitOnDelimiter(sql) {
  const chunks = [];
  let current = [];
  let delimiter = ';';

  for (const line of sql.split('\n')) {
    const m = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
    if (m) {
      if (current.length) { chunks.push({ sql: current.join('\n'), delimiter }); current = []; }
      delimiter = m[1];
      continue;
    }
    current.push(line);
  }
  if (current.length) chunks.push({ sql: current.join('\n'), delimiter });

  // Statements separated by a custom delimiter must be sent one at a time.
  const statements = [];
  for (const chunk of chunks) {
    if (chunk.delimiter === ';') {
      statements.push(chunk.sql);
    } else {
      for (const stmt of chunk.sql.split(chunk.delimiter)) {
        if (stmt.trim()) statements.push(stmt);
      }
    }
  }
  // Drop chunks that are only whitespace and SQL comments.
  //
  // Written as a line scan, not a regex. The obvious pattern for this,
  // /^\s*(--.*\n?)*\s*$/, has a nested quantifier: on a long comment-heavy
  // file that fails to match, the engine backtracks exponentially and the
  // script hangs. These files are mostly comments, so it hangs every time.
  return statements.filter(stmt => {
    for (const line of stmt.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('--')) return true;
    }
    return false;
  });
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_ROOT_USER || 'root',
    password: process.env.MYSQL_ROOT_PASSWORD || '',
    multipleStatements: true,
  });

  console.log('Connected to MySQL as', process.env.MYSQL_ROOT_USER || 'root');

  for (const file of FILES) {
    const full = path.join('db', file);
    const sql = await fs.readFile(full, 'utf8');
    process.stdout.write(`\n${file} … `);

    const statements = splitOnDelimiter(sql);
    let ran = 0;
    for (const stmt of statements) {
      try {
        await conn.query(stmt);
        ran++;
      } catch (err) {
        console.error(`\n  FAILED in ${file}:\n  ${err.message}`);
        console.error(`  Statement began: ${stmt.trim().slice(0, 120)}…`);
        throw err;
      }
    }
    console.log(`${ran} statement(s) OK`);
  }

  // Report what was built, so a successful run is self-evidencing.
  await conn.query('USE plotmatch');
  const [[counts]] = await conn.query(`
    SELECT (SELECT COUNT(*) FROM users)   AS users,
           (SELECT COUNT(*) FROM titles)  AS titles,
           (SELECT COUNT(*) FROM genres)  AS genres,
           (SELECT COUNT(*) FROM ratings) AS ratings,
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM session_swipes) AS swipes,
           (SELECT COUNT(*) FROM roles)   AS roles,
           (SELECT COUNT(*) FROM permissions) AS permissions
  `);
  console.log('\nSeeded:', counts);

  // The triggers, not the seed file, produced these numbers.
  const [top] = await conn.query(
    `SELECT name, avg_rating, rating_count FROM titles
     WHERE rating_count > 0 ORDER BY avg_rating DESC, rating_count DESC LIMIT 5`
  );
  console.log('\nTop rated (computed by triggers, never written by the seed):');
  console.table(top);

  const [objects] = await conn.query(`
    SELECT 'views' AS kind, COUNT(*) AS n FROM information_schema.views
      WHERE table_schema = 'plotmatch'
    UNION ALL SELECT 'triggers', COUNT(*) FROM information_schema.triggers
      WHERE trigger_schema = 'plotmatch'
    UNION ALL SELECT 'procedures', COUNT(*) FROM information_schema.routines
      WHERE routine_schema = 'plotmatch' AND routine_type = 'PROCEDURE'
    UNION ALL SELECT 'functions', COUNT(*) FROM information_schema.routines
      WHERE routine_schema = 'plotmatch' AND routine_type = 'FUNCTION'
  `);
  console.log('\nDatabase objects:');
  console.table(objects);

  await conn.end();
  console.log('\nNext:');
  console.log('  1. mongosh "$MONGODB_URI" db/mongo/01_create_collections.js');
  console.log('  2. npm run embed');
  console.log('  3. npm run dev');
}

main().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
