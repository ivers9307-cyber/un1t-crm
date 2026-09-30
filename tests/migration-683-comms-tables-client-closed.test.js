// MEMBERWRITESWEEP.1d — behavioural test for migration 683.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the three private helpers verbatim
// with prod EXECUTE) and adds email_sends, email_templates, sms_broadcasts,
// sms_broadcast_recipients and agent_message_feedback, reduced to the columns
// the policies, the foreign keys, the unique key and the service paths need
// (prod's column names and FK actions), with the 9 live policies written so
// they deparse to prod's pg_policies text (30 Sep 2026; pinned by a test).
// Two of prod's three triggers stand in: email_send_activity_trigger (AFTER
// INSERT on email_sends, SECURITY DEFINER, writes activities) and
// email_templates_updated_at (BEFORE UPDATE, INVOKER): neither needs a client
// privilege. It proves:
//
//   * BEFORE: a PLAIN STAFF member of a studio reads every email send,
//     template, SMS broadcast, SMS recipient and agent-reply rating at that
//     studio; rewrites a template's html_content (what the booking
//     confirmation, event, offer-purchase and sequence emails render);
//     deletes an email send; rates an agent reply AS ANOTHER USER (created_by
//     forged); and adds an SMS recipient. Staff at another studio reach
//     nothing; a member (no profile) reads and writes nothing; the SMS
//     recipient policy reads sms_broadcasts AS THE CALLER, so closing the
//     broadcasts alone turns every read of the recipients into a 42501 (why
//     the two close together);
//   * AFTER: no client privilege on any of the five (anon, authenticated,
//     PUBLIC; table and column level), RLS on, no policy; plain staff, owner,
//     master, member and anon are refused every read and write by the grant;
//     every service-role path still works: a send insert (its DEFINER
//     activity trigger fires) and a status update, a template update (its
//     updated_at trigger fires), a feedback upsert on (message_id,
//     created_by), and the SMS cascade (a broadcast takes its recipients);
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited privilege, a policy the file does
//     not know about, a policy elsewhere that reads a closed table as the
//     caller, and RLS off; three mutations of the file itself (no REVOKE; no
//     sms_broadcasts_update_at_location DROP; sms_broadcast_recipients kept
//     out of the file while sms_broadcasts closes) each abort with their
//     message; a second run passes; the rollback record restores the
//     before-state.
//
// Every describe runs in BOTH prod states: before mig 677 (as planned) and
// after it (prod since 30 Sep 2026, 13:13 UTC: no anon, authenticated arwd),
// with 677 replayed from its real file. 677 on top of 683 is replayed too.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, ALL_PRIVS, denied, rlsRefused, MIG_677, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/683_comms_tables_client_closed.sql'), 'utf8')
const TABLES = ['email_sends', 'email_templates', 'sms_broadcasts', 'sms_broadcast_recipients', 'agent_message_feedback']

// Row ids are fixed: 7<table index><k>, k = 1, 2 at A and b at B.
const rowId = (ti, k) => `7${ti}000000-0000-0000-0000-00000000000${k}`
const rowOf = (t, k) => rowId(TABLES.indexOf(t), k)
const SB1 = rowOf('sms_broadcasts', 1), SB2 = rowOf('sms_broadcasts', 2), SBB = rowOf('sms_broadcasts', 'b')
// Agent replies the ratings point at (whatsapp_messages ids in prod; no FK there).
const MSG = (k) => `7f000000-0000-0000-0000-00000000000${k}`

