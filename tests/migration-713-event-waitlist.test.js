// EVENT-WAITLIST.1 — mig 713: the event_waitlist table (one row per event +
// email, the status and source vocabularies, headcount bounds), the offer
// copy columns on race_events, the closed client ACL, and the cron heartbeat
// row (born healthy, replay-safe). Run against PGlite with the minimal tables
// it touches. Fictional values only.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/713_event_waitlist.sql'), 'utf8')
const L1 = 'a0000000-0000-4000-8000-0000000000a1'
const E1 = 'e0000000-0000-4000-8000-0000000000e1'

async function fresh() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE TABLE public.locations (id uuid PRIMARY KEY);
    CREATE TABLE public.contacts (id uuid PRIMARY KEY);
    CREATE TABLE public.race_events (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.race_registrations (id uuid PRIMARY KEY);
    CREATE TABLE public.cron_heartbeats (
      name text PRIMARY KEY, last_ok_at timestamptz NOT NULL DEFAULT now(),
      expected_interval_seconds int NOT NULL, grace_seconds int NOT NULL DEFAULT 60, notes text);
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    INSERT INTO public.locations VALUES ('${L1}');
    INSERT INTO public.race_events VALUES ('${E1}', 'Fictional Relay');`)
  await db.exec(MIG)
  return db
}

/** Insert one row; `cols` adds named columns with their values. */
const join = (db, email, cols = {}) => {
  const names = ['race_event_id', 'location_id', 'name', 'email', ...Object.keys(cols)]
  const values = [E1, L1, 'Ann Example', email, ...Object.values(cols)]
  const marks = values.map((_, i) => `$${i + 1}`).join(', ')
  return db.query(`INSERT INTO public.event_waitlist (${names.join(', ')}) VALUES (${marks})`, values)
}

// PGlite boots per test; a cold boot on a loaded runner can pass 5 s.
describe('migration 713 (EVENT-WAITLIST.1)', { timeout: 30_000 }, () => {
  it('a new row is waiting, from the public form, never offered', async () => {
    const db = await fresh()
    await join(db, 'ann@example.test')
    const { rows } = await db.query(`SELECT status, source, headcount, offer_count, last_offered_at FROM public.event_waitlist`)
    expect(rows).toEqual([{ status: 'waiting', source: 'public', headcount: 1, offer_count: 0, last_offered_at: null }])
  })

  it('one row per (event, email): a second join on the same email fails 23505', async () => {
    const db = await fresh()
    await join(db, 'ann@example.test')
    await expect(join(db, 'ann@example.test')).rejects.toThrow(/duplicate key|unique/i)
  })

  it('refuses a status or source outside the vocabulary, and a headcount outside 1..50', async () => {
    const db = await fresh()
    await expect(join(db, 'a@example.test', { status: 'held' })).rejects.toThrow(/check/i)
    await expect(join(db, 'b@example.test', { source: 'import' })).rejects.toThrow(/check/i)
    await expect(join(db, 'c@example.test', { headcount: 0 })).rejects.toThrow(/check/i)
    await expect(join(db, 'd@example.test', { headcount: 51 })).rejects.toThrow(/check/i)
  })

  it('stamps updated_at on update', async () => {
    const db = await fresh()
    await join(db, 'ann@example.test')
    await db.query(`UPDATE public.event_waitlist SET updated_at = '2000-01-01', created_at = '2000-01-01'`)
    await db.query(`UPDATE public.event_waitlist SET status = 'offered'`)
    const { rows } = await db.query(`SELECT updated_at > created_at AS moved FROM public.event_waitlist`)
    expect(rows[0].moved).toBe(true)
  })

  it('is closed to every client session (RLS on, nothing granted)', async () => {
    const db = await fresh()
    const { rows } = await db.query(`
      SELECT grantee FROM information_schema.table_privileges
      WHERE table_name = 'event_waitlist' AND grantee IN ('anon', 'authenticated')`)
    expect(rows).toEqual([])
    const rls = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'event_waitlist'`)
    expect(rls.rows[0].relrowsecurity).toBe(true)
  })

  it('adds the two offer copy columns to race_events', async () => {
    const db = await fresh()
    await db.query(`UPDATE public.race_events SET waitlist_email_subject = 's', waitlist_email_intro = 'i'`)
    const { rows } = await db.query(`SELECT waitlist_email_subject, waitlist_email_intro FROM public.race_events`)
    expect(rows).toEqual([{ waitlist_email_subject: 's', waitlist_email_intro: 'i' }])
  })

  it('seeds the cron heartbeat as 600 + 900, and a replay re-arms it', async () => {
    const db = await fresh()
    await db.query(`UPDATE public.cron_heartbeats SET last_ok_at = '2000-01-01' WHERE name = 'event-waitlist-offers'`)
    await db.exec(MIG)
    const { rows } = await db.query(`SELECT expected_interval_seconds AS i, grace_seconds AS g, last_ok_at > '2001-01-01' AS fresh FROM public.cron_heartbeats WHERE name = 'event-waitlist-offers'`)
    expect(rows).toEqual([{ i: 600, g: 900, fresh: true }])
  })
})
