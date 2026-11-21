CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users (id),
  balance numeric(12, 2) NOT NULL CHECK (balance >= 0)
);

CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts (user_id);
