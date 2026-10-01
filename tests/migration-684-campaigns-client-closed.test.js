// MEMBERWRITESWEEP.1e — behavioural test for migration 684.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the three private helpers verbatim
// with prod EXECUTE) and adds campaigns and campaign_recipients, reduced to
// the columns the policies, the triggers, the foreign keys and the service
// paths need (prod's column names and FK actions), with the 2 live policies
// written so they deparse to prod's pg_policies text (re-read 1 Oct 2026;
// pinned by a test). Prod's three triggers ON campaigns stand in verbatim
// (campaigns_block_sent_delete, campaigns_lock_sent_content,
// campaigns_updated_at, all INVOKER; no trigger on another table names
// either table), and campaign_link_clicks stands in for the tables clients
// may still read that reference campaigns (its SELECT policy reads its own
// location_id, not campaigns). It proves:
//
//   * BEFORE: a PLAIN STAFF member of a studio (no `email` needed, the
//     policy tests membership only) reads every campaign and every recipient
//     at that studio; schedules a draft (status 'scheduled', what the
//     run-campaigns cron promotes and SENDS); rewrites a draft's html and
//     forges its created_by; deletes a draft, and the FK cascade takes its
//     recipients with it. Staff at another studio reach nothing; a member
//     (no profile) reads and writes nothing; the recipient policy reads
//     campaigns AS THE CALLER, so closing campaigns alone turns every read of
//     campaign_recipients into a 42501 (why the two close together);
//   * AFTER: no client privilege on either table (anon, authenticated,
//     PUBLIC; table and column level), RLS on, no policy; plain staff,
//     owner, master, member and anon are refused every read and write by the
//     grant; every service-role path still works: the session routes' writes
//     (create with created_by, save, schedule, stop, delete; the three
//     triggers still fire and still refuse a sent campaign's content and
//     delete), the sender's recipient insert and status update, and the
//     cascade; campaign_link_clicks still reads for staff (its policy never
//     names campaigns), but a join from it to campaigns (a PostgREST embed)
//     is now a 42501;
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited privilege, a policy the file does
//     not know about, a policy elsewhere that reads a closed table as the
//     caller, and RLS off; three mutations of the file itself (no REVOKE; no
//     campaigns_location_scoped DROP; campaign_recipients kept out of the
//     file while campaigns closes) each abort with their message; a second
//     run passes; the rollback record restores the before-state.
//
// Every describe runs in BOTH prod states: before mig 677 (as planned) and
// after it (prod since 30 Sep 2026, 13:13 UTC: no anon, authenticated arwd),
// with 677 replayed from its real file.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, ALL_PRIVS, denied, rlsRefused, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/684_campaigns_client_closed.sql'), 'utf8')
const TABLES = ['campaigns', 'campaign_recipients']

// Fixed ids: campaigns 84…0k (1, 2 at A; b at B), recipients 85…0k.
const CAM = (k) => `84000000-0000-0000-0000-00000000000${k}`
const REC = (k) => `85000000-0000-0000-0000-00000000000${k}`
const CLK = (k) => `86000000-0000-0000-0000-00000000000${k}`

