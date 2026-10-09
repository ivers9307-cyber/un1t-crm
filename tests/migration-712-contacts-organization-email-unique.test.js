// W0.6 — behavioural test for migration 712.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) with the tables the file and
// the booking trigger touch (contacts reduced to the columns the audience
// view lists, so the view statement is the real one), mig 596's
// handle_new_booking + booking_created_trigger and mig 008's GLOBAL
// contacts_email_unique, runs the REAL 712 file and proves:
//   * organization_id is stamped on INSERT, on UPDATE OF location_id, and
//     backfilled; a location moved to another organisation re-stamps its
//     contacts;
//   * the global index is gone and contacts_email_org_unique is present:
//     one email may exist once PER ORGANISATION, a sibling studio in the
//     same org is refused, and two location-less rows are refused too
//     (NULLS NOT DISTINCT keeps mig 008's guarantee for them);
//   * the view carries organization_id LAST, security_invoker, no client
//     grant;
//   * a booking at a sibling studio links the in-org holder and creates no
//     contact; this-location beats sibling beats legacy NULL-location row;
//     another organisation's holder is never linked;
//   * a second run passes and changes nothing.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = (n) => readFileSync(path.resolve(import.meta.dirname, `../supabase/migrations/${n}`), 'utf8')
const MIG_712 = MIG('712_contacts_organization_email_unique.sql')
const MIG_596 = MIG('596_booking_trigger_pipeline_aware.sql')
// Mig 596's function, verbatim: from its CREATE to the end of its body.
const FN_596 = MIG_596.slice(MIG_596.indexOf('create or replace function'), MIG_596.indexOf('$function$;') + '$function$;'.length)

// contacts' columns = every `c.<col>` the 712 view lists, except the one it adds.
const VIEW_SQL = MIG_712.slice(MIG_712.indexOf('CREATE OR REPLACE VIEW'), MIG_712.indexOf('FROM public.contacts c'))
const CONTACT_COLS = [...new Set([...VIEW_SQL.matchAll(/\bc\.([a-z_0-9]+)/g)].map((m) => m[1]))].filter((c) => c !== 'organization_id')
const TYPED = { id: 'uuid PRIMARY KEY DEFAULT gen_random_uuid()', email: 'text', location_id: 'uuid REFERENCES public.locations(id)', created_at: 'timestamptz NOT NULL DEFAULT now()' }

const ORG_A = '11111111-1111-1111-1111-111111111111'
const ORG_B = '22222222-2222-2222-2222-222222222222'
const A1 = 'aaaaaaaa-0000-0000-0000-000000000001'  // org A
const A2 = 'aaaaaaaa-0000-0000-0000-000000000002'  // org A
const B1 = 'bbbbbbbb-0000-0000-0000-000000000001'  // org B
const SAM = 'cccccccc-0000-0000-0000-000000000001'      // sam@ at A1, pre-712
const NOWHERE = 'cccccccc-0000-0000-0000-000000000009'  // legacy location-less row

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE SCHEMA private;
  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id));
  CREATE TABLE public.contacts (
    ${CONTACT_COLS.map((c) => `${c} ${TYPED[c] || 'text'}`).join(',\n    ')}
  );
  CREATE UNIQUE INDEX contacts_email_unique ON public.contacts (email) WHERE email IS NOT NULL;
  CREATE TABLE public.contact_location_preferences (contact_id uuid, location_id uuid, email_marketing boolean, sms_marketing boolean, whatsapp_marketing boolean);
  CREATE TABLE public.event_types (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, location_id uuid);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type_id uuid, location_id uuid, customer_email text, customer_name text, customer_phone text, contact_id uuid, booking_date date DEFAULT current_date, start_time time DEFAULT '09:00');
  CREATE TABLE public.pipelines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, is_primary boolean, enabled boolean, mode text);
  CREATE TABLE public.pipeline_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid, archived boolean, display_order int);
  CREATE TABLE public.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, title text, status text, stage_id uuid, location_id uuid, pipeline_id uuid);
  CREATE TABLE public.activities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject text, type text, kind text, contact_id uuid, deal_id uuid, due_date date, due_time time, note text, done boolean, location_id uuid);
  INSERT INTO public.organizations VALUES ('${ORG_A}'), ('${ORG_B}');
  INSERT INTO public.locations VALUES ('${A1}', '${ORG_A}'), ('${A2}', '${ORG_A}'), ('${B1}', '${ORG_B}');
  INSERT INTO public.contacts (id, name, email, location_id, created_at) VALUES
    ('${SAM}', 'Sam', 'Sam@Example.test', '${A1}', now() - interval '2 days'),
    ('${NOWHERE}', 'Nowhere', 'nowhere@example.test', NULL, now() - interval '2 days');
  ${FN_596}
  CREATE TRIGGER booking_created_trigger BEFORE INSERT ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.handle_new_booking();