const TABLE_SQL = `
  CREATE TABLE public.email_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid,
    contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
    subject text NOT NULL DEFAULT 's', status text DEFAULT 'sent');
  CREATE TABLE public.email_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid,
    name text NOT NULL DEFAULT 't', html_content text,
    updated_at timestamptz DEFAULT '2000-01-01 00:00:00+00');
  CREATE TABLE public.sms_broadcasts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'draft');
  CREATE TABLE public.sms_broadcast_recipients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    broadcast_id uuid NOT NULL REFERENCES public.sms_broadcasts (id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending');
  CREATE TABLE public.agent_message_feedback (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL, message_id uuid NOT NULL, rating text NOT NULL, note text,
    created_by uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
    UNIQUE (message_id, created_by));

  -- Prod's email_send_activity_trigger: AFTER INSERT, SECURITY DEFINER,
  -- writes activities (a table no client role holds anything on).
  CREATE TABLE public.activities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, kind text);
  REVOKE ALL ON public.activities FROM anon, authenticated;
  CREATE FUNCTION public.log_email_send_activity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $t$
  BEGIN
    INSERT INTO public.activities (contact_id, kind) VALUES (NEW.contact_id, 'email_sent');
    RETURN NEW;
  END $t$;
  CREATE TRIGGER email_send_activity_trigger AFTER INSERT ON public.email_sends
    FOR EACH ROW EXECUTE FUNCTION public.log_email_send_activity();
  -- Prod's email_templates_updated_at: BEFORE UPDATE, INVOKER.
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $t$
  BEGIN NEW.updated_at := now(); RETURN NEW; END $t$;
  CREATE TRIGGER email_templates_updated_at BEFORE UPDATE ON public.email_templates
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
` + TABLES.map((t) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n')

// The 9 live policies (plan §1), written so they deparse to prod's text.
const MEMBERSHIP = '(private.auth_is_in_location(location_id))'
const VIA_BROADCAST = '(EXISTS (SELECT 1 FROM sms_broadcasts b WHERE b.id = sms_broadcast_recipients.broadcast_id AND private.auth_is_in_location(b.location_id)))'
const POLICY_SQL = `
  CREATE POLICY email_sends_location_scoped ON public.email_sends FOR ALL TO authenticated
    USING ${MEMBERSHIP} WITH CHECK ${MEMBERSHIP};
  CREATE POLICY email_templates_location_scoped ON public.email_templates FOR ALL TO authenticated
    USING ${MEMBERSHIP} WITH CHECK ${MEMBERSHIP};
  CREATE POLICY sms_broadcasts_select_at_location ON public.sms_broadcasts FOR SELECT TO authenticated
    USING ${MEMBERSHIP};
  CREATE POLICY sms_broadcasts_insert_at_location ON public.sms_broadcasts FOR INSERT TO authenticated
    WITH CHECK ${MEMBERSHIP};
  CREATE POLICY sms_broadcasts_update_at_location ON public.sms_broadcasts FOR UPDATE TO authenticated
    USING ${MEMBERSHIP} WITH CHECK ${MEMBERSHIP};
  CREATE POLICY sms_broadcasts_delete_at_location ON public.sms_broadcasts FOR DELETE TO authenticated
    USING ${MEMBERSHIP};
  CREATE POLICY sms_broadcast_recipients_select_at_location ON public.sms_broadcast_recipients FOR SELECT TO authenticated
    USING ${VIA_BROADCAST};
  CREATE POLICY sms_broadcast_recipients_insert_at_location ON public.sms_broadcast_recipients FOR INSERT TO authenticated
    WITH CHECK ${VIA_BROADCAST};
  CREATE POLICY agent_feedback_location_scoped ON public.agent_message_feedback FOR ALL TO authenticated
    USING ${MEMBERSHIP} WITH CHECK ${MEMBERSHIP};
`

// Prod text (pg_policies, re-read 30 Sep 2026 for this PR), ordered by table, name.
const PROD_M = 'private.auth_is_in_location(location_id)'
const PROD_VIA = '(EXISTS ( SELECT 1\n   FROM sms_broadcasts b\n  WHERE ((b.id = sms_broadcast_recipients.broadcast_id) AND private.auth_is_in_location(b.location_id))))'
const prodRow = (tablename, policyname, cmd, qual, with_check) => ({
  tablename, policyname, permissive: 'PERMISSIVE', cmd, roles: '{authenticated}', qual, with_check })
const PROD_POLICIES = [
  prodRow('agent_message_feedback', 'agent_feedback_location_scoped', 'ALL', PROD_M, PROD_M),
  prodRow('email_sends', 'email_sends_location_scoped', 'ALL', PROD_M, PROD_M),
  prodRow('email_templates', 'email_templates_location_scoped', 'ALL', PROD_M, PROD_M),
  prodRow('sms_broadcast_recipients', 'sms_broadcast_recipients_insert_at_location', 'INSERT', null, PROD_VIA),
  prodRow('sms_broadcast_recipients', 'sms_broadcast_recipients_select_at_location', 'SELECT', PROD_VIA, null),
  prodRow('sms_broadcasts', 'sms_broadcasts_delete_at_location', 'DELETE', PROD_M, null),
  prodRow('sms_broadcasts', 'sms_broadcasts_insert_at_location', 'INSERT', null, PROD_M),
  prodRow('sms_broadcasts', 'sms_broadcasts_select_at_location', 'SELECT', PROD_M, null),
  prodRow('sms_broadcasts', 'sms_broadcasts_update_at_location', 'UPDATE', PROD_M, PROD_M),
]

const SEED = `
  INSERT INTO public.email_sends (id, location_id, contact_id) VALUES
    ('${rowOf('email_sends', 1)}', '${IDS.LOC_A}', '${IDS.C_MEMBER}'),
    ('${rowOf('email_sends', 2)}', '${IDS.LOC_A}', '${IDS.C_MEMBER2}'),
    ('${rowOf('email_sends', 'b')}', '${IDS.LOC_B}', '${IDS.C_B}');
  INSERT INTO public.email_templates (id, location_id, html_content) VALUES
    ('${rowOf('email_templates', 1)}', '${IDS.LOC_A}', '<p>Booking confirmed</p>'),
    ('${rowOf('email_templates', 2)}', '${IDS.LOC_A}', '<p>Event</p>'),
    ('${rowOf('email_templates', 'b')}', '${IDS.LOC_B}', '<p>B</p>');
  INSERT INTO public.sms_broadcasts (id, location_id) VALUES
    ('${SB1}', '${IDS.LOC_A}'), ('${SB2}', '${IDS.LOC_A}'), ('${SBB}', '${IDS.LOC_B}');
  INSERT INTO public.sms_broadcast_recipients (id, broadcast_id, contact_id) VALUES
    ('${rowOf('sms_broadcast_recipients', 1)}', '${SB1}', '${IDS.C_MEMBER}'),
    ('${rowOf('sms_broadcast_recipients', 2)}', '${SB2}', '${IDS.C_MEMBER2}'),
    ('${rowOf('sms_broadcast_recipients', 'b')}', '${SBB}', '${IDS.C_B}');
  INSERT INTO public.agent_message_feedback (id, location_id, message_id, rating, created_by) VALUES
    ('${rowOf('agent_message_feedback', 1)}', '${IDS.LOC_A}', '${MSG(1)}', 'good', '${IDS.STAFF_A}'),
    ('${rowOf('agent_message_feedback', 2)}', '${IDS.LOC_A}', '${MSG(2)}', 'bad', '${IDS.OWNER_A}'),
    ('${rowOf('agent_message_feedback', 'b')}', '${IDS.LOC_B}', '${MSG('b')}', 'good', '${IDS.STAFF_B}');`

// The rollback record (plan Task 1d-5). Prod is in 677's end state (pre-probe
// 30 Sep: authenticated=arwd/postgres, no anon, on all five), so the
// POST_677 form is the one to use; the PRE_677 form would hand anon all eight
// privileges back and authenticated the four 677 removed.
const FIVE = `public.email_sends, public.email_templates, public.sms_broadcasts,
     public.sms_broadcast_recipients, public.agent_message_feedback`
const ROLLBACK_GRANT_PRE_677 = `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON ${FIVE}
  TO anon, authenticated;`
const ROLLBACK_GRANT_POST_677 = `GRANT SELECT, INSERT, UPDATE, DELETE
  ON ${FIVE}
  TO authenticated;`
const rollback683 = (grant) => `
BEGIN;
SET LOCAL lock_timeout = '5s';
${grant}
CREATE POLICY email_sends_location_scoped ON public.email_sends FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY email_templates_location_scoped ON public.email_templates FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY sms_broadcasts_select_at_location ON public.sms_broadcasts FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));
CREATE POLICY sms_broadcasts_insert_at_location ON public.sms_broadcasts FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY sms_broadcasts_update_at_location ON public.sms_broadcasts FOR UPDATE TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY sms_broadcasts_delete_at_location ON public.sms_broadcasts FOR DELETE TO authenticated
  USING (private.auth_is_in_location(location_id));
CREATE POLICY sms_broadcast_recipients_select_at_location ON public.sms_broadcast_recipients FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM sms_broadcasts b WHERE b.id = sms_broadcast_recipients.broadcast_id AND private.auth_is_in_location(b.location_id)));
CREATE POLICY sms_broadcast_recipients_insert_at_location ON public.sms_broadcast_recipients FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM sms_broadcasts b WHERE b.id = sms_broadcast_recipients.broadcast_id AND private.auth_is_in_location(b.location_id)));
CREATE POLICY agent_feedback_location_scoped ON public.agent_message_feedback FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
COMMIT;
`
const ROLLBACK_683 = { false: rollback683(ROLLBACK_GRANT_PRE_677), true: rollback683(ROLLBACK_GRANT_POST_677) }
const baseSpec = { tables: TABLE_SQL, policies: POLICY_SQL, seed: SEED }
const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`
// Rows at a studio: the recipients reach it through their broadcast.
const AT = (t, loc) => t === 'sms_broadcast_recipients'
  ? `SELECT count(*)::int AS n FROM public.sms_broadcast_recipients r JOIN public.sms_broadcasts b ON b.id = r.broadcast_id WHERE b.location_id = '${loc}'`
  : `SELECT count(*)::int AS n FROM public.${t} WHERE location_id = '${loc}'`
// One INSERT per table that satisfies its NOT NULLs and unique key (the parents exist at A).
const INSERT = {
  email_sends: `INSERT INTO public.email_sends (location_id, contact_id, subject) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER}', 'Hello')`,
  email_templates: `INSERT INTO public.email_templates (location_id, name, html_content) VALUES ('${IDS.LOC_A}', 'n', '<p>x</p>')`,
  sms_broadcasts: `INSERT INTO public.sms_broadcasts (location_id) VALUES ('${IDS.LOC_A}')`,
  sms_broadcast_recipients: `INSERT INTO public.sms_broadcast_recipients (broadcast_id, contact_id) VALUES ('${SB2}', '${IDS.C_MEMBER}')`,
  agent_message_feedback: `INSERT INTO public.agent_message_feedback (location_id, message_id, rating, created_by) VALUES ('${IDS.LOC_A}', '${MSG(3)}', 'good', '${IDS.STAFF_A}')`,
}
const UPDATE = (t) => `UPDATE public.${t} SET id = id WHERE id = '${rowOf(t, 1)}'`
const DELETE = (t) => `DELETE FROM public.${t} WHERE id = '${rowOf(t, 2)}'`

