// MEMBERWRITESWEEP.1g — behavioural test for migration 685.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the three private helpers verbatim
// with prod EXECUTE) and adds tv_displays, tv_templates and tv_content with
// prod's column names, defaults and FK actions (information_schema and
// pg_constraint, re-read 2 Oct 2026: tv_displays.token is text DEFAULT
// gen_random_uuid()::text; tv_content.tv_display_id is the primary key and
// cascades from tv_displays; both studio FKs cascade from locations; pushed_by
// and created_by SET NULL from profiles), with the 3 live policies written so
// they deparse to prod's pg_policies text (pinned by a test). No trigger on
// any of the three, none elsewhere names them, no view, no publication. It
// proves:
//
//   * BEFORE: a PLAIN STAFF member of a studio (no `tv_displays` permission
//     needed, the policies test membership only) reads every TV at that
//     studio with its cast token (the secret the public cast URL is built
//     from), puts any URL on a TV (an upsert on tv_content, the push) with a
//     forged pushed_by, re-points a TV's rotation and deletes a template.
//     Staff at another studio reach nothing; a member (no profile) reads and
//     writes nothing; the tv_content policy reads tv_displays AS THE CALLER,
//     so closing tv_displays alone turns every read of tv_content into a
//     42501 (why the three close together);
//   * AFTER: no client privilege on any of the three (anon, authenticated,
//     PUBLIC; table and column level), RLS on, no policy; plain staff, owner,
//     master, member and anon are refused every read and write by the grant;
//     every service-role path still works: the 1f session routes' writes
//     (register a TV, rotation, push with onConflict tv_display_id, clear,
//     delete a TV; create, update and delete a template), hyrox's upsert on
//     conflict and the publish runner's displays-with-content read, the public
//     cast read (token → display → content → template), and the TV delete
//     cascade to its content;
//   * the pre-check refuses a live policy whose text drifted from the one this
//     file was written against; the self-check aborts the WHOLE file on
//     another grantor's privilege (table or column level), an inherited
//     privilege, a policy the file does not know about, a policy elsewhere
//     that reads a closed table as the caller, and RLS off; three mutations of
//     the file itself (no REVOKE; no tv_displays_location_scoped DROP;
//     tv_content kept out of the file while tv_displays closes) each abort with
//     their message; a second run passes; the rollback record restores the
//     before-state.
//
// Every describe runs in BOTH prod states: before mig 677 and after it (prod
// since 30 Sep 2026, 13:13 UTC: no anon, authenticated arwd on all three,
// re-read 2 Oct 2026), with 677 replayed from its real file.
// Fictional ids only: the repo is public. No token value is ever written or
// compared here: the column's default makes one.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, ALL_PRIVS, denied, rlsRefused, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/685_tv_tables_client_closed.sql'), 'utf8')
const TABLES = ['tv_displays', 'tv_templates', 'tv_content']

// Fixed ids: TVs 87…0k (1, 2 at A; b at B), templates 88…0k.
const TV = (k) => `87000000-0000-0000-0000-00000000000${k}`
const TPL = (k) => `88000000-0000-0000-0000-00000000000${k}`

