// =============================================================================
// MongoDB client.
//
// Same globalThis caching rationale as mysql.js: without it, Next.js dev-mode
// reloads leak a connection pool per edit.
// =============================================================================

import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'plotmatch';

if (!uri) {
  throw new Error('MONGODB_URI is not set. Copy .env.example to .env.local.');
}

const globalForMongo = globalThis;

function createClient() {
  return new MongoClient(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
}

/** @type {Promise<MongoClient>} */
export const clientPromise =
  globalForMongo.__plotmatchMongo ?? createClient().connect();

if (process.env.NODE_ENV !== 'production') {
  globalForMongo.__plotmatchMongo = clientPromise;
}

export async function getDb() {
  const client = await clientPromise;
  return client.db(dbName);
}

export async function titleVectors() {
  return (await getDb()).collection('title_vectors');
}

export async function sessionCentroids() {
  return (await getDb()).collection('session_centroids');
}

export async function searchLogs() {
  return (await getDb()).collection('search_logs');
}