// What authenticated holds on each table before 683 in each state.
const AUTH_BEFORE = { false: ALL_PRIVS, true: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }

/** Run a statement as a user with one parent's SELECT revoked, in a transaction always rolled back. */
async function withParentRevoked(db, parent, uid, sql) {
  await db.query('BEGIN')
  try {
    await db.query(`REVOKE SELECT ON public.${parent} FROM authenticated`)
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    return (await db.query(sql)).rows
  } finally {
    await db.query('ROLLBACK')
  }
}

describe.each(PROD_STATES)('before 683: the holes (prod on 30 Sep 2026), $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot(spec) }, 120_000)
  afterAll(() => db?.close())

  it.each(TABLES)('the client grants on %s are the state\'s (default privileges, or 677\'s arwd for authenticated and nothing for anon)', async (t) => {
    const held = (await clientPrivileges(db, t)).filter((h) => !h.includes(':col-'))
    const expected = [
      ...(after677 ? [] : ALL_PRIVS.map((p) => `anon:${p}`)),
      ...AUTH_BEFORE[after677].map((p) => `authenticated:${p}`),
    ]
    expect(held.sort()).toEqual(expected.sort())
  })

  it("the replay's 9 policies read exactly as prod's pg_policies", async () => {
    expect(await policiesOf(db, TABLES)).toEqual(PROD_POLICIES)
  })

  it('plain staff at A: reads every A row of all five (two each), rewrites a template, deletes a send, rates a reply as another user, adds an SMS recipient', async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_A, count(t)), t).toEqual([{ n: 2 }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.email_templates SET html_content = '<a href="https://example.invalid">Pay here</a>'
        WHERE id = '${rowOf('email_templates', 1)}' RETURNING html_content`))
      .toEqual([{ html_content: '<a href="https://example.invalid">Pay here</a>' }])
    expect(await asUser(db, IDS.STAFF_A,
      `DELETE FROM public.email_sends WHERE id = '${rowOf('email_sends', 1)}' RETURNING id::text`)).toEqual([{ id: rowOf('email_sends', 1) }])
    expect(await asUser(db, IDS.STAFF_A,
      `INSERT INTO public.agent_message_feedback (location_id, message_id, rating, created_by)
         VALUES ('${IDS.LOC_A}', '${MSG(3)}', 'bad', '${IDS.OWNER_A}') RETURNING created_by::text`)).toEqual([{ created_by: IDS.OWNER_A }])
    expect(await asUser(db, IDS.STAFF_A, `${INSERT.sms_broadcast_recipients} RETURNING status`)).toEqual([{ status: 'pending' }])
  })

  it("plain staff at B reaches none of A's rows", async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_B, AT(t, IDS.LOC_A)), t).toEqual([{ n: 0 }])
    expect(await asUser(db, IDS.STAFF_B,
      `UPDATE public.email_templates SET html_content = 'x' WHERE location_id = '${IDS.LOC_A}' RETURNING id`)).toEqual([])
    await expect(asUser(db, IDS.STAFF_B, INSERT.sms_broadcast_recipients)).rejects.toThrow(rlsRefused('sms_broadcast_recipients'))
  })

  it('a member (no profile) reads nothing and every insert is refused by RLS', async () => {
    for (const t of TABLES) {
      expect(await asUser(db, IDS.MEMBER_UID, count(t)), t).toEqual([{ n: 0 }])
      await expect(asUser(db, IDS.MEMBER_UID, INSERT[t]), t).rejects.toThrow(rlsRefused(t))
    }
  })

  it('anon: every policy is TO authenticated, so a read returns 0 rows before 677 and is refused by the grant after it', async () => {
    for (const t of TABLES) {
      if (after677) await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      else expect(await asRole(db, 'anon', count(t)), t).toEqual([{ n: 0 }])
    }
  })

  it('the SMS recipient policies read sms_broadcasts AS THE CALLER: closing the broadcasts alone turns every read of the recipients into a 42501 (why the two close together)', async () => {
    await expect(withParentRevoked(db, 'sms_broadcasts', IDS.STAFF_A, count('sms_broadcast_recipients')))
      .rejects.toThrow(denied('sms_broadcasts'))
    await expect(withParentRevoked(db, 'sms_broadcasts', IDS.MASTER, count('sms_broadcast_recipients')))
      .rejects.toThrow(denied('sms_broadcasts'))
  })
})

describe.each(PROD_STATES)('after 683: the catalog, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot({ ...spec, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it.each(TABLES)('%s: no client privilege, RLS on, service_role DML, no policy', async (t) => {
    expect(await clientPrivileges(db, t)).toEqual([])
    expect(await rlsOn(db, t)).toBe(true)
    expect(await serviceRoleDml(db, t)).toBe(true)
    expect(await policiesOf(db, [t])).toEqual([])
  })

  it('the three triggers are untouched (the file changes grants and policies only)', async () => {
    const { rows } = await db.query(`SELECT tgname::text FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid IN ('public.email_sends'::regclass, 'public.email_templates'::regclass) ORDER BY 1`)
    expect(rows.map((r) => r.tgname)).toEqual(['email_send_activity_trigger', 'email_templates_updated_at'])
  })
})

describe.each(PROD_STATES)('after 683: people, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot({ ...spec, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it('plain staff, owner, master, member: every read and write on all five is refused by the grant', async () => {
    for (const uid of [IDS.STAFF_A, IDS.OWNER_A, IDS.MASTER, IDS.MEMBER_UID]) {
      for (const t of TABLES) {
        await expect(asUser(db, uid, count(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, INSERT[t]), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, UPDATE(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, DELETE(t)), `${uid} ${t}`).rejects.toThrow(denied(t))
        await expect(asUser(db, uid, `TRUNCATE public.${t}`), `${uid} ${t}`).rejects.toThrow(/permission denied/)
        await expect(asUser(db, uid, `LOCK TABLE public.${t} IN ACCESS EXCLUSIVE MODE`), `${uid} ${t}`).rejects.toThrow(denied(t))
      }
    }
    // The finding's own write, as the plain staff member: refused.
    await expect(asUser(db, IDS.STAFF_A,
      `UPDATE public.email_templates SET html_content = 'x' WHERE id = '${rowOf('email_templates', 1)}'`))
      .rejects.toThrow(denied('email_templates'))
  })

  it('anon: every read and write is refused by the grant', async () => {
    for (const t of TABLES) {
      await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', INSERT[t]), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', `DELETE FROM public.${t}`), t).rejects.toThrow(denied(t))
    }
  })

  it('service_role: a send insert fires the DEFINER activity trigger; a status update, a template update (its updated_at trigger fires) and a feedback upsert succeed; every table takes an insert and an update', async () => {
    // The seed's three sends logged three activities; the new send logs a fourth.
    expect(await asRole(db, 'service_role', `${INSERT.email_sends} RETURNING status`,
      `SELECT count(*)::int AS n FROM public.activities WHERE kind = 'email_sent'`)).toEqual([{ n: 4 }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.email_sends SET status = 'delivered' WHERE id = '${rowOf('email_sends', 1)}' RETURNING status`))
      .toEqual([{ status: 'delivered' }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.email_templates SET html_content = '<p>New</p>' WHERE id = '${rowOf('email_templates', 1)}'
        RETURNING html_content, updated_at > '2000-01-01 00:00:00+00' AS touched`)).toEqual([{ html_content: '<p>New</p>', touched: true }])
    expect(await asRole(db, 'service_role',
      `INSERT INTO public.agent_message_feedback (location_id, message_id, rating, created_by)
         VALUES ('${IDS.LOC_A}', '${MSG(1)}', 'bad', '${IDS.STAFF_A}')
         ON CONFLICT (message_id, created_by) DO UPDATE SET rating = EXCLUDED.rating RETURNING rating`,
      count('agent_message_feedback'))).toEqual([{ n: 3 }])
    for (const t of TABLES) {
      expect(await asRole(db, 'service_role', INSERT[t], UPDATE(t), count(t)), t).toEqual([{ n: 4 }])
    }
  })

  it('service_role: deleting a broadcast takes its recipients (the FK cascade runs as the owner)', async () => {
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.sms_broadcasts WHERE id = '${SB1}'`,
      `SELECT (SELECT count(*)::int FROM public.sms_broadcast_recipients) AS recipients,
              (SELECT count(*)::int FROM public.sms_broadcast_recipients WHERE broadcast_id = '${SB1}') AS of_sb1`))
      .toEqual([{ recipients: 2, of_sb1: 0 }])
  })
})

