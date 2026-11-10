-- =============================================================================
-- PlotMatch — File 5 of 6 : Query showcase (rubric items 3 and 4)
--
--   Section A — Joins (inner, left, right, self, cross, multi-way)
--   Section B — Nested (non-correlated) subqueries
--   Section C — Correlated subqueries
--   Section D — Set operations
--   Section E — CTEs, recursive CTEs, window functions
--   Section F — Aggregation with GROUP BY / HAVING / ROLLUP
--   Section G — Full-text search (the keyword baseline the vector index beats)
--
-- Run with:  mysql -u root -p --table plotmatch < db/05_queries.sql > logs/queries.log
-- =============================================================================

USE plotmatch;

-- =============================================================================
-- SECTION A — JOINS
-- =============================================================================

-- A1. INNER JOIN (three-way): every title with its director/author.
SELECT t.name AS title, t.type, p.name AS creator, tp.role
FROM titles t
INNER JOIN title_people tp ON tp.title_id = t.id
INNER JOIN people       p  ON p.id = tp.person_id
WHERE tp.role IN ('director', 'author')
ORDER BY t.type, t.name;

-- A2. LEFT JOIN: the catalogue including titles nobody has rated.
--     The NULL columns are the point — an INNER JOIN would hide these rows.
SELECT t.name, t.type, COUNT(r.id) AS reviews, COALESCE(ROUND(AVG(r.score), 2), 0) AS mean_score
FROM titles t
LEFT JOIN ratings r ON r.title_id = t.id
GROUP BY t.id, t.name, t.type
ORDER BY reviews ASC, t.name
LIMIT 15;

-- A3. RIGHT JOIN: genres that currently have no titles attached.
--     Written as a RIGHT JOIN deliberately, to show the mirrored form.
SELECT g.name AS genre, COUNT(tg.title_id) AS titles_in_genre
FROM title_genres tg
RIGHT JOIN genres g ON g.id = tg.genre_id
GROUP BY g.id, g.name
ORDER BY titles_in_genre ASC, g.name;

-- A4. SELF JOIN: pairs of users who both liked the same title in the same
--     session. u1.id < u2.id stops each pair appearing twice and stops a user
--     being paired with themselves.
SELECT s.invite_code,
       t.name AS agreed_on,
       u1.name AS member_a,
       u2.name AS member_b
FROM session_swipes sw1
JOIN session_swipes sw2
      ON sw1.session_id = sw2.session_id
     AND sw1.title_id   = sw2.title_id
     AND sw1.user_id    < sw2.user_id
JOIN users    u1 ON u1.id = sw1.user_id
JOIN users    u2 ON u2.id = sw2.user_id
JOIN titles   t  ON t.id  = sw1.title_id
JOIN sessions s  ON s.id  = sw1.session_id
WHERE sw1.liked = TRUE AND sw2.liked = TRUE
ORDER BY s.invite_code, t.name;

-- A5. CROSS JOIN: the full role-by-permission grid, showing which cells are
--     granted. This is the RBAC matrix that goes in the report.
SELECT r.name AS role,
       p.code AS permission,
       IF(rp.role_id IS NULL, 'no', 'YES') AS granted
FROM roles r
CROSS JOIN permissions p
LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_id = p.id
ORDER BY r.name, p.code;

-- =============================================================================
-- SECTION B — NESTED (NON-CORRELATED) SUBQUERIES
-- =============================================================================

-- B1. Scalar subquery in WHERE: titles rated above the global mean.
SELECT name, avg_rating, rating_count
FROM titles
WHERE rating_count > 0
  AND avg_rating > (SELECT AVG(score) FROM ratings)
ORDER BY avg_rating DESC;

-- B2. Subquery with IN: everything written or directed by anyone who has
--     worked on more than one title in the catalogue.
SELECT DISTINCT t.name, p.name AS creator
FROM titles t
JOIN title_people tp ON tp.title_id = t.id
JOIN people       p  ON p.id = tp.person_id
WHERE p.id IN (
    SELECT person_id FROM title_people GROUP BY person_id HAVING COUNT(DISTINCT title_id) > 1
)
ORDER BY p.name, t.name;

