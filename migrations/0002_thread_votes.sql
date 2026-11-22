CREATE TABLE thread_votes (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  voter_id TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK(vote IN (-1, 1)),
  PRIMARY KEY (thread_id, voter_id)
) WITHOUT ROWID;
