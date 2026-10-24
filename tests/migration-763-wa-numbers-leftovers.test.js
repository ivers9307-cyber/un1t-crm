// ORGCONTACTS.0 (spec §3.1-3.2) — behavioural test for migration 763: the
// WAORGNUMBER leftovers go. Loads mig 176's live shape of whatsapp_numbers
// (the per-studio label uniqueness and the per-studio default partial index),
// then the REAL 723, 743 and 763 files into PGlite. The default privileges
// mimic a database BEFORE mig 667/677/678, so a closed grant in the result is a
// migration's own REVOKE, not the sandbox. Fictional ids only: the repo is public.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_723 = read('723_move_whatsapp_conversation.sql')
const MIG_743 = read('743_wa_org_numbers.sql')
const MIG_763 = read('763_wa_numbers_leftovers.sql')

const ORG = 'd0000000-0000-0000-0000-000000000001'
const ORG2 = 'd0000000-0000-0000-0000-000000000002'
const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'
const OTHER = 'a0000000-0000-0000-0000-000000000003'
const NUM = 'f0000000-0000-0000-0000-000000000001'
const NUM2 = 'f0000000-0000-0000-0000-000000000002'
const NUM3 = 'f0000000-0000-0000-0000-000000000003'

// The columns 176 + 743 leave on whatsapp_numbers that 763 reads, plus mig
// 176's UNIQUE (location_id, label) and its per-studio default partial index.
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
    is_default boolean NOT NULL DEFAULT false, updated_at timestamptz DEFAULT now(),
    UNIQUE (location_id, label));
  CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_numbers_default
    ON public.whatsapp_numbers (location_id) WHERE is_default = true;
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
`
async function boot({ before763 = '', apply763 = true } = {}) {
  const db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG_723)
  await db.exec(MIG_743)
  if (before763) await db.exec(before763)
  if (apply763) await db.exec(MIG_763)
  return db
}
const one = async (db, sql) => (await db.query(sql)).rows[0]
const rows = async (db, sql) => (await db.query(sql)).rows
const triggers = (db) => rows(db, `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.whatsapp_numbers'::regclass AND NOT tgisinternal ORDER BY 1`)