const TABLE_SQL = `
  CREATE TABLE public.tv_displays (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations (id) ON DELETE CASCADE,
    label text NOT NULL, token text NOT NULL DEFAULT (gen_random_uuid())::text,
    active boolean NOT NULL DEFAULT true, rotation smallint NOT NULL DEFAULT 0);
  CREATE TABLE public.tv_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations (id) ON DELETE CASCADE,
    name text NOT NULL, base_image_path text NOT NULL, zones jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT '2000-01-01 00:00:00+00');
  CREATE TABLE public.tv_content (
    tv_display_id uuid PRIMARY KEY REFERENCES public.tv_displays (id) ON DELETE CASCADE,
    source_type text NOT NULL, source_ref text NOT NULL, label text, template_values jsonb,
    pushed_at timestamptz NOT NULL DEFAULT now(),
    pushed_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL, triggered_by text);
` + TABLES.map((t) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n')

// The 3 live policies (plan §1), written so they deparse to prod's text.
const MEMBERSHIP = '(private.auth_is_in_location(location_id))'
const VIA_DISPLAY = '(EXISTS (SELECT 1 FROM tv_displays d WHERE d.id = tv_content.tv_display_id AND private.auth_is_in_location(d.location_id)))'
const POLICY_SQL = `
  CREATE POLICY tv_displays_location_scoped ON public.tv_displays FOR ALL TO authenticated
    USING ${MEMBERSHIP} WITH CHECK ${MEMBERSHIP};
  CREATE POLICY tv_templates_location_scoped ON public.tv_templates FOR ALL TO authenticated
    USING ${MEMBERSHIP} WITH CHECK ${MEMBERSHIP};
  CREATE POLICY tv_content_location_scoped ON public.tv_content FOR ALL TO authenticated
    USING ${VIA_DISPLAY} WITH CHECK ${VIA_DISPLAY};
`

// Prod text (pg_policies, re-read 2 Oct 2026 for this PR), ordered by table, name.
const PROD_M = 'private.auth_is_in_location(location_id)'
const PROD_VIA = '(EXISTS ( SELECT 1\n   FROM tv_displays d\n  WHERE ((d.id = tv_content.tv_display_id) AND private.auth_is_in_location(d.location_id))))'
const prodRow = (tablename, policyname, qual) => ({
  tablename, policyname, permissive: 'PERMISSIVE', cmd: 'ALL', roles: '{authenticated}', qual, with_check: qual })
const PROD_POLICIES = [
  prodRow('tv_content', 'tv_content_location_scoped', PROD_VIA),
  prodRow('tv_displays', 'tv_displays_location_scoped', PROD_M),
  prodRow('tv_templates', 'tv_templates_location_scoped', PROD_M),
]

const SEED = `
  INSERT INTO public.tv_displays (id, location_id, label) VALUES
    ('${TV(1)}', '${IDS.LOC_A}', 'Lobby'), ('${TV(2)}', '${IDS.LOC_A}', 'Gym floor'), ('${TV('b')}', '${IDS.LOC_B}', 'B lobby');
  INSERT INTO public.tv_templates (id, location_id, name, base_image_path, created_by) VALUES
    ('${TPL(1)}', '${IDS.LOC_A}', 'Board', '${IDS.LOC_A}/templates/board.png', '${IDS.OWNER_A}'),
    ('${TPL('b')}', '${IDS.LOC_B}', 'B board', '${IDS.LOC_B}/templates/b.png', NULL);
  INSERT INTO public.tv_content (tv_display_id, source_type, source_ref, pushed_by, triggered_by) VALUES
    ('${TV(1)}', 'template', '${TPL(1)}', '${IDS.OWNER_A}', 'manual:${IDS.OWNER_A}'),
    ('${TV('b')}', 'url', 'https://example.invalid/b.png', NULL, 'manual');`

// The rollback record (plan Task 1g-5). Prod is in 677's end state (pre-probe
// 2 Oct: authenticated=arwd/postgres, no anon, on all three), so the POST_677
// form is the one to use; the PRE_677 form would hand anon all eight
// privileges back and authenticated the four 677 removed.
const THREE = 'public.tv_displays, public.tv_templates, public.tv_content'
const ROLLBACK_GRANT_PRE_677 = `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON ${THREE}
  TO anon, authenticated;`
const ROLLBACK_GRANT_POST_677 = `GRANT SELECT, INSERT, UPDATE, DELETE
  ON ${THREE}
  TO authenticated;`
const rollback685 = (grant) => `
BEGIN;
SET LOCAL lock_timeout = '5s';
${grant}
CREATE POLICY tv_displays_location_scoped ON public.tv_displays FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY tv_templates_location_scoped ON public.tv_templates FOR ALL TO authenticated
  USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));
CREATE POLICY tv_content_location_scoped ON public.tv_content FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM tv_displays d WHERE d.id = tv_content.tv_display_id AND private.auth_is_in_location(d.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM tv_displays d WHERE d.id = tv_content.tv_display_id AND private.auth_is_in_location(d.location_id)));
COMMIT;
`
const ROLLBACK_685 = { false: rollback685(ROLLBACK_GRANT_PRE_677), true: rollback685(ROLLBACK_GRANT_POST_677) }
const baseSpec = { tables: TABLE_SQL, policies: POLICY_SQL, seed: SEED }
const count = (t) => `SELECT count(*)::int AS n FROM public.${t}`
const AT = (t, loc) => t === 'tv_content'
  ? `SELECT count(*)::int AS n FROM public.tv_content c JOIN public.tv_displays d ON d.id = c.tv_display_id WHERE d.location_id = '${loc}'`
  : `SELECT count(*)::int AS n FROM public.${t} WHERE location_id = '${loc}'`
const INSERT = {
  tv_displays: `INSERT INTO public.tv_displays (location_id, label) VALUES ('${IDS.LOC_A}', 'New TV')`,
  tv_templates: `INSERT INTO public.tv_templates (location_id, name, base_image_path) VALUES ('${IDS.LOC_A}', 'T', '${IDS.LOC_A}/templates/t.png')`,
  tv_content: `INSERT INTO public.tv_content (tv_display_id, source_type, source_ref) VALUES ('${TV(2)}', 'url', 'https://example.invalid/x')`,
}
const KEY = { tv_displays: 'id', tv_templates: 'id', tv_content: 'tv_display_id' }
const ROW = { tv_displays: TV(2), tv_templates: TPL(1), tv_content: TV(1) }
const UPDATE = (t) => `UPDATE public.${t} SET ${KEY[t]} = ${KEY[t]} WHERE ${KEY[t]} = '${ROW[t]}'`
const DELETE = (t) => `DELETE FROM public.${t} WHERE ${KEY[t]} = '${ROW[t]}'`
// The push: what /api/admin/tv-displays/[id]/content and hyrox's push send
// (supabase-js upsert onConflict tv_display_id).
const PUSH = (tv, ref, by) => `INSERT INTO public.tv_content (tv_display_id, source_type, source_ref, pushed_by, triggered_by)
  VALUES ('${tv}', 'url', '${ref}', ${by ? `'${by}'` : 'NULL'}, ${by ? `'manual:${by}'` : `'manual'`})
  ON CONFLICT (tv_display_id) DO UPDATE SET source_type = EXCLUDED.source_type, source_ref = EXCLUDED.source_ref,
    pushed_by = EXCLUDED.pushed_by, triggered_by = EXCLUDED.triggered_by, pushed_at = now()
  RETURNING source_ref, pushed_by::text`

// What authenticated holds on each table before 685 in each state.
const AUTH_BEFORE = { false: ALL_PRIVS, true: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }

/** Run a statement as a user with tv_displays' SELECT revoked, in a transaction always rolled back. */
async function withParentRevoked(db, uid, sql) {
  await db.query('BEGIN')
  try {
    await db.query('REVOKE SELECT ON public.tv_displays FROM authenticated')
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    return (await db.query(sql)).rows
  } finally {
    await db.query('ROLLBACK')
  }
}

describe.each(PROD_STATES)('before 685: the holes (prod on 2 Oct 2026), $label', ({ after677 }) => {
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

  it("the replay's 3 policies read exactly as prod's pg_policies", async () => {
    expect(await policiesOf(db, TABLES)).toEqual(PROD_POLICIES)
  })

  it("plain staff at A: reads every A TV with its cast token, puts any URL on a TV with a forged pushed_by, re-rotates a TV and deletes a template", async () => {
    expect(await asUser(db, IDS.STAFF_A,
      `SELECT count(*)::int AS n, count(token)::int AS tokens FROM public.tv_displays`)).toEqual([{ n: 2, tokens: 2 }])
    expect(await asUser(db, IDS.STAFF_A, count('tv_templates'))).toEqual([{ n: 1 }])
    expect(await asUser(db, IDS.STAFF_A, count('tv_content'))).toEqual([{ n: 1 }])
    expect(await asUser(db, IDS.STAFF_A, PUSH(TV(1), 'https://example.invalid/pay-here', IDS.OWNER_A)))
      .toEqual([{ source_ref: 'https://example.invalid/pay-here', pushed_by: IDS.OWNER_A }])
    expect(await asUser(db, IDS.STAFF_A,
      `UPDATE public.tv_displays SET rotation = 180 WHERE id = '${TV(2)}' RETURNING rotation`)).toEqual([{ rotation: 180 }])
    expect(await asUser(db, IDS.STAFF_A,
      `DELETE FROM public.tv_templates WHERE id = '${TPL(1)}' RETURNING id::text`)).toEqual([{ id: TPL(1) }])
  })

  it("plain staff at B reaches none of A's rows", async () => {
    for (const t of TABLES) expect(await asUser(db, IDS.STAFF_B, AT(t, IDS.LOC_A)), t).toEqual([{ n: 0 }])
    expect(await asUser(db, IDS.STAFF_B,
      `UPDATE public.tv_displays SET rotation = 90 WHERE location_id = '${IDS.LOC_A}' RETURNING id`)).toEqual([])
    await expect(asUser(db, IDS.STAFF_B, INSERT.tv_content)).rejects.toThrow(rlsRefused('tv_content'))
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

  it('the tv_content policy reads tv_displays AS THE CALLER: closing tv_displays alone turns every read of tv_content into a 42501 (why the three close together)', async () => {
    await expect(withParentRevoked(db, IDS.STAFF_A, count('tv_content'))).rejects.toThrow(denied('tv_displays'))
    await expect(withParentRevoked(db, IDS.MASTER, count('tv_content'))).rejects.toThrow(denied('tv_displays'))
  })
})

describe.each(PROD_STATES)('after 685: the catalog, $label', ({ after677 }) => {
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

  it('the rows are untouched (the file changes grants and policies only)', async () => {
    expect(await asRole(db, 'service_role',
      `SELECT (SELECT count(*)::int FROM public.tv_displays) AS displays, (SELECT count(*)::int FROM public.tv_templates) AS templates,
              (SELECT count(*)::int FROM public.tv_content) AS content`)).toEqual([{ displays: 3, templates: 2, content: 2 }])
  })
})

describe.each(PROD_STATES)('after 685: people, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  beforeAll(async () => { db = await boot({ ...spec, migrate: [MIG] }) }, 120_000)
  afterAll(() => db?.close())

  it('plain staff, owner, master, member: every read and write on the three is refused by the grant', async () => {
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
    // The finding's own reads and writes, as the plain staff member: refused.
    await expect(asUser(db, IDS.STAFF_A, `SELECT token FROM public.tv_displays`)).rejects.toThrow(denied('tv_displays'))
    await expect(asUser(db, IDS.STAFF_A, PUSH(TV(1), 'https://example.invalid/pay-here', IDS.OWNER_A))).rejects.toThrow(denied('tv_content'))
  })

  it('anon: every read and write is refused by the grant', async () => {
    for (const t of TABLES) {
      await expect(asRole(db, 'anon', count(t)), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', INSERT[t]), t).rejects.toThrow(denied(t))
      await expect(asRole(db, 'anon', `DELETE FROM public.${t}`), t).rejects.toThrow(denied(t))
    }
  })

  it("service_role: the 1f TV routes' writes (register, rotation, push on conflict, clear, delete) succeed", async () => {
    expect(await asRole(db, 'service_role',
      `${INSERT.tv_displays} RETURNING label, token IS NOT NULL AS has_token, rotation`)).toEqual([{ label: 'New TV', has_token: true, rotation: 0 }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.tv_displays SET rotation = 90 WHERE id = '${TV(2)}' AND location_id = '${IDS.LOC_A}' RETURNING rotation`)).toEqual([{ rotation: 90 }])
    expect(await asRole(db, 'service_role', PUSH(TV(1), 'https://example.invalid/a.png', IDS.STAFF_A)))
      .toEqual([{ source_ref: 'https://example.invalid/a.png', pushed_by: IDS.STAFF_A }])
    expect(await asRole(db, 'service_role', PUSH(TV(2), 'https://example.invalid/b.png', IDS.STAFF_A)))
      .toEqual([{ source_ref: 'https://example.invalid/b.png', pushed_by: IDS.STAFF_A }])
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.tv_content WHERE tv_display_id = '${TV(1)}' RETURNING tv_display_id::text`)).toEqual([{ tv_display_id: TV(1) }])
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.tv_displays WHERE id = '${TV(2)}' AND location_id = '${IDS.LOC_A}' RETURNING id::text`)).toEqual([{ id: TV(2) }])
  })

  it("service_role: the 1f template routes' writes (create with created_by, update with updated_at, delete) succeed", async () => {
    expect(await asRole(db, 'service_role',
      `INSERT INTO public.tv_templates (location_id, name, base_image_path, zones, created_by)
         VALUES ('${IDS.LOC_A}', 'New', '${IDS.LOC_A}/templates/n.png', '[{"id":"z1"}]', '${IDS.STAFF_A}') RETURNING created_by::text`))
      .toEqual([{ created_by: IDS.STAFF_A }])
    expect(await asRole(db, 'service_role',
      `UPDATE public.tv_templates SET name = 'Board 2', updated_at = now() WHERE id = '${TPL(1)}'
         RETURNING name, updated_at > '2000-01-01 00:00:00+00' AS touched`)).toEqual([{ name: 'Board 2', touched: true }])
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.tv_templates WHERE id = '${TPL(1)}' AND location_id = '${IDS.LOC_A}' RETURNING id::text`)).toEqual([{ id: TPL(1) }])
  })

  it("service_role: hyrox's push (upsert on conflict for every active TV) and the publish runner's displays-with-content read", async () => {
    expect(await asRole(db, 'service_role',
      `INSERT INTO public.tv_content (tv_display_id, source_type, source_ref, triggered_by)
         SELECT id, 'url', 'https://example.invalid/hyrox', 'hyrox:session' FROM public.tv_displays
          WHERE location_id = '${IDS.LOC_A}' AND active
       ON CONFLICT (tv_display_id) DO UPDATE SET source_type = EXCLUDED.source_type, source_ref = EXCLUDED.source_ref,
         triggered_by = EXCLUDED.triggered_by
       RETURNING tv_display_id::text`)).toHaveLength(2)
    expect(await asRole(db, 'service_role',
      `SELECT d.id::text, c.triggered_by FROM public.tv_displays d LEFT JOIN public.tv_content c ON c.tv_display_id = d.id
        WHERE d.location_id = '${IDS.LOC_A}' AND d.active ORDER BY 1`))
      .toEqual([{ id: TV(1), triggered_by: `manual:${IDS.OWNER_A}` }, { id: TV(2), triggered_by: null }])
  })

  it('service_role: the public cast read (token → display → content → template) still resolves', async () => {
    expect(await asRole(db, 'service_role',
      `SELECT d.label, c.source_type, t.name FROM public.tv_displays d
         JOIN public.tv_content c ON c.tv_display_id = d.id
         LEFT JOIN public.tv_templates t ON c.source_type = 'template' AND t.id::text = c.source_ref
        WHERE d.token = (SELECT token FROM public.tv_displays WHERE id = '${TV(1)}') AND d.active`))
      .toEqual([{ label: 'Lobby', source_type: 'template', name: 'Board' }])
  })

  it('service_role: deleting a TV cascades to its content row', async () => {
    expect(await asRole(db, 'service_role',
      `DELETE FROM public.tv_displays WHERE id = '${TV(1)}'`,
      `SELECT (SELECT count(*)::int FROM public.tv_content WHERE tv_display_id = '${TV(1)}') AS mine,
              (SELECT count(*)::int FROM public.tv_content) AS all_content`)).toEqual([{ mine: 0, all_content: 1 }])
  })
})

describe.each(PROD_STATES)('the pre-check and the self-check abort the whole file, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message, sql = MIG) {
    db = await boot({ ...spec, before })
    const msg = await abortMessage(db, sql)
    expect(msg).toMatch(message)
    // Nothing applied: the old policies and the old grant are still there.
    const names = (await policiesOf(db, TABLES)).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['tv_displays_location_scoped', 'tv_content_location_scoped']))
    expect(await clientPrivileges(db, 'tv_displays')).toContain('authenticated:UPDATE')
  }

  it('pre-check: a live tv_templates policy whose text is not the one this file was written against', () => expectAbort(
    `DROP POLICY tv_templates_location_scoped ON public.tv_templates;
     CREATE POLICY tv_templates_location_scoped ON public.tv_templates FOR ALL TO authenticated
       USING (private.auth_is_master() OR private.auth_is_in_location(location_id))
       WITH CHECK (private.auth_is_master() OR private.auth_is_in_location(location_id));`,
    /mig 685: public\.tv_templates\.tv_templates_location_scoped is not the policy this file was written against/,
  ), 120_000)

  it('pre-check: a live tv_content policy that changed command (FOR SELECT, same text)', () => expectAbort(
    `DROP POLICY tv_content_location_scoped ON public.tv_content;
     CREATE POLICY tv_content_location_scoped ON public.tv_content FOR SELECT TO authenticated USING ${VIA_DISPLAY};`,
    /mig 685: public\.tv_content\.tv_content_location_scoped is not the policy this file was written against/,
  ), 120_000)

  it("when another grantor's UPDATE on tv_displays to authenticated survives the REVOKE", () => expectAbort(
    `GRANT ALL ON public.tv_displays TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT UPDATE ON public.tv_displays TO authenticated; RESET ROLE;`,
    /mig 685: (client roles still hold privileges on public\.tv_displays: authenticated:UPDATE \(from other_grantor\)|authenticated still holds UPDATE on public\.tv_displays)/,
  ), 120_000)

  it('when INSERT on tv_content is inherited through role membership (information_schema cannot see it)', () => expectAbort(
    `GRANT INSERT ON public.tv_content TO sneaky; GRANT sneaky TO authenticated;`,
    /mig 685: authenticated still holds INSERT on public\.tv_content/,
  ), 120_000)

  it("when another grantor's column-level SELECT (token) on tv_displays survives", () => expectAbort(
    `GRANT SELECT (token) ON public.tv_displays TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT SELECT (token) ON public.tv_displays TO authenticated; RESET ROLE;`,
    /column-level SELECT on public\.tv_displays|client roles still hold privileges on public\.tv_displays/,
  ), 120_000)

  it('when a policy the file does not know about is left on tv_templates', () => expectAbort(
    `CREATE POLICY tv_templates_stray ON public.tv_templates FOR SELECT TO authenticated USING (true);`,
    /mig 685: public\.tv_templates should have no policy left: tv_templates_stray SELECT/,
  ), 120_000)

  it('when a policy on another table still reads tv_displays as the caller', () => expectAbort(
    `CREATE TABLE public.x (id uuid); ALTER TABLE public.x ENABLE ROW LEVEL SECURITY;
     CREATE POLICY x_via ON public.x FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.tv_displays));`,
    /mig 685: policies on other tables still read a closed table as the caller: public\.x\.x_via/,
  ), 120_000)

  it('when RLS is off on tv_content (the grant would then be its only fence)', () => expectAbort(
    `ALTER TABLE public.tv_content DISABLE ROW LEVEL SECURITY;`,
    /mig 685: row level security is off on public\.tv_content/,
  ), 120_000)

  // Mutations of the file itself: each must abort it.
  const mutate = (from, to) => {
    const out = MIG.replace(from, to)
    expect(out, `mutation did not apply: ${from}`).not.toBe(MIG)
    return out
  }

  it('mutation: without the REVOKE the file aborts on tv_displays', () => expectAbort('',
    /mig 685: client roles still hold privileges on public\.tv_displays: (anon|authenticated):DELETE \(from postgres\)/,
    mutate(/REVOKE ALL\s+ON public\.tv_displays, public\.tv_templates, public\.tv_content\s+FROM anon, authenticated, PUBLIC;\n/, '')), 120_000)

  it('mutation: without the tv_displays_location_scoped DROP the file aborts on tv_displays', () => expectAbort('',
    /mig 685: public\.tv_displays should have no policy left: tv_displays_location_scoped ALL/,
    mutate('DROP POLICY IF EXISTS tv_displays_location_scoped ON public.tv_displays;\n', '')), 120_000)

  it('mutation: tv_content left out of the file (its DROP and the array entry) while tv_displays closes: check 5 names its policy', () => expectAbort('',
    /mig 685: policies on other tables still read a closed table as the caller: public\.tv_content\.tv_content_location_scoped$/,
    mutate(/, 'tv_content'\];/, '];')
      .replace('DROP POLICY IF EXISTS tv_content_location_scoped ON public.tv_content;\n', '')), 120_000)
})