-- B3. Derived table (subquery in FROM): per-user rating behaviour, filtered.
--     Note: MySQL only permits a derived table inside a view from 5.7.7
--     onward; both this query and view_top_rated_by_genre rely on that.
SELECT stats.user_name, stats.reviews, stats.mean_score, stats.generosity
FROM (
    SELECT u.name AS user_name,
           COUNT(*) AS reviews,
           ROUND(AVG(r.score), 2) AS mean_score,
           CASE WHEN AVG(r.score) >= 4.5 THEN 'very generous'
                WHEN AVG(r.score) >= 4.0 THEN 'generous'
                WHEN AVG(r.score) >= 3.5 THEN 'balanced'
                ELSE 'harsh' END AS generosity
    FROM users u JOIN ratings r ON r.user_id = u.id
    GROUP BY u.id, u.name
) stats
WHERE stats.reviews >= 3
ORDER BY stats.mean_score DESC;

-- B4. Subquery with ALL: the single highest-rated title, without ORDER BY.
SELECT name, avg_rating
FROM titles
WHERE rating_count > 0
  AND avg_rating >= ALL (SELECT avg_rating FROM titles WHERE rating_count > 0);

-- =============================================================================
-- SECTION C — CORRELATED SUBQUERIES
--   The inner query references the outer row, so it is re-evaluated per row.
-- =============================================================================

-- C1. Correlated scalar subquery: each title beside its own genre's average.
SELECT t.name,
       g.name AS genre,
       t.avg_rating,
       (SELECT ROUND(AVG(t2.avg_rating), 2)
        FROM titles t2
        JOIN title_genres tg2 ON tg2.title_id = t2.id
        WHERE tg2.genre_id = tg.genre_id
          AND t2.rating_count > 0) AS genre_average
FROM titles t
JOIN title_genres tg ON tg.title_id = t.id
JOIN genres       g  ON g.id = tg.genre_id
WHERE t.rating_count > 0
ORDER BY g.name, t.avg_rating DESC;

-- C2. Correlated EXISTS: users who have rated at least one book AND one movie.
SELECT u.name, u.email
FROM users u
WHERE EXISTS (SELECT 1 FROM ratings r JOIN titles t ON t.id = r.title_id
              WHERE r.user_id = u.id AND t.type = 'book')
  AND EXISTS (SELECT 1 FROM ratings r JOIN titles t ON t.id = r.title_id
              WHERE r.user_id = u.id AND t.type = 'movie')
ORDER BY u.name;

-- C3. Correlated NOT EXISTS: members who have joined a session but not yet
--     swiped on anything. This is exactly the "who are we waiting for?"
--     query the session room shows.
SELECT s.invite_code, u.name AS waiting_on
FROM session_members sm
JOIN sessions s ON s.id = sm.session_id
JOIN users    u ON u.id = sm.user_id
WHERE s.status = 'open'
  AND NOT EXISTS (
      SELECT 1 FROM session_swipes sw
      WHERE sw.session_id = sm.session_id AND sw.user_id = sm.user_id
  )
ORDER BY s.invite_code, u.name;

-- C4. Correlated subquery in SELECT: each user's most generously rated title.
SELECT u.name AS user_name,
       (SELECT t.name FROM ratings r JOIN titles t ON t.id = r.title_id
        WHERE r.user_id = u.id
        ORDER BY r.score DESC, t.name ASC LIMIT 1) AS favourite_title
FROM users u
WHERE EXISTS (SELECT 1 FROM ratings r WHERE r.user_id = u.id)
ORDER BY u.name;

-- =============================================================================
-- SECTION D — SET OPERATIONS
-- =============================================================================

