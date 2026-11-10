-- =============================================================================
-- PlotMatch — File 2 of 6 : Views, Functions, Procedures, Triggers
-- Run after 01_schema.sql
--
-- DELIMITER is a mysql-client directive, not server SQL. Run this file with the
-- mysql CLI or MySQL Workbench.
-- =============================================================================

USE plotmatch;

-- =============================================================================
-- SECTION 1 — Views
-- =============================================================================

-- -----------------------------------------------------------------------------
-- view_title_summary : catalogue row with its genre list rolled up.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW view_title_summary AS
SELECT
    t.id,
    t.name,
    t.type,
    t.release_year,
    t.avg_rating,
    t.rating_count,
    t.is_archived,
    GROUP_CONCAT(DISTINCT g.name ORDER BY g.name SEPARATOR ', ') AS genres
FROM titles t
LEFT JOIN title_genres tg ON tg.title_id = t.id
LEFT JOIN genres       g  ON g.id = tg.genre_id
GROUP BY t.id, t.name, t.type, t.release_year, t.avg_rating, t.rating_count, t.is_archived;

-- -----------------------------------------------------------------------------
-- view_top_rated_by_genre : top 5 titles per genre.
-- Uses a CTE + RANK() window function (rubric item 4).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW view_top_rated_by_genre AS
WITH ranked AS (
    SELECT
        g.id   AS genre_id,
        g.name AS genre,
        t.id   AS title_id,
        t.name AS title_name,
        t.avg_rating,
        t.rating_count,
        RANK() OVER (
            PARTITION BY g.id
            ORDER BY t.avg_rating DESC, t.rating_count DESC
        ) AS rank_in_genre
    FROM titles t
    JOIN title_genres tg ON tg.title_id = t.id
    JOIN genres       g  ON g.id = tg.genre_id
    WHERE t.rating_count > 0
      AND t.is_archived = FALSE
)
SELECT genre_id, genre, title_id, title_name, avg_rating, rating_count, rank_in_genre
FROM ranked
WHERE rank_in_genre <= 5;

-- -----------------------------------------------------------------------------
-- view_session_agreement : per-session, per-title swipe agreement.
--
-- This is the pure-SQL half of the recommendation score. The semantic half
-- (cosine similarity to the group centroid) comes from MongoDB.
--
-- v2 used HAVING COUNT(*) >= 2, which hid every title in a session where only
-- one member had swiped so far. The member count now comes from
-- session_members, so partial progress is visible and the API can decide what
-- quorum it wants.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW view_session_agreement AS
SELECT
    ss.session_id,
    ss.title_id,
    COUNT(*)                                        AS total_swipes,
    SUM(ss.liked)                                   AS likes,
    COUNT(*) - SUM(ss.liked)                        AS dislikes,
    ROUND(SUM(ss.liked) / COUNT(*) * 100, 2)        AS agreement_pct,
    (SELECT COUNT(*) FROM session_members sm
      WHERE sm.session_id = ss.session_id)          AS member_count,
    ROUND(COUNT(*) / NULLIF(
        (SELECT COUNT(*) FROM session_members sm
          WHERE sm.session_id = ss.session_id), 0) * 100, 2) AS participation_pct
FROM session_swipes ss
GROUP BY ss.session_id, ss.title_id;

-- -----------------------------------------------------------------------------
-- view_user_permissions : flattened RBAC lookup used by the API on every
-- protected request. Keeps permission checks a single indexed read.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW view_user_permissions AS
SELECT
    u.id        AS user_id,
    u.email,
    r.name      AS role_name,
    p.code      AS permission_code
FROM users u
JOIN roles            r  ON r.id = u.role_id
JOIN role_permissions rp ON rp.role_id = r.id
JOIN permissions      p  ON p.id = rp.permission_id
WHERE u.is_active = TRUE;

-- -----------------------------------------------------------------------------
-- view_embedding_health : operational view for the admin dashboard — how much
-- of the catalogue currently has a usable vector.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW view_embedding_health AS
SELECT
    COUNT(*)                                                       AS total_titles,
    SUM(te.status = 'ready')                                       AS ready,
    SUM(te.status = 'stale')                                       AS stale,
    SUM(te.status = 'pending')                                     AS pending,
    SUM(te.status = 'failed')                                      AS failed,
    SUM(te.title_id IS NULL)                                       AS never_embedded,
    ROUND(SUM(te.status = 'ready') / COUNT(*) * 100, 2)            AS coverage_pct
