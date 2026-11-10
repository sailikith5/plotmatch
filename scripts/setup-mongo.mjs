#!/usr/bin/env node
/**
 * Create the MongoDB collections and indexes using the Node driver.
 *
 * db/mongo/01_create_collections.js does the same thing but needs the mongosh
 * shell installed. The `mongodb` driver is already a dependency of this
 * project, so this script removes that extra install from the setup path.
 * The mongosh version is kept because it is the artefact the report cites.
 *
 *   node scripts/setup-mongo.mjs
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'plotmatch';

if (!uri) {
  console.error('MONGODB_URI is not set. Copy .env.example to .env.local first.');
  process.exit(1);
}

const titleVectorValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['titleId', 'title', 'type', 'embedding', 'model', 'dimensions', 'updatedAt'],
    properties: {
      titleId:     { bsonType: 'int' },
      title:       { bsonType: 'string' },
      type:        { enum: ['movie', 'book'] },
      genres:      { bsonType: 'array', items: { bsonType: 'string' } },
      releaseYear: { bsonType: ['int', 'null'] },
      sourceText:  { bsonType: 'string' },
      sourceHash:  { bsonType: 'string' },
      embedding:   { bsonType: 'array', minItems: 384, maxItems: 384, items: { bsonType: 'double' } },
      model:       { bsonType: 'string' },
      dimensions:  { bsonType: 'int', minimum: 1, maximum: 4096 },
      updatedAt:   { bsonType: 'date' },
    },
  },
};

const centroidValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['sessionId', 'centroid', 'memberCount', 'computedAt'],
    properties: {
      sessionId:        { bsonType: 'int' },
      inviteCode:       { bsonType: 'string' },
      centroid:         { bsonType: 'array', minItems: 384, maxItems: 384, items: { bsonType: 'double' } },
      memberCount:      { bsonType: 'int', minimum: 1 },
      likedTitleIds:    { bsonType: 'array', items: { bsonType: 'int' } },
      rejectedTitleIds: { bsonType: 'array', items: { bsonType: 'int' } },
      computedAt:       { bsonType: 'date' },
    },
  },
};

/** createCollection throws if it already exists; collMod updates it instead. */
async function ensureCollection(db, name, validator) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length) {
    if (validator) {
      await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    }
    return 'updated';
  }
  await db.createCollection(name, validator
    ? { validator, validationLevel: 'strict', validationAction: 'error' }
    : {});
  return 'created';
}

async function main() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(dbName);

  console.log(`Connected to MongoDB, database: ${dbName}\n`);

  console.log('title_vectors      ', await ensureCollection(db, 'title_vectors', titleVectorValidator));
  await db.collection('title_vectors').createIndex({ titleId: 1 }, { unique: true, name: 'uq_titleId' });
  await db.collection('title_vectors').createIndex({ type: 1, genres: 1 }, { name: 'idx_type_genres' });
  await db.collection('title_vectors').createIndex({ sourceHash: 1 }, { name: 'idx_source_hash' });

  console.log('session_centroids  ', await ensureCollection(db, 'session_centroids', centroidValidator));
  await db.collection('session_centroids').createIndex({ sessionId: 1 }, { unique: true, name: 'uq_sessionId' });
  await db.collection('session_centroids').createIndex(
    { computedAt: 1 }, { expireAfterSeconds: 604800, name: 'ttl_computedAt' });

  console.log('search_logs        ', await ensureCollection(db, 'search_logs', null));
  await db.collection('search_logs').createIndex({ userId: 1, at: -1 }, { name: 'idx_user_recent' });
  await db.collection('search_logs').createIndex({ kind: 1, at: -1 }, { name: 'idx_kind_recent' });
  await db.collection('search_logs').createIndex({ at: 1 }, { expireAfterSeconds: 2592000, name: 'ttl_30_days' });

  console.log('\nIndexes:');
  for (const c of ['title_vectors', 'session_centroids', 'search_logs']) {
    const names = (await db.collection(c).indexes()).map(i => i.name);
    console.log(`  ${c.padEnd(18)} ${names.join(', ')}`);
  }

  console.log('\nDone. Next: npm run embed');
  await client.close();
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  if (/ECONNREFUSED|serverSelection/i.test(err.message)) {
    console.error('MongoDB does not appear to be running. Start it, or set MONGODB_URI to an Atlas cluster.');
  }
  process.exit(1);
});
