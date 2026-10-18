// WAORGNUMBER.1 — behavioural test for migration 743: WhatsApp numbers are
// organisation-owned and switched on per studio (design R1). Loads the REAL
// 723 + 743 files into PGlite over the live columns of the tables they touch.
// The default privileges below mimic a database BEFORE mig 667/677/678, so a
// closed grant in the result is the migration's own REVOKE, not the sandbox.
// Fictional ids only: the repo is public.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_723 = read('723_move_whatsapp_conversation.sql')
const MIG_743 = read('743_wa_org_numbers.sql')

const ORG = 'd0000000-0000-0000-0000-000000000001'
const ORG2 = 'd0000000-0000-0000-0000-000000000002'
const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'
const OTHER = 'a0000000-0000-0000-0000-000000000003'
const NUM = 'f0000000-0000-0000-0000-000000000001'
const NUM2 = 'f0000000-0000-0000-0000-000000000002'
const NUM3 = 'f0000000-0000-0000-0000-000000000003'
const K_HATCH = 'b0000000-0000-0000-0000-000000000001'
const C1 = 'c0000000-0000-0000-0000-000000000001'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA private;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id));
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid NOT NULL);
  CREATE TABLE public.whatsapp_numbers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    label text NOT NULL DEFAULT 'n', is_active boolean NOT NULL DEFAULT true,
    is_default boolean NOT NULL DEFAULT false, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.whatsapp_conversations (
    id uuid PRIMARY KEY, location_id uuid NOT NULL, contact_id uuid, wa_phone text, window_open_at timestamptz,
    window_expires_at timestamptz, status text DEFAULT 'active', last_message_at timestamptz, last_message_direction text,
    last_message_preview text, unread_count integer DEFAULT 0, assigned_to uuid,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), wa_profile_name text,
    agent_active boolean NOT NULL DEFAULT true, agent_handed_off_at timestamptz, agent_last_reply_at timestamptz,
    agent_verified_contact_id uuid, agent_verified_at timestamptz, agent_processing_at timestamptz, resolved_at timestamptz,
    agent_followup_stage smallint NOT NULL DEFAULT 0, agent_followup_sent_at timestamptz, ctwa_clid text,
    is_blocked boolean NOT NULL DEFAULT false, handoff_escalated_at timestamptz, wa_bsuid text,
    agent_activity_notified_at timestamptz, agent_verify_attempts smallint NOT NULL DEFAULT 0, agent_paused_at timestamptz,
    whatsapp_number_id uuid REFERENCES public.whatsapp_numbers(id) ON DELETE SET NULL);
  CREATE TABLE public.whatsapp_messages (id serial PRIMARY KEY,
    conversation_id uuid REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE, location_id uuid, body text);
  CREATE TABLE public.agent_decisions (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_membership_requests (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_message_feedback (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_conversation_reviews (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid,
    review_date date, UNIQUE (channel, conversation_id, review_date));
  CREATE TABLE public.cancellation_form_links (id serial PRIMARY KEY, location_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('email', 'whatsapp')), conversation_id uuid);
  INSERT INTO public.organizations VALUES ('${ORG}'), ('${ORG2}');
  INSERT INTO public.locations VALUES ('${STILL}', '${ORG}'), ('${HATCH}', '${ORG}'), ('${OTHER}', '${ORG2}');
  INSERT INTO public.whatsapp_numbers (id, location_id, label, is_default) VALUES ('${NUM}', '${STILL}', 'main', true);
  INSERT INTO public.contacts VALUES ('${K_HATCH}', '${HATCH}');
`
async function boot(extraBefore = '') {
  const db = new PGlite()
  await db.exec(SCHEMA)
  if (extraBefore) await db.exec(extraBefore)
  await db.exec(MIG_723)
  await db.exec(MIG_743)
  return db
}
const one = async (db, sql) => (await db.query(sql)).rows[0]
const rows = async (db, sql) => (await db.query(sql)).rows

describe('743 organisation-owned WhatsApp numbers', () => {
  it('backfills one link row per number', async () => {
    const db = await boot()
    expect(await rows(db, `SELECT location_id, whatsapp_number_id, is_default FROM location_whatsapp_numbers`))
      .toEqual([{ location_id: STILL, whatsapp_number_id: NUM, is_default: true }])
  })

  it('backfills organization_id', async () => {
    const db = await boot()
    expect(await rows(db, `SELECT organization_id FROM whatsapp_numbers`)).toEqual([{ organization_id: ORG }])
  })

  it('refuses a link across organisations', async () => {
    const db = await boot()
    await expect(db.exec(`INSERT INTO location_whatsapp_numbers (location_id, whatsapp_number_id) VALUES ('${OTHER}', '${NUM}')`))
      .rejects.toThrow(/another organisation/)
    // and an UPDATE that moves a link there is refused too
    await db.exec(`INSERT INTO location_whatsapp_numbers (location_id, whatsapp_number_id) VALUES ('${HATCH}', '${NUM}')`)
    await expect(db.exec(`UPDATE location_whatsapp_numbers SET location_id = '${OTHER}' WHERE location_id = '${HATCH}'`))
      .rejects.toThrow(/another organisation/)
  })

  it('switching a number on at a second studio of the organisation is allowed', async () => {
    const db = await boot()
    await db.exec(`INSERT INTO location_whatsapp_numbers (location_id, whatsapp_number_id) VALUES ('${HATCH}', '${NUM}')`)
    expect((await one(db, `SELECT count(*)::int AS n FROM location_whatsapp_numbers`)).n).toBe(2)
  })

  it('one default per studio', async () => {
    const db = await boot(`INSERT INTO public.whatsapp_numbers (id, location_id, label) VALUES ('${NUM2}', '${STILL}', 'second');`)
    // NUM2's own home link (from the backfill) is not default; making it so beside NUM's default is refused
    await expect(db.exec(`UPDATE location_whatsapp_numbers SET is_default = true WHERE whatsapp_number_id = '${NUM2}'`))
      .rejects.toThrow(/location_whatsapp_numbers_one_default|duplicate key/)
  })

  it('is closed to clients', async () => {
    const db = await boot()
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect((await one(db, `SELECT has_table_privilege('${role}', 'public.location_whatsapp_numbers', '${priv}') AS ok`)).ok, `${role} ${priv}`).toBe(false)
      }
    }
  })

  it('move stamps from the link default', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C1}', '${STILL}', '${K_HATCH}', '15555550100');`)
    const r = (await one(db, `SELECT public.move_whatsapp_conversation('${C1}', '${HATCH}') AS r`)).r
    expect(r).toMatchObject({ conversation_id: C1, merged: false })
    expect(await one(db, `SELECT whatsapp_number_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ whatsapp_number_id: NUM })
  })

  it('move stamps the link default, not a newer number, and ignores a number no longer switched on at the source studio', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_numbers (id, location_id, label, updated_at) VALUES ('${NUM2}', '${STILL}', 'second', now() + interval '1 day');
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C1}', '${STILL}', '${K_HATCH}', '15555550100');`)
    // NUM stays the link default (is_default on the link), NUM2 is newer but not default
    await db.exec(`SELECT public.move_whatsapp_conversation('${C1}', '${HATCH}')`)
    expect(await one(db, `SELECT whatsapp_number_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ whatsapp_number_id: NUM })

    // switch NUM off at STILL: the stamp falls to the newest number that is still switched on there
    await db.exec(`UPDATE whatsapp_conversations SET whatsapp_number_id = NULL, location_id = '${STILL}' WHERE id = '${C1}'`)
    await db.exec(`DELETE FROM location_whatsapp_numbers WHERE whatsapp_number_id = '${NUM}' AND location_id = '${STILL}'`)
    await db.exec(`SELECT public.move_whatsapp_conversation('${C1}', '${HATCH}')`)
    expect(await one(db, `SELECT whatsapp_number_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ whatsapp_number_id: NUM2 })
  })

  it('move keeps its grants', async () => {
    const db = await boot()
    expect((await one(db, `SELECT has_function_privilege('authenticated', 'public.move_whatsapp_conversation(uuid,uuid)', 'EXECUTE') AS ok`)).ok).toBe(false)
    expect((await one(db, `SELECT has_function_privilege('anon', 'public.move_whatsapp_conversation(uuid,uuid)', 'EXECUTE') AS ok`)).ok).toBe(false)
  })

  it('deprecation comment', async () => {
    const db = await boot()
    const c = (col) => one(db, `SELECT col_description('public.whatsapp_numbers'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.whatsapp_numbers'::regclass AND attname = '${col}')) AS d`)
    expect((await c('is_default')).d).toMatch(/DEPRECATED \(mig 743\)/)
    expect((await c('location_id')).d).toMatch(/Home studio/)
  })

  it('old-style insert without organization_id gets it filled', async () => {
    const db = await boot()
    await db.exec(`INSERT INTO public.whatsapp_numbers (id, location_id, label) VALUES ('${NUM2}', '${HATCH}', 'hatch')`)
    expect(await one(db, `SELECT organization_id FROM whatsapp_numbers WHERE id = '${NUM2}'`)).toEqual({ organization_id: ORG })
  })

  it('a newly inserted number is switched on at its home studio (default when none)', async () => {
    const db = await boot()
    // HATCH has no default link yet: the first number there becomes it
    await db.exec(`INSERT INTO public.whatsapp_numbers (id, location_id, label) VALUES ('${NUM2}', '${HATCH}', 'hatch')`)
    // STILL already has a default (NUM): a second number there is switched on but not default
    await db.exec(`INSERT INTO public.whatsapp_numbers (id, location_id, label) VALUES ('${NUM3}', '${STILL}', 'still-2')`)
    expect(await rows(db, `SELECT location_id, whatsapp_number_id, is_default FROM location_whatsapp_numbers WHERE whatsapp_number_id <> '${NUM}' ORDER BY whatsapp_number_id`))
      .toEqual([
        { location_id: HATCH, whatsapp_number_id: NUM2, is_default: true },
        { location_id: STILL, whatsapp_number_id: NUM3, is_default: false },
      ])
  })

  it('the definer trigger switches a number on even when a client-role session inserts it', async () => {
    const db = await boot()
    await db.exec(`SET ROLE authenticated`)
    try {
      await db.exec(`INSERT INTO public.whatsapp_numbers (id, location_id, label) VALUES ('${NUM2}', '${HATCH}', 'hatch')`)
      // the session itself still cannot touch the closed link table
      await expect(db.exec(`INSERT INTO public.location_whatsapp_numbers (location_id, whatsapp_number_id) VALUES ('${HATCH}', '${NUM}')`))
        .rejects.toThrow(/permission denied/)
    } finally {
      await db.exec(`RESET ROLE`)
    }
    expect(await rows(db, `SELECT location_id, whatsapp_number_id, is_default FROM location_whatsapp_numbers WHERE whatsapp_number_id = '${NUM2}'`))
      .toEqual([{ location_id: HATCH, whatsapp_number_id: NUM2, is_default: true }])
  })

  it('an insert with an explicit foreign organization_id is refused (its home link would cross organisations)', async () => {
    const db = await boot()
    await expect(db.exec(`INSERT INTO public.whatsapp_numbers (id, location_id, label, organization_id) VALUES ('${NUM2}', '${HATCH}', 'x', '${ORG2}')`))
      .rejects.toThrow(/another organisation/)
    expect((await one(db, `SELECT count(*)::int AS n FROM whatsapp_numbers WHERE id = '${NUM2}'`)).n).toBe(0)
  })

  it('refuses an organisation change that would leave a cross-organisation link, allows a same-organisation home move', async () => {
    const db = await boot()
    await expect(db.exec(`UPDATE public.whatsapp_numbers SET organization_id = '${ORG2}' WHERE id = '${NUM}'`))
      .rejects.toThrow(/another organisation/)
    await expect(db.exec(`UPDATE public.whatsapp_numbers SET location_id = '${OTHER}', organization_id = '${ORG2}' WHERE id = '${NUM}'`))
      .rejects.toThrow(/another organisation/)
    // moving the home studio inside the organisation is fine
    await db.exec(`UPDATE public.whatsapp_numbers SET location_id = '${HATCH}' WHERE id = '${NUM}'`)
    expect(await one(db, `SELECT location_id, organization_id FROM whatsapp_numbers WHERE id = '${NUM}'`)).toEqual({ location_id: HATCH, organization_id: ORG })
    // once the number is switched on nowhere, its organisation may change
    await db.exec(`DELETE FROM location_whatsapp_numbers WHERE whatsapp_number_id = '${NUM}'`)
    await db.exec(`UPDATE public.whatsapp_numbers SET organization_id = '${ORG2}', location_id = '${OTHER}' WHERE id = '${NUM}'`)
    expect(await one(db, `SELECT organization_id FROM whatsapp_numbers WHERE id = '${NUM}'`)).toEqual({ organization_id: ORG2 })
  })

  it('the trigger functions are closed to anon and authenticated', async () => {
    const db = await boot()
    for (const fn of ['private.location_whatsapp_numbers_same_org()', 'private.whatsapp_numbers_fill_organization()', 'private.whatsapp_numbers_switch_on_at_home()', 'private.whatsapp_numbers_org_change_guard()']) {
      for (const role of ['anon', 'authenticated']) {
        expect((await one(db, `SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ok`)).ok, `${role} ${fn}`).toBe(false)
      }
    }
  })
})