FROM titles t
LEFT JOIN title_embeddings te ON te.title_id = t.id
WHERE t.is_archived = FALSE;

-- =============================================================================
-- SECTION 2 — Stored functions
-- =============================================================================
DELIMITER $$

-- -----------------------------------------------------------------------------
-- fn_user_has_permission : the single authorization predicate used by the
-- application and by 06_rbac_dcl.sql. Returns TRUE if the user's role carries
-- the named permission.
-- -----------------------------------------------------------------------------
-- Note on routine characteristics: these functions read tables, so they are
-- NOT DETERMINISTIC. Declaring READS SQL DATA alone satisfies MySQL's
-- ERROR 1418 binary-logging check; adding DETERMINISTIC as well (as is often
-- copy-pasted) would be a false declaration that can corrupt replication.
CREATE FUNCTION fn_user_has_permission (p_user_id INT, p_code VARCHAR(50))
RETURNS BOOLEAN
READS SQL DATA
NOT DETERMINISTIC
BEGIN
    DECLARE v_found INT DEFAULT 0;

    SELECT COUNT(*) INTO v_found
    FROM view_user_permissions
    WHERE user_id = p_user_id
      AND permission_code = p_code;

    RETURN v_found > 0;
END$$

-- -----------------------------------------------------------------------------
-- fn_title_bayesian_score : a shrunk ("Bayesian") rating.
--
-- A title with one 5-star rating should not outrank a title with four hundred
-- 4.6-star ratings. This pulls a title's mean toward the global mean in
-- proportion to how little evidence it has:
--
--     (v / (v + m)) * R  +  (m / (v + m)) * C
--
-- where v = rating_count, R = avg_rating, C = global mean, m = confidence
-- threshold. This is the ordering used by the catalogue and by the
-- recommendation blend.
-- -----------------------------------------------------------------------------
CREATE FUNCTION fn_title_bayesian_score (p_title_id INT, p_min_votes INT)
RETURNS DECIMAL(6,4)
READS SQL DATA
NOT DETERMINISTIC
BEGIN
    DECLARE v_avg    DECIMAL(3,2);
    DECLARE v_count  INT;
    DECLARE v_global DECIMAL(6,4);

    SELECT avg_rating, rating_count INTO v_avg, v_count
    FROM titles WHERE id = p_title_id;

    IF v_count IS NULL OR v_count = 0 THEN
        RETURN 0.0000;
    END IF;

    SELECT COALESCE(AVG(score), 0) INTO v_global FROM ratings;

    RETURN ROUND(
        (v_count / (v_count + p_min_votes)) * v_avg
      + (p_min_votes / (v_count + p_min_votes)) * v_global
    , 4);
END$$

-- -----------------------------------------------------------------------------
-- fn_session_quorum_met : has a session gathered enough signal to finalize?
-- Requires every member to have swiped at least p_min_swipes times.
-- -----------------------------------------------------------------------------
CREATE FUNCTION fn_session_quorum_met (p_session_id INT, p_min_swipes INT)
RETURNS BOOLEAN
READS SQL DATA
NOT DETERMINISTIC
BEGIN
    DECLARE v_lagging INT DEFAULT 0;

    SELECT COUNT(*) INTO v_lagging
    FROM session_members sm
    WHERE sm.session_id = p_session_id
      AND (
            SELECT COUNT(*) FROM session_swipes ss
            WHERE ss.session_id = sm.session_id
              AND ss.user_id    = sm.user_id
          ) < p_min_swipes;

    RETURN v_lagging = 0;
END$$

DELIMITER ;

-- =============================================================================
-- SECTION 3 — Stored procedures
-- =============================================================================
DELIMITER $$

-- -----------------------------------------------------------------------------
-- sp_recalc_title_stats : single source of truth for the derived rating
-- columns. Both the triggers and the admin repair endpoint call this, so the
-- maintenance logic exists in exactly one place.
-- -----------------------------------------------------------------------------
CREATE PROCEDURE sp_recalc_title_stats (IN p_title_id INT)
BEGIN
    UPDATE titles t
    SET t.rating_count = (SELECT COUNT(*)            FROM ratings r WHERE r.title_id = p_title_id),
        t.avg_rating   = (SELECT COALESCE(AVG(score), 0) FROM ratings r WHERE r.title_id = p_title_id)
    WHERE t.id = p_title_id;
