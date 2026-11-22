CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  tid INTEGER NOT NULL,
  episode INTEGER,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
  posted_at INTEGER NOT NULL,
  author_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id, id);
CREATE INDEX IF NOT EXISTS comments_recent ON comments(posted_at, thread_id);
CREATE INDEX IF NOT EXISTS comments_author ON comments(author_key, posted_at);

CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  refreshed_at INTEGER NOT NULL,
  airings TEXT NOT NULL
);