describe('763 WhatsApp number leftovers', () => {
  it('is_default and its per-studio default index are gone; the link table keeps its own', async () => {
    const db = await boot()
    expect(await rows(db, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'whatsapp_numbers' AND column_name = 'is_default'`)).toEqual([])
    expect((await one(db, `SELECT to_regclass('public.idx_whatsapp_numbers_default') AS i`)).i).toBeNull()
    expect((await one(db, `SELECT to_regclass('public.location_whatsapp_numbers_one_default') AS i`)).i).not.toBeNull()
    expect(await rows(db, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'location_whatsapp_numbers' AND column_name = 'is_default'`)).toHaveLength(1)
  })

  it('the two compatibility triggers and their functions are gone; the organisation-change guard remains', async () => {
    const db = await boot()
    expect((await triggers(db)).map((t) => t.tgname)).toEqual(['trg_whatsapp_numbers_org_change_guard'])
    expect((await one(db, `SELECT to_regprocedure('private.whatsapp_numbers_fill_organization()') AS f`)).f).toBeNull()
    expect((await one(db, `SELECT to_regprocedure('private.whatsapp_numbers_switch_on_at_home()') AS f`)).f).toBeNull()
    expect((await one(db, `SELECT to_regprocedure('private.whatsapp_numbers_org_change_guard()') AS f`)).f).not.toBeNull()
  })

  it('a number inserted on its own is NOT switched on anywhere (the route writes the link now)', async () => {
    const db = await boot()
    await db.exec(`INSERT INTO whatsapp_numbers (id, organization_id, location_id, label) VALUES ('${NUM2}', '${ORG}', '${HATCH}', 'second')`)
    expect(await rows(db, `SELECT whatsapp_number_id FROM location_whatsapp_numbers WHERE location_id = '${HATCH}'`)).toEqual([])
  })

  it('an insert without organization_id is refused (nothing fills it any more)', async () => {
    const db = await boot()
    await expect(db.exec(`INSERT INTO whatsapp_numbers (id, location_id, label) VALUES ('${NUM2}', '${HATCH}', 'second')`))
      .rejects.toThrow(/null value in column "organization_id"/)
  })

  it('the label is unique per ORGANISATION, not per studio', async () => {
    const db = await boot()
    await expect(db.exec(`INSERT INTO whatsapp_numbers (id, organization_id, location_id, label) VALUES ('${NUM2}', '${ORG}', '${HATCH}', 'main')`))
      .rejects.toThrow(/whatsapp_numbers_organization_label_unique/)
    await db.exec(`INSERT INTO whatsapp_numbers (id, organization_id, location_id, label) VALUES ('${NUM3}', '${ORG2}', '${OTHER}', 'main')`)
    expect(await rows(db, `SELECT conname FROM pg_constraint WHERE conrelid = 'public.whatsapp_numbers'::regclass AND contype = 'u' ORDER BY 1`))
      .toEqual([{ conname: 'whatsapp_numbers_organization_label_unique' }])
  })

  it('the organisation-change guard still refuses a move that strands a link', async () => {
    const db = await boot()
    await db.exec(`INSERT INTO location_whatsapp_numbers (location_id, whatsapp_number_id) VALUES ('${HATCH}', '${NUM}')`)
    await expect(db.exec(`UPDATE whatsapp_numbers SET organization_id = '${ORG2}', location_id = '${OTHER}' WHERE id = '${NUM}'`))
      .rejects.toThrow(/another organisation/)
    await db.exec(`UPDATE whatsapp_numbers SET location_id = '${HATCH}' WHERE id = '${NUM}'`)
  })

  it('the location_id comment names the three duties of the home studio', async () => {
    const db = await boot()
    const { c } = await one(db, `SELECT col_description('public.whatsapp_numbers'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.whatsapp_numbers'::regclass AND attname = 'location_id')) AS c`)
    expect(c).toMatch(/Unknown senders, Meta-made templates and chat-opener edits belong to this studio/)
  })

  it('move_whatsapp_conversation still stamps from the link default and keeps its grants', async () => {
    const db = await boot()
    await db.exec(`INSERT INTO whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${NUM3}', '${STILL}', NULL, '353870000001')`)
    await db.exec(`SELECT public.move_whatsapp_conversation('${NUM3}', '${HATCH}')`)
    expect((await one(db, `SELECT whatsapp_number_id FROM whatsapp_conversations WHERE id = '${NUM3}'`)).whatsapp_number_id).toBe(NUM)
    expect((await one(db, `SELECT has_function_privilege('authenticated', 'public.move_whatsapp_conversation(uuid,uuid)', 'EXECUTE') AS x`)).x).toBe(false)
  })

  it('aborts, and changes nothing, when two numbers of one organisation already share a label', async () => {
    const db = await boot({ apply763: false, before763: `INSERT INTO whatsapp_numbers (id, organization_id, location_id, label) VALUES ('${NUM2}', '${ORG}', '${HATCH}', 'main')` })
    await expect(db.exec(MIG_763)).rejects.toThrow(/mig 763: 1 label\(s\) are used by more than one number of the same organisation/)
    await db.exec('ROLLBACK')   // the failed BEGIN block leaves the session aborted
    expect(await rows(db, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'whatsapp_numbers' AND column_name = 'is_default'`)).toHaveLength(1)
    expect((await triggers(db)).map((t) => t.tgname)).toHaveLength(3)
  })

  it('a second run is a no-op', async () => {
    const db = await boot()
    await db.exec(MIG_763)
    expect((await triggers(db)).map((t) => t.tgname)).toEqual(['trg_whatsapp_numbers_org_change_guard'])
    expect(await rows(db, `SELECT conname FROM pg_constraint WHERE conrelid = 'public.whatsapp_numbers'::regclass AND contype = 'u'`)).toHaveLength(1)
  })

  it('the file ends with the self-check and COMMIT, never names the old constraint by a guessed name, and carries no placeholder', () => {
    expect(MIG_763).toMatch(/END \$\$;\s*COMMIT;\s*$/)
    expect(MIG_763).not.toMatch(/whatsapp_numbers_location_id_label_key/)
    expect(MIG_763).not.toMatch(/@@/)
  })
})
