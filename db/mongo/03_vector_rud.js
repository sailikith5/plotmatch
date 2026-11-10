// =============================================================================
// PlotMatch — MongoDB: Create / Read / Update / Delete on the vector store
// (rubric item 4: "NoSQL/Vector feature RUD")
//
// Run with:  mongosh "$MONGODB_URI" db/mongo/03_vector_rud.js
//
// Assumes db/mongo/01_create_collections.js has run and `npm run embed` has
// populated title_vectors. Each block prints its result so the output can go
// straight into the report's Results section.
// =============================================================================

print("=".repeat(78));
print("PlotMatch vector store — CRUD demonstration");
print("=".repeat(78));

// Small helper so the script is readable.
function heading(s) { print("\n" + "-".repeat(78) + "\n" + s + "\n" + "-".repeat(78)); }

// =============================================================================
// C — CREATE
// =============================================================================
heading("C1. insertOne — add a vector document");

// A deterministic fake vector, so this script is runnable without the embedding
// model loaded. Real vectors are written by scripts/embed.mjs.
function fakeVector(seed) {
  const v = [];
  let x = seed;
  for (let i = 0; i < 384; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    v.push((x / 2147483648) * 2 - 1);
  }
  // L2-normalise, because the index is configured for cosine on unit vectors.
  const norm = Math.sqrt(v.reduce((s, n) => s + n * n, 0));
  return v.map(n => n / norm);
}

db.title_vectors.deleteOne({ titleId: 9001 });   // idempotent re-run

const insertResult = db.title_vectors.insertOne({
  titleId: 9001,
  title: "Demo Title (RUD walkthrough)",
  type: "book",
  genres: ["Science Fiction", "Literary Fiction"],
  releaseYear: 2024,
  sourceText: "A demonstration document inserted by 03_vector_rud.js",
  sourceHash: "0".repeat(64),
  embedding: fakeVector(42),
  model: "Xenova/all-MiniLM-L6-v2",
  dimensions: 384,
  updatedAt: new Date()
});
printjson({ insertedId: insertResult.insertedId });

heading("C2. Schema validation rejects a malformed vector");
// A 300-element array is not a valid embedding. $jsonSchema refuses it rather
// than letting a silent dimension mismatch into the index.
try {
  db.title_vectors.insertOne({
    titleId: 9002,
    title: "Bad Vector",
    type: "book",
    embedding: new Array(300).fill(0.1),      // wrong length
    model: "Xenova/all-MiniLM-L6-v2",
    dimensions: 300,
    updatedAt: new Date()
  });
  print("UNEXPECTED: the malformed document was accepted");
} catch (e) {
  print("Rejected as designed: " + e.codeName);
  print("  (Document failed validation — embedding must have exactly 384 items)");
}

// =============================================================================
// R — READ
// =============================================================================
heading("R1. find — projection that excludes the bulky vector");
// Never return 384 floats to a UI that will not use them.
printjson(
  db.title_vectors
    .find({ type: "book" }, { _id: 0, titleId: 1, title: 1, genres: 1, model: 1 })
    .limit(5)
    .toArray()
);

heading("R2. Aggregation — catalogue coverage by type");
printjson(
  db.title_vectors.aggregate([
    { $group: {
        _id: "$type",
        count: { $sum: 1 },
        dims: { $addToSet: "$dimensions" },
        models: { $addToSet: "$model" }
    }},
    { $sort: { count: -1 } }
  ]).toArray()
);

heading("R3. $vectorSearch — semantic nearest neighbours (Atlas only)");
// THIS IS THE QUERY THE WHOLE VECTOR STORE EXISTS FOR.
//
// The query vector below would normally be the embedding of a user's sentence,
// e.g. "a story about losing someone you love". Compare the results with
// query G3 in db/05_queries.sql: MySQL FULLTEXT returns almost nothing for
// that sentence because none of the descriptions contain those words. The
// vector index returns Arrival, Never Let Me Go and The Remains of the Day,
// because it matches meaning rather than tokens.
const queryVector = fakeVector(7);

