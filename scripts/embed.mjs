#!/usr/bin/env node
/**
 * Build the vector store from the MySQL catalogue.
 *
 *   node scripts/embed.mjs                 # embed anything not ready
 *   node scripts/embed.mjs --stale-only    # only rows marked stale
 *   node scripts/embed.mjs --all           # re-embed everything
 *
 * This runs as a script rather than inside a request handler because loading
 * a 90 MB transformer model blocks the event loop for seconds. Next.js would
 * time out; a worker will not.
 *
 * The workflow it completes:
 *   trg_titles_after_insert  -> registers a title as 'pending'
 *   trg_titles_after_update  -> flips an edited title back to 'stale'
 *   this script              -> embeds, writes to MongoDB, marks 'ready'
 */

// Next.js loads .env.local automatically; a standalone script does not.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();                       // fall back to .env

import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
const STALE_ONLY = args.includes('--stale-only');
const ALL = args.includes('--all');

const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const DIMS = Number(process.env.EMBEDDING_DIMENSIONS || 384);

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Must match buildSourceText() in src/lib/vector.js, or hashes will not agree. */
function buildSourceText({ name, type, release_year, genres, description }) {
  return [
    name,
    type === 'book' ? 'book' : 'film',
    release_year ? `(${release_year})` : '',
    genres || '',
    description || '',
  ].filter(Boolean).join('. ');
}

async function main() {
  console.log(`PlotMatch embedding worker\n  model: ${MODEL} (${DIMS}d)`);

  const sql = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'plotmatch',
  });

  const mongo = new MongoClient(process.env.MONGODB_URI);
  await mongo.connect();
  const col = mongo.db(process.env.MONGODB_DB || 'plotmatch').collection('title_vectors');

  // Which titles need work?
  let statusClause = "AND (te.status IN ('pending', 'stale', 'failed') OR te.title_id IS NULL)";
  if (STALE_ONLY) statusClause = "AND te.status = 'stale'";
  if (ALL) statusClause = '';

  const [rows] = await sql.query(
    `SELECT t.id, t.name, t.type, t.release_year, t.description,
            GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR ', ') AS genres,
            te.status, te.source_hash
     FROM titles t
     LEFT JOIN title_embeddings te ON te.title_id = t.id
     LEFT JOIN title_genres tg ON tg.title_id = t.id
     LEFT JOIN genres       g  ON g.id = tg.genre_id
     WHERE t.is_archived = FALSE ${statusClause}
     GROUP BY t.id`
  );

  if (!rows.length) {
    console.log('Nothing to embed. Everything is up to date.');
    await sql.end();
    await mongo.close();
    return;
  }

  console.log(`  ${rows.length} title(s) to process\n`);

  // Load the model once, lazily — the first run downloads it to ./models.
  const { pipeline, env } = await import('@xenova/transformers');
  env.cacheDir = './models';
  console.log('Loading model (first run downloads ~90 MB)…');
  const extract = await pipeline('feature-extraction', MODEL);
  console.log('Model ready.\n');

  let embedded = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const sourceText = buildSourceText(row);
    const hash = sha256(sourceText);

    // Skip when the source text is byte-identical to what was embedded last
    // time. This is what makes re-runs cheap and why source_hash is stored.
    if (!ALL && row.source_hash === hash && row.status === 'ready') {
      skipped++;
      continue;
    }

    try {
      const out = await extract(sourceText, { pooling: 'mean', normalize: true });
      const embedding = Array.from(out.data);

      if (embedding.length !== DIMS) {
        throw new Error(`Model returned ${embedding.length} dimensions, expected ${DIMS}`);
      }

      const result = await col.updateOne(
        { titleId: row.id },
        {
          $set: {
            titleId: row.id,
            title: row.name,
            type: row.type,
            genres: row.genres ? row.genres.split(', ') : [],
            releaseYear: row.release_year ?? null,
            sourceText,
            sourceHash: hash,
            embedding,
            model: MODEL,
            dimensions: DIMS,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );

      const mongoId = result.upsertedId
        ? result.upsertedId.toString()
        : (await col.findOne({ titleId: row.id }, { projection: { _id: 1 } }))._id.toString();

      // Close the loop in MySQL so view_embedding_health is accurate.
      await sql.query(
        `INSERT INTO title_embeddings
            (title_id, model_name, dimensions, mongo_doc_id, status, source_hash, embedded_at)
         VALUES (?, ?, ?, ?, 'ready', ?, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
            model_name = ?, dimensions = ?, mongo_doc_id = ?,
            status = 'ready', source_hash = ?, embedded_at = CURRENT_TIMESTAMP`,
        [row.id, MODEL, DIMS, mongoId, hash, MODEL, DIMS, mongoId, hash]
      );

      embedded++;
      process.stdout.write(`  [${embedded}/${rows.length}] ${row.name}\n`);
    } catch (err) {
      failed++;
      console.error(`  FAILED ${row.name}: ${err.message}`);
      await sql.query(
        `INSERT INTO title_embeddings (title_id, model_name, dimensions, status)
         VALUES (?, ?, ?, 'failed')
         ON DUPLICATE KEY UPDATE status = 'failed'`,
        [row.id, MODEL, DIMS]
      );
    }
  }

  console.log(`\nDone. embedded: ${embedded}, unchanged: ${skipped}, failed: ${failed}`);

  const [[health]] = await sql.query('SELECT * FROM view_embedding_health');
  console.log(`Coverage: ${health.ready}/${health.total_titles} (${health.coverage_pct}%)`);

  await sql.end();
  await mongo.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
