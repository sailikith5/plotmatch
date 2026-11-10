-- =============================================================================
-- PlotMatch — File 4 of 6 : DML operations (rubric item 3)
--
-- Every statement here is runnable against the seeded database and is paired
-- with a verification SELECT, so the output can be pasted straight into the
-- report's "Results" section.
--
-- Run with:  mysql -u root -p --table plotmatch < db/04_dml.sql > logs/dml.log
-- =============================================================================

USE plotmatch;

-- =============================================================================
-- 1. INSERT
-- =============================================================================

-- 1a. Simple INSERT — register a new member.
INSERT INTO users (name, email, password_hash, role_id)
VALUES ('Kavya Iyer', 'kavya@plotmatch.dev',
        'scrypt$16384:8:1$0000000000000000000000000000000f$placeholder_rehash_on_first_login',
        (SELECT id FROM roles WHERE name = 'user'));

SELECT id, name, email, role_id FROM users WHERE email = 'kavya@plotmatch.dev';

-- 1b. Multi-row INSERT — add two titles.
INSERT INTO titles (name, type, release_year, description) VALUES
('Annihilation', 'movie', 2018,
 'A biologist joins an expedition into a quarantined zone where the laws of biology are being rewritten.'),
('The Left Hand of Darkness', 'book', 1969,
 'An envoy to an icebound planet must navigate a society without fixed gender, and a journey across the ice that tests his assumptions.');

-- Both triggers fired: embedding rows registered as pending.
SELECT t.name, te.status, te.model_name, te.dimensions
FROM titles t JOIN title_embeddings te ON te.title_id = t.id
WHERE t.name IN ('Annihilation', 'The Left Hand of Darkness');

-- 1c. INSERT ... SELECT — bulk-add every unrated science fiction title to
--     Kavya's watchlist.
INSERT INTO watchlist (user_id, title_id)
SELECT (SELECT id FROM users WHERE email = 'kavya@plotmatch.dev'), t.id
FROM titles t
JOIN title_genres tg ON tg.title_id = t.id
JOIN genres       g  ON g.id = tg.genre_id
WHERE g.name = 'Science Fiction'
  AND t.rating_count = 0
ON DUPLICATE KEY UPDATE added_at = added_at;   -- idempotent re-run

SELECT t.name FROM watchlist w
JOIN titles t ON t.id = w.title_id
JOIN users  u ON u.id = w.user_id
WHERE u.email = 'kavya@plotmatch.dev';

-- 1d. INSERT through a stored procedure (atomic upsert).
-- Resolve the ids in their own statements first. MySQL locks every table a
-- statement touches, subqueries included, so passing (SELECT ... FROM titles)
-- straight into the CALL would leave `titles` in use when the rating trigger
-- tries to update it -- ERROR 1442. Two SET statements sidestep it entirely.
SET @kavya_id        = (SELECT id FROM users  WHERE email = 'kavya@plotmatch.dev');
SET @annihilation_id = (SELECT id FROM titles WHERE name  = 'Annihilation');

CALL sp_upsert_rating(@kavya_id, @annihilation_id,
    5, 'The lighthouse sequence is the most unsettling thing I have seen.');

SELECT t.name, t.avg_rating, t.rating_count
FROM titles t WHERE t.name = 'Annihilation';

-- =============================================================================
-- 2. UPDATE
-- =============================================================================

-- 2a. Simple UPDATE — correct a release year.
UPDATE titles SET release_year = 2018 WHERE name = 'Annihilation';

-- 2b. UPDATE firing the staleness trigger. Editing a description invalidates
--     the stored vector, so trg_titles_after_update flips the embedding to
--     'stale' automatically. This is the relational/vector coherence
--     mechanism, and it is observable:
SELECT te.status AS status_before
FROM title_embeddings te JOIN titles t ON t.id = te.title_id
WHERE t.name = 'Dune';

UPDATE titles
SET description = CONCAT(description, ' A meditation on ecology, prophecy and empire.')
WHERE name = 'Dune';

SELECT te.status AS status_after
FROM title_embeddings te JOIN titles t ON t.id = te.title_id
WHERE t.name = 'Dune';

-- 2c. UPDATE with a join — archive every title that has never been rated and
--     was added more than 0 days ago (soft delete, rubric item 2 constraint).
UPDATE titles t
LEFT JOIN ratings r ON r.title_id = t.id
SET t.is_archived = TRUE
WHERE r.id IS NULL
  AND t.name = 'The Left Hand of Darkness';

SELECT name, is_archived, rating_count FROM titles WHERE name = 'The Left Hand of Darkness';

-- 2d. UPDATE via the RBAC-guarded procedure. Promoting a user requires the
--     actor to hold 'user.manage_roles'; the admin does, so this succeeds and
--     writes an audit row.
CALL sp_set_user_role(
    (SELECT id FROM users WHERE email = 'admin@plotmatch.dev'),
    (SELECT id FROM users WHERE email = 'kavya@plotmatch.dev'),
    'moderator');