-- D1. UNION: a single "activity feed" of everything a user has engaged with.
SELECT 'rated' AS activity, t.name AS title, r.created_at AS at_time
FROM ratings r JOIN titles t ON t.id = r.title_id
WHERE r.user_id = (SELECT id FROM users WHERE email = 'sai@plotmatch.dev')
UNION
SELECT 'watchlisted', t.name, w.added_at
FROM watchlist w JOIN titles t ON t.id = w.title_id
WHERE w.user_id = (SELECT id FROM users WHERE email = 'sai@plotmatch.dev')
ORDER BY at_time DESC;

-- D2. UNION ALL preserves duplicates; UNION removes them. Compare the counts:
SELECT 'union_all' AS variant, COUNT(*) AS rows_returned FROM (
    SELECT title_id FROM ratings   WHERE user_id = 3
    UNION ALL
    SELECT title_id FROM watchlist WHERE user_id = 3
) x
UNION ALL
SELECT 'union_distinct', COUNT(*) FROM (
    SELECT title_id FROM ratings   WHERE user_id = 3
    UNION
    SELECT title_id FROM watchlist WHERE user_id = 3
) y;

-- D3. INTERSECT — titles that BOTH Sai and Ravi have rated.
--     Requires MySQL 8.0.31+. The portable equivalent is below.
SELECT t.name FROM titles t JOIN ratings r ON r.title_id = t.id
WHERE r.user_id = (SELECT id FROM users WHERE email = 'sai@plotmatch.dev')
INTERSECT
SELECT t.name FROM titles t JOIN ratings r ON r.title_id = t.id
WHERE r.user_id = (SELECT id FROM users WHERE email = 'ravi@plotmatch.dev');

-- D3b. Portable INTERSECT (any MySQL 8 version) — same result via INNER JOIN:
SELECT t.name
FROM titles t
JOIN ratings r1 ON r1.title_id = t.id AND r1.user_id = (SELECT id FROM users WHERE email='sai@plotmatch.dev')
JOIN ratings r2 ON r2.title_id = t.id AND r2.user_id = (SELECT id FROM users WHERE email='ravi@plotmatch.dev');

-- D4. EXCEPT — on Sai's watchlist but not yet rated by him. (MySQL 8.0.31+)
SELECT t.name FROM watchlist w JOIN titles t ON t.id = w.title_id
WHERE w.user_id = (SELECT id FROM users WHERE email = 'sai@plotmatch.dev')
EXCEPT
SELECT t.name FROM ratings r JOIN titles t ON t.id = r.title_id
WHERE r.user_id = (SELECT id FROM users WHERE email = 'sai@plotmatch.dev');

-- D4b. Portable EXCEPT — same result via LEFT JOIN ... IS NULL:
SELECT t.name
FROM watchlist w
JOIN titles t ON t.id = w.title_id
LEFT JOIN ratings r ON r.title_id = t.id AND r.user_id = w.user_id
WHERE w.user_id = (SELECT id FROM users WHERE email = 'sai@plotmatch.dev')
  AND r.id IS NULL;

-- =============================================================================
-- SECTION E — CTEs, RECURSIVE CTEs, WINDOW FUNCTIONS
-- =============================================================================

-- E1. Simple CTE: readable multi-stage aggregation.
WITH genre_stats AS (
    SELECT g.id, g.name,
           COUNT(DISTINCT t.id) AS title_count,
           ROUND(AVG(t.avg_rating), 2) AS mean_rating
    FROM genres g
    JOIN title_genres tg ON tg.genre_id = g.id
    JOIN titles       t  ON t.id = tg.title_id
    WHERE t.rating_count > 0
    GROUP BY g.id, g.name
),
busy_genres AS (
    SELECT * FROM genre_stats WHERE title_count >= 2
)
SELECT name AS genre, title_count, mean_rating
FROM busy_genres
ORDER BY mean_rating DESC;

-- E2. Multiple CTEs feeding a window function: rank each user's own ratings.
WITH user_ratings AS (
    SELECT u.name AS user_name, t.name AS title, r.score, t.type
    FROM ratings r
    JOIN users  u ON u.id = r.user_id
    JOIN titles t ON t.id = r.title_id
)
SELECT user_name, title, type, score,
       ROW_NUMBER() OVER (PARTITION BY user_name ORDER BY score DESC, title) AS rn,
       DENSE_RANK() OVER (PARTITION BY user_name ORDER BY score DESC)        AS score_rank,
       ROUND(AVG(score) OVER (PARTITION BY user_name), 2)                    AS user_mean,
       score - ROUND(AVG(score) OVER (PARTITION BY user_name), 2)            AS vs_own_mean
