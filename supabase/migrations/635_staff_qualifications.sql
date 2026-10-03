-- 635 — QUALS.1: staff qualifications with expiry.
--
-- THE MODEL
-- ─────────
--   staff_qualification_types  the ORGANISATION's catalogue (First aid,
--       Insurance, Garda vetting seeded for every organisation). Per
--       organisation, not per studio: a qualification belongs to a person,
--       and a coach at two studios of one organisation holds one first-aid
--       certificate, not two. Types are archived (active = false), never
--       deleted: a record or a requirement pins them.
--   staff_qualifications  one row per (person, type): issued_on (optional),
--       expires_on (optional; NULL = does not expire), note <= 300, who
--       recorded it and who last changed it. organization_id is pinned to the
--       type's organisation by a composite FK, so a record can never point at
--       another organisation's type.
--   shift_template_qualification_requirements  a template may ask for up to
--       5 types (the cap is the API's). ADVISORY: the coach picker badges a
--       coach without a current record; nothing refuses an assignment. Its
--       own table rather than a shift_templates column because the browser
--       still holds UPDATE on shift_templates (mig 600 policy, mig 628
--       header); this table is service-role only. A SECURITY DEFINER trigger
--       refuses a type from another organisation, whoever writes the row.
--
-- POSTURE: SERVICE ROLE ONLY on all three. RLS enabled, NO policies, the
-- browser roles hold NO privilege (every reader is an /api route on the
-- service-role client). get_advisors rls_enabled_no_policy (INFO) rises by
-- exactly 3.
--
-- FKs: profile_id CASCADE (inert: a staff profile is never deleted, mig 622
-- tombstones it; a tombstone's records stay on disk and are never listed,
-- because a tombstone has no profile_locations). recorded_by / updated_by /
-- created_by SET NULL (an audit column outlives its actor). template_id
-- CASCADE (SHIFTTPL.1's hard delete of an unused template takes its
-- requirements). organization_id CASCADE (organisations are not deleted).
-- Type references are NO ACTION: a type in use cannot be deleted.
--
-- HEARTBEAT (the CLAUDE.md arm rule): the weekly digest is an ARM of the
-- daily 08:00 UTC cron /api/cron/contract-reminders, so it gets its OWN row,
-- 'qualification-digest', 86400s + 43200s grace (the roster-runway
-- convention, mig 633). It is stamped only when the arm returned an outcome
-- and did not throw (src/lib/cron-arm-health.js). Born healthy, ON CONFLICT
-- DO UPDATE re-arm (601/623/633).
--
-- APPLY ORDER. Apply this file BEFORE the QUALS.1 code deploys: its routes
-- and the arm read these tables, and a select naming a missing table fails.
-- Applied alone it changes nothing (new objects only). Then, per the arm
-- rule, RE-RUN the heartbeat INSERT below via execute_sql right AFTER the
-- production deploy is live. A row seeded early only goes stale after 36
-- hours, so this is belt and braces, but it is the rule. The WHOLE FILE also
-- replays as a no-op (IF NOT EXISTS, CREATE OR REPLACE, seeds only for an
-- organisation with no types at all, so an owner's renames survive).
--
-- One explicit transaction: a failed self-check leaves NOTHING applied.
--
-- ─────────────────────────────────────────────────────────────────────────
-- PRE-APPLY CHECKS (read-only; keep the output in the scratchpad)
-- ─────────────────────────────────────────────────────────────────────────
-- (a) Nothing by these names exists yet:
--       SELECT to_regclass('public.staff_qualification_types'),
--              to_regclass('public.staff_qualifications'),
--              to_regclass('public.shift_template_qualification_requirements'),
--              to_regprocedure('private.shift_template_qualification_same_org()');
--     Expected: NULL, NULL, NULL, NULL.
-- (b) SELECT name FROM public.cron_heartbeats WHERE name = 'qualification-digest';   -- 0 rows
-- (c) The private schema exists (mig 622's triggers live there):
--       SELECT nspname FROM pg_namespace WHERE nspname = 'private';                   -- 1 row
-- (d) What will be seeded (information): SELECT id, name, active FROM public.organizations ORDER BY name;
--     Expected on 25 Sep: UN1T Group, CCF Autos (mig 079), maybe more.
-- (e) The advisor baseline: get_advisors(security) → rls_enabled_no_policy count.
-- (f) list_migrations shows no 635.
--
-- ─────────────────────────────────────────────────────────────────────────
-- POST-APPLY CHECKS
-- ─────────────────────────────────────────────────────────────────────────
-- (g) SELECT r, t, p FROM unnest(ARRAY['anon', 'authenticated']) r,
--            unnest(ARRAY['public.staff_qualification_types', 'public.staff_qualifications',
--                         'public.shift_template_qualification_requirements']) t,
--            unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
--      WHERE has_table_privilege(r, t, p);
--     Expected: 0 rows.
-- (h) SELECT o.name, count(t.id) FROM public.organizations o
--       LEFT JOIN public.staff_qualification_types t ON t.organization_id = o.id GROUP BY 1 ORDER BY 1;
--     Expected: 3 per organisation.
-- (i) SELECT name, expected_interval_seconds, grace_seconds FROM public.cron_heartbeats
--      WHERE name = 'qualification-digest';   -- 86400, 43200
-- (j) SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.shift_template_qualification_requirements'::regclass
--        AND NOT tgisinternal;   -- shift_template_qualification_same_org
-- (k) get_advisors (security AND performance). Expected: rls_enabled_no_policy
--     +3 (these tables), nothing else new. unindexed_foreign_keys: none (every
--     FK is indexed below).
-- (l) Smoke once deployed: GET /api/qualifications?location_id=<Stillorgan> as
--     an owner → 200, three types, every member listed.
--
-- ROLLBACK (only while no record has been entered; afterwards dump the three
-- tables first). Revert the QUALS.1 code FIRST and let it deploy (its routes
-- and the arm fail without these tables), then:
--   BEGIN;
--   DROP TABLE IF EXISTS public.shift_template_qualification_requirements;
--   DROP FUNCTION IF EXISTS private.shift_template_qualification_same_org();
--   DROP TABLE IF EXISTS public.staff_qualifications;
--   DROP TABLE IF EXISTS public.staff_qualification_types;
--   DELETE FROM public.cron_heartbeats WHERE name = 'qualification-digest';
--   COMMIT;

BEGIN;

-- ── The catalogue ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_qualification_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  sort_order       integer NOT NULL DEFAULT 100,
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- One line, 1-60 characters, no leading or trailing whitespace. \s covers
  -- newlines, so a newline-only name fails `~ '\S'` (the BLOCKEDIT.1 lesson:
  -- btrim() trims spaces only).
  CONSTRAINT staff_qualification_types_name CHECK (
    char_length(name) BETWEEN 1 AND 60
    AND name ~ '\S'
    AND name !~ '^\s'
    AND name !~ '\s$'
    AND name !~ '[\r\n]'
  ),
  -- The target of staff_qualifications' composite FK.
  CONSTRAINT staff_qualification_types_id_org UNIQUE (id, organization_id)
);

-- One name per organisation, case-insensitively. Leads with organization_id,
-- so it also covers that FK.
CREATE UNIQUE INDEX IF NOT EXISTS staff_qualification_types_org_name_key
  ON public.staff_qualification_types (organization_id, lower(name));
CREATE INDEX IF NOT EXISTS staff_qualification_types_created_by_idx
  ON public.staff_qualification_types (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE public.staff_qualification_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_qualification_types FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_qualification_types TO service_role;

COMMENT ON TABLE public.staff_qualification_types IS
  'QUALS.1 (mig 635) — an ORGANISATION''s catalogue of staff qualification types (First aid, Insurance, Garda vetting seeded per organisation). Owners add, rename and archive (active = false); a type is never deleted once a record or a template requirement names it. Service-role only: RLS on, no policies, no browser grants.';

-- ── The records ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_qualifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  qualification_type_id uuid NOT NULL,
  issued_on             date,
  expires_on            date,
  note                  text,
  recorded_by           uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_qualifications_type_same_org
    FOREIGN KEY (qualification_type_id, organization_id)
    REFERENCES public.staff_qualification_types (id, organization_id),
  CONSTRAINT staff_qualifications_one_per_type UNIQUE (profile_id, qualification_type_id),
  CONSTRAINT staff_qualifications_dates CHECK (
    issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on
  ),
  CONSTRAINT staff_qualifications_note CHECK (
    note IS NULL OR (char_length(note) <= 300 AND note ~ '\S')
  )
);

-- The digest's read: an organisation's records by expiry. Leads with
-- organization_id, so it also covers that FK.
CREATE INDEX IF NOT EXISTS staff_qualifications_org_expires_idx
  ON public.staff_qualifications (organization_id, expires_on);
-- The composite FK to the catalogue (advisor unindexed_foreign_keys), and the
-- picker's "records of these types" read.
CREATE INDEX IF NOT EXISTS staff_qualifications_type_org_idx
  ON public.staff_qualifications (qualification_type_id, organization_id);
-- profile_id is covered by staff_qualifications_one_per_type (leads with it).
CREATE INDEX IF NOT EXISTS staff_qualifications_recorded_by_idx
  ON public.staff_qualifications (recorded_by) WHERE recorded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS staff_qualifications_updated_by_idx
  ON public.staff_qualifications (updated_by) WHERE updated_by IS NOT NULL;

ALTER TABLE public.staff_qualifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_qualifications FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_qualifications TO service_role;

COMMENT ON TABLE public.staff_qualifications IS
  'QUALS.1 (mig 635) — one row per (person, qualification type): issued_on (optional), expires_on (NULL = does not expire), note <= 300, recorded_by / updated_by. organization_id is the type''s (composite FK). Managed by owners and managers at a studio the person belongs to (the API decides; service-role only). Status on a day (shared/qualifications.js): missing, expired (before the day), expiring (the day up to 30 days ahead), valid. A tombstoned person''s rows stay and are never listed.';

-- ── Template requirements (advisory) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shift_template_qualification_requirements (
  template_id           uuid NOT NULL REFERENCES public.shift_templates(id) ON DELETE CASCADE,
  qualification_type_id uuid NOT NULL REFERENCES public.staff_qualification_types(id),
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, qualification_type_id)
);

CREATE INDEX IF NOT EXISTS shift_template_qualification_requirements_type_idx
  ON public.shift_template_qualification_requirements (qualification_type_id);
CREATE INDEX IF NOT EXISTS shift_template_qualification_requirements_created_by_idx
  ON public.shift_template_qualification_requirements (created_by) WHERE created_by IS NOT NULL;

ALTER TABLE public.shift_template_qualification_requirements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_template_qualification_requirements FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_template_qualification_requirements TO service_role;

COMMENT ON TABLE public.shift_template_qualification_requirements IS
  'QUALS.1 (mig 635) — the qualification types a shift template asks for (the API caps it at 5). ADVISORY ONLY: the coach picker badges a coach with no current record on the shift''s date; no route refuses an assignment because of it. Same organisation as the template''s studio (trigger shift_template_qualification_same_org). Service-role only.';

-- Same organisation, whoever writes. SECURITY DEFINER (the mig 622 posture
-- for private.refuse_tombstone_access_row): the check must read
-- shift_templates, locations and the catalogue whatever the writer's grants.
-- Lives in `private` (not exposed by PostgREST), pins search_path.
CREATE OR REPLACE FUNCTION private.shift_template_qualification_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.shift_templates t
      JOIN public.locations l ON l.id = t.location_id
      JOIN public.staff_qualification_types q ON q.organization_id = l.organization_id
     WHERE t.id = NEW.template_id
       AND q.id = NEW.qualification_type_id
  ) THEN
    RAISE EXCEPTION 'qualification_requirement_other_org: type % is not in the organisation of template %',
      NEW.qualification_type_id, NEW.template_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.shift_template_qualification_same_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS shift_template_qualification_same_org ON public.shift_template_qualification_requirements;