END$$

-- -----------------------------------------------------------------------------
-- sp_rebuild_all_title_stats : full reconciliation sweep. Exposed to admins so
-- a drift incident can be repaired without a manual UPDATE.
-- -----------------------------------------------------------------------------
CREATE PROCEDURE sp_rebuild_all_title_stats ()
BEGIN
    UPDATE titles t
    LEFT JOIN (
        SELECT title_id, COUNT(*) AS c, AVG(score) AS a
        FROM ratings GROUP BY title_id
    ) agg ON agg.title_id = t.id
    SET t.rating_count = COALESCE(agg.c, 0),
        t.avg_rating   = COALESCE(agg.a, 0);
END$$

-- -----------------------------------------------------------------------------
-- sp_upsert_rating : atomic insert-or-update of one user's rating.
--
-- Fixed from v2: created_at is no longer overwritten on the update path — that
-- is what updated_at is for.
-- -----------------------------------------------------------------------------
CREATE PROCEDURE sp_upsert_rating (
    IN p_user_id     INT,
    IN p_title_id    INT,
    IN p_score       TINYINT UNSIGNED,
    IN p_review_text TEXT
)
BEGIN
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    INSERT INTO ratings (user_id, title_id, score, review_text)
    VALUES (p_user_id, p_title_id, p_score, p_review_text)
    ON DUPLICATE KEY UPDATE
        score       = p_score,
        review_text = p_review_text;

    -- Belt and braces: ON DUPLICATE KEY UPDATE does not fire the AFTER UPDATE
    -- trigger when the new values equal the old ones, so recompute explicitly.
    CALL sp_recalc_title_stats(p_title_id);

    COMMIT;
END$$

-- -----------------------------------------------------------------------------
-- sp_create_session : open a room and seat the host in one transaction.
-- -----------------------------------------------------------------------------
CREATE PROCEDURE sp_create_session (
    IN  p_host_user_id INT,
    IN  p_title_type   VARCHAR(10),
    OUT p_session_id   INT,
    OUT p_invite_code  VARCHAR(16)
)
BEGIN
    DECLARE v_code VARCHAR(16);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    -- 8 hex characters from a UUID; uq_sessions_invite_code is the backstop.
    SET v_code = UPPER(SUBSTRING(REPLACE(UUID(), '-', ''), 1, 8));

    INSERT INTO sessions (host_user_id, invite_code, title_type)
    VALUES (p_host_user_id, v_code, p_title_type);

    SET p_session_id  = LAST_INSERT_ID();
    SET p_invite_code = v_code;

    -- The host is seated by trg_sessions_after_insert.
    COMMIT;
END$$

-- -----------------------------------------------------------------------------
-- sp_join_session : join by invite code. Refuses closed sessions.
-- -----------------------------------------------------------------------------
CREATE PROCEDURE sp_join_session (
    IN  p_user_id     INT,
    IN  p_invite_code VARCHAR(16),
    OUT p_session_id  INT
)
BEGIN
    DECLARE v_status VARCHAR(20);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    -- SELECT ... INTO leaves its targets untouched when no row matches, so
    -- clear them first rather than trusting the previous call's values.
    SET p_session_id = NULL;
    SET v_status     = NULL;

    SELECT id, status INTO p_session_id, v_status
    FROM sessions WHERE invite_code = p_invite_code
    FOR UPDATE;

    IF p_session_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No session with that invite code';
    END IF;

    IF v_status <> 'open' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Session is no longer open';
    END IF;

    INSERT IGNORE INTO session_members (session_id, user_id)
    VALUES (p_session_id, p_user_id);

    COMMIT;
END$$

