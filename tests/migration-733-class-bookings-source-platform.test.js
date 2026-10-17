// UN1TBOOK.1 — migration 733: class_bookings.source_platform, the un1t:
// namespace CHECK, and campaign_outcome_stats counting CANCELLED correctly.
//
// Two halves:
//   * file-text pins (the shape the plan fixes: column, both CHECKs, the one
//     changed filter, the restated EXECUTE decision, a catalog self-check);
//   * behaviour on PGlite (PostgreSQL 17; prod is 17.6): class_bookings as
//     mig 288 created it, with prod's ACL (authenticated arwd, service_role
//     all, no anon) and its one SELECT policy; mig 513's file run verbatim so
//     733 replaces a real function. It proves an existing Glofox row takes
//     the 'glofox' default and the namespace CHECK validates over it; a
//     projection that forgets source_platform on a un1t: row is REFUSED by
//     the database (review focus 4); un1t_online needs the prefix on BOTH
//     ids; the stats RPC stops counting a 'CANCELLED' booking (and still
//     refuses anon/authenticated); the file aborts WHOLE on a write policy
//     (the self-check) or a pre-existing mismatched row (VALIDATE
//     CONSTRAINT); the stale mig 288/726/730 comments are refreshed; a
//     second run passes.
// Fictional ids only: the repo is public.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { sqlCode } from './helpers/sql-code.js'

const MIGRATIONS = path.resolve(import.meta.dirname, '../supabase/migrations')
const MIG_733_PATH = path.join(MIGRATIONS, '733_class_bookings_source_platform.sql')
const MIG_513 = readFileSync(path.join(MIGRATIONS, '513_campaign_outcome_stats.sql'), 'utf8')
const readMig733 = () => readFileSync(MIG_733_PATH, 'utf8')

/** SQL with its comments blanked by the quote-aware scanner (GUARDSTRIP.1). */
const code = (sql) => sqlCode(sql)
const squash = (s) => s.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()

/** The body of the function definition between `as $$` and the closing `$$;`. */
function fnBody(sql) {
  const start = sql.search(/create\s+or\s+replace\s+function\s+public\.campaign_outcome_stats/i)
  expect(start).toBeGreaterThanOrEqual(0)
  const open = sql.indexOf('$$', start)
  const close = sql.indexOf('$$', open + 2)
  return sql.slice(open + 2, close)
}