CREATE TRIGGER shift_template_qualification_same_org
  BEFORE INSERT OR UPDATE ON public.shift_template_qualification_requirements
  FOR EACH ROW EXECUTE FUNCTION private.shift_template_qualification_same_org();

-- ── Seeds: only for an organisation with NO types at all ─────────────────
-- So a replay never re-adds a type an owner renamed or archived, and an
-- organisation created since the first apply gets the three on a replay.
INSERT INTO public.staff_qualification_types (organization_id, name, sort_order)
SELECT o.id, s.name, s.sort_order
  FROM public.organizations o
 CROSS JOIN (VALUES ('First aid', 10), ('Insurance', 20), ('Garda vetting', 30)) AS s(name, sort_order)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.staff_qualification_types t WHERE t.organization_id = o.id
 );

-- ── The digest arm's heartbeat row (born healthy, re-armed on replay) ────
INSERT INTO public.cron_heartbeats (name, last_ok_at, expected_interval_seconds, grace_seconds, notes)
VALUES (
  'qualification-digest',
  now(),
  86400,
  43200,
  'QUALS.1 — the weekly qualification digest arm (src/lib/qualification-digest.js runQualificationDigest) of the daily 08:00 UTC Vercel cron /api/cron/contract-reminders. No route or vercel.json entry of its own. Runs every day; each owner is sent at most one digest per Dublin week, on the first run with anything expired or expiring in 30 days (push_event_sends: the week key qualification_digest:<org>:<Monday> is stamped only AFTER a send that delivered (a push or a fallback email); the day''s attempt claims ...:d<day>, so a dead attempt is retried the next day and a lost stamp costs a duplicate, never a loss). Stamped ONLY when the arm returned an outcome and did not throw (a locations, links, types or records read failure); a per-recipient delivery failure (outcome.failed / email_failed, not stamped, retried tomorrow), a lost week stamp (outcome.stamp_failed) and a week with nothing to say still stamp. Independent of the parent and of the roster-runway arm. STALE = no clean run for 36 hours: read contract-reminders.last_outcome.qualifications (the error text) and the cron-contract-reminders logError lines. last_outcome carries { organizations, recipients, rows, nothing_due, quiet_hours, sent, emailed, email_failed, deduped, failed, stamp_failed }.'
)
ON CONFLICT (name) DO UPDATE
  SET last_ok_at = now(),
      expected_interval_seconds = EXCLUDED.expected_interval_seconds,
      grace_seconds = EXCLUDED.grace_seconds,
      notes = EXCLUDED.notes;

