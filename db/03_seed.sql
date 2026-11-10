-- =============================================================================
-- PlotMatch — File 3 of 6 : Seed data
-- Run after 02_programmability.sql
--
-- The triggers from file 2 are already live, so avg_rating / rating_count are
-- computed automatically as the ratings below are inserted, and every title
-- gets a 'pending' row in title_embeddings. Nothing here sets those columns by
-- hand — that is the point of the demo.
--
-- Demo credentials (password hashes are real scrypt digests, not placeholders):
--   admin@plotmatch.dev / Admin@123    role: admin
--   mod@plotmatch.dev   / Mod@12345    role: moderator
--   sai@plotmatch.dev   / Sai@12345    role: user
--   ravi@plotmatch.dev  / Ravi@1234    role: user
--   neha@plotmatch.dev  / Neha@1234    role: user
--   arjun@plotmatch.dev / Arjun@123    role: user
--   divya@plotmatch.dev / Divya@123    role: user
-- =============================================================================

USE plotmatch;

-- =============================================================================
-- Roles and permissions (rubric item 6: minimum two roles)
-- =============================================================================

INSERT INTO roles (name, description) VALUES
    ('admin',     'Full control: catalogue, users, roles, embeddings, audit trail'),
    ('moderator', 'Curates the catalogue and moderates reviews; cannot manage users'),
    ('user',      'Standard member: rate, build a watchlist, run group sessions');

INSERT INTO permissions (code, description) VALUES
    ('title.create',      'Add a title to the catalogue'),
    ('title.update',      'Edit catalogue metadata'),
    ('title.archive',     'Soft-delete a title'),
    ('title.delete',      'Hard-delete a title'),
    ('rating.write',      'Create or update own rating'),
    ('rating.moderate',   'Remove any user review'),
    ('watchlist.write',   'Manage own watchlist'),
    ('session.create',    'Open a group discovery session'),
    ('user.manage_roles', 'Change another account role'),
    ('user.deactivate',   'Disable an account'),
    ('embedding.rebuild', 'Trigger re-embedding of the catalogue'),
    ('audit.read',        'Read the audit trail');

-- admin: everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'admin';

-- moderator: catalogue curation + review moderation + ordinary member rights
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
WHERE r.name = 'moderator'
  AND p.code IN ('title.create','title.update','title.archive','rating.moderate',
                 'rating.write','watchlist.write','session.create');

-- user: own data only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
WHERE r.name = 'user'
  AND p.code IN ('rating.write','watchlist.write','session.create');

