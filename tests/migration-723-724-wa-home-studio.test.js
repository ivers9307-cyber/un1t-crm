// WAHOMESTUDIO.1 — behavioural test for migrations 723 (move/merge function)
// and 724 (backfill). Models the live columns (information_schema, 15 Oct
// 2026) of the tables the function touches (every whatsapp_conversations column
// the merge rule reads, and its two live PARTIAL unique indexes) and runs the
// REAL files.
// Fictional ids only: the repo is public.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_723 = read('723_move_whatsapp_conversation.sql')
const MIG_724 = read('724_wa_home_studio_backfill.sql')

const ORG = 'd0000000-0000-0000-0000-000000000001'
const ORG2 = 'd0000000-0000-0000-0000-000000000002'
const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'
const OTHER = 'a0000000-0000-0000-0000-000000000003'
const NUM = 'f0000000-0000-0000-0000-000000000001'
const K_HATCH = 'b0000000-0000-0000-0000-000000000001'
const K_STILL = 'b0000000-0000-0000-0000-000000000002'
const C1 = 'c0000000-0000-0000-0000-000000000001'
const C2 = 'c0000000-0000-0000-0000-000000000002'
const C3 = 'c0000000-0000-0000-0000-000000000003'
const C4 = 'c0000000-0000-0000-0000-000000000004'
const C5 = 'c0000000-0000-0000-0000-000000000005'
const K_X = 'b0000000-0000-0000-0000-000000000003'
const USER = 'e0000000-0000-0000-0000-000000000001'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid NOT NULL);
  CREATE TABLE public.whatsapp_numbers (id uuid PRIMARY KEY, location_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
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
  CREATE UNIQUE INDEX idx_wa_conv_location_phone ON public.whatsapp_conversations (location_id, wa_phone) WHERE wa_phone IS NOT NULL;
  CREATE UNIQUE INDEX whatsapp_conversations_location_wa_bsuid_key ON public.whatsapp_conversations (location_id, wa_bsuid) WHERE wa_bsuid IS NOT NULL;
  CREATE TABLE public.whatsapp_messages (id serial PRIMARY KEY,
    conversation_id uuid REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE, location_id uuid, body text);
  CREATE TABLE public.agent_decisions (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_membership_requests (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_message_feedback (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_conversation_reviews (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid,
    review_date date, UNIQUE (channel, conversation_id, review_date));
  CREATE TABLE public.cancellation_form_links (id serial PRIMARY KEY, location_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('email', 'whatsapp')), conversation_id uuid);
  INSERT INTO public.locations VALUES ('${STILL}', '${ORG}'), ('${HATCH}', '${ORG}'), ('${OTHER}', '${ORG2}');
  INSERT INTO public.whatsapp_numbers (id, location_id, is_default) VALUES ('${NUM}', '${STILL}', true);
  INSERT INTO public.contacts VALUES ('${K_HATCH}', '${HATCH}'), ('${K_STILL}', '${STILL}');
`
async function boot(extra = '') {
  const db = new PGlite()
  await db.exec(SCHEMA)
  if (extra) await db.exec(extra)
  await db.exec(MIG_723)
  return db
}
const one = async (db, sql) => (await db.query(sql)).rows[0]
const move = (db, conv, loc) => one(db, `SELECT public.move_whatsapp_conversation('${conv}', '${loc}') AS r`).then((x) => x.r)

const HATCH_THREAD_AT_STILL = `
  INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, unread_count, last_message_at, last_message_preview)
    VALUES ('${C1}', '${STILL}', '${K_HATCH}', '15555550100', 2, '2026-10-01T10:00Z', 'old');
  INSERT INTO public.whatsapp_messages (conversation_id, location_id, body) VALUES ('${C1}', '${STILL}', 'hi'), ('${C1}', '${STILL}', 'there');
  INSERT INTO public.agent_decisions (channel, conversation_id, location_id) VALUES ('whatsapp', '${C1}', '${STILL}');
  INSERT INTO public.agent_conversation_reviews (channel, conversation_id, location_id, review_date) VALUES ('whatsapp', '${C1}', '${STILL}', '2026-10-01');
`

describe('723 move_whatsapp_conversation', () => {
  it('re-files a thread with its messages and agent rows, and stamps the source studio’s default number', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL)
    const r = await move(db, C1, HATCH)
    expect(r).toEqual({ conversation_id: C1, merged: false, from_location_id: STILL, to_location_id: HATCH })
    expect(await one(db, `SELECT location_id, whatsapp_number_id FROM whatsapp_conversations WHERE id = '${C1}'`))
      .toEqual({ location_id: HATCH, whatsapp_number_id: NUM })
    expect((await db.query(`SELECT DISTINCT location_id FROM whatsapp_messages`)).rows).toEqual([{ location_id: HATCH }])
    expect(await one(db, `SELECT location_id FROM agent_decisions`)).toEqual({ location_id: HATCH })
    expect(await one(db, `SELECT location_id FROM agent_conversation_reviews`)).toEqual({ location_id: HATCH })
  })

  it('merges into an existing thread at the target: messages re-pointed, newest preview kept, unread summed, source deleted', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL + `
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, unread_count, last_message_at, last_message_preview)
        VALUES ('${C2}', '${HATCH}', '${K_HATCH}', '15555550100', 1, '2026-10-05T10:00Z', 'new');
      INSERT INTO public.whatsapp_messages (conversation_id, location_id, body) VALUES ('${C2}', '${HATCH}', 'later');
      INSERT INTO public.agent_conversation_reviews (channel, conversation_id, location_id, review_date) VALUES ('whatsapp', '${C2}', '${HATCH}', '2026-10-01');
    `)
    const r = await move(db, C1, HATCH)
    expect(r).toMatchObject({ conversation_id: C2, merged: true })
    expect(await one(db, `SELECT count(*)::int AS n FROM whatsapp_conversations`)).toEqual({ n: 1 })
    expect(await one(db, `SELECT count(*)::int AS n FROM whatsapp_messages WHERE conversation_id = '${C2}' AND location_id = '${HATCH}'`)).toEqual({ n: 3 })
    expect(await one(db, `SELECT unread_count, last_message_preview, whatsapp_number_id FROM whatsapp_conversations WHERE id = '${C2}'`))
      .toEqual({ unread_count: 3, last_message_preview: 'new', whatsapp_number_id: NUM })
    // Review Focus 2: the same-day review clash keeps the target's row.
    expect((await db.query(`SELECT conversation_id FROM agent_conversation_reviews`)).rows).toEqual([{ conversation_id: C2 }])
    expect(await one(db, `SELECT conversation_id, location_id FROM agent_decisions`)).toEqual({ conversation_id: C2, location_id: HATCH })
  })

  it('merge carries a block, a takeover, a pause, the assignee and the bsuid from the source onto a fresh target', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, is_blocked, agent_active, agent_paused_at,
          assigned_to, wa_bsuid, wa_profile_name, ctwa_clid, agent_followup_stage, agent_verify_attempts, agent_handed_off_at,
          agent_verified_contact_id, agent_verified_at, resolved_at, created_at)
        VALUES ('${C1}', '${STILL}', '${K_HATCH}', '15555550100', true, false, '2026-10-02T09:00Z',
          '${USER}', 'BSUID.X', 'Pat', 'clid-1', 2, 3, '2026-10-03T09:00Z',
          '${K_STILL}', '2026-10-04T09:00Z', NULL, '2026-09-01T00:00Z');
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, resolved_at, created_at, agent_processing_at, status)
        VALUES ('${C2}', '${HATCH}', '${K_HATCH}', '15555550100', '2026-10-06T09:00Z', '2026-10-01T00:00Z', '2026-10-07T09:00Z', 'resolved');
    `)
    const r = await move(db, C1, HATCH)
    expect(r).toMatchObject({ conversation_id: C2, merged: true })
    const row = await one(db, `SELECT is_blocked, agent_active, agent_paused_at::text AS paused, assigned_to, wa_bsuid, wa_profile_name, ctwa_clid,
        agent_followup_stage, agent_verify_attempts, agent_handed_off_at::text AS handed, agent_verified_contact_id, agent_verified_at::text AS vat,
        resolved_at, created_at::text AS created, agent_processing_at::text AS lease, status
      FROM whatsapp_conversations WHERE id = '${C2}'`)
    expect(row).toMatchObject({
      is_blocked: true, agent_active: false, assigned_to: USER, wa_bsuid: 'BSUID.X', wa_profile_name: 'Pat', ctwa_clid: 'clid-1',
      agent_followup_stage: 2, agent_verify_attempts: 3, agent_verified_contact_id: K_STILL, resolved_at: null, status: 'resolved',
    })
    expect(new Date(row.paused).toISOString()).toBe('2026-10-02T09:00:00.000Z')
    expect(new Date(row.handed).toISOString()).toBe('2026-10-03T09:00:00.000Z')
    expect(new Date(row.vat).toISOString()).toBe('2026-10-04T09:00:00.000Z')
    expect(new Date(row.created).toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(new Date(row.lease).toISOString()).toBe('2026-10-07T09:00:00.000Z')   // the target's live claim lease, not imported
  })

  it('merges into a target studio row holding the same wa_bsuid under a different wa_phone, with no unique violation', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, wa_bsuid, unread_count)
        VALUES ('${C1}', '${STILL}', '${K_HATCH}', '15555550100', 'BSUID.X', 1);
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, wa_bsuid, unread_count)
        VALUES ('${C2}', '${HATCH}', '${K_HATCH}', '15555550199', 'BSUID.X', 4);
      INSERT INTO public.whatsapp_messages (conversation_id, location_id, body) VALUES ('${C1}', '${STILL}', 'hi');
    `)
    const r = await move(db, C1, HATCH)
    expect(r).toMatchObject({ conversation_id: C2, merged: true })
    expect(await one(db, `SELECT count(*)::int AS n FROM whatsapp_conversations`)).toEqual({ n: 1 })
    expect(await one(db, `SELECT unread_count, wa_phone FROM whatsapp_conversations`)).toEqual({ unread_count: 5, wa_phone: '15555550199' })
    expect(await one(db, `SELECT conversation_id, location_id FROM whatsapp_messages`)).toEqual({ conversation_id: C2, location_id: HATCH })
  })

  it('re-points the membership-request and message-feedback rows too, on a re-file and on a merge', async () => {
    const rows = `
      INSERT INTO public.agent_membership_requests (channel, conversation_id, location_id) VALUES ('whatsapp', '${C1}', '${STILL}'), ('instagram', '${C1}', '${STILL}');
      INSERT INTO public.agent_message_feedback (channel, conversation_id, location_id) VALUES ('whatsapp', '${C1}', '${STILL}');
    `
    const db = await boot(HATCH_THREAD_AT_STILL + rows)
    await move(db, C1, HATCH)
    expect((await db.query(`SELECT channel, conversation_id, location_id FROM agent_membership_requests ORDER BY channel`)).rows)
      .toEqual([{ channel: 'instagram', conversation_id: C1, location_id: STILL }, { channel: 'whatsapp', conversation_id: C1, location_id: HATCH }])
    expect(await one(db, `SELECT conversation_id, location_id FROM agent_message_feedback`)).toEqual({ conversation_id: C1, location_id: HATCH })

    const db2 = await boot(HATCH_THREAD_AT_STILL + rows + `
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C2}', '${HATCH}', '${K_HATCH}', '15555550100');`)
    await move(db2, C1, HATCH)
    expect(await one(db2, `SELECT conversation_id, location_id FROM agent_message_feedback`)).toEqual({ conversation_id: C2, location_id: HATCH })
    expect((await db2.query(`SELECT conversation_id FROM agent_membership_requests WHERE channel = 'whatsapp'`)).rows).toEqual([{ conversation_id: C2 }])
  })

  // F5 — cancellation_form_links.conversation_id (mig 585) is a soft ref with
  // no FK: a merge that deleted the source left the link pointing at nothing,
  // so the approve path could not answer in-thread. location_id stays the
  // issuing studio: confirm.js looks the link up and sends by it.
  it('re-points the WhatsApp cancellation-form links on a merge and a re-file, keeping the issuing studio (email links untouched)', async () => {
    const links = `
      INSERT INTO public.cancellation_form_links (location_id, channel, conversation_id) VALUES
        ('${STILL}', 'whatsapp', '${C1}'), ('${STILL}', 'email', '${C1}');
    `
    const db = await boot(HATCH_THREAD_AT_STILL + links + `
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C2}', '${HATCH}', '${K_HATCH}', '15555550100');`)
    const r = await move(db, C1, HATCH)
    expect(r).toMatchObject({ conversation_id: C2, merged: true })
    expect((await db.query(`SELECT channel, conversation_id, location_id FROM cancellation_form_links ORDER BY channel`)).rows).toEqual([
      { channel: 'email', conversation_id: C1, location_id: STILL },
      { channel: 'whatsapp', conversation_id: C2, location_id: STILL },
    ])

    const db2 = await boot(HATCH_THREAD_AT_STILL + links)
    await move(db2, C1, HATCH)
    expect(await one(db2, `SELECT conversation_id, location_id FROM cancellation_form_links WHERE channel = 'whatsapp'`))
      .toEqual({ conversation_id: C1, location_id: STILL })
  })

  it('refuses another organisation and its own studio, writing nothing (Review Focus 5)', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL)
    await expect(move(db, C1, OTHER)).rejects.toThrow(/other_organisation/)
    await expect(move(db, C1, STILL)).rejects.toThrow(/same_studio/)
    await expect(move(db, C3, HATCH)).rejects.toThrow(/conversation_not_found/)
    expect(await one(db, `SELECT location_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ location_id: STILL })
  })

  it('is executable by service_role only', async () => {
    const db = await boot()
    const acl = await one(db, `SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'move_whatsapp_conversation'`)
    expect(acl.acl).toContain('service_role=X')
    expect(acl.acl).not.toMatch(/(^|[{,])=X/)        // no PUBLIC
    expect(acl.acl).not.toMatch(/(anon|authenticated)=X/)
  })
})

describe('723 wa_message_location_from_conversation (a message row belongs to its thread’s studio)', () => {
  const insertMsg = (db, conv, loc, body = 'x') =>
    one(db, `INSERT INTO public.whatsapp_messages (conversation_id, location_id, body) VALUES (${conv ? `'${conv}'` : 'NULL'}, ${loc ? `'${loc}'` : 'NULL'}, '${body}')
      RETURNING location_id, conversation_id`)

  it('a message inserted into a Hatch-filed thread with the sending studio’s location_id lands at Hatch', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C1}', '${HATCH}', '${K_HATCH}', '15555550100');`)
    expect(await insertMsg(db, C1, STILL)).toEqual({ location_id: HATCH, conversation_id: C1 })
    expect(await insertMsg(db, C1, null)).toEqual({ location_id: HATCH, conversation_id: C1 })
  })

  it('a message already carrying its thread’s studio is unchanged', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C1}', '${STILL}', '${K_STILL}', '15555550100');`)
    expect(await insertMsg(db, C1, STILL)).toEqual({ location_id: STILL, conversation_id: C1 })
  })

  it('a message with no conversation keeps its location_id', async () => {
    const db = await boot()
    expect(await insertMsg(db, null, STILL)).toEqual({ location_id: STILL, conversation_id: null })
    expect(await insertMsg(db, null, null)).toEqual({ location_id: null, conversation_id: null })
  })

  it('only INSERT is covered: an UPDATE of location_id is left alone (the move function’s job)', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C1}', '${HATCH}', '${K_HATCH}', '15555550100');`)
    await insertMsg(db, C1, STILL)
    await db.exec(`UPDATE public.whatsapp_messages SET location_id = '${STILL}'`)
    expect(await one(db, `SELECT location_id FROM whatsapp_messages`)).toEqual({ location_id: STILL })
  })

  it('is a BEFORE INSERT row trigger, SECURITY INVOKER with a pinned search_path, and re-running the migration passes', async () => {
    const db = await boot()
    await db.exec(MIG_723)
    const t = await one(db, `SELECT count(*)::int AS n, bool_or(tgtype & 2 = 2) AS before_, bool_or(tgtype & 4 = 4) AS ins, bool_or(tgtype & 16 = 0) AS no_update, bool_or(tgtype & 1 = 1) AS per_row
      FROM pg_trigger WHERE tgname = 'trg_wa_message_location_from_conversation' AND NOT tgisinternal`)
    expect(t).toEqual({ n: 1, before_: true, ins: true, no_update: true, per_row: true })
    const f = await one(db, `SELECT prosecdef, proconfig::text AS cfg, prorettype::regtype::text AS ret FROM pg_proc WHERE proname = 'wa_message_location_from_conversation'`)
    expect(f.prosecdef).toBe(false)
    expect(f.cfg).toContain('search_path=public, pg_temp')
    expect(f.ret).toBe('trigger')
  })

  it('the function is not executable by PUBLIC, anon or authenticated', async () => {
    const db = await boot()
    const acl = await one(db, `SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'wa_message_location_from_conversation'`)
    expect(acl.acl).not.toBeNull()
    expect(acl.acl).not.toMatch(/(^|[{,])=X/)
    expect(acl.acl).not.toMatch(/(anon|authenticated)=X/)
  })
})

