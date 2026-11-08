// HOSTPAGE.2 — behavioural test for migration 823 (host page extras, rating
// copy, event_ratings, event_rating_requests), replayed on PGlite.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/823_host_page_extras_ratings.sql'), 'utf8')
const H = 'a0000000-0000-4000-8000-0000000000a1'
const E = 'e0000000-0000-4000-8000-0000000000e1'
const R1 = '80000000-0000-4000-8000-000000000001'
const SCHEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TABLE public.event_hosts (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.race_events (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.race_registrations (id uuid PRIMARY KEY);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY);
  INSERT INTO public.event_hosts (id, name) VALUES ('${H}', 'Acme');
  INSERT INTO public.race_events (id, name) VALUES ('${E}', 'W');
  INSERT INTO public.race_registrations (id) VALUES ('${R1}');
`
let db
beforeEach(async () => { db = new PGlite(); await db.exec(SCHEMA); await db.exec(MIG) })

const col = (table, name) => db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, name]).then((r) => r.rows[0])
const clientPrivs = (table) => db.query(`SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE table_name = $1 AND grantee IN ('anon','authenticated')`, [table]).then((r) => r.rows[0].n)
const rls = (table) => db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [table]).then((r) => r.rows[0].relrowsecurity)
const rate = (reg, rating, comment = null) => db.query(`INSERT INTO public.event_ratings (race_event_id, registration_id, host_id, rating, comment) VALUES ('${E}', $1, '${H}', $2, $3)`, [reg, rating, comment])

describe('migration 823 — host page extras + ratings', () => {
  it('adds the five event_hosts columns (toggles default true) and the two rating copy columns', async () => {
    expect(await col('event_hosts', 'about_text')).toMatchObject({ data_type: 'text', is_nullable: 'YES' })
    expect(await col('event_hosts', 'photos')).toMatchObject({ data_type: 'jsonb', is_nullable: 'YES' })
    expect(await col('event_hosts', 'testimonials')).toMatchObject({ data_type: 'jsonb', is_nullable: 'YES' })
    expect(await col('event_hosts', 'show_past_events')).toMatchObject({ data_type: 'boolean', is_nullable: 'NO', column_default: 'true' })
    expect(await col('event_hosts', 'show_ratings')).toMatchObject({ data_type: 'boolean', is_nullable: 'NO', column_default: 'true' })
    expect(await col('race_events', 'rating_email_subject')).toMatchObject({ data_type: 'text' })
    expect(await col('race_events', 'rating_email_intro')).toMatchObject({ data_type: 'text' })
  })
  it('event_ratings: 1–5 only, comment ≤600, one per registration, public by default', async () => {
    await expect(rate(R1, 6)).rejects.toMatchObject({ code: '23514' })
    await expect(rate(R1, 0)).rejects.toMatchObject({ code: '23514' })
    await expect(rate(R1, 5, 'x'.repeat(601))).rejects.toMatchObject({ code: '23514' })
    await rate(R1, 5, 'Great')
    await expect(rate(R1, 4)).rejects.toMatchObject({ code: '23505' })
    const { rows } = await db.query(`SELECT is_public FROM public.event_ratings WHERE registration_id = '${R1}'`)
    expect(rows[0].is_public).toBe(true)
  })
  it('event_rating_requests is keyed by registration', async () => {
    await db.query(`INSERT INTO public.event_rating_requests (registration_id, race_event_id) VALUES ('${R1}', '${E}')`)
    await expect(db.query(`INSERT INTO public.event_rating_requests (registration_id, race_event_id) VALUES ('${R1}', '${E}')`)).rejects.toMatchObject({ code: '23505' })
  })
  it('both tables are closed to every client role, RLS on', async () => {
    for (const t of ['event_ratings', 'event_rating_requests']) {
      expect(await clientPrivs(t)).toBe(0)
      expect(await rls(t)).toBe(true)
    }
  })
  it('re-applies cleanly', async () => {
    await expect(db.exec(MIG)).resolves.not.toThrow()
  })
})