-- =============================================================================
-- Users
-- Hashes are scrypt (Node's built-in crypto.scryptSync), format:
--   scrypt$N:r:p$salt$derivedkey
-- =============================================================================

INSERT INTO users (name, email, password_hash, role_id) VALUES
('Admin',        'admin@plotmatch.dev', 'scrypt$16384:8:1$5c3902108d87cfed1e693084e2a3ff83$19191e13bc68449708219e37e8fcfdde0006e839ba37721658de1f69a5269914ec1fb96feee5b800837fe7a10b0ad5c363ebbbda3454a722d6ee0a7cba8ea9db', (SELECT id FROM roles WHERE name='admin')),
('Meera Nair',   'mod@plotmatch.dev',   'scrypt$16384:8:1$571ab5a540e85239d197e4e50a290209$318c078c0062cb2bfd8df65531218712e307cd39ec67a361ae81279224a996f27c8209fee080517e6db0cd4c6aaf7a4f416c34dd5a608d17a47c177c676b5c5c', (SELECT id FROM roles WHERE name='moderator')),
('Sai',          'sai@plotmatch.dev',   'scrypt$16384:8:1$da0019e1440599a2a3568c1739d51eba$94766f966b3053840182bd44091ab67f3eb1c29e617eff5ebf8b03695be5deb8150a56c4730dd0ba18742f8ac82a59e18b5fde03bc703c0d55a18eb2fa1bab9b', (SELECT id FROM roles WHERE name='user')),
('Ravi Kumar',   'ravi@plotmatch.dev',  'scrypt$16384:8:1$8ab74129398c3e4df1014421e3601702$244260b0442357e264f55e0704bb6491619f054cac5191a45a148d746d5475a6fa69bddf87bb30c8ec9afe38f8d2068b935a2bdc5ddc2ab0c47b72a0e3edcc87', (SELECT id FROM roles WHERE name='user')),
('Neha Shetty',  'neha@plotmatch.dev',  'scrypt$16384:8:1$c23d817f30d7b61fea323f1f506cae18$abd07ab0c4abe1c7ee9b39f3ec610505d6655d778cfcb774cd8000ebb41ffd6a5da449a2385bb2131cbaa7a4758a761b9aed607d8c7f86d6a2d3416c9dccde49', (SELECT id FROM roles WHERE name='user')),
('Arjun Rao',    'arjun@plotmatch.dev', 'scrypt$16384:8:1$a2beb3d31dda42924271e5aa638f8397$ae954b368a77bbaa009f7dbe2af90e882bf3b64d8662ff61f5f45ba8386b8a457f4e7490e140b957fd7cbe7aef91a70a53586b864a9bcd14c0c2353ed3ba7a20', (SELECT id FROM roles WHERE name='user')),
('Divya Menon',  'divya@plotmatch.dev', 'scrypt$16384:8:1$1b4a2ac31f09e63519e71c0206d64d08$89314b997a32b620ed25402f5b8aa691bbbf687a0399332f767fecfcdbdf4c0dca37de734c991e531d6193270c539936bb134f13e298e21a9b8e008a27dc5720', (SELECT id FROM roles WHERE name='user'));

-- =============================================================================
-- Genres
-- =============================================================================

INSERT INTO genres (name) VALUES
('Science Fiction'), ('Thriller'), ('Drama'), ('Fantasy'), ('Mystery'),
('Romance'), ('Historical'), ('Horror'), ('Comedy'), ('Adventure'),
('Literary Fiction'), ('Dystopian');

-- =============================================================================
-- Titles — a deliberately mixed catalogue so that "semantic" search has
-- something to prove. Note the pre-1800 books: the v2 CHECK constraint
-- (release_year BETWEEN 1800 AND 2100) would have rejected these outright.
-- =============================================================================

INSERT INTO titles (name, type, release_year, description) VALUES
-- Movies
('Arrival', 'movie', 2016,
 'A linguist is recruited by the military to communicate with alien visitors, and discovers that learning their language reshapes her perception of time, memory and loss.'),
('Blade Runner 2049', 'movie', 2017,
 'A young blade runner uncovers a secret buried for decades that could plunge what remains of society into chaos, and sets out to find a man who has been missing for thirty years.'),
('Parasite', 'movie', 2019,
 'A poor family schemes to become employed by a wealthy household by posing as unrelated, highly qualified individuals, until a hidden occupant upends everything.'),
('The Prestige', 'movie', 2006,
 'Two rival stage magicians in Victorian London destroy each other in an escalating obsession to produce the perfect illusion.'),
('Interstellar', 'movie', 2014,
 'With Earth dying, a former pilot leads a mission through a wormhole to find humanity a new home, trading years of his daughter''s life for every hour near a black hole.'),
('Knives Out', 'movie', 2019,
 'A private detective investigates the death of a wealthy crime novelist, sifting through a family of suspects who all had reason to want him gone.'),
('Spirited Away', 'movie', 2001,
 'A sullen ten-year-old girl wanders into a world of spirits and must work in a bathhouse to free her parents and recover her own name.'),
('Get Out', 'movie', 2017,
 'A young photographer visits his girlfriend''s family estate for the weekend and uncovers a horror beneath their relentless politeness.'),
('Everything Everywhere All at Once', 'movie', 2022,
 'An exhausted laundromat owner is pulled into a multiverse conflict and must connect with the lives she did not live in order to save the one she did.'),
('Children of Men', 'movie', 2006,
 'In a world where humans have become infertile and society is collapsing, a disillusioned bureaucrat must escort the only pregnant woman alive to safety.'),
('The Grand Budapest Hotel', 'movie', 2014,
 'A legendary concierge and his trusted lobby boy become entangled in the theft of a priceless painting and the battle for a family fortune.'),
('Oppenheimer', 'movie', 2023,
 'The physicist who led the Manhattan Project reckons with the weapon he built and the political machinery that turns on him afterwards.'),
-- Books
('Project Hail Mary', 'book', 2021,
 'A lone astronaut wakes with no memory aboard a spacecraft and must solve an extinction-level scientific problem, aided by an unexpected companion.'),
('The Three-Body Problem', 'book', 2008,
 'During the Cultural Revolution a secret military project makes contact with an alien civilisation, setting in motion a confrontation across centuries.'),
('Klara and the Sun', 'book', 2021,
 'An artificial friend in a shop window observes human behaviour with great care, and is bought to keep a chronically ill girl company.'),
('Never Let Me Go', 'book', 2005,
 'Three friends raised at a sheltered English boarding school slowly discover the purpose for which they were created.'),
('The Name of the Wind', 'book', 2007,
 'A gifted and arrogant young man recounts how he became the most notorious magician of his age, from street orphan to university student.'),
('Gone Girl', 'book', 2012,
 'On their fifth wedding anniversary a woman disappears, and her husband becomes the prime suspect as the story of their marriage is retold from both sides.'),
('Dune', 'book', 1965,
 'The heir to a noble house is cast into the politics of a desert planet that is the sole source of the most valuable substance in the universe.'),
('The Remains of the Day', 'book', 1989,
 'An English butler takes a motoring holiday and reflects on a lifetime of service, dignity and the love he declined to acknowledge.'),
('Piranesi', 'book', 2020,
 'A man lives in an endless house of statues and tides, keeping meticulous journals, until evidence of another life begins to surface.'),
('Frankenstein', 'book', 1818,
 'A young natural philosopher animates a creature from dead matter and abandons it, with consequences that pursue him to the ends of the earth.'),
('Pride and Prejudice', 'book', 1813,
 'A sharp-witted young woman and a proud landowner misjudge each other repeatedly in a society organised entirely around marriage and money.'),
('The Odyssey', 'book', -750,
 'After the fall of Troy a king spends ten years trying to return home, outwitting monsters and gods while his household is besieged by suitors.');

-- =============================================================================
-- Genre assignments
-- =============================================================================

INSERT INTO title_genres (title_id, genre_id)
SELECT t.id, g.id
FROM (
    SELECT 'Arrival' AS title_name, 'Science Fiction' AS genre_name UNION ALL
    SELECT 'Arrival', 'Drama'                                        UNION ALL
    SELECT 'Blade Runner 2049', 'Science Fiction'                    UNION ALL
    SELECT 'Blade Runner 2049', 'Mystery'                            UNION ALL
    SELECT 'Parasite', 'Thriller'                                    UNION ALL
    SELECT 'Parasite', 'Drama'                                       UNION ALL
    SELECT 'Parasite', 'Comedy'                                      UNION ALL
    SELECT 'The Prestige', 'Mystery'                                 UNION ALL
    SELECT 'The Prestige', 'Drama'                                   UNION ALL
    SELECT 'Interstellar', 'Science Fiction'                         UNION ALL
    SELECT 'Interstellar', 'Adventure'                               UNION ALL
    SELECT 'Knives Out', 'Mystery'                                   UNION ALL
    SELECT 'Knives Out', 'Comedy'                                    UNION ALL
    SELECT 'Spirited Away', 'Fantasy'                                UNION ALL
    SELECT 'Spirited Away', 'Adventure'                              UNION ALL
    SELECT 'Get Out', 'Horror'                                       UNION ALL
    SELECT 'Get Out', 'Thriller'                                     UNION ALL
    SELECT 'Everything Everywhere All at Once', 'Science Fiction'    UNION ALL
    SELECT 'Everything Everywhere All at Once', 'Comedy'             UNION ALL
    SELECT 'Children of Men', 'Dystopian'                            UNION ALL
    SELECT 'Children of Men', 'Thriller'                             UNION ALL
    SELECT 'The Grand Budapest Hotel', 'Comedy'                      UNION ALL
    SELECT 'The Grand Budapest Hotel', 'Adventure'                   UNION ALL
    SELECT 'Oppenheimer', 'Historical'                               UNION ALL
    SELECT 'Oppenheimer', 'Drama'                                    UNION ALL
    SELECT 'Project Hail Mary', 'Science Fiction'                    UNION ALL
    SELECT 'Project Hail Mary', 'Adventure'                          UNION ALL
    SELECT 'The Three-Body Problem', 'Science Fiction'               UNION ALL
    SELECT 'Klara and the Sun', 'Science Fiction'                    UNION ALL
    SELECT 'Klara and the Sun', 'Literary Fiction'                   UNION ALL
    SELECT 'Never Let Me Go', 'Dystopian'                            UNION ALL
    SELECT 'Never Let Me Go', 'Literary Fiction'                     UNION ALL
    SELECT 'The Name of the Wind', 'Fantasy'                         UNION ALL
    SELECT 'The Name of the Wind', 'Adventure'                       UNION ALL
    SELECT 'Gone Girl', 'Thriller'                                   UNION ALL
    SELECT 'Gone Girl', 'Mystery'                                    UNION ALL
    SELECT 'Dune', 'Science Fiction'                                 UNION ALL
    SELECT 'Dune', 'Adventure'                                       UNION ALL
    SELECT 'The Remains of the Day', 'Literary Fiction'              UNION ALL
    SELECT 'The Remains of the Day', 'Historical'                    UNION ALL
    SELECT 'Piranesi', 'Fantasy'                                     UNION ALL
    SELECT 'Piranesi', 'Mystery'                                     UNION ALL
    SELECT 'Frankenstein', 'Horror'                                  UNION ALL
    SELECT 'Frankenstein', 'Science Fiction'                         UNION ALL
    SELECT 'Pride and Prejudice', 'Romance'                          UNION ALL
    SELECT 'Pride and Prejudice', 'Literary Fiction'                 UNION ALL
    SELECT 'The Odyssey', 'Adventure'                                UNION ALL
    SELECT 'The Odyssey', 'Historical'
) m
JOIN titles t ON t.name = m.title_name
JOIN genres g ON g.name = m.genre_name;

-- =============================================================================
-- People and credits
--
-- trg_title_people_before_insert enforces that books take 'author' and movies
-- take 'director'/'actor'. Try adding a director to Dune and it will raise
-- SQLSTATE 45000 — a two-table rule that no CHECK constraint can express.
-- =============================================================================

INSERT INTO people (name) VALUES
('Denis Villeneuve'), ('Bong Joon-ho'), ('Christopher Nolan'), ('Rian Johnson'),
('Hayao Miyazaki'), ('Jordan Peele'), ('Alfonso Cuaron'), ('Wes Anderson'),
('Amy Adams'), ('Ryan Gosling'), ('Song Kang-ho'), ('Daniel Kaluuya'),
('Michelle Yeoh'), ('Cillian Murphy'), ('Michael Caine'), ('Christian Bale'),
('Andy Weir'), ('Liu Cixin'), ('Kazuo Ishiguro'), ('Patrick Rothfuss'),
('Gillian Flynn'), ('Frank Herbert'), ('Susanna Clarke'), ('Mary Shelley'),
('Jane Austen'), ('Homer');

INSERT INTO title_people (title_id, person_id, role, billing)
SELECT t.id, p.id, m.role, m.billing
FROM (
    SELECT 'Arrival' AS title_name, 'Denis Villeneuve' AS person_name, 'director' AS role, NULL AS billing UNION ALL
    SELECT 'Arrival', 'Amy Adams', 'actor', 1                                   UNION ALL
    SELECT 'Blade Runner 2049', 'Denis Villeneuve', 'director', NULL            UNION ALL
    SELECT 'Blade Runner 2049', 'Ryan Gosling', 'actor', 1                      UNION ALL
    SELECT 'Parasite', 'Bong Joon-ho', 'director', NULL                         UNION ALL
    SELECT 'Parasite', 'Song Kang-ho', 'actor', 1                               UNION ALL
    SELECT 'The Prestige', 'Christopher Nolan', 'director', NULL                UNION ALL
    SELECT 'The Prestige', 'Christian Bale', 'actor', 1                         UNION ALL
    SELECT 'Interstellar', 'Christopher Nolan', 'director', NULL                UNION ALL
    -- Michael Caine appears in all three of these, which is what gives the
    -- recursive "degrees of separation" query in 05_queries.sql a real
    -- multi-hop path to walk.
    SELECT 'The Prestige', 'Michael Caine', 'actor', 2                          UNION ALL
    SELECT 'Interstellar', 'Michael Caine', 'actor', 2                          UNION ALL
    SELECT 'Children of Men', 'Michael Caine', 'actor', 2                       UNION ALL
    SELECT 'Oppenheimer', 'Christopher Nolan', 'director', NULL                 UNION ALL
    SELECT 'Oppenheimer', 'Cillian Murphy', 'actor', 1                          UNION ALL
    SELECT 'Knives Out', 'Rian Johnson', 'director', NULL                       UNION ALL
    SELECT 'Spirited Away', 'Hayao Miyazaki', 'director', NULL                  UNION ALL
    SELECT 'Get Out', 'Jordan Peele', 'director', NULL                          UNION ALL
    SELECT 'Get Out', 'Daniel Kaluuya', 'actor', 1                              UNION ALL
    SELECT 'Everything Everywhere All at Once', 'Michelle Yeoh', 'actor', 1     UNION ALL
    SELECT 'Children of Men', 'Alfonso Cuaron', 'director', NULL                UNION ALL
    SELECT 'The Grand Budapest Hotel', 'Wes Anderson', 'director', NULL         UNION ALL
    SELECT 'Project Hail Mary', 'Andy Weir', 'author', NULL                     UNION ALL
    SELECT 'The Three-Body Problem', 'Liu Cixin', 'author', NULL                UNION ALL
    SELECT 'Klara and the Sun', 'Kazuo Ishiguro', 'author', NULL                UNION ALL
    SELECT 'Never Let Me Go', 'Kazuo Ishiguro', 'author', NULL                  UNION ALL
    SELECT 'The Remains of the Day', 'Kazuo Ishiguro', 'author', NULL           UNION ALL
    SELECT 'The Name of the Wind', 'Patrick Rothfuss', 'author', NULL           UNION ALL
    SELECT 'Gone Girl', 'Gillian Flynn', 'author', NULL                         UNION ALL
    SELECT 'Dune', 'Frank Herbert', 'author', NULL                              UNION ALL
    SELECT 'Piranesi', 'Susanna Clarke', 'author', NULL                         UNION ALL
    SELECT 'Frankenstein', 'Mary Shelley', 'author', NULL                       UNION ALL
    SELECT 'Pride and Prejudice', 'Jane Austen', 'author', NULL                 UNION ALL
    SELECT 'The Odyssey', 'Homer', 'author', NULL
) m
JOIN titles t ON t.name = m.title_name
JOIN people p ON p.name = m.person_name;

-- =============================================================================
-- Ratings
--
-- These INSERTs fire trg_ratings_after_insert, which calls
-- sp_recalc_title_stats. Nothing below writes avg_rating or rating_count
-- directly — that is the whole point of the demonstration.
-- =============================================================================

-- MySQL refuses to let a trigger UPDATE a table that the statement which
-- fired the trigger is already reading. This INSERT fires
-- trg_ratings_after_insert, which calls sp_recalc_title_stats to update
-- `titles` -- so the INSERT must not itself read `titles`, or it fails with
--   ERROR 1442: Can't update table 'titles' in stored function/trigger
--               because it is already used by the statement which invoked it
-- Resolving the title ids into a temporary table first keeps `titles` out of
-- the invoking statement, so the trigger is free to update it. The
-- application never hits this: sp_upsert_rating inserts explicit ids and
-- never joins to `titles`.
CREATE TEMPORARY TABLE tmp_title_ids AS SELECT id, name FROM titles;

INSERT INTO ratings (user_id, title_id, score, review_text)
SELECT u.id, t.id, m.score, m.review_text
FROM (
    SELECT 'sai@plotmatch.dev'  AS email, 'Arrival' AS title_name, 5 AS score, 'The structure rewires itself on a second viewing. Quietly devastating.' AS review_text UNION ALL
    SELECT 'sai@plotmatch.dev',  'Interstellar', 4, 'The docking sequence alone justifies the running time.'                  UNION ALL
    SELECT 'sai@plotmatch.dev',  'Project Hail Mary', 5, 'Problem-solving as pure joy. The alien companion steals the book.'  UNION ALL
    SELECT 'sai@plotmatch.dev',  'Dune', 4, 'Dense and political, but the world holds together completely.'                   UNION ALL
    SELECT 'sai@plotmatch.dev',  'Parasite', 5, 'Every shot earns its place. The tonal shift is perfectly judged.'            UNION ALL
    SELECT 'ravi@plotmatch.dev', 'Arrival', 4, 'Beautiful, though the military subplot drags.'                                UNION ALL
    SELECT 'ravi@plotmatch.dev', 'Blade Runner 2049', 5, 'Patient, enormous and lonely. Astonishing to look at.'              UNION ALL
    SELECT 'ravi@plotmatch.dev', 'The Three-Body Problem', 5, 'The physics is the plot. Ambitious in a way few books are.'    UNION ALL
    SELECT 'ravi@plotmatch.dev', 'Oppenheimer', 4, 'The hearing scenes carry more tension than the test.'                     UNION ALL
    SELECT 'ravi@plotmatch.dev', 'Dune', 5, 'Still the benchmark for world-building.'                                         UNION ALL
    SELECT 'neha@plotmatch.dev', 'Klara and the Sun', 5, 'The narrator notices everything and understands almost none of it.' UNION ALL
    SELECT 'neha@plotmatch.dev', 'Never Let Me Go', 5, 'Restraint doing the work of horror.'                                  UNION ALL
    SELECT 'neha@plotmatch.dev', 'The Remains of the Day', 5, 'A man explaining away his own life, one page at a time.'       UNION ALL
    SELECT 'neha@plotmatch.dev', 'Piranesi', 4, 'Strange and gentle. The house is the best character.'                        UNION ALL
    SELECT 'neha@plotmatch.dev', 'Arrival', 5, 'The only film that has made me cry about linguistics.'                        UNION ALL
    SELECT 'arjun@plotmatch.dev','Knives Out', 4, 'A genuinely fair mystery, which is rarer than it should be.'               UNION ALL
    SELECT 'arjun@plotmatch.dev','Gone Girl', 4, 'The midpoint turn is a masterclass in withheld information.'                UNION ALL
    SELECT 'arjun@plotmatch.dev','The Prestige', 5, 'Obsession as a closed loop. Rewards rewatching.'                         UNION ALL
    SELECT 'arjun@plotmatch.dev','Get Out', 4, 'Funny until it absolutely is not.'                                            UNION ALL
    SELECT 'arjun@plotmatch.dev','Parasite', 5, 'Deserved everything it won.'                                                 UNION ALL
    SELECT 'divya@plotmatch.dev','Spirited Away', 5, 'Grew up on it and it still opens up further every time.'                UNION ALL
    SELECT 'divya@plotmatch.dev','The Grand Budapest Hotel', 4, 'Melancholy hiding inside a dollhouse.'                       UNION ALL
    SELECT 'divya@plotmatch.dev','Pride and Prejudice', 5, 'The dialogue is sharper than most things written now.'            UNION ALL
    SELECT 'divya@plotmatch.dev','The Name of the Wind', 3, 'Gorgeous prose attached to a protagonist who is never wrong.'    UNION ALL
    SELECT 'divya@plotmatch.dev','Everything Everywhere All at Once', 5, 'Chaotic, and then suddenly about your mother.'      UNION ALL
    SELECT 'mod@plotmatch.dev',  'Frankenstein', 5, 'The creature is the most articulate character in the book.'              UNION ALL
    SELECT 'mod@plotmatch.dev',  'Children of Men', 5, 'The long takes make the despair feel procedural.'                     UNION ALL
    SELECT 'mod@plotmatch.dev',  'The Odyssey', 4, 'The oldest road novel there is.'                                          UNION ALL
    SELECT 'mod@plotmatch.dev',  'Arrival', 4, 'Rare science fiction about understanding rather than conquest.'               UNION ALL
    SELECT 'mod@plotmatch.dev',  'Dune', 3, 'Admire it more than I enjoy it.'
) m
JOIN users  u ON u.email = m.email
JOIN tmp_title_ids t ON t.name = m.title_name;

DROP TEMPORARY TABLE tmp_title_ids;

-- =============================================================================
-- Watchlists
-- =============================================================================

INSERT INTO watchlist (user_id, title_id)
SELECT u.id, t.id
FROM (
    SELECT 'sai@plotmatch.dev'  AS email, 'Piranesi' AS title_name  UNION ALL
    SELECT 'sai@plotmatch.dev',  'Klara and the Sun'                UNION ALL
    SELECT 'sai@plotmatch.dev',  'Oppenheimer'                      UNION ALL
    SELECT 'ravi@plotmatch.dev', 'Project Hail Mary'                UNION ALL
    SELECT 'ravi@plotmatch.dev', 'Everything Everywhere All at Once' UNION ALL
    SELECT 'neha@plotmatch.dev', 'Frankenstein'                     UNION ALL
    SELECT 'neha@plotmatch.dev', 'Gone Girl'                        UNION ALL
    SELECT 'arjun@plotmatch.dev','The Three-Body Problem'           UNION ALL
    SELECT 'divya@plotmatch.dev','Never Let Me Go'
) m
JOIN users  u ON u.email = m.email
JOIN titles t ON t.name  = m.title_name;

-- =============================================================================
-- Group sessions
--
-- MOVIE001 is a movie night with full participation.
-- BOOKCLUB is open and mid-swipe (Arjun has not voted yet), so the UI has a
-- live room to demonstrate and fn_session_quorum_met returns FALSE for it.
--
-- Note that nothing below adds a host to session_members — that is
-- trg_sessions_after_insert's job.
-- =============================================================================

INSERT INTO sessions (host_user_id, invite_code, title_type, status) VALUES
((SELECT id FROM users WHERE email = 'sai@plotmatch.dev'),  'MOVIE001', 'movie', 'open'),
((SELECT id FROM users WHERE email = 'neha@plotmatch.dev'), 'BOOKCLUB', 'book',  'open');

INSERT INTO session_members (session_id, user_id)
SELECT s.id, u.id
FROM (
    SELECT 'MOVIE001' AS code, 'ravi@plotmatch.dev'  AS email UNION ALL
    SELECT 'MOVIE001', 'neha@plotmatch.dev'                   UNION ALL
    SELECT 'BOOKCLUB', 'sai@plotmatch.dev'                    UNION ALL
    SELECT 'BOOKCLUB', 'divya@plotmatch.dev'                  UNION ALL
    SELECT 'BOOKCLUB', 'arjun@plotmatch.dev'
) m
JOIN sessions s ON s.invite_code = m.code
JOIN users    u ON u.email       = m.email;

-- The composite FK means every row here must match a real membership; an
-- unjoined user cannot be inserted even by accident.
INSERT INTO session_swipes (session_id, user_id, title_id, liked)
SELECT s.id, u.id, t.id, m.liked
FROM (
    SELECT 'MOVIE001' AS code, 'sai@plotmatch.dev' AS email, 'Arrival' AS title_name, TRUE AS liked UNION ALL
    SELECT 'MOVIE001', 'ravi@plotmatch.dev',  'Arrival', TRUE            UNION ALL
    SELECT 'MOVIE001', 'neha@plotmatch.dev',  'Arrival', TRUE            UNION ALL
    SELECT 'MOVIE001', 'sai@plotmatch.dev',   'Interstellar', TRUE       UNION ALL
    SELECT 'MOVIE001', 'ravi@plotmatch.dev',  'Interstellar', FALSE      UNION ALL
    SELECT 'MOVIE001', 'neha@plotmatch.dev',  'Interstellar', FALSE      UNION ALL
    SELECT 'MOVIE001', 'sai@plotmatch.dev',   'Parasite', TRUE           UNION ALL
    SELECT 'MOVIE001', 'ravi@plotmatch.dev',  'Parasite', TRUE           UNION ALL
    SELECT 'MOVIE001', 'neha@plotmatch.dev',  'Parasite', FALSE          UNION ALL
    SELECT 'MOVIE001', 'sai@plotmatch.dev',   'Get Out', FALSE           UNION ALL
    SELECT 'MOVIE001', 'ravi@plotmatch.dev',  'Get Out', FALSE           UNION ALL
    SELECT 'MOVIE001', 'neha@plotmatch.dev',  'Get Out', TRUE            UNION ALL
    SELECT 'MOVIE001', 'sai@plotmatch.dev',   'Blade Runner 2049', TRUE  UNION ALL
    SELECT 'MOVIE001', 'ravi@plotmatch.dev',  'Blade Runner 2049', TRUE  UNION ALL
    SELECT 'MOVIE001', 'neha@plotmatch.dev',  'Blade Runner 2049', FALSE UNION ALL
    SELECT 'BOOKCLUB', 'neha@plotmatch.dev',  'Klara and the Sun', TRUE  UNION ALL
    SELECT 'BOOKCLUB', 'sai@plotmatch.dev',   'Klara and the Sun', TRUE  UNION ALL
    SELECT 'BOOKCLUB', 'divya@plotmatch.dev', 'Klara and the Sun', TRUE  UNION ALL
    SELECT 'BOOKCLUB', 'neha@plotmatch.dev',  'Piranesi', TRUE           UNION ALL
    SELECT 'BOOKCLUB', 'sai@plotmatch.dev',   'Piranesi', TRUE           UNION ALL
    SELECT 'BOOKCLUB', 'divya@plotmatch.dev', 'Piranesi', FALSE          UNION ALL
    SELECT 'BOOKCLUB', 'neha@plotmatch.dev',  'Dune', FALSE              UNION ALL
    SELECT 'BOOKCLUB', 'sai@plotmatch.dev',   'Dune', TRUE               UNION ALL
    SELECT 'BOOKCLUB', 'divya@plotmatch.dev', 'Dune', FALSE              UNION ALL
    SELECT 'BOOKCLUB', 'neha@plotmatch.dev',  'Gone Girl', FALSE         UNION ALL
    SELECT 'BOOKCLUB', 'sai@plotmatch.dev',   'Gone Girl', FALSE
) m
JOIN sessions s ON s.invite_code = m.code
JOIN users    u ON u.email       = m.email
JOIN titles   t ON t.name        = m.title_name;

-- =============================================================================
-- Post-seed verification — confirms the triggers did the work
-- =============================================================================

-- 1. Derived columns populated by triggers, never written by hand:
SELECT name, avg_rating, rating_count
FROM titles WHERE rating_count > 0
ORDER BY avg_rating DESC, rating_count DESC
LIMIT 10;

-- 2. Hosts auto-seated by trg_sessions_after_insert:
SELECT s.invite_code, u.name AS member, (u.id = s.host_user_id) AS is_host
FROM session_members sm
JOIN sessions s ON s.id = sm.session_id
JOIN users    u ON u.id = sm.user_id
ORDER BY s.invite_code, is_host DESC;

-- 3. Every title registered for embedding by trg_titles_after_insert:
SELECT status, COUNT(*) AS n FROM title_embeddings GROUP BY status;