`

let db
const run = (sql) => db['exec'](sql)
const rows = async (sql, params) => (await db.query(sql, params)).rows
const one = async (sql, params) => (await rows(sql, params))[0]
/** Run SQL inside a savepoint that is ALWAYS rolled back (a passing statement leaves no row); return the error it raised, or null. */
async function refused(sql) {
  await run('BEGIN; SAVEPOINT s;')
  try { await run(sql); return null } catch (e) { return String(e.message || e) } finally { await run('ROLLBACK TO SAVEPOINT s; COMMIT;') }
}
const orgOf = async (id) => (await one('SELECT organization_id FROM public.contacts WHERE id = $1', [id])).organization_id
const emailIndexes = async () => (await rows("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'contacts' AND indexname LIKE 'contacts_email%' ORDER BY 1")).map((r) => r.indexname)
const contactCount = async () => (await one('SELECT count(*)::int AS n FROM public.contacts')).n
async function book(locationId, email) {
  await run(`DELETE FROM public.bookings;`)
  await db.query('INSERT INTO public.bookings (location_id, customer_email, customer_name) VALUES ($1, $2, $3)', [locationId, email, 'Sam Lee'])
  return (await one('SELECT contact_id FROM public.bookings')).contact_id
}

describe('migration 712 — contact email unique per organisation', () => {
  beforeAll(async () => {
    db = new PGlite()
    await run(SCHEMA)
    expect(await emailIndexes()).toEqual(['contacts_email_unique'])
    await run(MIG_712)
  }, 60_000)
  afterAll(async () => { await db?.close() })

  it('backfills organization_id from the location; a location-less row stays NULL', async () => {
    expect(await orgOf(SAM)).toBe(ORG_A)
    expect(await orgOf(NOWHERE)).toBeNull()
  })

  it('replaces the global index with contacts_email_org_unique (NULLS NOT DISTINCT)', async () => {
    expect(await emailIndexes()).toEqual(['contacts_email_org_unique'])
    const idx = await one("SELECT i.indnullsnotdistinct AS nnd FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'contacts_email_org_unique'")
    expect(idx.nnd).toBe(true)
  })

  it('stamps organization_id on INSERT and re-stamps on UPDATE OF location_id', async () => {
    await run(`INSERT INTO public.contacts (id, name, email, location_id) VALUES ('cccccccc-0000-0000-0000-000000000002', 'Mover', 'mover@example.test', '${A1}')`)
    expect(await orgOf('cccccccc-0000-0000-0000-000000000002')).toBe(ORG_A)
    await run(`UPDATE public.contacts SET location_id = '${B1}' WHERE id = 'cccccccc-0000-0000-0000-000000000002'`)
    expect(await orgOf('cccccccc-0000-0000-0000-000000000002')).toBe(ORG_B)
    await run(`UPDATE public.contacts SET location_id = NULL WHERE id = 'cccccccc-0000-0000-0000-000000000002'`)
    expect(await orgOf('cccccccc-0000-0000-0000-000000000002')).toBeNull()
    await run(`DELETE FROM public.contacts WHERE id = 'cccccccc-0000-0000-0000-000000000002'`)
  })

  it('the same email may exist once per ORGANISATION, never twice within one', async () => {
    expect(await refused(`INSERT INTO public.contacts (name, email, location_id) VALUES ('Sam B', 'sam@example.test', '${B1}')`)).toBeNull()
    expect(await refused(`INSERT INTO public.contacts (name, email, location_id) VALUES ('Sam again', 'Sam@Example.test', '${A2}')`))
      .toMatch(/contacts_email_org_unique/)
    expect(await refused(`INSERT INTO public.contacts (name, email, location_id) VALUES ('Sam again', 'Sam@Example.test', '${A1}')`))
      .toMatch(/contacts_email_org_unique/)
  })

  it('two location-less rows with one email are refused (NULL organisation is not an escape)', async () => {
    expect(await refused(`INSERT INTO public.contacts (name, email, location_id) VALUES ('Nowhere 2', 'nowhere@example.test', NULL)`))
      .toMatch(/contacts_email_org_unique/)
    // A different address with no location is still fine.
    expect(await refused(`INSERT INTO public.contacts (name, email, location_id) VALUES ('Nowhere 3', 'elsewhere@example.test', NULL)`)).toBeNull()
  })

  it('a location moved to another organisation carries its contacts with it', async () => {
    await run(`INSERT INTO public.contacts (id, name, email, location_id) VALUES ('cccccccc-0000-0000-0000-000000000003', 'At A2', 'at-a2@example.test', '${A2}')`)
    expect(await orgOf('cccccccc-0000-0000-0000-000000000003')).toBe(ORG_A)
    await run(`UPDATE public.locations SET organization_id = '${ORG_B}' WHERE id = '${A2}'`)
    expect(await orgOf('cccccccc-0000-0000-0000-000000000003')).toBe(ORG_B)
    expect(await orgOf(SAM)).toBe(ORG_A) // A1 did not move
    await run(`UPDATE public.locations SET organization_id = '${ORG_A}' WHERE id = '${A2}'`)
    expect(await orgOf('cccccccc-0000-0000-0000-000000000003')).toBe(ORG_A)
    await run(`DELETE FROM public.contacts WHERE id = 'cccccccc-0000-0000-0000-000000000003'`)
  })

  it('the view carries organization_id LAST, security_invoker, no client grant', async () => {
    const cols = (await rows("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contact_location_audience' ORDER BY ordinal_position")).map((r) => r.column_name)
    expect(cols.at(-1)).toBe('organization_id')
    expect(cols).toHaveLength(CONTACT_COLS.length + 1 + 4)
    const v = await one("SELECT reloptions FROM pg_class WHERE oid = 'public.contact_location_audience'::regclass")
    expect(v.reloptions).toEqual(['security_invoker=on'])
    const grants = await rows("SELECT grantee FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'contact_location_audience' AND grantee IN ('anon', 'authenticated', 'PUBLIC')")
    expect(grants).toEqual([])
  })

  it('a booking at a sibling studio links the in-org holder and creates no contact', async () => {
    const before = await contactCount()
    expect(await book(A2, 'SAM@example.test')).toBe(SAM)
    expect(await contactCount()).toBe(before)
  })

  it('this location beats an in-org sibling, and a sibling beats a legacy location-less row', async () => {
    // sam@ is held at A1 (org A); give org B its own holder at B1.
    await run(`INSERT INTO public.contacts (id, name, email, location_id) VALUES ('cccccccc-0000-0000-0000-00000000000b', 'Sam B', 'sam@example.test', '${B1}')`)
    expect(await book(B1, 'sam@example.test')).toBe('cccccccc-0000-0000-0000-00000000000b')
    // nowhere@ is held only by the legacy NULL-location row: it still matches.
    expect(await book(A2, 'NOWHERE@example.test')).toBe(NOWHERE)
    // Give A1 (a sibling of A2) its own nowhere@: the sibling now wins over the legacy row.
    await run(`INSERT INTO public.contacts (id, name, email, location_id) VALUES ('cccccccc-0000-0000-0000-000000000004', 'Nowhere at A1', 'nowhere@example.test', '${A1}')`)
    expect(await book(A2, 'nowhere@example.test')).toBe('cccccccc-0000-0000-0000-000000000004')
    // And a holder at the booking's own location wins over both.
    await run(`UPDATE public.contacts SET location_id = '${A2}' WHERE id = 'cccccccc-0000-0000-0000-000000000004'`)
    expect(await book(A2, 'nowhere@example.test')).toBe('cccccccc-0000-0000-0000-000000000004')
    await run(`DELETE FROM public.contacts WHERE id = 'cccccccc-0000-0000-0000-000000000004'`)
  })

  it("a booking in another organisation never links that org's holder: it creates its own contact", async () => {
    await run(`DELETE FROM public.contacts WHERE location_id = '${B1}'`)
    const before = await contactCount()
    const linked = await book(B1, 'sam@example.test')
    expect(linked).not.toBe(SAM)
    const created = await one('SELECT organization_id, location_id FROM public.contacts WHERE id = $1', [linked])
    expect(created).toEqual({ organization_id: ORG_B, location_id: B1 })
    expect(await contactCount()).toBe(before + 1)
  })

  it('a second run passes and leaves one trigger of each', async () => {
    await run(MIG_712)
    expect(await emailIndexes()).toEqual(['contacts_email_org_unique'])
    const t = await rows("SELECT tgname FROM pg_trigger WHERE tgname IN ('contacts_set_organization_id', 'locations_restamp_contacts_organization') ORDER BY 1")
    expect(t.map((r) => r.tgname)).toEqual(['contacts_set_organization_id', 'locations_restamp_contacts_organization'])
  })
})
