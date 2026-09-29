-- Server-side task state, so a player's progress follows them between devices.
-- Keyed by SteamID64, which is the only identity the session token carries.

-- At most one active task per (player, game) — the Taskman lock, enforced by
-- the primary key rather than by application code.
CREATE TABLE IF NOT EXISTS active_tasks (
  steamid        TEXT    NOT NULL,
  appid          INTEGER NOT NULL,
  achievement    TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  description    TEXT    NOT NULL DEFAULT '',
  icon           TEXT,
  tier           TEXT    NOT NULL DEFAULT 'unknown',
  global_percent REAL,
  rolled_at      INTEGER NOT NULL,
  PRIMARY KEY (steamid, appid)
);

-- The completion log. The composite key makes double-crediting the same
-- achievement impossible, however many times a client retries.
CREATE TABLE IF NOT EXISTS completed_tasks (
  steamid        TEXT    NOT NULL,
  appid          INTEGER NOT NULL,
  achievement    TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  icon           TEXT,
  tier           TEXT    NOT NULL DEFAULT 'unknown',
  global_percent REAL,
  rolled_at      INTEGER,
  completed_at   INTEGER NOT NULL,
  PRIMARY KEY (steamid, appid, achievement)
);

CREATE INDEX IF NOT EXISTS idx_completed_recent
  ON completed_tasks (steamid, completed_at DESC);

-- Skips are counted so they cost something.
CREATE TABLE IF NOT EXISTS game_skips (
  steamid TEXT    NOT NULL,
  appid   INTEGER NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (steamid, appid)
);
