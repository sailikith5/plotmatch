// =============================================================================
// The semantic layer: embeddings, similarity search, and group centroids.
//
// This is the file that makes "Semantic Discovery" in the project title mean
// something. Everything relational lives in MySQL; everything about *meaning*
// lives here and in MongoDB.
//
// TWO BACKENDS
//   VECTOR_BACKEND=atlas  -> MongoDB Atlas $vectorSearch (HNSW approximate
//                            nearest neighbour). What a production deployment
//                            would use; scales to millions of vectors.
//   VECTOR_BACKEND=local  -> exact cosine similarity computed in Node over
//                            every vector. O(n), but n is ~26 here, so it runs
//                            in single-digit milliseconds and returns the same
//                            ranking that ANN approximates.
//
// The local backend exists so the demonstration cannot fail because a cloud
// cluster is unreachable. Both paths return the identical shape, so nothing
// upstream knows or cares which ran.
// =============================================================================

import { titleVectors, sessionCentroids } from './mongo';

const BACKEND = (process.env.VECTOR_BACKEND || 'local').toLowerCase();
const MODEL = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
const DIMS = Number(process.env.EMBEDDING_DIMENSIONS || 384);

// -----------------------------------------------------------------------------
// Embedding
// -----------------------------------------------------------------------------

let extractorPromise = null;

/**
 * Lazily load the sentence-transformer. The model is ~90 MB and is downloaded
 * once, then cached on disk, so only the first call pays the cost. It is held
 * in a module-level promise so concurrent requests share one instance instead
 * of each loading their own copy into memory.
 */
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = './models';
      return pipeline('feature-extraction', MODEL);
    })();
  }
  return extractorPromise;
}

/**
 * Turn text into a unit-length vector.
 *
 * Mean pooling + L2 normalisation is what all-MiniLM-L6-v2 expects. Because
 * the output is normalised, cosine similarity reduces to a dot product, which
 * is why the local backend can be a single multiply-accumulate loop.
 */
export async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/** The exact text that gets embedded. Must match scripts/embed.mjs. */
export function buildSourceText({ name, type, releaseYear, genres, description }) {
  const parts = [
    name,
    type === 'book' ? 'book' : 'film',
    releaseYear ? `(${releaseYear})` : '',
    Array.isArray(genres) && genres.length ? genres.join(', ') : '',
    description || '',
  ];
  return parts.filter(Boolean).join('. ');
}

// -----------------------------------------------------------------------------
// Similarity maths
// -----------------------------------------------------------------------------

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalise(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map(x => x / n);
}

/**
 * Build a group taste vector.
 *
 * The centroid is the mean of the liked vectors, pulled away from the mean of
 * the rejected ones. The 0.3 weight on dislikes is deliberate and worth
 * defending in the viva: a rejection carries real but weaker information than
 * an endorsement — "not tonight" is not "never". Weighting them equally made
 * the centroid collapse toward the origin whenever a group disagreed, which
 * produced bland, low-similarity recommendations for exactly the groups that
 * most needed a tie-breaker.
 */
export function computeCentroid(likedVectors, rejectedVectors = [], dislikeWeight = 0.3) {
  if (!likedVectors.length) return null;

  const dims = likedVectors[0].length;
  const centroid = new Array(dims).fill(0);

  for (const v of likedVectors) {
    for (let i = 0; i < dims; i++) centroid[i] += v[i];
  }
  for (let i = 0; i < dims; i++) centroid[i] /= likedVectors.length;

  if (rejectedVectors.length) {
    const neg = new Array(dims).fill(0);
    for (const v of rejectedVectors) {
      for (let i = 0; i < dims; i++) neg[i] += v[i];
    }
    for (let i = 0; i < dims; i++) {
      centroid[i] -= dislikeWeight * (neg[i] / rejectedVectors.length);
    }
  }

  return normalise(centroid);
}

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

/**
 * Nearest neighbours to `queryVector`.
 *
 * @param {number[]} queryVector
 * @param {{type?: string, genres?: string[], excludeTitleIds?: number[], limit?: number}} opts
 * @returns {Promise<Array<{titleId:number,title:string,type:string,genres:string[],score:number}>>}
 */