FROM user_ratings
ORDER BY user_name, rn;

-- E3. RECURSIVE CTE — degrees of separation between titles.
--
--     Two titles are one step apart if they share a person (director, author
--     or actor). This walks that graph outward from a seed title up to three
--     hops, which is the "because you liked X" fallback the app uses when a
--     user has too little history for the vector model to be useful.
--
--     `visited` accumulates the ids already on the path, and the INSTR guard
--     stops the recursion looping back — without it this query would not
--     terminate, because the co-credit graph is undirected and cyclic.
WITH RECURSIVE title_graph AS (
    -- Anchor member: the seed title, at depth 0.
    SELECT t.id                                   AS title_id,
           0                                      AS depth,
           CAST(CONCAT('|', t.id, '|') AS CHAR(500)) AS visited
    FROM titles t
    WHERE t.name = 'Children of Men'

    UNION ALL

    -- Recursive member: step to any title sharing a person with the current one.
    SELECT t2.id,
           g.depth + 1,
           CONCAT(g.visited, t2.id, '|')
    FROM title_graph g
    JOIN title_people tp1 ON tp1.title_id  = g.title_id
    JOIN title_people tp2 ON tp2.person_id = tp1.person_id
    JOIN titles       t2  ON t2.id = tp2.title_id
    WHERE g.depth < 3
      AND INSTR(g.visited, CONCAT('|', t2.id, '|')) = 0
)
SELECT MIN(g.depth) AS degrees_of_separation,
       t.name       AS title,
       t.avg_rating
FROM title_graph g
JOIN titles t ON t.id = g.title_id
WHERE g.depth > 0
GROUP BY t.id, t.name, t.avg_rating
ORDER BY degrees_of_separation, t.name;

-- E4. RECURSIVE CTE — generate a dense date spine so a reporting chart has a
--     row for every day, including days with no activity.
WITH RECURSIVE date_spine AS (
    SELECT CURDATE() - INTERVAL 13 DAY AS d
    UNION ALL
    SELECT d + INTERVAL 1 DAY FROM date_spine WHERE d < CURDATE()
)
SELECT ds.d AS day, COUNT(r.id) AS ratings_submitted
FROM date_spine ds
LEFT JOIN ratings r ON DATE(r.created_at) = ds.d
GROUP BY ds.d
ORDER BY ds.d;

