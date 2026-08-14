-- 546: one ACTIVE registration per physical device, enforced at the DB.
--
-- WHY: the only uniqueness on contact_devices was (contact_id, device_type,
-- identifier) — per-contact. Sample routing is by identifier alone
-- (resolveStrapsForBatch), so the same strap registered to TWO members makes
-- routing nondeterministic: whoever the query happens to return first gets the
-- other member's heart-rate data. Both claim surfaces shipped 2026-08-14 (the
-- coach one-tap on /live and the champ-app "were you wearing this?" nudge)
-- check-then-insert, and pairOverride's persist path has no steal guard at
-- all — every one of those app-level checks loses the same race two writers
-- can win together. The DB is the only place this invariant actually holds.
--
-- Partial on is_active so a deactivated registration (member replaces a
-- strap, staff unregisters it) frees the identifier for the next owner while
-- the history row stays.
--
-- Safe to apply: contact_devices holds 1 row at migration time.
CREATE UNIQUE INDEX IF NOT EXISTS contact_devices_one_active_identifier
  ON public.contact_devices (identifier)
  WHERE is_active;