describe('724 backfill', () => {
  it('moves only threads of contacts whose home is a number-less same-org sibling; a second run is a no-op', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL + `
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C3}', '${STILL}', '${K_STILL}', '15555550101');
    `)
    await db.exec(MIG_724)
    expect((await db.query(`SELECT id, location_id FROM whatsapp_conversations ORDER BY id`)).rows)
      .toEqual([{ id: C1, location_id: HATCH }, { id: C3, location_id: STILL }])
    await db.exec(MIG_724)
    expect(await one(db, `SELECT location_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ location_id: HATCH })
  })

  it('skips a thread whose merge would collide on wa_bsuid (NOTICE, no abort) while the other threads still move', async () => {
    // C1 would merge into C2 (same wa_phone at Hatch) and copy BSUID.X onto it,
    // but C4 at Hatch already holds BSUID.X: unique_violation. C5 must still move.
    const db = await boot(HATCH_THREAD_AT_STILL + `
      UPDATE public.whatsapp_conversations SET wa_bsuid = 'BSUID.X' WHERE id = '${C1}';
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C2}', '${HATCH}', '${K_HATCH}', '15555550100');
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone, wa_bsuid) VALUES ('${C4}', '${HATCH}', '${K_X}', '15555550177', 'BSUID.X');
      INSERT INTO public.contacts VALUES ('${K_X}', '${HATCH}');
      INSERT INTO public.whatsapp_conversations (id, location_id, contact_id, wa_phone) VALUES ('${C5}', '${STILL}', '${K_HATCH}', '15555550188');
    `)
    const notices = []
    await db.exec(MIG_724, { onNotice: (n) => notices.push(n.message) })
    expect((await db.query(`SELECT id, location_id FROM whatsapp_conversations ORDER BY id`)).rows)
      .toEqual([{ id: C1, location_id: STILL }, { id: C2, location_id: HATCH }, { id: C4, location_id: HATCH }, { id: C5, location_id: HATCH }])
    expect(notices.some((m) => m.includes('skipped thread') && m.includes(C1))).toBe(true)
    expect(notices.at(-1)).toMatch(/1 moved, 0 merged, 1 skipped/)
  })

  it('leaves a contact whose home studio has its own active number alone', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL + `
      INSERT INTO public.whatsapp_numbers (id, location_id, is_default) VALUES ('f0000000-0000-0000-0000-000000000002', '${HATCH}', true);
    `)
    await db.exec(MIG_724)
    expect(await one(db, `SELECT location_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ location_id: STILL })
  })
})