-- E5. Window function with a frame: running total of reviews over time.
SELECT DATE(r.created_at) AS day,
       COUNT(*) AS reviews_that_day,
       SUM(COUNT(*)) OVER (ORDER BY DATE(r.created_at)
                           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM ratings r
GROUP BY DATE(r.created_at)
ORDER BY day;

-- E6. LAG / LEAD: compare each title's rating to the next one down the ranking.
SELECT name, avg_rating,
       LAG(avg_rating)  OVER (ORDER BY avg_rating DESC) AS rating_above,
       LEAD(avg_rating) OVER (ORDER BY avg_rating DESC) AS rating_below,
       ROUND(avg_rating - LEAD(avg_rating) OVER (ORDER BY avg_rating DESC), 2) AS gap_to_next
FROM titles
WHERE rating_count > 1
ORDER BY avg_rating DESC;

-- E7. The Bayesian re-ranking from fn_title_bayesian_score. A single 5-star
--     rating should not outrank a title with many strong ratings; compare the
--     two orderings side by side.
SELECT t.name,
       t.avg_rating AS raw_mean,
       t.rating_count AS votes,
       fn_title_bayesian_score(t.id, 5) AS shrunk_score,
       RANK() OVER (ORDER BY t.avg_rating DESC)                  AS rank_by_raw,
       RANK() OVER (ORDER BY fn_title_bayesian_score(t.id, 5) DESC) AS rank_by_shrunk
FROM titles t
WHERE t.rating_count > 0
ORDER BY shrunk_score DESC;

-- =============================================================================
-- SECTION F — AGGREGATION
-- =============================================================================

-- F1. GROUP BY with HAVING: genres whose mean rating clears 4.0.
SELECT g.name AS genre,
       COUNT(DISTINCT t.id) AS titles,
       ROUND(AVG(t.avg_rating), 2) AS mean_rating
FROM genres g
JOIN title_genres tg ON tg.genre_id = g.id
JOIN titles       t  ON t.id = tg.title_id
WHERE t.rating_count > 0
GROUP BY g.id, g.name
HAVING AVG(t.avg_rating) > 4.0
ORDER BY mean_rating DESC;

-- F2. GROUP BY ... WITH ROLLUP: per-type subtotals plus a grand total.
--     The NULL in the `type` column is the rollup row.
SELECT COALESCE(type, 'ALL TYPES') AS media_type,
       COUNT(*) AS titles,
       ROUND(AVG(avg_rating), 2) AS mean_rating
FROM titles
WHERE rating_count > 0
GROUP BY type WITH ROLLUP;

-- F3. The session agreement view in anger — the candidate shortlist for a
--     session, ordered by consensus. This is the SQL half of the
--     recommendation; the semantic half comes from MongoDB.
SELECT s.invite_code,
       t.name AS candidate,
       va.likes, va.dislikes, va.agreement_pct,
       va.total_swipes, va.member_count, va.participation_pct
FROM view_session_agreement va
JOIN sessions s ON s.id = va.session_id
JOIN titles   t ON t.id = va.title_id
WHERE s.invite_code = 'MOVIE001'
ORDER BY va.agreement_pct DESC, va.total_swipes DESC;

-- F4. Quorum check using the stored function.
SELECT s.invite_code, s.status,
       fn_session_quorum_met(s.id, 3) AS quorum_met,
       (SELECT COUNT(*) FROM session_members sm WHERE sm.session_id = s.id) AS members
FROM sessions s;

-- =============================================================================
-- SECTION G — FULL-TEXT SEARCH (the keyword baseline)
-- =============================================================================

-- G1. Natural-language full-text search over name + description.
SELECT name, type,
       ROUND(MATCH(name, description) AGAINST ('alien language memory' IN NATURAL LANGUAGE MODE), 4) AS relevance
FROM titles
WHERE MATCH(name, description) AGAINST ('alien language memory' IN NATURAL LANGUAGE MODE)
ORDER BY relevance DESC;

-- G2. Boolean mode with required and excluded terms.
SELECT name, type
FROM titles
WHERE MATCH(name, description) AGAINST ('+desert +planet -alien' IN BOOLEAN MODE);

-- G3. THE COMPARISON THAT MOTIVATES THE VECTOR DATABASE.
--     A user searching for "a story about losing someone you love" expects
--     Arrival, Never Let Me Go and The Remains of the Day. FULLTEXT returns
--     almost nothing, because none of those descriptions contain the query's
--     words — it matches tokens, not meaning.
SELECT name,
       ROUND(MATCH(name, description)
             AGAINST ('a story about losing someone you love' IN NATURAL LANGUAGE MODE), 4) AS relevance
FROM titles
WHERE MATCH(name, description) AGAINST ('a story about losing someone you love' IN NATURAL LANGUAGE MODE)
ORDER BY relevance DESC;
-- Run the same sentence through db/mongo/03_vector_rud.js to see the
-- difference. The side-by-side output is reproduced in the report, Section 8.

-- G4. Full-text over review bodies.
SELECT u.name AS reviewer, t.name AS title, LEFT(r.review_text, 60) AS snippet
FROM ratings r
JOIN users  u ON u.id = r.user_id
JOIN titles t ON t.id = r.title_id
WHERE MATCH(r.review_text) AGAINST ('prose dialogue writing' IN NATURAL LANGUAGE MODE);
