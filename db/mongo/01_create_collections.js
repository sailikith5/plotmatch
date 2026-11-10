// =============================================================================
// PlotMatch — MongoDB: collection creation and schema validation
//
// Run with:  mongosh "$MONGODB_URI" db/mongo/01_create_collections.js
//        or: mongosh mongodb://localhost:27017/plotmatch db/mongo/01_create_collections.js
//
// WHY MONGODB SITS ALONGSIDE MYSQL (technology justification, rubric item 2)
// -----------------------------------------------------------------------------
// MySQL is the system of record. Every fact with a referential obligation —
// who rated what, who is in which session, which role holds which permission —
// stays in MySQL, because those facts need foreign keys, multi-row
// transactions and constraints that fail loudly.
//
// An embedding has none of those properties. It is a 384-element float array
// with exactly one owner, it is derived (and therefore reproducible), and the
// operation performed on it is approximate nearest-neighbour search over a
// metric space. Expressed in MySQL that becomes either a 384-column table or a
// BLOB with a full scan and cosine computed in SQL for every query — O(n) per
// search, with no index that helps.
//
// MongoDB Atlas Vector Search indexes exactly this access pattern (HNSW), and
// its document model means the vector travels with the metadata needed to
// pre-filter it — type, genres, year — in a single round trip.
//
// The split is therefore along a real seam: MySQL owns truth and integrity,
// MongoDB owns similarity. title_embeddings in MySQL is the registry that
// keeps the two reconcilable, and trg_titles_after_update marks a vector
// 'stale' the moment its source text changes.
// =============================================================================

const dbName = db.getName();
print(`Creating PlotMatch collections in: ${dbName}`);

// -----------------------------------------------------------------------------
// 1. title_vectors — one document per catalogue title
// -----------------------------------------------------------------------------
// Schema validation is deliberate. "Schemaless" does not mean "unvalidated":
// a wrong-length vector is a silent correctness bug, because cosine similarity
// against a mismatched dimension either throws at query time or, worse,
// quietly returns nonsense. $jsonSchema makes the database reject it.
db.createCollection("title_vectors", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["titleId", "title", "type", "embedding", "model", "dimensions", "updatedAt"],
      properties: {
        titleId: {
          bsonType: "int",
          description: "Mirrors MySQL titles.id — the join key between the two stores"
        },
        title:       { bsonType: "string" },
        type:        { enum: ["movie", "book"] },
        genres:      { bsonType: "array", items: { bsonType: "string" } },
        releaseYear: { bsonType: ["int", "null"] },
        sourceText:  { bsonType: "string", description: "Exact text that was embedded" },
        sourceHash:  { bsonType: "string", description: "SHA-256 of sourceText, for staleness checks" },
        embedding: {
          bsonType: "array",
          minItems: 384,
          maxItems: 384,
          items: { bsonType: "double" },
          description: "384-dim unit vector from all-MiniLM-L6-v2"
        },
        model:       { bsonType: "string" },
        dimensions:  { bsonType: "int", minimum: 1, maximum: 4096 },
        updatedAt:   { bsonType: "date" }
      }
    }
  },
  validationLevel: "strict",
  validationAction: "error"
});

// titleId is the bridge to MySQL and must be unique.
db.title_vectors.createIndex({ titleId: 1 }, { unique: true, name: "uq_titleId" });
// Supports pre-filtered vector search ("science fiction books only").
db.title_vectors.createIndex({ type: 1, genres: 1 }, { name: "idx_type_genres" });
db.title_vectors.createIndex({ sourceHash: 1 }, { name: "idx_source_hash" });

// -----------------------------------------------------------------------------
// 2. session_centroids — the group taste vector
// -----------------------------------------------------------------------------
// The centroid is the mean of the vectors of the titles a session's members
// liked, minus a weighted pull away from the ones they rejected. Storing it
// means a session's recommendations can be recomputed without re-reading every
// swipe, and the TTL index below expires stale rooms automatically — a NoSQL
// capability with no clean relational equivalent.
db.createCollection("session_centroids", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["sessionId", "centroid", "memberCount", "computedAt"],
      properties: {
        sessionId:    { bsonType: "int", description: "Mirrors MySQL sessions.id" },
        inviteCode:   { bsonType: "string" },
        centroid:     { bsonType: "array", minItems: 384, maxItems: 384, items: { bsonType: "double" } },
        memberCount:  { bsonType: "int", minimum: 1 },
        likedTitleIds:   { bsonType: "array", items: { bsonType: "int" } },
        rejectedTitleIds:{ bsonType: "array", items: { bsonType: "int" } },
        computedAt:   { bsonType: "date" }
      }
    }
  }
});

db.session_centroids.createIndex({ sessionId: 1 }, { unique: true, name: "uq_sessionId" });
// TTL: a centroid is a cache of a live room. Expire it a week after it was
// last computed so abandoned sessions clean themselves up.
db.session_centroids.createIndex(
  { computedAt: 1 },
  { expireAfterSeconds: 604800, name: "ttl_computedAt" }
);

// -----------------------------------------------------------------------------
// 3. search_logs — free-shape analytics
// -----------------------------------------------------------------------------
// This collection shows the other half of why a document store earns its place:
// the payload shape differs per search type (semantic searches carry a vector
// and a score distribution, keyword searches carry a FULLTEXT relevance, group
// searches carry a member list). In MySQL that is either a sparse table full of
// NULLs or three tables; here it is one collection with a flexible `params`
// sub-document and no migration when a new search type is added.
db.createCollection("search_logs");
db.search_logs.createIndex({ userId: 1, at: -1 }, { name: "idx_user_recent" });
db.search_logs.createIndex({ kind: 1, at: -1 },   { name: "idx_kind_recent" });
db.search_logs.createIndex(
  { at: 1 },
  { expireAfterSeconds: 2592000, name: "ttl_30_days" }   // 30-day retention
);

print("Collections created:");
printjson(db.getCollectionNames());

print("\nIndexes on title_vectors:");
printjson(db.title_vectors.getIndexes().map(i => i.name));
print("Indexes on session_centroids:");
printjson(db.session_centroids.getIndexes().map(i => i.name));
print("Indexes on search_logs:");
printjson(db.search_logs.getIndexes().map(i => i.name));

print("\nNext: create the Atlas Vector Search index from db/mongo/02_vector_index.json,");
print("then run `npm run embed` to populate title_vectors.");