describe('mig 733 — file text', () => {
  it('adds source_platform with the glofox default and the two-value CHECK', () => {
    const sql = squash(code(readMig733()))
    expect(sql).toContain(
      "ALTER TABLE public.class_bookings ADD COLUMN IF NOT EXISTS source_platform text NOT NULL DEFAULT 'glofox' " +
      "CONSTRAINT class_bookings_source_platform_check CHECK (source_platform IN ('glofox', 'un1t_online'));")
    expect(sql).toMatch(/^BEGIN; SET LOCAL lock_timeout = '5s';/)
    expect(sql).toMatch(/COMMIT;$/)
  })

  it('the namespace CHECK ties un1t_online to the un1t: prefix on BOTH ids', () => {
    const sql = squash(code(readMig733()))
    expect(sql).toContain(
      'ADD CONSTRAINT class_bookings_source_namespace_check CHECK (' +
      "(source_platform = 'un1t_online') = (glofox_booking_id LIKE 'un1t:%') " +
      "AND (source_platform = 'un1t_online') = (glofox_event_id LIKE 'un1t:%')) NOT VALID;")
    expect(sql).toContain('ALTER TABLE public.class_bookings VALIDATE CONSTRAINT class_bookings_source_namespace_check;')
    // Added NOT VALID, validated after, in the same file.
    expect(sql.indexOf('NOT VALID;')).toBeLessThan(sql.indexOf('VALIDATE CONSTRAINT'))
  })

  it("campaign_outcome_stats keeps mig 513's body except the CANCELLED filter", () => {
    const sql = readMig733()
    const before = fnBody(MIG_513)
    const after = fnBody(sql)
    expect(after).toContain("and upper(coalesce(b.status, '')) <> 'CANCELLED'")
    expect(after).not.toMatch(/is\s+distinct\s+from\s+'cancelled'/i)
    // Byte-for-byte mig 513 apart from that one line.
    expect(after).toBe(before.replace(
      "and b.status is distinct from 'cancelled'",
      "and upper(coalesce(b.status, '')) <> 'CANCELLED'"))
    // Same signature, return shape and attributes as 513.
    const head = (s) => squash(s.slice(
      s.search(/create\s+or\s+replace\s+function\s+public\.campaign_outcome_stats/i),
      s.indexOf('$$', s.search(/create\s+or\s+replace\s+function\s+public\.campaign_outcome_stats/i))))
    expect(head(sql)).toBe(head(MIG_513))
    expect(head(sql)).toMatch(/\bsecurity invoker\b/)
    const c = squash(code(sql))
    expect(c).toContain('revoke execute on function public.campaign_outcome_stats(uuid, int) from public, anon, authenticated;')
    expect(c).toContain('grant execute on function public.campaign_outcome_stats(uuid, int) to service_role;')
  })

  it('self-check reads the catalog', () => {
    const sql = code(readMig733())
    const doBlock = sql.slice(sql.indexOf('DO $$'))
    expect(doBlock).toContain('information_schema.columns')
    expect(doBlock).toContain('pg_constraint')
    expect(doBlock).toContain("'class_bookings_source_platform_check'")
    expect(doBlock).toContain("'class_bookings_source_namespace_check'")
    expect(doBlock).toContain("has_table_privilege('authenticated', 'public.class_bookings', 'SELECT')")
    expect(doBlock).toMatch(/pg_policy[\s\S]*polcmd IN \('a', 'w', 'd', '\*'\)/)
    expect(doBlock).toMatch(/has_function_privilege\('anon', 'public\.campaign_outcome_stats\(uuid, integer\)', 'EXECUTE'\)/)
    expect(doBlock).toMatch(/has_function_privilege\('authenticated', 'public\.campaign_outcome_stats\(uuid, integer\)', 'EXECUTE'\)/)
  })

  it('says it is applied to prod by the controller before merge and before the code deploys', () => {
    const header = readMig733().split('\n').filter((l) => l.startsWith('--')).map((l) => l.replace(/^--\s?/, '')).join(' ')
    expect(squash(header)).toMatch(/applied to prod by the controller BEFORE merge/i)
    expect(squash(header)).toMatch(/before the code (that filters on it )?deploys/i)
  })
})

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

const LOC = 'b1000000-0000-0000-0000-00000000000a'
const C_BOOKED = 'c0000000-0000-0000-0000-000000000001'
const C_CANCELLED = 'c0000000-0000-0000-0000-000000000002'
const C_LOWER = 'c0000000-0000-0000-0000-000000000003'
const C_NULL = 'c0000000-0000-0000-0000-000000000004'
const CAMPAIGN = 'd0000000-0000-0000-0000-000000000001'
const GLOFOX_EVENT = '0123456789abcdef01234567'
const GLOFOX_BOOKING = '89abcdef0123456789abcdef'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA public, private TO anon, authenticated, service_role;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY);
  CREATE FUNCTION private.auth_is_in_location(loc uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

  -- mig 288 verbatim (columns, keys, RLS, the one policy).
  CREATE TABLE public.class_bookings (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    glofox_event_id   text NOT NULL,
    glofox_booking_id text NOT NULL,
    glofox_member_id  text,
    contact_id        uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
    member_name       text,
    class_name        text,
    starts_at         timestamptz,
    status            text,
    attended          boolean NOT NULL DEFAULT false,
    raw               jsonb,
    synced_at         timestamptz NOT NULL DEFAULT now(),
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, glofox_booking_id)
  );
  ALTER TABLE public.class_bookings ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "class_bookings_location_read" ON public.class_bookings
    FOR SELECT TO authenticated
    USING (private.auth_is_in_location(location_id));
  -- Prod ACL (17 Oct 2026): authenticated arwd, service_role all, no anon.
  REVOKE ALL ON public.class_bookings FROM anon, authenticated, PUBLIC;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_bookings TO authenticated;
  GRANT ALL ON public.class_bookings TO service_role;

  -- What mig 513's body reads, reduced to the columns it names.
  CREATE TABLE public.campaign_link_clicks (campaign_id uuid, contact_id uuid, clicked_at timestamptz);
  CREATE TABLE public.campaign_recipients (campaign_id uuid, contact_id uuid, opened_at timestamptz, sent_at timestamptz, status text);
  CREATE TABLE public.race_registrations (contact_id uuid, status text, created_at timestamptz);
  CREATE TABLE public.offer_purchases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, paid_at timestamptz, amount_cents bigint);
  CREATE TABLE public.race_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, status text, created_at timestamptz, amount_cents bigint);
  GRANT SELECT ON public.campaign_link_clicks, public.campaign_recipients, public.race_registrations,
    public.offer_purchases, public.race_payments TO service_role;

  -- mig 726's tables (reduced) and mig 730's column, so 733 can refresh their comments.
  CREATE TABLE public.un1t_bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.un1t_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.class_occurrences (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_platform text NOT NULL DEFAULT 'glofox');
  COMMENT ON COLUMN public.class_occurrences.source_platform IS
    'UN1TCLASS.1 (mig 730) — glofox | un1t_online. un1t_online rows have NO class_bookings rows, so booking-derived metrics (no-show, attended) are unavailable for them, never zero.';
  COMMENT ON TABLE public.un1t_events IS
    'UN1TSYNC.1 (mig 726) / UN1TCLASS.1 (mig 730): un1t.online classes and events. NOT written to class_bookings. Service role only.';