export async function searchSimilar(queryVector, opts = {}) {
  const { type, genres, excludeTitleIds = [], limit = 10 } = opts;
  const col = await titleVectors();

  if (BACKEND === 'atlas') {
    const filter = {};
    if (type && type !== 'any') filter.type = { $eq: type };
    if (genres?.length) filter.genres = { $in: genres };

    const pipeline = [
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector,
          // Over-fetch candidates so that excluding already-seen titles does
          // not leave the caller short.
          numCandidates: Math.max(100, limit * 20),
          limit: limit + excludeTitleIds.length,
          ...(Object.keys(filter).length ? { filter } : {}),
        },
      },
      {
        $project: {
          _id: 0, titleId: 1, title: 1, type: 1, genres: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    const rows = await col.aggregate(pipeline).toArray();
    return rows
      .filter(r => !excludeTitleIds.includes(r.titleId))
      .slice(0, limit);
  }

  // --- local: exact cosine, computed in Node -------------------------------
  const mongoFilter = {};
  if (type && type !== 'any') mongoFilter.type = type;
  if (genres?.length) mongoFilter.genres = { $in: genres };
  if (excludeTitleIds.length) mongoFilter.titleId = { $nin: excludeTitleIds };

  const docs = await col
    .find(mongoFilter, { projection: { _id: 0, titleId: 1, title: 1, type: 1, genres: 1, embedding: 1 } })
    .toArray();

  return docs
    .map(d => ({
      titleId: d.titleId,
      title: d.title,
      type: d.type,
      genres: d.genres || [],
      // Shift cosine from [-1,1] to [0,1] so scores match the Atlas convention
      // and session_recs.match_score stays comparable across backends.
      score: (cosine(queryVector, d.embedding) + 1) / 2,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Free-text semantic search: embed the sentence, then find neighbours. */
export async function semanticSearch(queryText, opts = {}) {
  const vector = await embed(queryText);
  return searchSimilar(vector, opts);
}

// -----------------------------------------------------------------------------
// Group recommendation
// -----------------------------------------------------------------------------

/**
 * Compute and cache a session's centroid from its swipes.
 *
 * @param {number} sessionId
 * @param {string} inviteCode
 * @param {Array<{titleId:number, liked:boolean}>} swipes
 * @param {number} memberCount
 */
export async function buildSessionCentroid(sessionId, inviteCode, swipes, memberCount) {
  const col = await titleVectors();

  const likedIds = [...new Set(swipes.filter(s => s.liked).map(s => s.titleId))];
  const rejectedIds = [...new Set(swipes.filter(s => !s.liked).map(s => s.titleId))];

  if (!likedIds.length) return null;

  const docs = await col
    .find({ titleId: { $in: [...likedIds, ...rejectedIds] } },
          { projection: { _id: 0, titleId: 1, embedding: 1 } })
    .toArray();

  const byId = new Map(docs.map(d => [d.titleId, d.embedding]));
  const likedVectors = likedIds.map(id => byId.get(id)).filter(Boolean);
  const rejectedVectors = rejectedIds.map(id => byId.get(id)).filter(Boolean);

  if (!likedVectors.length) return null;

  const centroid = computeCentroid(likedVectors, rejectedVectors);

  const centroids = await sessionCentroids();
  await centroids.updateOne(
    { sessionId },
    {
      $set: {
        sessionId, inviteCode, centroid,
        memberCount,
        likedTitleIds: likedIds,
        rejectedTitleIds: rejectedIds,
        computedAt: new Date(),
      },
    },
    { upsert: true }
  );

  return centroid;
}

/**
 * Blend the semantic score with the relational agreement score.
 *
 * Neither signal is sufficient alone:
 *   - similarity alone recommends a title that matches the group's taste but
 *     that half of them have already swiped away;
 *   - agreement alone can only rank titles the group has *already seen*, so it
 *     can never surface anything new.
 *
 * The blend lets the vector store propose candidates nobody has voted on while
 * letting explicit votes dominate when they exist.
 */
export function blendScores(similarity, agreementPct, weight = 0.6) {
  const agreement = (agreementPct ?? 50) / 100;
  return weight * similarity + (1 - weight) * agreement;
}

export const vectorConfig = { backend: BACKEND, model: MODEL, dimensions: DIMS };