describe.each(PROD_STATES)('the self-check aborts the whole file, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG) {
    db = await boot({ ...spec, before })
    const msg = await abortMessage(db, sql)
    expect(msg).toMatch(message)
    // Nothing applied: the old policies and the old grant are still there.
    const names = (await policiesOf(db, TABLES)).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['email_templates_location_scoped', 'sms_broadcasts_update_at_location',
      'sms_broadcast_recipients_select_at_location', 'agent_feedback_location_scoped']))
    expect(await clientPrivileges(db, 'email_templates')).toContain('authenticated:UPDATE')
  }

  it("when another grantor's UPDATE on email_templates to authenticated survives the REVOKE", () => expectAbort(
    `GRANT ALL ON public.email_templates TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.email_templates TO authenticated; RESET ROLE;`,
    /mig 683: (client roles still hold privileges on public\.email_templates: authenticated:UPDATE \(from other_grantor\)|authenticated still holds UPDATE on public\.email_templates)/,
  ), 120_000)

  it('when INSERT on agent_message_feedback is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.agent_message_feedback TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 683: authenticated still holds INSERT on public\.agent_message_feedback/,
  ), 120_000)

  it("when another grantor's column-level UPDATE (html_content) on email_templates survives", () => expectAbort(
    `GRANT UPDATE (html_content) ON public.email_templates TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE (html_content) ON public.email_templates TO authenticated; RESET ROLE;`,
    /column-level UPDATE on public\.email_templates|client roles still hold privileges on public\.email_templates/,
  ), 120_000)

  it('when a policy the file does not know about is left on email_sends', () => expectAbort(
    `CREATE POLICY email_sends_stray ON public.email_sends FOR SELECT TO authenticated USING (true);`,
    /mig 683: public\.email_sends should have no policy left: email_sends_stray SELECT/,
  ), 120_000)

  it('when a policy on another table still reads sms_broadcasts as the caller', () => expectAbort(
    `CREATE TABLE public.x (id uuid); ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;
     CREATE POLICY x_via ON public.x FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.sms_broadcasts));`,
    /mig 683: policies on other tables still read a closed table as the caller: public\.x\.x_via/,
  ), 120_000)

  it('when RLS is off on email_sends (the grant would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.email_sends DISABLE ROW LEVEL SECURITY;`,
    /mig 683: row level security is off on public\.email_sends/,
  ), 120_000)

  // Mutations of the file itself (the 1b/1c procedure): each must abort it.
  const mutate = (from, to) => {
    const out = MIG.replace(from, to)
    expect(out, `mutation did not apply: ${from}`).not.toBe(MIG)
    return out
  }

  it('mutation: without the REVOKE the file aborts on email_sends', () => expectAbort('',
    /mig 683: client roles still hold privileges on public\.email_sends: (anon|authenticated):DELETE \(from postgres\)/,
    mutate(/REVOKE ALL\s+ON public\.email_sends[\s\S]*?FROM anon, authenticated, PUBLIC;\n/, '')), 120_000)

  it('mutation: without the sms_broadcasts_update_at_location DROP the file aborts on sms_broadcasts', () => expectAbort('',
    /mig 683: public\.sms_broadcasts should have no policy left: sms_broadcasts_update_at_location UPDATE/,
    mutate('DROP POLICY IF EXISTS sms_broadcasts_update_at_location ON public.sms_broadcasts;\n', '')), 120_000)

  it('mutation: sms_broadcast_recipients left out of the file (both DROPs and the array entry) while sms_broadcasts closes: check 5 names both its policies', () => expectAbort('',
    /mig 683: policies on other tables still read a closed table as the caller: (public\.sms_broadcast_recipients\.sms_broadcast_recipients_(insert|select)_at_location(, )?){2}$/,
    mutate(/'sms_broadcast_recipients', /, '')
      .replace('DROP POLICY IF EXISTS sms_broadcast_recipients_insert_at_location ON public.sms_broadcast_recipients;\n', '')
      .replace('DROP POLICY IF EXISTS sms_broadcast_recipients_select_at_location ON public.sms_broadcast_recipients;\n', '')), 120_000)
})

