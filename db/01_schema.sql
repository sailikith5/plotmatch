-- =============================================================================
-- PlotMatch — Database Schema v3 (MySQL 8.0+)
-- Group-Aware Semantic Discovery for Movies & Books
-- File 1 of 6 : DDL — tables, constraints, indexes
--
-- Run order: 01_schema -> 02_programmability -> 03_seed -> 04_dml
--            -> 05_queries -> 06_rbac_dcl
--
-- Run with:  mysql -u root -p < db/01_schema.sql
-- NOTE: the DELIMITER directives in 02_programmability.sql are mysql-client
--       commands. Use the mysql CLI or MySQL Workbench, not phpMyAdmin.
-- =============================================================================

DROP DATABASE IF EXISTS plotmatch;
CREATE DATABASE plotmatch
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci;
USE plotmatch;

-- =============================================================================
-- SECTION 1 — Authorization model (RBAC held in the database)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- roles : named roles. Rubric item 6 requires a minimum of two.
-- -----------------------------------------------------------------------------
CREATE TABLE roles (
    id           TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(30)  NOT NULL,
    description  VARCHAR(255) NOT NULL,
    CONSTRAINT uq_roles_name UNIQUE (name)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- permissions : atomic capabilities a role may hold.
-- -----------------------------------------------------------------------------
CREATE TABLE permissions (
    id           SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code         VARCHAR(50)  NOT NULL,
    description  VARCHAR(255) NOT NULL,
    CONSTRAINT uq_permissions_code UNIQUE (code)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- role_permissions : M:N roles <-> permissions.
-- This is what makes the access control *data* rather than hard-coded strings,
-- so permissions can be granted/revoked without redeploying the application.
-- -----------------------------------------------------------------------------
CREATE TABLE role_permissions (
    role_id        TINYINT  UNSIGNED NOT NULL,
    permission_id  SMALLINT UNSIGNED NOT NULL,
    granted_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (role_id, permission_id),
    CONSTRAINT fk_rp_role       FOREIGN KEY (role_id)       REFERENCES roles(id)       ON DELETE CASCADE,
    CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =============================================================================
-- SECTION 2 — Core entities
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- role_id is RESTRICT on delete: a role that is still assigned cannot be
-- dropped out from under its users.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    name           VARCHAR(100) NOT NULL,
    email          VARCHAR(150) NOT NULL,
    password_hash  VARCHAR(255) NOT NULL,
    role_id        TINYINT UNSIGNED NOT NULL,
    is_active      BOOLEAN   NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_users_email UNIQUE (email),
    CONSTRAINT fk_users_role  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
    CONSTRAINT chk_users_email_shape CHECK (email LIKE '%_@_%._%')
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- titles : a movie or a book.
--
-- avg_rating / rating_count are MATERIALIZED DERIVED ATTRIBUTES, not a
-- normalization defect. They are fully determined by the ratings relation and
-- are kept in step by the triggers in 02_programmability.sql. The trade-off is
-- documented in the report: O(1) catalogue reads in exchange for write-side
-- maintenance.
--
-- release_year is NULLable and allows negative years so that classical works
-- (Homer, c. -750) and undated editions can be catalogued. The v2 lower bound
-- of 1800 silently rejected most of the literary canon.
-- -----------------------------------------------------------------------------
CREATE TABLE titles (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(200) NOT NULL,
    type          ENUM('movie', 'book') NOT NULL,
    release_year  SMALLINT NULL,
    description   TEXT,
    poster_url    VARCHAR(500),
    avg_rating    DECIMAL(3,2) NOT NULL DEFAULT 0.00,
    rating_count  INT          NOT NULL DEFAULT 0,
    is_archived   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP    NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    -- Generated column: lets the catalogue filter unrated titles without a
    -- function call on every row, and demonstrates a stored generated column.
    is_rated      BOOLEAN GENERATED ALWAYS AS (rating_count > 0) STORED,
    CONSTRAINT chk_titles_year CHECK (release_year IS NULL OR release_year BETWEEN -800 AND 2100),
    CONSTRAINT chk_titles_avg_rating CHECK (avg_rating BETWEEN 0 AND 5),
    CONSTRAINT chk_titles_rating_count CHECK (rating_count >= 0)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- genres
-- -----------------------------------------------------------------------------
CREATE TABLE genres (
    id    SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(50) NOT NULL,
    CONSTRAINT uq_genres_name UNIQUE (name)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- title_genres : M:N titles <-> genres
-- -----------------------------------------------------------------------------
CREATE TABLE title_genres (
    title_id  INT NOT NULL,
    genre_id  SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (title_id, genre_id),
    CONSTRAINT fk_tg_title FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE CASCADE,
    CONSTRAINT fk_tg_genre FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- people : directors, authors, actors
-- -----------------------------------------------------------------------------
CREATE TABLE people (
    id    INT AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(150) NOT NULL,
    CONSTRAINT uq_people_name UNIQUE (name)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- title_people : M:N titles <-> people, with `role` as the discriminator.
-- `role` is part of the primary key, so the same person may be both the
-- director and an actor on one title.
-- -----------------------------------------------------------------------------
CREATE TABLE title_people (
    title_id   INT NOT NULL,
    person_id  INT NOT NULL,
    role       ENUM('director', 'author', 'actor') NOT NULL,
    billing    TINYINT UNSIGNED NULL,
    PRIMARY KEY (title_id, person_id, role),
    CONSTRAINT fk_tp_title  FOREIGN KEY (title_id)  REFERENCES titles(id) ON DELETE CASCADE,
    CONSTRAINT fk_tp_person FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- ratings : M:N users <-> titles, carrying score and review.
-- UNIQUE(user_id, title_id) is the natural key: one rating per user per title.
--
-- fk_ratings_user is ON DELETE CASCADE, but note that MySQL does NOT fire
-- triggers for cascaded FK actions. trg_users_before_delete in
-- 02_programmability.sql deletes these rows explicitly first so that the
-- rating-statistics triggers actually run. See the report, Section 7.
-- -----------------------------------------------------------------------------
CREATE TABLE ratings (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT NOT NULL,
    title_id     INT NOT NULL,
    score        TINYINT UNSIGNED NOT NULL,
    review_text  TEXT,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ratings_user  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    CONSTRAINT fk_ratings_title FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE CASCADE,
    CONSTRAINT uq_ratings_user_title UNIQUE (user_id, title_id),
    CONSTRAINT chk_ratings_score CHECK (score BETWEEN 1 AND 5)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- watchlist : M:N users <-> titles
-- -----------------------------------------------------------------------------
CREATE TABLE watchlist (
    user_id   INT NOT NULL,
    title_id  INT NOT NULL,
    added_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, title_id),
    CONSTRAINT fk_wl_user  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    CONSTRAINT fk_wl_title FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =============================================================================
-- SECTION 3 — Group discovery sessions
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sessions : one group "what should we watch/read" room.
--
-- host_user_id is ON DELETE RESTRICT. v2 used CASCADE, which meant one member
-- deleting their account destroyed the session and every other member's
-- swipes. Hosts must transfer or close a session before deleting the account.
-- -----------------------------------------------------------------------------
CREATE TABLE sessions (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    host_user_id  INT NOT NULL,
    invite_code   VARCHAR(16) NOT NULL,
    title_type    ENUM('movie', 'book', 'any') NOT NULL DEFAULT 'any',
    status        ENUM('open', 'finalized', 'cancelled') NOT NULL DEFAULT 'open',
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finalized_at  TIMESTAMP NULL DEFAULT NULL,
    CONSTRAINT fk_sessions_host FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT uq_sessions_invite_code UNIQUE (invite_code),
    CONSTRAINT chk_sessions_code_len CHECK (CHAR_LENGTH(invite_code) >= 6)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- session_members : M:N users <-> sessions.
-- The host is inserted automatically by trg_sessions_after_insert.
-- -----------------------------------------------------------------------------
CREATE TABLE session_members (
    session_id  INT NOT NULL,
    user_id     INT NOT NULL,
    joined_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, user_id),
    CONSTRAINT fk_sm_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_sm_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- session_swipes : one member's like/dislike of one candidate title.
--
-- The composite FK to session_members is the important constraint here: it is
-- structurally impossible to swipe in a session you have not joined. v2 had
-- two independent FKs (to sessions and to users), which allowed any user id to
-- be paired with any session id.
-- -----------------------------------------------------------------------------
CREATE TABLE session_swipes (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    session_id  INT NOT NULL,
    user_id     INT NOT NULL,
    title_id    INT NOT NULL,
    liked       BOOLEAN NOT NULL,
    swiped_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ss_member FOREIGN KEY (session_id, user_id)
        REFERENCES session_members(session_id, user_id) ON DELETE CASCADE,
    CONSTRAINT fk_ss_title  FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE CASCADE,
    CONSTRAINT uq_ss_session_user_title UNIQUE (session_id, user_id, title_id)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- session_recs : the computed group recommendation set for a session.
--
-- rank_position lets a session hold an ordered shortlist rather than a single
-- winner. match_score is the cosine similarity of the title vector to the
-- group centroid (computed against MongoDB Atlas Vector Search);
-- agreement_pct is the pure-SQL swipe agreement from view_session_agreement.
-- -----------------------------------------------------------------------------
CREATE TABLE session_recs (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    session_id     INT NOT NULL,
    title_id       INT NOT NULL,
    rank_position  TINYINT UNSIGNED NOT NULL,
    match_score    DECIMAL(5,4) NOT NULL,
    agreement_pct  DECIMAL(5,2) NOT NULL,
    generated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_sr_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    CONSTRAINT fk_sr_title   FOREIGN KEY (title_id)   REFERENCES titles(id)   ON DELETE CASCADE,
    CONSTRAINT uq_sr_session_title UNIQUE (session_id, title_id),
    CONSTRAINT uq_sr_session_rank  UNIQUE (session_id, rank_position),
    CONSTRAINT chk_sr_agreement CHECK (agreement_pct BETWEEN 0 AND 100),
    CONSTRAINT chk_sr_match     CHECK (match_score BETWEEN -1 AND 1)
) ENGINE=InnoDB;

-- =============================================================================
-- SECTION 4 — Polyglot persistence bridge
-- =============================================================================

-- -----------------------------------------------------------------------------
-- title_embeddings : MySQL-side registry of the vectors that live in MongoDB.
--
-- The vector itself is NOT stored here. MySQL remains the system of record for
-- relational facts; MongoDB Atlas owns the 384-dimension embedding and the
-- approximate-nearest-neighbour index. This table records *that* a vector
-- exists, which model produced it, and whether it is stale — so the two stores
-- can be reconciled without scanning MongoDB.
--
-- When titles.description changes, trg_titles_after_update marks the row
-- 'stale' and the re-embedding worker picks it up.
-- -----------------------------------------------------------------------------
CREATE TABLE title_embeddings (
    title_id      INT NOT NULL PRIMARY KEY,
    model_name    VARCHAR(100) NOT NULL,
    dimensions    SMALLINT UNSIGNED NOT NULL,
    mongo_doc_id  CHAR(24) NULL,
    status        ENUM('pending', 'ready', 'stale', 'failed') NOT NULL DEFAULT 'pending',
    source_hash   CHAR(64) NULL,
    embedded_at   TIMESTAMP NULL DEFAULT NULL,
    updated_at    TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_te_title FOREIGN KEY (title_id) REFERENCES titles(id) ON DELETE CASCADE,
    CONSTRAINT chk_te_dims CHECK (dimensions BETWEEN 1 AND 4096)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- audit_log : who did what. Written by triggers and by the admin API.
-- actor_user_id is SET NULL so the audit trail survives account deletion.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    actor_user_id  INT NULL,
    action         VARCHAR(60) NOT NULL,
    entity_type    VARCHAR(40) NOT NULL,
    entity_id      INT NULL,
    detail         JSON NULL,
    occurred_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- =============================================================================
-- SECTION 5 — Indexes
--
-- MySQL auto-creates an index for every foreign key, and a composite UNIQUE
-- serves any leftmost-prefix lookup. v2 declared four indexes that merely
-- duplicated those (idx_ratings_title, idx_watchlist_title, idx_swipes_session,
-- idx_recs_session); they cost write throughput and bought nothing, so they
-- are gone. What remains are indexes that support an actual query plan.
-- =============================================================================

-- Catalogue browse: filter by type, order by rating.
CREATE INDEX idx_titles_type_rating ON titles(type, avg_rating DESC, rating_count DESC);

-- "Top rated overall" and the window-function view.
CREATE INDEX idx_titles_rating ON titles(avg_rating DESC, rating_count DESC);

-- Year-range filters in the catalogue.
CREATE INDEX idx_titles_year ON titles(release_year);

-- Title autocomplete / prefix search.
CREATE INDEX idx_titles_name ON titles(name);

-- Reconciliation sweep: "which embeddings need rebuilding?"
CREATE INDEX idx_embeddings_status ON title_embeddings(status);

-- Audit queries are almost always "latest first", often per actor.
CREATE INDEX idx_audit_time  ON audit_log(occurred_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, occurred_at DESC);

-- Keyword baseline. These are deliberately contrasted with MongoDB vector
-- search in the report: FULLTEXT matches words, the vector index matches
-- meaning. 05_queries.sql runs the same user intent through both.
CREATE FULLTEXT INDEX ft_titles_description ON titles(name, description);
CREATE FULLTEXT INDEX ft_ratings_review     ON ratings(review_text);