-- -----------------------------------------------------------------------------
-- sp_finalize_session : persist the ranked recommendation shortlist and close
-- the session, as one transaction.
--
-- This replaces v2's trg_session_recs_after_insert, which finalized a session
-- on its *first* recommendation row (so a ranked list closed the room before
-- rows 2..N were written), resurrected cancelled sessions, and did nothing at
-- all on the ON DUPLICATE KEY UPDATE path. Lifecycle changes belong in the
-- procedure that owns the operation, not in a row trigger.
--
-- p_recs is a JSON array, highest rank first:
--   [{"title_id":12,"match_score":0.8431,"agreement_pct":75.00}, ...]
-- -----------------------------------------------------------------------------
CREATE PROCEDURE sp_finalize_session (
    IN p_session_id INT,
    IN p_recs       JSON
)
BEGIN
    DECLARE v_i             INT DEFAULT 0;
    DECLARE v_n             INT;
    DECLARE v_status        VARCHAR(20);
    DECLARE v_title_id      INT;
    DECLARE v_match_score   DECIMAL(5,4);
    DECLARE v_agreement_pct DECIMAL(5,2);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    SET v_status = NULL;
    SELECT status INTO v_status FROM sessions WHERE id = p_session_id FOR UPDATE;

    IF v_status IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unknown session';
    END IF;

    IF v_status = 'cancelled' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot finalize a cancelled session';
    END IF;

    SET v_n = JSON_LENGTH(p_recs);

    -- Replace the shortlist wholesale rather than upserting row by row.
    -- Re-finalizing can reorder titles, and uq_sr_session_rank would collide
    -- mid-loop if rank 2 were written before rank 1 released the value.
    DELETE FROM session_recs WHERE session_id = p_session_id;

    WHILE v_i < v_n DO
        SET v_title_id      = JSON_EXTRACT(p_recs, CONCAT('$[', v_i, '].title_id'));
        SET v_match_score   = JSON_EXTRACT(p_recs, CONCAT('$[', v_i, '].match_score'));
        SET v_agreement_pct = JSON_EXTRACT(p_recs, CONCAT('$[', v_i, '].agreement_pct'));

        INSERT INTO session_recs (session_id, title_id, rank_position, match_score, agreement_pct)
        VALUES (p_session_id, v_title_id, v_i + 1, v_match_score, v_agreement_pct);

        SET v_i = v_i + 1;
    END WHILE;

    UPDATE sessions
    SET status = 'finalized', finalized_at = CURRENT_TIMESTAMP
    WHERE id = p_session_id AND status = 'open';

    COMMIT;
END$$

-- -----------------------------------------------------------------------------
-- sp_delete_user : GDPR-style account removal.
--
-- Deletes ratings explicitly so the statistics triggers fire (MySQL does not
-- run triggers for cascaded FK actions), reassigns or blocks on hosted
-- sessions, and leaves the audit trail intact via ON DELETE SET NULL.
-- -----------------------------------------------------------------------------
CREATE PROCEDURE sp_delete_user (IN p_user_id INT)
BEGIN
    DECLARE v_hosted INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    SELECT COUNT(*) INTO v_hosted
    FROM sessions WHERE host_user_id = p_user_id AND status = 'open';

    IF v_hosted > 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'User still hosts open sessions; close or transfer them first';
    END IF;

    -- Explicit, so trg_ratings_after_delete runs for every row.
    DELETE FROM ratings WHERE user_id = p_user_id;

    -- Everything else is safe to cascade.
    DELETE FROM users WHERE id = p_user_id;

    COMMIT;
END$$

-- -----------------------------------------------------------------------------
-- sp_set_user_role : admin-only role change, guarded by the RBAC function and
-- recorded in the audit log. Demonstrates authorization enforced *in* the
-- database rather than only in the API layer.
-- -----------------------------------------------------------------------------
CREATE PROCEDURE sp_set_user_role (
    IN p_actor_id   INT,
    IN p_target_id  INT,
    IN p_role_name  VARCHAR(30)
)
BEGIN
    DECLARE v_role_id TINYINT UNSIGNED;
    DECLARE v_old_role VARCHAR(30);

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    IF NOT fn_user_has_permission(p_actor_id, 'user.manage_roles') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Permission denied: user.manage_roles';
    END IF;

    START TRANSACTION;

    SELECT id INTO v_role_id FROM roles WHERE name = p_role_name;
    IF v_role_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Unknown role';
    END IF;

    SELECT r.name INTO v_old_role
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.id = p_target_id;

    UPDATE users SET role_id = v_role_id WHERE id = p_target_id;

    INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, detail)
    VALUES (p_actor_id, 'role.change', 'user', p_target_id,
            JSON_OBJECT('from', v_old_role, 'to', p_role_name));

    COMMIT;
END$$

DELIMITER ;

-- =============================================================================
-- SECTION 4 — Triggers
-- =============================================================================
DELIMITER $$

-- --- Rating statistics -------------------------------------------------------

CREATE TRIGGER trg_ratings_after_insert
AFTER INSERT ON ratings
FOR EACH ROW
BEGIN
    CALL sp_recalc_title_stats(NEW.title_id);
