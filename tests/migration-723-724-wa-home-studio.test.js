// WAHOMESTUDIO.1 — behavioural test for migrations 723 (move/merge function)
// and 724 (backfill). Models the live columns (information_schema, 15 Oct
// 2026) of the tables the function touches and runs the REAL files.
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

const SCHEMA = `
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid NOT NULL);
  CREATE TABLE public.whatsapp_numbers (id uuid PRIMARY KEY, location_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
    is_default boolean NOT NULL DEFAULT false, updated_at timestamptz DEFAULT now());
  CREATE TABLE public.whatsapp_conversations (
    id uuid PRIMARY KEY, location_id uuid NOT NULL, contact_id uuid, wa_phone text, status text DEFAULT 'active',
    window_expires_at timestamptz, last_message_at timestamptz, last_message_direction text, last_message_preview text,
    unread_count integer DEFAULT 0, assigned_to uuid, resolved_at timestamptz,
    whatsapp_number_id uuid REFERENCES public.whatsapp_numbers(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (location_id, wa_phone));
  CREATE TABLE public.whatsapp_messages (id serial PRIMARY KEY,
    conversation_id uuid REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE, location_id uuid, body text);
  CREATE TABLE public.agent_decisions (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_membership_requests (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_message_feedback (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid);
  CREATE TABLE public.agent_conversation_reviews (id serial PRIMARY KEY, channel text, conversation_id uuid, location_id uuid,
    review_date date, UNIQUE (channel, conversation_id, review_date));
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

  it('leaves a contact whose home studio has its own active number alone', async () => {
    const db = await boot(HATCH_THREAD_AT_STILL + `
      INSERT INTO public.whatsapp_numbers (id, location_id, is_default) VALUES ('f0000000-0000-0000-0000-000000000002', '${HATCH}', true);
    `)
    await db.exec(MIG_724)
    expect(await one(db, `SELECT location_id FROM whatsapp_conversations WHERE id = '${C1}'`)).toEqual({ location_id: STILL })
  })
})
