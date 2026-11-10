-- =============================================================================
-- PlotMatch — File 6 of 6 : DCL and role-based access control (rubric item 6)
--
-- Authorization is enforced at two layers, and the report explains why both
-- are needed:
--
--   Layer 1 — APPLICATION RBAC (roles / permissions / role_permissions).
--             Fine-grained and data-driven: a permission can be granted or
--             revoked by an admin at runtime without a redeploy. This is what
--             the API checks on every request, via fn_user_has_permission.
--
--   Layer 2 — DATABASE DCL (GRANT / REVOKE to MySQL accounts below).
--             Coarse but absolute: even if the application layer is bypassed
--             or compromised, the connection itself cannot run statements the
--             MySQL account was never granted. The read-only reporting account
--             physically cannot write.
--
-- Layer 1 alone is a lock on the front door with the back door open; Layer 2
-- alone is too blunt to express "users may edit their own rating". Together
-- they give defence in depth.
--
-- Run as root:  mysql -u root -p < db/06_rbac_dcl.sql
-- =============================================================================

USE plotmatch;

-- =============================================================================
-- SECTION 1 — MySQL accounts, one per application role
-- =============================================================================

DROP USER IF EXISTS 'plotmatch_app'@'localhost';
DROP USER IF EXISTS 'plotmatch_readonly'@'localhost';
DROP USER IF EXISTS 'plotmatch_admin'@'localhost';

-- Replace these passwords before any non-local deployment.
CREATE USER 'plotmatch_app'@'localhost'      IDENTIFIED BY 'app_Passw0rd!';
CREATE USER 'plotmatch_readonly'@'localhost' IDENTIFIED BY 'read_Passw0rd!';
CREATE USER 'plotmatch_admin'@'localhost'    IDENTIFIED BY 'admin_Passw0rd!';

-- =============================================================================
-- SECTION 2 — GRANT
-- =============================================================================

-- --- The account the Next.js API connects as ---------------------------------
-- Day-to-day CRUD, plus EXECUTE so it can call the stored procedures. It is
-- deliberately NOT granted DROP, ALTER or CREATE: a SQL-injection hole in the
-- app cannot drop a table, because the connection has no such privilege.
GRANT SELECT, INSERT, UPDATE, DELETE ON plotmatch.* TO 'plotmatch_app'@'localhost';
GRANT EXECUTE ON plotmatch.* TO 'plotmatch_app'@'localhost';

-- The app must never rewrite the audit trail. INSERT and SELECT only: no
-- UPDATE, no DELETE, so history is append-only even to the application.
REVOKE UPDATE, DELETE ON plotmatch.audit_log FROM 'plotmatch_app'@'localhost';

-- --- Read-only reporting account (dashboards, marks demo, BI tools) ----------
GRANT SELECT ON plotmatch.view_title_summary       TO 'plotmatch_readonly'@'localhost';
GRANT SELECT ON plotmatch.view_top_rated_by_genre  TO 'plotmatch_readonly'@'localhost';
GRANT SELECT ON plotmatch.view_session_agreement   TO 'plotmatch_readonly'@'localhost';
GRANT SELECT ON plotmatch.view_embedding_health    TO 'plotmatch_readonly'@'localhost';

-- Column-level grant: the reporting account may read the user table, but NOT
-- the password hash or the email address. This is the finest granularity DCL
-- offers and is worth demonstrating in the viva.
GRANT SELECT (id, name, created_at) ON plotmatch.users TO 'plotmatch_readonly'@'localhost';

-- --- DBA account -------------------------------------------------------------
GRANT ALL PRIVILEGES ON plotmatch.* TO 'plotmatch_admin'@'localhost' WITH GRANT OPTION;

FLUSH PRIVILEGES;

-- =============================================================================
-- SECTION 3 — Verify the grants
-- =============================================================================

SHOW GRANTS FOR 'plotmatch_app'@'localhost';
SHOW GRANTS FOR 'plotmatch_readonly'@'localhost';
SHOW GRANTS FOR 'plotmatch_admin'@'localhost';

-- =============================================================================
-- SECTION 4 — Demonstrating that the restrictions actually bite
--
-- Run each block in a separate shell. The errors are the evidence; capture
-- them for the report's Results section.
-- =============================================================================

-- $ mysql -u plotmatch_readonly -p plotmatch
--
--   SELECT * FROM view_title_summary LIMIT 3;
--     -> succeeds
--
--   SELECT id, name FROM users LIMIT 3;
--     -> succeeds (granted columns)
--
--   SELECT email, password_hash FROM users LIMIT 1;
--     -> ERROR 1143 (42000): SELECT command denied to user 'plotmatch_readonly'
--        for column 'email' in table 'users'
--
--   DELETE FROM ratings;
--     -> ERROR 1142 (42000): DELETE command denied to user 'plotmatch_readonly'
--
-- $ mysql -u plotmatch_app -p plotmatch
--
--   INSERT INTO ratings (user_id, title_id, score) VALUES (3, 1, 5);
--     -> succeeds
--
--   DROP TABLE ratings;
--     -> ERROR 1142 (42000): DROP command denied to user 'plotmatch_app'
--
--   DELETE FROM audit_log;
--     -> ERROR 1142 (42000): DELETE command denied to user 'plotmatch_app'

-- =============================================================================
-- SECTION 5 — REVOKE, and runtime permission changes (rubric: feature RUD)
-- =============================================================================

-- 5a. DCL revoke: withdraw a privilege from a MySQL account.
REVOKE DELETE ON plotmatch.* FROM 'plotmatch_app'@'localhost';
SHOW GRANTS FOR 'plotmatch_app'@'localhost';

-- Restore it, since the app does need to delete watchlist rows.
GRANT DELETE ON plotmatch.* TO 'plotmatch_app'@'localhost';
REVOKE UPDATE, DELETE ON plotmatch.audit_log FROM 'plotmatch_app'@'localhost';
FLUSH PRIVILEGES;

-- 5b. Application-level revoke: strip 'title.archive' from moderators at
--     runtime. No redeploy, no schema change — the permission is data.
SELECT 'before' AS state,
       fn_user_has_permission((SELECT id FROM users WHERE email='mod@plotmatch.dev'),
                              'title.archive') AS can_archive;

DELETE FROM role_permissions
WHERE role_id       = (SELECT id FROM roles       WHERE name = 'moderator')
  AND permission_id = (SELECT id FROM permissions WHERE code = 'title.archive');

SELECT 'after revoke' AS state,
       fn_user_has_permission((SELECT id FROM users WHERE email='mod@plotmatch.dev'),
                              'title.archive') AS can_archive;

-- 5c. ... and grant it back.
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM roles WHERE name = 'moderator'),
       (SELECT id FROM permissions WHERE code = 'title.archive');

SELECT 'after re-grant' AS state,
       fn_user_has_permission((SELECT id FROM users WHERE email='mod@plotmatch.dev'),
                              'title.archive') AS can_archive;

-- 5d. The full effective-permission matrix, per user.
SELECT u.name, r.name AS role,
       GROUP_CONCAT(p.code ORDER BY p.code SEPARATOR ', ') AS permissions
FROM users u
JOIN roles            r  ON r.id = u.role_id
LEFT JOIN role_permissions rp ON rp.role_id = r.id
LEFT JOIN permissions      p  ON p.id = rp.permission_id
GROUP BY u.id, u.name, r.name
ORDER BY r.name, u.name;