END$$

CREATE TRIGGER trg_ratings_after_update
AFTER UPDATE ON ratings
FOR EACH ROW
BEGIN
    CALL sp_recalc_title_stats(NEW.title_id);
    -- A rating can be moved between titles; refresh the old one too.
    IF OLD.title_id <> NEW.title_id THEN
        CALL sp_recalc_title_stats(OLD.title_id);
    END IF;
END$$

CREATE TRIGGER trg_ratings_after_delete
AFTER DELETE ON ratings
FOR EACH ROW
BEGIN
    CALL sp_recalc_title_stats(OLD.title_id);
END$$

-- --- Validation that CHECK cannot express ------------------------------------

-- A book cannot have a director; a movie cannot have an author. This spans two
-- tables, so a CHECK constraint cannot do it.
CREATE TRIGGER trg_title_people_before_insert
BEFORE INSERT ON title_people
FOR EACH ROW
BEGIN
    DECLARE v_type VARCHAR(10);
    SELECT type INTO v_type FROM titles WHERE id = NEW.title_id;

    IF v_type = 'book' AND NEW.role IN ('director', 'actor') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A book cannot have a director or actor';
    END IF;

    IF v_type = 'movie' AND NEW.role = 'author' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A movie credit must be director or actor';
    END IF;
END$$

-- --- Session lifecycle -------------------------------------------------------

-- The host is always a member of their own session. v2 left this to the
-- application, so a host could be absent from session_members and therefore
-- (under the new composite FK) unable to swipe in their own room.
CREATE TRIGGER trg_sessions_after_insert
AFTER INSERT ON sessions
FOR EACH ROW
BEGIN
    INSERT IGNORE INTO session_members (session_id, user_id)
    VALUES (NEW.id, NEW.host_user_id);
END$$

-- Swipes are only meaningful while the room is open.
CREATE TRIGGER trg_session_swipes_before_insert
BEFORE INSERT ON session_swipes
FOR EACH ROW
BEGIN
    DECLARE v_status VARCHAR(20);
    SELECT status INTO v_status FROM sessions WHERE id = NEW.session_id;

    IF v_status <> 'open' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot swipe in a session that is not open';
    END IF;
END$$

-- --- Cascade-safety: make the statistics triggers actually fire --------------

-- MySQL does not activate triggers for cascaded foreign key actions, so
-- deleting a user would cascade their ratings away WITHOUT running
-- trg_ratings_after_delete, leaving titles.avg_rating and rating_count
-- permanently wrong. Deleting the child rows here, before the parent row goes,
-- routes them through the normal DELETE path so the triggers run.
CREATE TRIGGER trg_users_before_delete
BEFORE DELETE ON users
FOR EACH ROW
BEGIN
    DELETE FROM ratings WHERE user_id = OLD.id;
END$$

-- --- Vector store coherence --------------------------------------------------

-- The embedding is derived from name + description. If either changes, the
-- stored vector no longer represents the title: mark it stale so the
-- re-embedding worker picks it up. This is how the relational store and the
-- vector store are kept from drifting apart.
CREATE TRIGGER trg_titles_after_update
AFTER UPDATE ON titles
FOR EACH ROW
BEGIN
    IF NOT (NEW.name <=> OLD.name) OR NOT (NEW.description <=> OLD.description) THEN
        UPDATE title_embeddings
        SET status = 'stale'
        WHERE title_id = NEW.id AND status <> 'pending';
    END IF;
END$$

-- Every new title needs a vector eventually; register it as pending.
CREATE TRIGGER trg_titles_after_insert
AFTER INSERT ON titles
FOR EACH ROW
BEGIN
    INSERT IGNORE INTO title_embeddings (title_id, model_name, dimensions, status)
    VALUES (NEW.id, 'Xenova/all-MiniLM-L6-v2', 384, 'pending');
END$$

-- --- Audit -------------------------------------------------------------------

CREATE TRIGGER trg_sessions_after_update
AFTER UPDATE ON sessions
FOR EACH ROW
BEGIN
    IF OLD.status <> NEW.status THEN
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, detail)
        VALUES (NEW.host_user_id, 'session.status_change', 'session', NEW.id,
                JSON_OBJECT('from', OLD.status, 'to', NEW.status));
    END IF;
END$$

DELIMITER ;
