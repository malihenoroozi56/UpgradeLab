-- Intentionally destructive migration used to test that UpgradeLab fails an
-- upgrade instead of trusting a successful container start.
ALTER TABLE users DROP COLUMN email;

-- A realistic-looking bug: a "recalculation" that silently loses 40% of money.
UPDATE accounts SET balance = balance * 0.6;

CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY,
  event text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
