// CBRCLIENTCLOSED.1 — behavioural test for migration 742.
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges) and adds class_booking_requests
// reduced to the columns the checks touch, with mig 335's RLS-on-no-policy and
// its INVOKER updated_at trigger (the one trigger prod has, re-read 18 Oct
// 2026). It proves:
//
//   * BEFORE: authenticated holds table privileges (arwd after 677, the full
//     default before it) and is fenced only by RLS having no policy: a
//     permissive policy added on top hands a signed-in session every row;
//   * AFTER: no client privilege (anon, authenticated, PUBLIC; table and
//     column level), RLS on, no policy; a signed-in session and anon are
//     refused by the GRANT, not RLS, even with a permissive policy present;
//     the service role still inserts, reads, updates (trigger fires) and
//     deletes;
//   * the self-check aborts the WHOLE file on another grantor's privilege
//     (table or column level), an inherited one, a policy and RLS off, and
//     on the file with its REVOKE removed; a second run passes.
//
// Every describe runs in BOTH prod states: before mig 677 and after it (prod
// since 30 Sep 2026), with 677 replayed from its real file.
// Fictional ids only: the repo is public.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, denied, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/742_class_booking_requests_client_closed.sql'), 'utf8')
const T = 'class_booking_requests'
const REQ_1 = '74200000-0000-0000-0000-000000000001'

const TABLES = `
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
  CREATE TABLE public.class_booking_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL,
    contact_id uuid,
    glofox_event_id text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT '2000-01-01'
  );
  CREATE OR REPLACE TRIGGER trg_cbr_updated_at BEFORE UPDATE ON public.class_booking_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  ALTER TABLE public.class_booking_requests ENABLE ROW LEVEL SECURITY;
`
const SEED = `
  INSERT INTO public.class_booking_requests (id, location_id, contact_id, glofox_event_id)
  VALUES ('${REQ_1}', '${IDS.LOC_A}', '${IDS.C_MEMBER}', 'evt-1');
`
// The hole the REVOKE closes: any permissive policy would open the table.
const OPEN_POLICY = `CREATE POLICY cbr_open ON public.class_booking_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);`

const bootAt = (state, extra = {}) => boot({ tables: TABLES, policies: '', seed: SEED, after677: state.after677, ...extra })

describe.each(PROD_STATES)('mig 742 — $label', (state) => {
  it('BEFORE: authenticated holds table privileges, fenced only by RLS', async () => {
    const db = await bootAt(state)
    const held = await clientPrivileges(db, T)
    expect(held).toEqual(expect.arrayContaining(['authenticated:SELECT', 'authenticated:INSERT', 'authenticated:UPDATE', 'authenticated:DELETE']))
    // No policy: reads come back empty rather than refused.
    expect(await asUser(db, IDS.STAFF_A, `SELECT id FROM public.${T}`)).toEqual([])
    // ...and one permissive policy hands every row to any signed-in session.
    await db.exec(OPEN_POLICY)
    expect(await asUser(db, IDS.STAFF_A, `SELECT id FROM public.${T}`)).toEqual([{ id: REQ_1 }])
    await db.close()
  })

  it('AFTER: no client privilege, RLS on, no policy; the server keeps DML', async () => {
    const db = await bootAt(state, { migrate: [MIG] })
    expect(await clientPrivileges(db, T)).toEqual([])
    expect(await rlsOn(db, T)).toBe(true)
    expect(await policiesOf(db, [T])).toEqual([])
    expect(await serviceRoleDml(db, T)).toBe(true)
    await db.close()
  })

  it('AFTER: signed-in and anon sessions are refused by the grant, even with a permissive policy', async () => {
    const db = await bootAt(state, { migrate: [MIG] })
    await db.exec(OPEN_POLICY)
    for (const stmt of [
      `SELECT id FROM public.${T}`,
      `INSERT INTO public.${T} (location_id, glofox_event_id) VALUES ('${IDS.LOC_A}', 'evt-2')`,
      `UPDATE public.${T} SET status = 'booked' WHERE id = '${REQ_1}'`,
      `DELETE FROM public.${T} WHERE id = '${REQ_1}'`,
    ]) {
      await expect(asUser(db, IDS.STAFF_A, stmt), stmt).rejects.toThrow(denied(T))
      await expect(asUser(db, IDS.MEMBER_UID, stmt), stmt).rejects.toThrow(denied(T))
      await expect(asRole(db, 'anon', stmt), stmt).rejects.toThrow(denied(T))
    }
    await db.close()
  })

  it('AFTER: the queue still works for the service role (enqueue, claim, trigger, delete)', async () => {
    const db = await bootAt(state, { migrate: [MIG] })
    const rows = await asRole(db, 'service_role',
      `INSERT INTO public.${T} (location_id, contact_id, glofox_event_id) VALUES ('${IDS.LOC_A}', '${IDS.C_MEMBER2}', 'evt-2')`,
      `UPDATE public.${T} SET status = 'processing', attempts = attempts + 1 WHERE id = '${REQ_1}'`,
      `DELETE FROM public.${T} WHERE glofox_event_id = 'evt-2'`,
      `SELECT status, attempts, updated_at > '2000-01-01'::timestamptz AS stamped FROM public.${T} ORDER BY created_at`)
    expect(rows).toEqual([{ status: 'processing', attempts: 1, stamped: true }])
    await db.close()
  })

  it('the file without its REVOKE aborts on its own self-check', async () => {
    const mutant = MIG.replace(/^REVOKE ALL ON public\.class_booking_requests FROM anon, authenticated, PUBLIC;$/m, '')
    expect(mutant).not.toBe(MIG)
    const db = await bootAt(state)
    expect(await abortMessage(db, mutant)).toMatch(/client roles still hold privileges on public\.class_booking_requests: .*authenticated:SELECT/)
    await db.close()
  })

  it('a second run passes', async () => {
    const db = await bootAt(state, { migrate: [MIG] })
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await clientPrivileges(db, T)).toEqual([])
    await db.close()
  })

  it.each([
    ['another grantor\'s privilege', `GRANT SELECT ON public.${T} TO other_grantor WITH GRANT OPTION; SET ROLE other_grantor; GRANT SELECT ON public.${T} TO authenticated; RESET ROLE;`, /client roles still hold privileges/],
    ['an inherited privilege', `GRANT SELECT ON public.${T} TO sneaky; GRANT sneaky TO authenticated;`, /authenticated still holds SELECT/],
    ['another grantor\'s column grant', `GRANT SELECT ON public.${T} TO other_grantor WITH GRANT OPTION; SET ROLE other_grantor; GRANT SELECT (status) ON public.${T} TO authenticated; RESET ROLE;`, /client roles still hold privileges/],
    ['a policy', OPEN_POLICY, /should have no policy: cbr_open/],
    ['RLS off', `ALTER TABLE public.${T} DISABLE ROW LEVEL SECURITY;`, /row level security is off/],
  ])('the self-check aborts the whole file on %s', async (_label, before, message) => {
    const db = await bootAt(state, { before })
    const err = await abortMessage(db, MIG)
    expect(err).toMatch(message)
    // Rolled back whole: the REVOKE did not stick either.
    expect(await clientPrivileges(db, T)).toEqual(expect.arrayContaining(['authenticated:SELECT']))
    await db.close()
  })
})