`

const SEED = `
  INSERT INTO public.locations (id) VALUES ('${LOC}');
  INSERT INTO public.contacts (id) VALUES ('${C_BOOKED}'), ('${C_CANCELLED}'), ('${C_LOWER}'), ('${C_NULL}');
  INSERT INTO public.class_bookings (location_id, glofox_event_id, glofox_booking_id, status, attended)
    VALUES ('${LOC}', '${GLOFOX_EVENT}', '${GLOFOX_BOOKING}', 'BOOKED', true);
`

let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

async function boot({ migrate = true, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_513)
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(readMig733())
}

afterEach(async () => { await db?.close(); db = undefined })

async function asRole(role, sql, params = []) {
  await runSql('BEGIN')
  try {
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql, params)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

/** Insert one class_bookings row as service_role; resolves to the error code or 'ok'. */
async function insertAs(fields) {
  const cols = Object.keys(fields)
  const vals = cols.map((_, i) => `$${i + 1}`)
  try {
    await asRole('service_role',
      `INSERT INTO public.class_bookings (location_id, ${cols.join(', ')}) VALUES ('${LOC}', ${vals.join(', ')})`,
      Object.values(fields))
    return 'ok'
  } catch (e) {
    return `${e.code}:${e.constraint ?? ''}`
  }
}

describe('mig 733 — class_bookings behaviour', () => {
  it('an existing Glofox row takes the glofox default and the namespace CHECK is validated', async () => {
    await boot()
    const { rows } = await db.query('SELECT source_platform FROM public.class_bookings')
    expect(rows).toEqual([{ source_platform: 'glofox' }])
    const { rows: cons } = await db.query(`
      SELECT conname, convalidated FROM pg_constraint
       WHERE conrelid = 'public.class_bookings'::regclass AND contype = 'c' ORDER BY conname`)
    expect(cons).toEqual([
      { conname: 'class_bookings_source_namespace_check', convalidated: true },
      { conname: 'class_bookings_source_platform_check', convalidated: true },
    ])
  }, 60_000)

  it('a projection writer that omits source_platform on un1t: ids is refused by the database', async () => {
    await boot()
    expect(await insertAs({ glofox_event_id: 'un1t:evt-1', glofox_booking_id: 'un1t:bk-1', status: 'BOOKED' }))
      .toBe('23514:class_bookings_source_namespace_check')
  }, 60_000)

  it('un1t_online needs the un1t: prefix on BOTH ids, and glofox may carry it on neither', async () => {
    await boot()
    const NS = '23514:class_bookings_source_namespace_check'
    expect(await insertAs({ source_platform: 'un1t_online', glofox_event_id: 'un1t:evt-1', glofox_booking_id: 'un1t:bk-1' })).toBe('ok')
    expect(await insertAs({ source_platform: 'un1t_online', glofox_event_id: GLOFOX_EVENT, glofox_booking_id: 'un1t:bk-2' })).toBe(NS)
    expect(await insertAs({ source_platform: 'un1t_online', glofox_event_id: 'un1t:evt-1', glofox_booking_id: 'bk-3' })).toBe(NS)
    expect(await insertAs({ source_platform: 'un1t_online', glofox_event_id: GLOFOX_EVENT, glofox_booking_id: 'bk-4' })).toBe(NS)
    expect(await insertAs({ source_platform: 'glofox', glofox_event_id: GLOFOX_EVENT, glofox_booking_id: 'un1t:bk-5' })).toBe(NS)
    expect(await insertAs({ glofox_event_id: 'un1t:evt-1', glofox_booking_id: 'bk-6' })).toBe(NS)
    expect(await insertAs({ source_platform: 'mindbody', glofox_event_id: GLOFOX_EVENT, glofox_booking_id: 'bk-7' }))
      .toBe('23514:class_bookings_source_platform_check')
    expect(await insertAs({ source_platform: null, glofox_event_id: GLOFOX_EVENT, glofox_booking_id: 'bk-8' }))
      .toBe('23502:')
  }, 60_000)

  it('VALIDATE CONSTRAINT aborts the whole file on a pre-existing mismatched row', async () => {
    await boot({ migrate: false, before: `
      INSERT INTO public.class_bookings (location_id, glofox_event_id, glofox_booking_id)
        VALUES ('${LOC}', 'un1t:evt-early', 'un1t:bk-early');` })
    await expect(runSql(readMig733())).rejects.toThrow(/class_bookings_source_namespace_check/)
    await runSql('ROLLBACK')
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'class_bookings' AND column_name = 'source_platform'`)
    expect(rows[0].n).toBe(0)
  }, 60_000)

  it('the self-check aborts the whole file on a write policy', async () => {
    await boot({ migrate: false, before: `
      CREATE POLICY class_bookings_sneaky_write ON public.class_bookings FOR INSERT TO authenticated WITH CHECK (true);` })
    await expect(runSql(readMig733())).rejects.toThrow(/write .*policy/i)
    await runSql('ROLLBACK')
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'class_bookings' AND column_name = 'source_platform'`)
    expect(rows[0].n).toBe(0)
  }, 60_000)

  it('the self-check aborts the whole file if a client can execute the stats RPC', async () => {
    await boot({ migrate: false })
    // A later file re-opening EXECUTE after 733 is what the guard test catches;
    // here prove the catalog check itself fires by running 733 with the
    // revoke stripped out after a grant.
    await runSql('GRANT EXECUTE ON FUNCTION public.campaign_outcome_stats(uuid, int) TO authenticated')
    const withoutRevoke = readMig733().replace(/revoke execute on function public\.campaign_outcome_stats[^;]*;/i, '')
    await expect(runSql(withoutRevoke)).rejects.toThrow(/a client role can execute campaign_outcome_stats; it is service_role only/)
    await runSql('ROLLBACK')
  }, 60_000)

  it('is re-runnable', async () => {
    await boot()
    await runSql(readMig733())
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'public.class_bookings'::regclass AND conname = 'class_bookings_source_namespace_check'`)
    expect(rows[0].n).toBe(1)
  }, 60_000)

  it('comments the column and refreshes the un1t_bookings table comment', async () => {
    await boot()
    const { rows } = await db.query(`
      SELECT col_description('public.class_bookings'::regclass,
               (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.class_bookings'::regclass AND attname = 'source_platform')) AS col,
             obj_description('public.un1t_bookings'::regclass, 'pg_class') AS tbl`)
    expect(rows[0].col).toMatch(/un1t:/)
    expect(rows[0].col).toMatch(/send-class-booking-reminders and credit-attendance filter source_platform = 'glofox'/)
    expect(rows[0].tbl).not.toMatch(/NOT written to class_bookings/)
    expect(rows[0].tbl).toMatch(/class_bookings/)
  }, 60_000)

  it("refreshes mig 288's and mig 730's comments, which said un1t_online classes had no class_bookings rows", async () => {
    await boot()
    const { rows } = await db.query(`
      SELECT obj_description('public.class_bookings'::regclass, 'pg_class') AS bookings,
             col_description('public.class_occurrences'::regclass,
               (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.class_occurrences'::regclass AND attname = 'source_platform')) AS occ_col,
             obj_description('public.un1t_events'::regclass, 'pg_class') AS events`)
    const { bookings, occ_col: occCol, events } = rows[0]
    expect(bookings).toMatch(/Glofox .*and un1t\.online .*distinguished by source_platform/)
    expect(bookings).toMatch(/reminds and credits only source_platform = 'glofox'/)
    expect(occCol).toMatch(/^UN1TCLASS\.1 \(mig 730\) \/ UN1TBOOK\.1 \(mig 733\) — glofox \| un1t_online\./)
    expect(occCol).toMatch(/projected into class_bookings/)
    expect(occCol).toMatch(/never reminds or credits/)
    expect(occCol).not.toMatch(/NO class_bookings rows/i)
    expect(occCol).not.toMatch(/unavailable/i)
    expect(events).toMatch(/projected into class_occurrences/)
    expect(events).toMatch(/bookings are projected into class_bookings/)
    expect(events).not.toMatch(/NOT written to class_bookings/i)
  }, 60_000)
})