const TABLE_SQL = `
  CREATE TABLE public.campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations (id),
    name text NOT NULL DEFAULT 'c', subject text NOT NULL DEFAULT 's', html_content text,
    status text DEFAULT 'draft', scheduled_at timestamptz, cancel_requested_at timestamptz,
    created_by uuid REFERENCES public.profiles (id),
    parent_campaign_id uuid REFERENCES public.campaigns (id) ON DELETE SET NULL,
    updated_at timestamptz DEFAULT '2000-01-01 00:00:00+00');
  CREATE TABLE public.campaign_recipients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
    contact_id uuid NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'queued');
  -- A table clients still read that references campaigns (prod: SELECT policy
  -- on its own location_id; authenticated arwd after 677).
  CREATE TABLE public.campaign_link_clicks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id uuid NOT NULL REFERENCES public.campaigns (id) ON DELETE CASCADE,
    location_id uuid NOT NULL);
  ALTER TABLE public.campaign_link_clicks ENABLE ROW LEVEL SECURITY;
  CREATE POLICY campaign_link_clicks_select ON public.campaign_link_clicks FOR SELECT TO authenticated
    USING (private.auth_is_in_location(location_id));

  -- Prod's three triggers ON campaigns (pg_get_functiondef, 1 Oct 2026), all INVOKER.
  CREATE FUNCTION public.campaigns_block_sent_delete() RETURNS trigger LANGUAGE plpgsql
    SET search_path TO 'public' AS $function$
  BEGIN
    IF OLD.status IN ('draft', 'scheduled') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'Campaign % is % and cannot be deleted. Its recipients, opens and clicks are the record of what was actually sent, and campaign_recipients / campaign_link_clicks cascade with it.',
      OLD.id, COALESCE(OLD.status, 'in an unknown state')
      USING ERRCODE = 'check_violation';
  END;
  $function$;
  CREATE FUNCTION public.campaigns_lock_sent_content() RETURNS trigger LANGUAGE plpgsql
    SET search_path TO 'public' AS $function$
  BEGIN
    IF OLD.status IN ('draft', 'scheduled') THEN
      RETURN NEW;
    END IF;
    IF (NEW.subject IS DISTINCT FROM OLD.subject)
    OR (NEW.html_content IS DISTINCT FROM OLD.html_content)
    THEN
      RAISE EXCEPTION
        'Campaign % is % — its content is the record of what was sent and cannot be edited. Duplicate it instead.',
        OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END;
  $function$;
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $t$
  BEGIN NEW.updated_at := now(); RETURN NEW; END $t$;
  CREATE TRIGGER campaigns_block_sent_delete BEFORE DELETE ON public.campaigns
    FOR EACH ROW EXECUTE FUNCTION public.campaigns_block_sent_delete();
  CREATE TRIGGER campaigns_lock_sent_content BEFORE UPDATE ON public.campaigns
    FOR EACH ROW EXECUTE FUNCTION public.campaigns_lock_sent_content();
  CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON public.campaigns
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
` + TABLES.map((t) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n')

// The 2 live policies (plan §1), written so they deparse to prod's text.
const MEMBERSHIP = '(private.auth_is_in_location(location_id))'
const VIA_CAMPAIGN = '(EXISTS (SELECT 1 FROM campaigns ca WHERE ca.id = campaign_recipients.campaign_id AND private.auth_is_in_location(ca.location_id)))'
const POLICY_SQL = `
  CREATE POLICY campaigns_location_scoped ON public.campaigns FOR ALL TO authenticated
    USING ${MEMBERSHIP} WITH CHECK ${MEMBERSHIP};
  CREATE POLICY campaign_recipients_via_campaign ON public.campaign_recipients FOR ALL TO authenticated
    USING ${VIA_CAMPAIGN} WITH CHECK ${VIA_CAMPAIGN};
`

// Prod text (pg_policies, re-read 1 Oct 2026 for this PR), ordered by table, name.
const PROD_M = 'private.auth_is_in_location(location_id)'
const PROD_VIA = '(EXISTS ( SELECT 1\n   FROM campaigns ca\n  WHERE ((ca.id = campaign_recipients.campaign_id) AND private.auth_is_in_location(ca.location_id))))'
const prodRow = (tablename, policyname, qual) => ({
  tablename, policyname, permissive: 'PERMISSIVE', cmd: 'ALL', roles: '{authenticated}', qual, with_check: qual })
const PROD_POLICIES = [
  prodRow('campaign_recipients', 'campaign_recipients_via_campaign', PROD_VIA),
  prodRow('campaigns', 'campaigns_location_scoped', PROD_M),
]

const SEED = `
  INSERT INTO public.campaigns (id, location_id, status, html_content, created_by) VALUES
    ('${CAM(1)}', '${IDS.LOC_A}', 'draft', '<p>Weekend offer</p>', '${IDS.OWNER_A}'),
    ('${CAM(2)}', '${IDS.LOC_A}', 'sent', '<p>Sent</p>', '${IDS.OWNER_A}'),
    ('${CAM('b')}', '${IDS.LOC_B}', 'draft', '<p>B</p>', '${IDS.STAFF_B}');
  INSERT INTO public.campaign_recipients (id, campaign_id, contact_id, status) VALUES
    ('${REC(1)}', '${CAM(1)}', '${IDS.C_MEMBER}', 'queued'),
    ('${REC(2)}', '${CAM(2)}', '${IDS.C_MEMBER2}', 'delivered'),
    ('${REC('b')}', '${CAM('b')}', '${IDS.C_B}', 'queued');
  INSERT INTO public.campaign_link_clicks (id, campaign_id, location_id) VALUES
    ('${CLK(1)}', '${CAM(2)}', '${IDS.LOC_A}'), ('${CLK(2)}', '${CAM(1)}', '${IDS.LOC_A}');`

// The rollback record (plan Task 1e-7 Step 7). Prod is in 677's end state
// (pre-probe 1 Oct: authenticated=arwd/postgres, no anon, on both), so the
// POST_677 form is the one to use; the PRE_677 form would hand anon all eight
// privileges back and authenticated the four 677 removed.
const TWO = 'public.campaigns, public.campaign_recipients'
const ROLLBACK_GRANT_PRE_677 = `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON ${TWO}
  TO anon, authenticated;`
const ROLLBACK_GRANT_POST_677 = `GRANT SELECT, INSERT, UPDATE, DELETE
  ON ${TWO}
  TO authenticated;`
const rollback684 = (grant) => `
BEGIN;
SET LOCAL lock_timeout = '5s';
${grant}
CREATE POLICY campaigns_location_scoped ON public.campaigns FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY campaign_recipients_via_campaign ON public.campaign_recipients FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM campaigns ca WHERE ca.id = campaign_recipients.campaign_id AND private.auth_is_in_location(ca.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns ca WHERE ca.id = campaign_recipients.campaign_id AND private.auth_is_in_location(ca.location_id)));
COMMIT;
`
const ROLLBACK_684 = { false: rollback684(ROLLBACK_GRANT_PRE_677), true: rollback684(ROLLBACK_GRANT_POST_677) }
const baseSpec = { tables: TABLE_SQL, policies: POLICY_SQL, seed: SEED }
const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`
const AT = (t, loc) => t === 'campaign_recipients'
  ? `SELECT count(*)::int AS n FROM public.campaign_recipients r JOIN public.campaigns c ON c.id = r.campaign_id WHERE c.location_id = '${loc}'`
  : `SELECT count(*)::int AS n FROM public.campaigns WHERE location_id = '${loc}'`
const INSERT = {
  campaigns: `INSERT INTO public.campaigns (location_id, status, created_by) VALUES ('${IDS.LOC_A}', 'draft', '${IDS.STAFF_A}')`,
  campaign_recipients: `INSERT INTO public.campaign_recipients (campaign_id, contact_id) VALUES ('${CAM(1)}', '${IDS.C_MEMBER2}')`,
}
const UPDATE = (t) => `UPDATE public.${t} SET id = id WHERE id = '${t === 'campaigns' ? CAM(1) : REC(1)}'`
const DELETE = (t) => `DELETE FROM public.${t} WHERE id = '${t === 'campaigns' ? CAM(1) : REC(1)}'`

// What authenticated holds on each table before 684 in each state.
const AUTH_BEFORE = { false: ALL_PRIVS, true: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }

/** Run a statement as a user with campaigns' SELECT revoked, in a transaction always rolled back. */
async function withParentRevoked(db, uid, sql) {
  await db.query('BEGIN')
  try {
    await db.query('REVOKE SELECT ON public.campaigns FROM authenticated')
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    return (await db.query(sql)).rows
  } finally {
    await db.query('ROLLBACK')
  }
}

describe.each(PROD_STATES)('before 684: the holes (prod on 1 Oct 2026), $label', ({ after677 }) => {
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

  it("the replay's 2 policies read exactly as prod's pg_policies", async () => {
    expect(await policiesOf(db, TABLES)).toEqual(PROD_POLICIES)
  })

  it('plain staff at A: reads every A campaign and recipient, schedules a draft, rewrites it with a forged created_by, and deletes it (its recipients cascade)', async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_A, count(t)), t).toEqual([{ n: 2 }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.campaigns SET status = 'scheduled', scheduled_at = now() + interval '1 hour'
        WHERE id = '${CAM(1)}' RETURNING status`)).toEqual([{ status: 'scheduled' }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.campaigns SET html_content = '<a href="https://example.invalid">Pay here</a>', created_by = '${IDS.OWNER_A}'
        WHERE id = '${CAM(1)}' RETURNING created_by::text`)).toEqual([{ created_by: IDS.OWNER_A }])
    expect(await asUser(db, IDS.STAFF_A,
      `DELETE FROM public.campaigns WHERE id = '${CAM(1)}'`,
      `SELECT count(*)::int AS n FROM public.campaign_recipients WHERE campaign_id = '${CAM(1)}'`)).toEqual([{ n: 0 }])
  })

  it("plain staff at B reaches none of A's rows", async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_B, AT(t, IDS.LOC_A)), t).toEqual([{ n: 0 }])
    expect(await asUser(db, IDS.STAFF_B,
      `UPDATE public.campaigns SET status = 'scheduled' WHERE location_id = '${IDS.LOC_A}' RETURNING id`)).toEqual([])
    await expect(asUser(db, IDS.STAFF_B, INSERT.campaign_recipients)).rejects.toThrow(rlsRefused('campaign_recipients'))
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

  it('the recipient policy reads campaigns AS THE CALLER: closing campaigns alone turns every read of the recipients into a 42501 (why the two close together)', async () => {
    await expect(withParentRevoked(db, IDS.STAFF_A, count('campaign_recipients'))).rejects.toThrow(denied('campaigns'))
    await expect(withParentRevoked(db, IDS.MASTER, count('campaign_recipients'))).rejects.toThrow(denied('campaigns'))
  })
})

describe.each(PROD_STATES)('after 684: the catalog, $label', ({ after677 }) => {
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

  it('the three replayed triggers are untouched (the file changes grants and policies only)', async () => {
    const { rows } = await db.query(`SELECT tgname::text FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid = 'public.campaigns'::regclass ORDER BY 1`)
    expect(rows.map((r) => r.tgname)).toEqual(['campaigns_block_sent_delete', 'campaigns_lock_sent_content', 'campaigns_updated_at'])
  })

  it('campaign_link_clicks keeps its own policy and grants (it references campaigns but its policy does not read it)', async () => {
    expect((await policiesOf(db, ['campaign_link_clicks'])).map((p) => p.policyname)).toEqual(['campaign_link_clicks_select'])
    expect(await clientPrivileges(db, 'campaign_link_clicks')).toContain('authenticated:SELECT')
  })
})

describe.each(PROD_STATES)('after 684: people, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot({ ...spec, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it('plain staff, owner, master, member: every read and write on both tables is refused by the grant', async () => {
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
      `UPDATE public.campaigns SET status = 'scheduled', scheduled_at = now() WHERE id = '${CAM(1)}'`))
      .rejects.toThrow(denied('campaigns'))
  })

  it('anon: every read and write is refused by the grant', async () => {
    for (const t of TABLES) {
      await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', INSERT[t]), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', `DELETE FROM public.${t}`), t).rejects.toThrow(denied(t))
    }
  })

  it('campaign_link_clicks still reads for staff; a join from it to campaigns (a PostgREST embed) is now a 42501', async () => {
    expect(await asUser(db, IDS.STAFF_A, count('campaign_link_clicks'))).toEqual([{ n: 2 }])
    await expect(asUser(db, IDS.STAFF_A,
      `SELECT c.status FROM public.campaign_link_clicks k JOIN public.campaigns c ON c.id = k.campaign_id`))
      .rejects.toThrow(denied('campaigns'))
  })

  it("service_role: the session routes' writes (create, save, schedule, stop, delete) succeed, and the updated_at trigger fires", async () => {
    expect(await asRole(db, 'service_role',
      `${INSERT.campaigns} RETURNING created_by::text`)).toEqual([{ created_by: IDS.STAFF_A }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.campaigns SET html_content = '<p>New</p>' WHERE id = '${CAM(1)}' AND status IN ('draft', 'scheduled')
        RETURNING html_content, updated_at > '2000-01-01 00:00:00+00' AS touched`)).toEqual([{ html_content: '<p>New</p>', touched: true }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.campaigns SET status = 'scheduled', scheduled_at = now() + interval '1 day', cancel_requested_at = NULL
        WHERE id = '${CAM(1)}' AND status IN ('draft', 'scheduled', 'failed') RETURNING status`)).toEqual([{ status: 'scheduled' }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.campaigns SET status = 'scheduled' WHERE id = '${CAM(1)}'`,
      `UPDATE public.campaigns SET status = 'draft', scheduled_at = NULL WHERE id = '${CAM(1)}' AND status = 'scheduled' RETURNING status`))
      .toEqual([{ status: 'draft' }])
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.campaigns WHERE id = '${CAM(1)}' AND status IN ('draft', 'scheduled') RETURNING id::text`)).toEqual([{ id: CAM(1) }])
  })

  it("service_role: the INVOKER triggers still refuse a sent campaign's content and delete (check_violation, the routes' 409)", async () => {
    await expect(asRole(db, 'service_role',
      `UPDATE public.campaigns SET html_content = 'x' WHERE id = '${CAM(2)}'`)).rejects.toThrow(/cannot be edited/)
    await expect(asRole(db, 'service_role',
      `DELETE FROM public.campaigns WHERE id = '${CAM(2)}'`)).rejects.toThrow(/cannot be deleted/)
  })

  it("service_role: the sender's recipient insert and status update, and the cascade (a draft takes its recipients and clicks)", async () => {
    expect(await asRole(db, 'service_role', INSERT.campaign_recipients,
      `UPDATE public.campaign_recipients SET status = 'sent' WHERE id = '${REC(1)}' RETURNING status`)).toEqual([{ status: 'sent' }])
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.campaigns WHERE id = '${CAM(1)}'`,
      `SELECT (SELECT count(*)::int FROM public.campaign_recipients WHERE campaign_id = '${CAM(1)}') AS recipients,
              (SELECT count(*)::int FROM public.campaign_link_clicks WHERE campaign_id = '${CAM(1)}') AS clicks,
              (SELECT count(*)::int FROM public.campaign_recipients) AS all_recipients`))
      .toEqual([{ recipients: 0, clicks: 0, all_recipients: 2 }])
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
    expect(names).toEqual(expect.arrayContaining(['campaigns_location_scoped', 'campaign_recipients_via_campaign']))
    expect(await clientPrivileges(db, 'campaigns')).toContain('authenticated:UPDATE')
  }

  it("when another grantor's UPDATE on campaigns to authenticated survives the REVOKE", () => expectAbort(
    `GRANT ALL ON public.campaigns TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.campaigns TO authenticated; RESET ROLE;`,
    /mig 684: (client roles still hold privileges on public\.campaigns: authenticated:UPDATE \(from other_grantor\)|authenticated still holds UPDATE on public\.campaigns)/,
  ), 120_000)

  it('when INSERT on campaign_recipients is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.campaign_recipients TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 684: authenticated still holds INSERT on public\.campaign_recipients/,
  ), 120_000)

  it("when another grantor's column-level UPDATE (status) on campaigns survives", () => expectAbort(
    `GRANT UPDATE (status) ON public.campaigns TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE (status) ON public.campaigns TO authenticated; RESET ROLE;`,
    /column-level UPDATE on public\.campaigns|client roles still hold privileges on public\.campaigns/,
  ), 120_000)

  it('when a policy the file does not know about is left on campaigns', () => expectAbort(
    `CREATE POLICY campaigns_stray ON public.campaigns FOR SELECT TO authenticated USING (true);`,
    /mig 684: public\.campaigns should have no policy left: campaigns_stray SELECT/,
  ), 120_000)

  it('when a policy on another table still reads campaigns as the caller', () => expectAbort(
    `CREATE TABLE public.x (id uuid); ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;
     CREATE POLICY x_via ON public.x FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.campaigns));`,
    /mig 684: policies on other tables still read a closed table as the caller: public\.x\.x_via/,
  ), 120_000)

  it('when RLS is off on campaign_recipients (the grant would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.campaign_recipients DISABLE ROW LEVEL SECURITY;`,
    /mig 684: row level security is off on public\.campaign_recipients/,
  ), 120_000)

  // Mutations of the file itself: each must abort it.
  const mutate = (from, to) => {
    const out = MIG.replace(from, to)
    expect(out, `mutation did not apply: ${from}`).not.toBe(MIG)
    return out
  }

  it('mutation: without the REVOKE the file aborts on campaigns', () => expectAbort('',
    /mig 684: client roles still hold privileges on public\.campaigns: (anon|authenticated):DELETE \(from postgres\)/,
    mutate(/REVOKE ALL\s+ON public\.campaigns, public\.campaign_recipients\s+FROM anon, authenticated, PUBLIC;\n/, '')), 120_000)

  it('mutation: without the campaigns_location_scoped DROP the file aborts on campaigns', () => expectAbort('',
    /mig 684: public\.campaigns should have no policy left: campaigns_location_scoped ALL/,
    mutate('DROP POLICY IF EXISTS campaigns_location_scoped ON public.campaigns;\n', '')), 120_000)

  it('mutation: campaign_recipients left out of the file (its DROP and the array entry) while campaigns closes: check 5 names its policy', () => expectAbort('',
    /mig 684: policies on other tables still read a closed table as the caller: public\.campaign_recipients\.campaign_recipients_via_campaign$/,
    mutate(/, 'campaign_recipients'\]/, ']')
      .replace('DROP POLICY IF EXISTS campaign_recipients_via_campaign ON public.campaign_recipients;\n', '')), 120_000)
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

  it('the rollback record restores the 2 policies and the before privileges (and so the holes)', async () => {
    db = await boot(spec)
    const policiesBefore = await policiesOf(db, TABLES)
    const privsBefore = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await abortMessage(db, ROLLBACK_684[after677])).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual(policiesBefore)
    expect(await policiesOf(db, TABLES)).toEqual(PROD_POLICIES)
    expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsBefore)
    expect(await asUser(db, IDS.STAFF_A, count('campaign_recipients'))).toEqual([{ n: 2 }])
  }, 120_000)

  if (after677) {
    it('the pre-677 rollback text would reopen what 677 closed (anon, and authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN): use the POST_677 form on prod', async () => {
      db = await boot(spec)
      expect(await abortMessage(db, MIG)).toBeNull()
      expect(await abortMessage(db, ROLLBACK_684[false])).toBeNull()
      const held = await clientPrivileges(db, 'campaigns')
      expect(held).toContain('anon:SELECT')
      expect(held).toContain('authenticated:MAINTAIN')
    }, 120_000)
  }
})
