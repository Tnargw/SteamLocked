-- Players, for the leaderboard.
--
-- Name and avatar are cached here so rendering a 50-row board costs one query
-- instead of 50 calls to GetPlayerSummaries. They are refreshed whenever the
-- player loads their profile.
--
-- `listed` defaults to 1: players appear on the global board unless they turn
-- it off in settings.
CREATE TABLE IF NOT EXISTS players (
  steamid    TEXT    PRIMARY KEY,
  name       TEXT,
  avatar     TEXT,
  listed     INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

-- Ranking reads only listed players, ordered by score.
CREATE INDEX IF NOT EXISTS idx_players_listed ON players (listed);

-- The leaderboard aggregates completed_tasks per player, so it needs a cheap
-- path from steamid to that player's completions.
CREATE INDEX IF NOT EXISTS idx_completed_by_player ON completed_tasks (steamid);
