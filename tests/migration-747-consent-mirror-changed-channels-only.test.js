// WAORGNUMBER.3 — behavioural test for migration 747: the contact_preferences ->
// contact_location_preferences mirror acts only on channels that CHANGED.
//
// Since R6 a WhatsApp STOP/START in a studio thread writes only that studio's
// contact_location_preferences row. Under mig 489/543 the next contact_preferences
// write of any kind re-mirrored all three channels onto the home studio's row,
// silently undoing it. Loads the REAL 543 and 747 files into PGlite over the
// columns of the tables they touch, with the mig 489 trigger binding.
// Fictional ids only: the repo is public.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_543 = mig('543_sync_prefs_stamp_unsubscribed_at.sql')
const MIG_747 = mig('747_consent_mirror_changed_channels_only.sql')

const HOME = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'a0000000-0000-0000-0000-000000000002'
const C = 'c0000000-0000-0000-0000-000000000001'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id));
  CREATE TABLE public.contact_preferences (
    contact_id uuid PRIMARY KEY REFERENCES public.contacts(id),
    email_marketing boolean DEFAULT true, sms_marketing boolean DEFAULT true, whatsapp_marketing boolean DEFAULT true,
    email_administrative boolean DEFAULT true, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.contact_location_preferences (
    contact_id uuid NOT NULL REFERENCES public.contacts(id), location_id uuid NOT NULL REFERENCES public.locations(id),
    email_marketing boolean NOT NULL DEFAULT true, sms_marketing boolean NOT NULL DEFAULT true,
    whatsapp_marketing boolean NOT NULL DEFAULT true, subscribed_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL, unsubscribed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id, location_id));
  CREATE TABLE public.consent_log (contact_id uuid, channel text, action text, created_at timestamptz DEFAULT now());
  INSERT INTO public.locations VALUES ('${HOME}'), ('${OTHER}');
  INSERT INTO public.contacts VALUES ('${C}', '${HOME}');
