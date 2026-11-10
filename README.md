# PlotMatch

**Group-aware semantic discovery for movies and books.**

A DBMS mini project (UE23CS351A). Everyone in a group swipes through candidate
titles; the system builds a taste vector for the group as a whole, finds titles
near it that nobody has seen yet, blends that with the votes already cast, and
produces one ranked shortlist.

Two databases, split along a real seam:

| | Owns | Why |
|---|---|---|
| **MySQL 8** | accounts, roles and permissions, catalogue, ratings, sessions, votes | Everything with a referential obligation or a multi-row invariant |
| **MongoDB Atlas** | 384-dimension title embeddings, group centroids, search analytics | Approximate-nearest-neighbour search, which no B-tree can accelerate |

`title_embeddings` in MySQL is the registry that keeps the two reconcilable.

---

## Quick start

```bash
git clone https://github.com/[YOUR-ORG]/plotmatch.git
cd plotmatch
npm install
cp .env.example .env.local      # then edit it — see below
```

Generate a session secret and paste it into `.env.local` as `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then build both databases and start the app:

```bash
npm run db:setup -- --with-dcl                          # MySQL: schema, routines, seed, accounts
mongosh "$MONGODB_URI" db/mongo/01_create_collections.js # MongoDB: collections and indexes
npm run embed                                            # build the vector store
npm run dev                                              # http://localhost:3000
```

`npm run embed` downloads a ~90 MB sentence-transformer on first run and caches
it in `./models`. No API key is needed and nothing is sent anywhere.

### Demo accounts

| Email | Password | Role |
|---|---|---|
| `admin@plotmatch.dev` | `Admin@123` | admin |
| `mod@plotmatch.dev` | `Mod@12345` | moderator |
| `sai@plotmatch.dev` | `Sai@12345` | user |
| `ravi@plotmatch.dev` | `Ravi@1234` | user |
| `neha@plotmatch.dev` | `Neha@1234` | user |

Two sessions are seeded: `MOVIE001` (everyone has voted — ready to finalise) and
`BOOKCLUB` (still open, one member yet to vote).

---

## No MongoDB Atlas cluster?

Set `VECTOR_BACKEND=local` in `.env.local` and point `MONGODB_URI` at a local
`mongod`. Similarity is then computed exactly in Node instead of through Atlas
`$vectorSearch`. At this catalogue size that takes single-digit milliseconds and
returns the same ranking the approximate index approximates — so the
demonstration works with no cloud dependency.

---

## Repository layout

```
db/                          SQL, run in numbered order
  01_schema.sql              DDL: tables, constraints, indexes
  02_programmability.sql     views, functions, procedures, triggers
  03_seed.sql                sample data + verification queries
  04_dml.sql                 INSERT / UPDATE / DELETE / TCL
  05_queries.sql             joins, nested, correlated, recursive, set operations
  06_rbac_dcl.sql            CREATE USER / GRANT / REVOKE
  mongo/                     collections, vector index, vector CRUD
docs/                        ER diagram, schema diagram, project report
scripts/                     setup-db.mjs, embed.mjs
src/lib/                     mysql, mongo, auth, rbac, vector
src/app/                     pages and API route handlers
middleware.js                edge auth gate
```

Run the SQL files in order. Each is standalone and each prints its own results,
so the output can be captured for the report:

```bash
mysql -u root -p --table plotmatch < db/04_dml.sql     > logs/dml.log
mysql -u root -p --table plotmatch < db/05_queries.sql > logs/queries.log
mongosh "$MONGODB_URI" db/mongo/03_vector_rud.js       > logs/vector_rud.log
```

---

## What the database does for itself

The schema is not a passive store. These rules hold no matter which client
writes the row:

- **A swipe must belong to a real membership.** `session_swipes` has a composite
  foreign key to `session_members(session_id, user_id)`, so an unjoined user
  cannot vote even by direct SQL.
- **Rating statistics maintain themselves.** `titles.avg_rating` and
  `rating_count` are written only by triggers, never by application code.
- **Cascades do not silently corrupt those statistics.** MySQL does not fire
  triggers for cascaded foreign-key actions, so deleting a user would remove
  their ratings without updating the affected titles. `trg_users_before_delete`
  deletes the child rows explicitly first, routing them through the normal
  DELETE path. `db/04_dml.sql` §3b contains a query that proves no drift remains.
- **A book cannot have a director.** A two-table rule, so it lives in a trigger
  rather than a CHECK constraint.
- **Editing a synopsis invalidates its vector.** `trg_titles_after_update` marks
  the embedding `stale`; `npm run embed:stale` picks up the queue.
- **Authorization is data.** Roles, permissions and their mapping are tables.
  `fn_user_has_permission` is the single predicate used by both the API and the
  stored procedures, so a permission can be revoked at runtime with no redeploy.

---

## Security

- Every query is parameterised through `mysql2`'s prepared statements. The
  application pool deliberately leaves `multipleStatements` **off**; only
  `scripts/setup-db.mjs` enables it, and only to load the schema files.
- Passwords are salted scrypt digests (`scrypt$N:r:p$salt$digest`), verified
  with a constant-time comparison.
- Sessions are HttpOnly, SameSite=Lax JWT cookies with a 12-hour lifetime.
- The app connects as `plotmatch_app`, which has no `DROP`, `ALTER` or `CREATE`
  privilege and cannot update or delete `audit_log`. A reporting account exists
  with column-level grants that exclude `email` and `password_hash`.
- Destructive and privilege-changing endpoints re-check permissions against the
  database rather than trusting the token, so a revocation takes effect before
  the token expires.

Change every password in `.env.example` and `db/06_rbac_dcl.sql` before running
this anywhere but localhost.

---

## Report

`docs/DBMS-Project-Report.docx` — includes the ER diagram, relational schema,
normalisation argument, DDL/DML/NoSQL listings, results, and the rubric
completion table.
