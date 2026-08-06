-- roleplay-agent schema (PostgreSQL 11 compatible)
-- Layers:
--   persona           : structured personas (immutable core layer)
--   memory_summaries  : long-term story memory (layer 2, retrieval-injected)
--   scene_state       : per-session mutable state (layer 3)
--   worldbook         : worldbuilding / lore entries
--   sessions/messages : chat logs

CREATE TABLE IF NOT EXISTS persona (
  id           TEXT PRIMARY KEY,
  version      INTEGER NOT NULL DEFAULT 1,
  display_name TEXT NOT NULL,
  doc          JSONB NOT NULL,
  core_prompt  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  persona_id      TEXT NOT NULL REFERENCES persona(id),
  title           TEXT,
  pi_session_file TEXT,
  turn_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn       INTEGER NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content    TEXT NOT NULL,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS memory_summaries (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event','relationship','foreshadow','fact')),
  summary    TEXT NOT NULL,
  entities   TEXT[] NOT NULL DEFAULT '{}',
  tags       TEXT[] NOT NULL DEFAULT '{}',
  importance SMALLINT NOT NULL DEFAULT 2 CHECK (importance BETWEEN 1 AND 5),
  source     TEXT NOT NULL DEFAULT 'turn' CHECK (source IN ('turn','compaction','tool')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_entities ON memory_summaries USING GIN (entities);
CREATE INDEX IF NOT EXISTS idx_memory_tags ON memory_summaries USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_summaries(created_at DESC);

CREATE TABLE IF NOT EXISTS scene_state (
  session_id         TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  location           TEXT NOT NULL DEFAULT '',
  time_label         TEXT NOT NULL DEFAULT '',
  mood               TEXT NOT NULL DEFAULT '',
  ongoing_events     TEXT NOT NULL DEFAULT '',
  relationship_score SMALLINT NOT NULL DEFAULT 20 CHECK (relationship_score BETWEEN 0 AND 100),
  relationship_note  TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worldbook (
  id         BIGSERIAL PRIMARY KEY,
  entry_key  TEXT UNIQUE NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  entities   TEXT[] NOT NULL DEFAULT '{}',
  tags       TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worldbook_entities ON worldbook USING GIN (entities);
CREATE INDEX IF NOT EXISTS idx_worldbook_tags ON worldbook USING GIN (tags);