describe('mig 733 — campaign_outcome_stats', () => {
  const T0 = '2026-10-01T09:00:00Z'
  const IN_WINDOW = '2026-10-03T09:00:00Z'
  const SEED_STATS = `
    INSERT INTO public.campaign_link_clicks (campaign_id, contact_id, clicked_at) VALUES
      ('${CAMPAIGN}', '${C_BOOKED}', '${T0}'), ('${CAMPAIGN}', '${C_CANCELLED}', '${T0}'),
      ('${CAMPAIGN}', '${C_LOWER}', '${T0}'), ('${CAMPAIGN}', '${C_NULL}', '${T0}');
    INSERT INTO public.class_bookings (location_id, glofox_event_id, glofox_booking_id, contact_id, starts_at, status) VALUES
      ('${LOC}', 'ev-a', 'bk-a', '${C_BOOKED}', '${IN_WINDOW}', 'BOOKED'),
      ('${LOC}', 'ev-b', 'bk-b', '${C_CANCELLED}', '${IN_WINDOW}', 'CANCELLED'),
      ('${LOC}', 'ev-c', 'bk-c', '${C_LOWER}', '${IN_WINDOW}', 'cancelled'),
      ('${LOC}', 'ev-d', 'bk-d', '${C_NULL}', '${IN_WINDOW}', NULL);
  `
  const attendances = async () => {
    const rows = await asRole('service_role',
      'SELECT cohort, contacts::int, class_attendances::int FROM public.campaign_outcome_stats($1, 7)', [CAMPAIGN])
    return rows.find((r) => r.cohort === 'clicked')
  }

  it("before 733 an upper-case 'CANCELLED' booking counted as an attendance", async () => {
    await boot({ migrate: false, before: SEED_STATS })
    expect(await attendances()).toEqual({ cohort: 'clicked', contacts: 4, class_attendances: 3 })
  }, 60_000)

  it('after 733 neither spelling of cancelled counts; BOOKED and a null status still do', async () => {
    await boot({ before: SEED_STATS })
    expect(await attendances()).toEqual({ cohort: 'clicked', contacts: 4, class_attendances: 2 })
  }, 60_000)

  it('stays service_role only and security invoker', async () => {
    await boot()
    const { rows } = await db.query(`
      SELECT has_function_privilege('anon', 'public.campaign_outcome_stats(uuid, integer)', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'public.campaign_outcome_stats(uuid, integer)', 'EXECUTE') AS authed,
             has_function_privilege('service_role', 'public.campaign_outcome_stats(uuid, integer)', 'EXECUTE') AS svc,
             (SELECT prosecdef FROM pg_proc WHERE oid = 'public.campaign_outcome_stats(uuid, integer)'::regprocedure) AS definer`)
    expect(rows[0]).toEqual({ anon: false, authed: false, svc: true, definer: false })
    await expect(asRole('authenticated', 'SELECT * FROM public.campaign_outcome_stats($1, 7)', [CAMPAIGN]))
      .rejects.toThrow(/permission denied for function campaign_outcome_stats/)
  }, 60_000)
})
