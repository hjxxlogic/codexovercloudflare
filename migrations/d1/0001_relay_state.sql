-- scope is registry or host:<hostId>. Scope versions fence optimistic batches.
CREATE TABLE relay_scopes (
  scope TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  token TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE relay_state (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  PRIMARY KEY (scope, key)
) WITHOUT ROWID;
CREATE INDEX relay_state_keys ON relay_state(key, scope);
