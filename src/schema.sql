-- stockroom schema. One SQLite file holds the whole catalog.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Labeled bins: every file on every shelf, with a fingerprint and a summary.
CREATE TABLE files (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,   -- relative to the root, with forward slashes
  shelf      TEXT NOT NULL,          -- the shelf it came from, like "site" or "guidance"
  kind       TEXT NOT NULL,          -- code | guidance | example | asset
  lang       TEXT,                   -- html | css | js | md | svg | json | text
  applies_to TEXT NOT NULL,          -- ",web,slides," or "" for everything
  bytes      INTEGER NOT NULL,
  lines      INTEGER,
  sha256     TEXT NOT NULL,
  summary    TEXT,
  body       TEXT                    -- NULL for binary assets
);

-- The index at the back of the catalog. Trigram tokens let a search jump
-- straight to the files that contain a piece of text, typos included.
CREATE VIRTUAL TABLE file_text USING fts5(body, tokenize = 'trigram', content = '');

-- Guidance split at its headings, so a station can read one rule instead of a binder.
CREATE TABLE sections (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id),
  heading    TEXT NOT NULL,
  trail      TEXT NOT NULL,          -- "Arrows > Callout arrows"
  level      INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL
);
CREATE INDEX sections_file ON sections(file_id);

-- Part numbers: every name that is defined or used, and where.
CREATE TABLE symbols (
  file_id INTEGER NOT NULL REFERENCES files(id),
  name    TEXT NOT NULL,             -- .card, #menu, --primary, addToCart, #c2410c
  kind    TEXT NOT NULL,             -- class | id | token | function | color
  role    TEXT NOT NULL,             -- def | use
  line    INTEGER NOT NULL,
  scope   TEXT,                      -- where a token is defined, like [data-theme="dark"]
  value   TEXT                       -- a token's value, like #c2410c
);
CREATE INDEX symbols_name ON symbols(name);
CREATE INDEX symbols_file ON symbols(file_id);

-- The where-used list: every link from one file to another, resolved once.
CREATE TABLE refs (
  from_id INTEGER NOT NULL REFERENCES files(id),
  line    INTEGER NOT NULL,
  kind    TEXT NOT NULL,             -- stylesheet | script | include | image | font | link | import | data | ...
  raw     TEXT NOT NULL,             -- exactly what the file says
  target  TEXT,                      -- the resolved path, or the URL if external
  status  TEXT NOT NULL              -- ok | missing | outside | skipped | external | package
);
CREATE INDEX refs_target ON refs(target);
CREATE INDEX refs_from ON refs(from_id);

-- Approved and rejected examples, and why.
CREATE TABLE examples (
  file_id INTEGER NOT NULL REFERENCES files(id),
  topic   TEXT NOT NULL,             -- illustration | slides | web | ...
  verdict TEXT NOT NULL,             -- approved | rejected
  note    TEXT,
  note_path TEXT                     -- the sidecar .md the note came from, if any
);

-- Blind spots: what the clerk left out on purpose, and why.
CREATE TABLE skipped (
  path   TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