`
// The mig 489 binding (unchanged by 543 and 747).
const TRIGGER = `
  CREATE TRIGGER sync_contact_location_preferences_trigger AFTER INSERT OR UPDATE ON public.contact_preferences
    FOR EACH ROW EXECUTE FUNCTION public.sync_contact_location_preferences();`

async function boot({ upTo = 747 } = {}) {
  const db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG_543)
  if (upTo >= 747) await db.exec(MIG_747)
  await db.exec(TRIGGER)
  return db
}
const rows = async (db, sql) => (await db.query(sql)).rows
const studioRows = (db) => rows(db, `
  SELECT location_id, email_marketing AS email, sms_marketing AS sms, whatsapp_marketing AS wa, unsubscribed_at IS NOT NULL AS stamped
    FROM contact_location_preferences ORDER BY location_id`)
const row = (location_id, email, sms, wa, stamped = false) => ({ location_id, email, sms, wa, stamped })

// Both studio rows open, the contact-wide row open.
const SEED = `
  INSERT INTO contact_location_preferences (contact_id, location_id, source) VALUES ('${C}', '${HOME}', 'test'), ('${C}', '${OTHER}', 'test');
  INSERT INTO contact_preferences (contact_id) VALUES ('${C}');`

describe('747 consent mirror acts only on changed channels', () => {
  it('(a) a studio-only WhatsApp STOP on the home row survives a later unrelated email change', async () => {
    const db = await boot()
    await db.exec(SEED)
    // The R6 STOP: the home studio's row only.
    await db.exec(`UPDATE contact_location_preferences SET whatsapp_marketing = false WHERE contact_id = '${C}' AND location_id = '${HOME}'`)
    // An email unsubscribe, contact-wide.
    await db.exec(`UPDATE contact_preferences SET email_marketing = false WHERE contact_id = '${C}'`)
    expect(await studioRows(db)).toEqual([
      row(HOME, false, true, false, true), // WhatsApp STOP kept; email fanned out and stamped
      row(OTHER, false, true, true, true),
    ])
  })

  it('(a, before) mig 543 re-subscribed that STOP: the defect 747 closes', async () => {
    const db = await boot({ upTo: 543 })
    await db.exec(SEED)
    await db.exec(`UPDATE contact_location_preferences SET whatsapp_marketing = false WHERE contact_id = '${C}' AND location_id = '${HOME}'`)
    await db.exec(`UPDATE contact_preferences SET email_marketing = false WHERE contact_id = '${C}'`)
    expect((await studioRows(db))[0]).toMatchObject({ location_id: HOME, wa: true })
  })

  it('(b) a studio START survives an unrelated write while contact_preferences.whatsapp_marketing is false', async () => {
    const db = await boot()
    await db.exec(SEED)
    // A historic contact-wide STOP fans out everywhere.
    await db.exec(`UPDATE contact_preferences SET whatsapp_marketing = false WHERE contact_id = '${C}'`)
    expect((await studioRows(db)).map((r) => r.wa)).toEqual([false, false])
    // The R6 START at the home studio, then an unrelated contact_preferences write.
    await db.exec(`UPDATE contact_location_preferences SET whatsapp_marketing = true WHERE contact_id = '${C}' AND location_id = '${HOME}'`)
    await db.exec(`UPDATE contact_preferences SET email_administrative = false, updated_at = now() WHERE contact_id = '${C}'`)
    await db.exec(`UPDATE contact_preferences SET sms_marketing = false WHERE contact_id = '${C}'`)
    expect(await studioRows(db)).toEqual([row(HOME, true, false, true), row(OTHER, true, false, false)])
  })

  it('(c) a contact-wide WhatsApp false still fans out to every studio row', async () => {
    const db = await boot()
    await db.exec(SEED)
    await db.exec(`UPDATE contact_preferences SET whatsapp_marketing = false WHERE contact_id = '${C}'`)
    expect(await studioRows(db)).toEqual([row(HOME, true, true, false), row(OTHER, true, true, false)])
  })

  it('(d) a contact-wide email re-subscribe mirrors email to the home row only, clearing its stamp', async () => {
    const db = await boot()
    await db.exec(SEED)
    await db.exec(`UPDATE contact_preferences SET email_marketing = false WHERE contact_id = '${C}'`)
    expect(await studioRows(db)).toEqual([row(HOME, false, true, true, true), row(OTHER, false, true, true, true)])
    await db.exec(`UPDATE contact_preferences SET email_marketing = true WHERE contact_id = '${C}'`)
    expect(await studioRows(db)).toEqual([row(HOME, true, true, true, false), row(OTHER, false, true, true, true)])
  })

  it('(d) a write that leaves email alone leaves unsubscribed_at alone', async () => {
    const db = await boot()
    await db.exec(SEED)
    await db.exec(`UPDATE contact_location_preferences SET email_marketing = false, unsubscribed_at = '2026-01-01T00:00:00Z' WHERE location_id = '${HOME}'`)
    await db.exec(`UPDATE contact_preferences SET sms_marketing = false WHERE contact_id = '${C}'`)
    const [home] = await rows(db, `SELECT email_marketing, sms_marketing, unsubscribed_at FROM contact_location_preferences WHERE location_id = '${HOME}'`)
    expect(home.email_marketing).toBe(false)
    expect(home.sms_marketing).toBe(false)
    expect(new Date(home.unsubscribed_at).toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('(e) INSERT of contact_preferences mirrors every channel as before', async () => {
    const db = await boot()
    await db.exec(`INSERT INTO contact_location_preferences (contact_id, location_id, source) VALUES ('${C}', '${HOME}', 'test'), ('${C}', '${OTHER}', 'test')`)
    await db.exec(`INSERT INTO contact_preferences (contact_id, email_marketing, sms_marketing, whatsapp_marketing) VALUES ('${C}', false, false, false)`)
    expect(await studioRows(db)).toEqual([row(HOME, false, false, false, true), row(OTHER, false, false, false, true)])
  })

  it('(e) INSERT with a channel on mirrors it onto the home row only', async () => {
    const db = await boot()
    await db.exec(`INSERT INTO contact_location_preferences (contact_id, location_id, source, whatsapp_marketing) VALUES ('${C}', '${HOME}', 'test', false), ('${C}', '${OTHER}', 'test', false)`)
    await db.exec(`INSERT INTO contact_preferences (contact_id) VALUES ('${C}')`)
    expect((await studioRows(db)).map((r) => [r.location_id, r.wa])).toEqual([[HOME, true], [OTHER, false]])
  })

  it('keeps SECURITY DEFINER and the pinned search_path', async () => {
    const db = await boot()
    const [fn] = await rows(db, `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'sync_contact_location_preferences'`)
    expect(fn.prosecdef).toBe(true)
    expect(fn.proconfig).toEqual(['search_path=public'])
  })
})