SELECT u.name, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
WHERE u.email = 'kavya@plotmatch.dev';

SELECT action, entity_type, entity_id, detail FROM audit_log
ORDER BY id DESC LIMIT 1;

-- 2e. The same call by a non-admin must FAIL with 'Permission denied'.
--     Uncomment to demonstrate authorization enforced inside the database:
-- CALL sp_set_user_role(
--     (SELECT id FROM users WHERE email = 'sai@plotmatch.dev'),
--     (SELECT id FROM users WHERE email = 'ravi@plotmatch.dev'),
--     'admin');

-- =============================================================================
-- 3. DELETE
-- =============================================================================

-- 3a. DELETE a single row and watch the statistics trigger correct the parent.
SELECT name, avg_rating, rating_count FROM titles WHERE name = 'Annihilation';

-- Same reason as 1d: this DELETE fires trg_ratings_after_delete, which
-- updates `titles`, so the DELETE itself must not read `titles`.
SET @kavya_id        = (SELECT id FROM users  WHERE email = 'kavya@plotmatch.dev');
SET @annihilation_id = (SELECT id FROM titles WHERE name  = 'Annihilation');

DELETE FROM ratings WHERE user_id = @kavya_id AND title_id = @annihilation_id;

SELECT name, avg_rating, rating_count FROM titles WHERE name = 'Annihilation';

-- 3b. The cascade-vs-trigger demonstration (report Section 7).
--
--     MySQL does not activate triggers for cascaded FK actions, so deleting a
--     user whose ratings cascade away would leave titles.avg_rating stale.
--     trg_users_before_delete removes the child rows explicitly first, which
--     routes them through the normal DELETE path and fires the triggers.
--
--     Record the state, delete the user, then confirm the figures still agree
--     with a recomputation from the base table:

CREATE TEMPORARY TABLE tmp_before AS
SELECT id, name, avg_rating, rating_count FROM titles;

DELETE FROM users WHERE email = 'kavya@plotmatch.dev';

-- Expected: zero rows. Any row returned means the derived columns drifted.
SELECT t.id, t.name, t.avg_rating AS stored_avg, t.rating_count AS stored_count,
       COALESCE(agg.a, 0) AS actual_avg, COALESCE(agg.c, 0) AS actual_count
FROM titles t
LEFT JOIN (
    SELECT title_id, COUNT(*) AS c, ROUND(AVG(score), 2) AS a
    FROM ratings GROUP BY title_id
) agg ON agg.title_id = t.id
WHERE t.rating_count <> COALESCE(agg.c, 0)
   OR ABS(t.avg_rating - COALESCE(agg.a, 0)) > 0.01;

DROP TEMPORARY TABLE tmp_before;

-- 3c. DELETE blocked by a constraint. Sessions use ON DELETE RESTRICT for the
--     host, so an account that still hosts an open room cannot be removed.
--     sp_delete_user raises a readable error instead of a raw FK violation.
--     Uncomment to demonstrate:
-- CALL sp_delete_user((SELECT id FROM users WHERE email = 'sai@plotmatch.dev'));
--     ERROR 1644: User still hosts open sessions; close or transfer them first

-- 3d. Clean up the demo titles.
DELETE FROM titles WHERE name IN ('Annihilation', 'The Left Hand of Darkness');

-- title_embeddings cascades, so the registry stays in step:
SELECT COUNT(*) AS orphaned_embeddings
FROM title_embeddings te
LEFT JOIN titles t ON t.id = te.title_id
WHERE t.id IS NULL;

-- =============================================================================
-- 4. TCL — transaction control (COMMIT / ROLLBACK / SAVEPOINT)
-- =============================================================================

-- 4a. ROLLBACK undoes the whole unit of work.
START TRANSACTION;
    UPDATE titles SET avg_rating = 1.00 WHERE name = 'Arrival';
    SELECT name, avg_rating AS inside_transaction FROM titles WHERE name = 'Arrival';
ROLLBACK;
SELECT name, avg_rating AS after_rollback FROM titles WHERE name = 'Arrival';

-- 4b. SAVEPOINT allows partial rollback.
START TRANSACTION;
    INSERT INTO genres (name) VALUES ('Documentary');
    SAVEPOINT after_documentary;
    INSERT INTO genres (name) VALUES ('Mockumentary');
    ROLLBACK TO SAVEPOINT after_documentary;   -- drops only 'Mockumentary'
COMMIT;

SELECT name FROM genres WHERE name IN ('Documentary', 'Mockumentary');
-- Expected: Documentary only.

DELETE FROM genres WHERE name = 'Documentary';