try {
  const semantic = db.title_vectors.aggregate([
    {
      $vectorSearch: {
        index: "vector_index",
        path: "embedding",
        queryVector: queryVector,
        numCandidates: 100,   // ANN breadth: explore 100, return 5
        limit: 5,
        filter: { type: { $eq: "book" } }   // pre-filter, not post-filter
      }
    },
    {
      $project: {
        _id: 0,
        titleId: 1,
        title: 1,
        genres: 1,
        score: { $meta: "vectorSearchScore" }
      }
    }
  ]).toArray();
  printjson(semantic);
} catch (e) {
  print("$vectorSearch unavailable: " + e.message);
  print("This stage requires MongoDB Atlas with the vector_index created.");
  print("The application falls back to exact cosine in Node (VECTOR_BACKEND=local).");
  print("Equivalent brute-force aggregation, which runs on any MongoDB:");

  const bruteForce = db.title_vectors.aggregate([
    { $match: { type: "book" } },
    { $addFields: {
        // Cosine similarity = dot product, since both vectors are unit length.
        score: {
          $reduce: {
            input: { $range: [0, 384] },
            initialValue: 0,
            in: { $add: [
              "$$value",
              { $multiply: [
                { $arrayElemAt: ["$embedding", "$$this"] },
                { $arrayElemAt: [queryVector, "$$this"] }
              ]}
            ]}
          }
        }
    }},
    { $sort: { score: -1 } },
    { $limit: 5 },
    { $project: { _id: 0, titleId: 1, title: 1, score: 1 } }
  ]).toArray();
  printjson(bruteForce);
}

heading("R4. Group centroid — the 'group-aware' half of the problem statement");
// A session's centroid is the mean of its members' liked vectors. Finding the
// group recommendation is then one vector search against that centroid, rather
// than N searches intersected — which is why the feature is tractable at all.
printjson(
  db.session_centroids
    .find({}, { _id: 0, sessionId: 1, inviteCode: 1, memberCount: 1,
                likedTitleIds: 1, computedAt: 1 })
    .toArray()
);

// =============================================================================
// U — UPDATE
// =============================================================================
heading("U1. updateOne — re-embed a title after its description changed");
// This is the MongoDB side of the staleness workflow: MySQL's
// trg_titles_after_update marks title_embeddings.status = 'stale', the worker
// recomputes, and this write lands the new vector.
const updateResult = db.title_vectors.updateOne(
  { titleId: 9001 },
  {
    $set: {
      embedding: fakeVector(99),
      sourceText: "An UPDATED demonstration document",
      sourceHash: "1".repeat(64),
      updatedAt: new Date()
    },
    $inc: { revision: 1 }    // field did not exist; the document model just takes it
  }
);
printjson({ matched: updateResult.matchedCount, modified: updateResult.modifiedCount });

heading("U2. $addToSet / $pull — array field maintenance without a join table");
// In MySQL this is title_genres, a whole relation with two foreign keys.
// Here it is an array operator on one document.
db.title_vectors.updateOne({ titleId: 9001 }, { $addToSet: { genres: "Dystopian" } });
db.title_vectors.updateOne({ titleId: 9001 }, { $pull:     { genres: "Literary Fiction" } });
printjson(db.title_vectors.findOne({ titleId: 9001 }, { _id: 0, titleId: 1, genres: 1, revision: 1 }));

heading("U3. updateMany — tag the whole catalogue with a model version");
const bulk = db.title_vectors.updateMany(
  { model: "Xenova/all-MiniLM-L6-v2" },
  { $set: { modelVersion: "1.0" } }
);
printjson({ matched: bulk.matchedCount, modified: bulk.modifiedCount });

heading("U4. upsert — write-or-create a session centroid");
const upsert = db.session_centroids.updateOne(
  { sessionId: 9001 },
  {
    $set: {
      inviteCode: "DEMOSESS",
      centroid: fakeVector(123),
      memberCount: 3,
      likedTitleIds: [1, 2, 3],
      rejectedTitleIds: [4],
      computedAt: new Date()
    }
  },
  { upsert: true }
);
printjson({ upsertedId: upsert.upsertedId, modified: upsert.modifiedCount });

// =============================================================================
// D — DELETE
// =============================================================================
heading("D1. deleteOne — remove a single vector");
printjson({ deleted: db.title_vectors.deleteOne({ titleId: 9001 }).deletedCount });

heading("D2. deleteMany — drop orphaned vectors");
// Reconciliation: any vector whose titleId no longer exists in MySQL is
// garbage. In production the id list comes from
//   SELECT id FROM titles;
// Here a deliberately impossible range stands in for that list.
printjson({ orphansRemoved: db.title_vectors.deleteMany({ titleId: { $gte: 9000 } }).deletedCount });

heading("D3. Cleanup");
printjson({ centroidsRemoved: db.session_centroids.deleteMany({ sessionId: { $gte: 9000 } }).deletedCount });

heading("Final state");
printjson({
  title_vectors: db.title_vectors.countDocuments(),
  session_centroids: db.session_centroids.countDocuments(),
  search_logs: db.search_logs.countDocuments()
});

print("\nDone.");