-- ── Self-check (POST-state, from the catalog, never from this text) ──────
DO $$
DECLARE
  t text;
  r text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_qualification_types', 'staff_qualifications', 'shift_template_qualification_requirements'] LOOP
    PERFORM 1 FROM pg_class c WHERE c.oid = ('public.' || t)::regclass AND c.relrowsecurity;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mig 635: RLS is not enabled on public.%; nothing was applied', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege(r, 'public.' || t, p) THEN
          RAISE EXCEPTION 'mig 635: % still holds % on public.%; nothing was applied', r, p, t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  PERFORM 1 FROM public.organizations o
   WHERE NOT EXISTS (SELECT 1 FROM public.staff_qualification_types q WHERE q.organization_id = o.id);
  IF FOUND THEN
    RAISE EXCEPTION 'mig 635: an organisation has no qualification types after the seed; nothing was applied';
  END IF;

  -- The same-organisation trigger is what stops another organisation's type
  -- on a template, whoever writes; confirm it from the catalog.
  PERFORM 1
     FROM pg_trigger tg
     JOIN pg_proc pr ON pr.oid = tg.tgfoid
    WHERE tg.tgrelid = 'public.shift_template_qualification_requirements'::regclass
      AND tg.tgname = 'shift_template_qualification_same_org'
      AND NOT tg.tgisinternal
      AND tg.tgenabled <> 'D'
      AND pr.proname = 'shift_template_qualification_same_org'
      AND pr.pronamespace = 'private'::regnamespace
      AND pr.prosecdef;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 635: the same-organisation trigger on public.shift_template_qualification_requirements is missing, disabled or not SECURITY DEFINER; nothing was applied';
  END IF;

  PERFORM 1 FROM public.cron_heartbeats h
   WHERE h.name = 'qualification-digest' AND h.expected_interval_seconds = 86400 AND h.grace_seconds = 43200;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mig 635: the qualification-digest heartbeat row did not end up on 86400 + 43200; nothing was applied';
  END IF;
END $$;

COMMIT;
