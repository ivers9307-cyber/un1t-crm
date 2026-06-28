-- 328 — per-drip "per-tick batch size" (burstiness control), independent of the
-- daily cap. The daily_cap + send window govern TOTAL volume per 24h; per_tick_max
-- only controls how many go out in each 15-min cron tick (smaller = smoother drip,
-- larger = burstier). NULL = the code default (PER_TICK_MAX = 100 in
-- src/lib/whatsapp-drip.js).

ALTER TABLE whatsapp_broadcasts
  ADD COLUMN IF NOT EXISTS per_tick_max integer
  CHECK (per_tick_max IS NULL OR (per_tick_max > 0 AND per_tick_max <= 5000));

COMMENT ON COLUMN whatsapp_broadcasts.per_tick_max IS
  'Drip burstiness: max messages per 15-min cron tick. NULL = code default (PER_TICK_MAX=100). daily_cap + send window govern the 24h total.';
