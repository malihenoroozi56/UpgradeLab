-- A safe, backwards-compatible migration: add a column, keep existing data.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY,
  event text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO audit_log (event) VALUES ('upgraded to 2.0.0');