describe.each(PROD_STATES)('idempotent and reversible, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  afterEach(async () => { await db?.close() })

  it('a second run passes its own self-check', async () => {
    db = await boot({ ...spec, migrate: [MIG] })
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual([])
  }, 120_000)

  it('the rollback record restores the 9 policies and the before privileges (and so the holes)', async () => {
    db = await boot(spec)
    const policiesBefore = await policiesOf(db, TABLES)
    const privsBefore = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await abortMessage(db, ROLLBACK_683[after677])).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual(policiesBefore)
    expect(await policiesOf(db, TABLES)).toEqual(PROD_POLICIES)
    expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsBefore)
    expect(await asUser(db, IDS.STAFF_A, count('email_sends'))).toEqual([{ n: 2 }])
  }, 120_000)

  if (after677) {
    it('the pre-677 rollback text would reopen what 677 closed (anon, and authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN): use the POST_677 form on prod', async () => {
      db = await boot(spec)
      expect(await abortMessage(db, MIG)).toBeNull()
      expect(await abortMessage(db, ROLLBACK_683[false])).toBeNull()
      const held = await clientPrivileges(db, 'email_templates')
      expect(held).toContain('anon:SELECT')
      expect(held).toContain('authenticated:MAINTAIN')
    }, 120_000)
  } else {
    it('677 applied on top of 683 still passes its own self-check and leaves 683\'s end state', async () => {
      db = await boot({ ...spec, migrate: [MIG] })
      const privsAfter683 = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
      expect(await abortMessage(db, `CREATE FUNCTION public.list_enabled_integrations() RETURNS integer LANGUAGE sql AS 'SELECT 1';
        REVOKE ALL ON FUNCTION public.list_enabled_integrations() FROM PUBLIC, anon;`)).toBeNull()
      expect(await abortMessage(db, MIG_677)).toBeNull()
      expect(await policiesOf(db, TABLES)).toEqual([])
      expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsAfter683)
    }, 120_000)
  }
})
