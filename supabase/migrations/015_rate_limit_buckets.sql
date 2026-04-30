-- ============================================================
-- 015: Rate limiting buckets (fixed-window counter)
--
-- Backs `src/lib/rate-limit.js`. One row per (bucket_key, window_start).
-- Cleaned up daily by /api/cron/prune-rate-limits.
-- ============================================================

CREATE TABLE rate_limit_buckets (
  bucket_key   TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INT         NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

-- Used by the prune cron to find expired rows.
CREATE INDEX idx_rate_limit_buckets_expires
  ON rate_limit_buckets (expires_at);


-- ============================================================
-- ATOMIC INCREMENT + READ
-- One round-trip from the app: insert-or-increment, then return
-- the current count. Service role only — RLS blocks all other roles.
-- ============================================================
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  p_key          TEXT,
  p_window_start TIMESTAMPTZ,
  p_window_ms    INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  INSERT INTO rate_limit_buckets (bucket_key, window_start, count, expires_at)
  VALUES (
    p_key,
    p_window_start,
    1,
    p_window_start + (p_window_ms * 2 || ' milliseconds')::INTERVAL
  )
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET count = rate_limit_buckets.count + 1
  RETURNING count INTO v_count;

  RETURN v_count;
END;
$$;

-- Service role bypasses RLS automatically; no other role should reach this.
REVOKE ALL ON FUNCTION public.rate_limit_hit(TEXT, TIMESTAMPTZ, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, TIMESTAMPTZ, INT) TO service_role;


-- ============================================================
-- RLS — service role only
-- No CREATE POLICY = no role except service_role can read/write.
-- (Service role bypasses RLS automatically.)
-- ============================================================
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