describe.each(PROD_STATES)('idempotent and reversible, $label', ({ after677 }) => {
  const spec = { ...baseSpec, after677 }
  let db
  afterEach(async () => { await db?.close() })

  it('a second run passes its own pre-check and self-check', async () => {
    db = await boot({ ...spec, migrate: [MIG] })
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual([])
  }, 120_000)

  it('the rollback record restores the 3 policies and the before privileges (and so the holes)', async () => {
    db = await boot(spec)
    const policiesBefore = await policiesOf(db, TABLES)
    const privsBefore = await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await abortMessage(db, ROLLBACK_685[after677])).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual(policiesBefore)
    expect(await policiesOf(db, TABLES)).toEqual(PROD_POLICIES)
    expect(await Promise.all(TABLES.map((t) => clientPrivileges(db, t)))).toEqual(privsBefore)
    expect(await asUser(db, IDS.STAFF_A, count('tv_content'))).toEqual([{ n: 1 }])
  }, 120_000)

  it('after a rollback the file applies again (its pre-check accepts the restored policies)', async () => {
    db = await boot({ ...spec, migrate: [MIG, ROLLBACK_685[after677]] })
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await policiesOf(db, TABLES)).toEqual([])
  }, 120_000)

  if (after677) {
    it('the pre-677 rollback text would reopen what 677 closed (anon, and authenticated TRUNCATE/REFERENCES/TRIGGER/MAINTAIN): use the POST_677 form on prod', async () => {
      db = await boot(spec)
      expect(await abortMessage(db, MIG)).toBeNull()
      expect(await abortMessage(db, ROLLBACK_685[false])).toBeNull()
      const held = await clientPrivileges(db, 'tv_displays')
      expect(held).toContain('anon:SELECT')
      expect(held).toContain('authenticated:MAINTAIN')
    }, 120_000)
  }
})
