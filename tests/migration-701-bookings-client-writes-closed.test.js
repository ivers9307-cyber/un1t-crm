// C138 (e) — behavioural test for migration 701 (bookings client writes closed).
//
// No local Supabase stack exists, so DDL would otherwise get its first run on
// prod. This boots PGlite (PostgreSQL 17) through tests/helpers/member-write-
// sweep.js (Supabase's default privileges, the private helpers verbatim with
// prod EXECUTE) and adds private.auth_is_manager_at (verbatim from prod, 2 Oct
// 2026, prod EXECUTE), a stand-in for private.auth_mobile_can_location_ids
// (same name, signature, SECURITY DEFINER and EXECUTE as prod; its body reads
// a test grant table instead of mig 691's role templates, which this file
// never touches), bookings reduced to the columns the policies, triggers and
// service paths need, prod's three triggers (two SECURITY DEFINER stand-ins
// and the INVOKER updated_at), booking_reminder_sends with its live policy
// (it reads bookings AS THE CALLER), and the four live bookings policies
// written so they deparse to prod's pg_policies text (pinned by a test). It
// proves:
//
//   * BEFORE: staff with the phone `bookings` key insert a booking at their
//     studio and rewrite any booking there (status, date, skip_reminder) past
//     every route; a manager deletes one; nobody reaches another studio; a
//     member (no profile) reaches nothing;
//   * AFTER: authenticated holds SELECT only (anon and PUBLIC nothing; table
//     and column level), RLS on, exactly bookings_select unchanged; every
//     client write is refused by the grant; the phone read is unchanged (staff
//     read their studio's bookings, not another's; a member reads none);
//     booking_reminder_sends still reads; service_role inserts, updates and
//     deletes, and the triggers still fire;
//   * the pre-check aborts on a policy it does not know, a known policy with
//     other text, and a missing bookings_select; the self-check aborts on
//     another grantor's privilege (table or column level), an inherited one,
//     and RLS off; nothing is applied on an abort; a second run passes; the
//     ROLLBACK record in the file restores the before-state.
//
// Every describe runs in BOTH prod states: before mig 677 and after it (prod
// since 30 Sep 2026: no anon, authenticated arwd), with 677 replayed from its
// real file. Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, policiesOf, clientPrivileges, rlsOn, serviceRoleDml, abortMessage,
  IDS, denied, rlsRefused, PROD_STATES } from './helpers/member-write-sweep.js'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/701_bookings_client_writes_closed.sql'), 'utf8')

const BK = (k) => `70000000-0000-0000-0000-00000000000${k}`

const TABLE_SQL = `
  -- private.auth_is_manager_at, VERBATIM from prod (pg_get_functiondef, 2 Oct 2026).
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid)
   RETURNS boolean
   LANGUAGE sql
   STABLE SECURITY DEFINER
   SET search_path TO ''
  AS $function$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
        AND (
          p.role = 'master'
          OR EXISTS (
            SELECT 1 FROM public.profile_locations pl
            WHERE pl.profile_id = (SELECT auth.uid())
              AND pl.location_id = p_location_id
              AND pl.role IN ('owner','manager','head_coach')
          )
        )
    )
  $function$;

  -- Stand-in for the phone-key resolver (prod: mig 691's role templates).
  -- Same name, signature, DEFINER and EXECUTE; master holds every studio.
  CREATE TABLE public.test_phone_bookings (profile_id uuid, location_id uuid);
  REVOKE ALL ON public.test_phone_bookings FROM anon, authenticated;
  CREATE FUNCTION private.auth_mobile_can_location_ids(perm_key text)
   RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
  AS $function$
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master')
        THEN (SELECT array_agg(id) FROM public.locations)
      ELSE (SELECT array_agg(location_id) FROM public.test_phone_bookings
             WHERE profile_id = (SELECT auth.uid()) AND perm_key = 'bookings')
    END
  $function$;
  REVOKE ALL ON FUNCTION private.auth_is_manager_at(uuid), private.auth_mobile_can_location_ids(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_manager_at(uuid), private.auth_mobile_can_location_ids(text) TO authenticated, service_role;

  CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid REFERENCES public.locations (id),
    contact_id uuid REFERENCES public.contacts (id),
    status text NOT NULL DEFAULT 'confirmed',
    booking_date date NOT NULL DEFAULT '2026-10-10',
    skip_reminder boolean NOT NULL DEFAULT false,
    updated_at timestamptz DEFAULT '2000-01-01 00:00:00+00');
  CREATE TABLE public.booking_status_log (booking_id uuid, status text);
  REVOKE ALL ON public.booking_status_log FROM anon, authenticated;
  CREATE TABLE public.booking_reminder_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id uuid REFERENCES public.bookings (id) ON DELETE CASCADE);
  ALTER TABLE public.booking_reminder_sends ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "booking_reminder_sends readable" ON public.booking_reminder_sends FOR SELECT TO authenticated
    USING (private.auth_is_master() OR (EXISTS (SELECT 1 FROM bookings b
      WHERE b.id = booking_reminder_sends.booking_id AND private.auth_is_in_location(b.location_id))));

  -- Prod's three triggers: two SECURITY DEFINER (stand-ins that write a log
  -- row) and update_updated_at (INVOKER).
  CREATE FUNCTION public.handle_new_booking() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $t$
  BEGIN INSERT INTO public.booking_status_log VALUES (NEW.id, 'created'); RETURN NEW; END $t$;
  CREATE FUNCTION public.log_booking_status_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $t$
  BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN INSERT INTO public.booking_status_log VALUES (NEW.id, NEW.status); END IF;
    RETURN NEW;
  END $t$;
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $t$
  BEGIN NEW.updated_at := now(); RETURN NEW; END $t$;
  CREATE TRIGGER booking_created_trigger AFTER INSERT ON public.bookings
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_booking();
  CREATE TRIGGER booking_status_change_trigger AFTER UPDATE ON public.bookings
    FOR EACH ROW EXECUTE FUNCTION public.log_booking_status_change();
  CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON public.bookings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
`

// The 4 live policies (pg_policies, 2 Oct 2026), written so they deparse to prod's text.
const PHONE = `(location_id = ANY ((SELECT private.auth_mobile_can_location_ids('bookings'))::uuid[]))`
const POLICY_SQL = `
  CREATE POLICY bookings_select ON public.bookings FOR SELECT TO authenticated USING ${PHONE};
  CREATE POLICY bookings_insert ON public.bookings FOR INSERT TO authenticated WITH CHECK ${PHONE};
  CREATE POLICY bookings_update ON public.bookings FOR UPDATE TO authenticated USING ${PHONE} WITH CHECK ${PHONE};
  CREATE POLICY bookings_delete ON public.bookings FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));
`
// Prod text, verbatim.
const PROD_PHONE = "(location_id = ANY (( SELECT private.auth_mobile_can_location_ids('bookings'::text) AS auth_mobile_can_location_ids)::uuid[]))"
const prodRow = (policyname, cmd, qual, with_check) =>
  ({ tablename: 'bookings', policyname, permissive: 'PERMISSIVE', cmd, roles: '{authenticated}', qual, with_check })
const PROD_POLICIES = [
  prodRow('bookings_delete', 'DELETE', 'private.auth_is_manager_at(location_id)', null),
  prodRow('bookings_insert', 'INSERT', null, PROD_PHONE),
  prodRow('bookings_select', 'SELECT', PROD_PHONE, null),
  prodRow('bookings_update', 'UPDATE', PROD_PHONE, PROD_PHONE),
]

// Staff A and owner A hold the phone key at A; staff B at B. Bookings 1, 2 at A, 3 at B.
const SEED = `
  INSERT INTO public.test_phone_bookings VALUES
    ('${IDS.STAFF_A}', '${IDS.LOC_A}'), ('${IDS.OWNER_A}', '${IDS.LOC_A}'), ('${IDS.STAFF_B}', '${IDS.LOC_B}');
  INSERT INTO public.bookings (id, location_id, contact_id) VALUES
    ('${BK(1)}', '${IDS.LOC_A}', '${IDS.C_MEMBER}'), ('${BK(2)}', '${IDS.LOC_A}', '${IDS.C_MEMBER2}'),
    ('${BK(3)}', '${IDS.LOC_B}', '${IDS.C_B}');
  INSERT INTO public.booking_reminder_sends (booking_id) VALUES ('${BK(1)}'), ('${BK(3)}');
  DELETE FROM public.booking_status_log;
`
const baseSpec = { tables: TABLE_SQL, policies: POLICY_SQL, seed: SEED }

const ids = 'SELECT id::text FROM public.bookings ORDER BY id'
const INSERT_A = `INSERT INTO public.bookings (location_id) VALUES ('${IDS.LOC_A}') RETURNING id`
const UPDATE_1 = `UPDATE public.bookings SET status = 'cancelled', skip_reminder = true WHERE id = '${BK(1)}' RETURNING id`
const DELETE_2 = `DELETE FROM public.bookings WHERE id = '${BK(2)}' RETURNING id`

// The ROLLBACK record, taken from the file's own comment block (post-677 form).
const ROLLBACK = MIG.split('-- ROLLBACK (post-677 form; run as one transaction):\n')[1]
  .split('\n-- (The replay')[0]
  .split('\n').map((l) => l.replace(/^-- {0,3}/, '')).join('\n')

describe.each(PROD_STATES)('before 701: the holes (prod on 2 Oct 2026), $label', ({ after677 }) => {
  let db
  beforeAll(async () => { db = await boot({ ...baseSpec, after677 }) }, 120_000)
  afterAll(async () => { await db?.close() })

  it("the replay's 4 policies read exactly as prod's pg_policies", async () => {
    expect(await policiesOf(db, ['bookings'])).toEqual(PROD_POLICIES)
  })

  it("the client grants are the state's (default privileges, or 677's arwd for authenticated and nothing for anon)", async () => {
    const held = await clientPrivileges(db, 'bookings')
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(held).toContain(`authenticated:${p}`)
    expect(held.some((h) => h.startsWith('anon:'))).toBe(!after677)
  })

  it('staff with the phone key at A insert and rewrite bookings there past every route; not at B', async () => {
    expect(await asUser(db, IDS.STAFF_A, INSERT_A)).toHaveLength(1)
    expect(await asUser(db, IDS.STAFF_A, UPDATE_1)).toEqual([{ id: BK(1) }])
    expect(await asUser(db, IDS.STAFF_B, UPDATE_1)).toEqual([])
    await expect(asUser(db, IDS.STAFF_B, INSERT_A)).rejects.toThrow(rlsRefused('bookings'))
  })

  it('a manager deletes a booking outright; plain staff cannot; a member reaches nothing', async () => {
    expect(await asUser(db, IDS.OWNER_A, DELETE_2)).toEqual([{ id: BK(2) }])
    expect(await asUser(db, IDS.STAFF_A, DELETE_2)).toEqual([])
    expect(await asUser(db, IDS.MEMBER_UID, UPDATE_1)).toEqual([])
    expect(await asUser(db, IDS.MEMBER_UID, ids)).toEqual([])
  })
})

describe.each(PROD_STATES)('after 701, $label', ({ after677 }) => {
  let db
  beforeAll(async () => { db = await boot({ ...baseSpec, after677, migrate: [MIG] }) }, 120_000)
  afterAll(async () => { await db?.close() })

  it('the catalog: authenticated SELECT only, anon and PUBLIC nothing, RLS on, service_role DML', async () => {
    expect(await clientPrivileges(db, 'bookings')).toEqual(['authenticated:SELECT', 'authenticated:col-SELECT'])
    expect(await rlsOn(db, 'bookings')).toBe(true)
    expect(await serviceRoleDml(db, 'bookings')).toBe(true)
  })

  it('exactly bookings_select is left, byte-identical to prod', async () => {
    expect(await policiesOf(db, ['bookings'])).toEqual([PROD_POLICIES[2]])
  })

  it('staff, owner and master: every insert, update and delete is refused by the grant', async () => {
    for (const uid of [IDS.STAFF_A, IDS.OWNER_A, IDS.MASTER]) {
      await expect(asUser(db, uid, INSERT_A), uid).rejects.toThrow(denied('bookings'))
      await expect(asUser(db, uid, UPDATE_1), uid).rejects.toThrow(denied('bookings'))
      await expect(asUser(db, uid, DELETE_2), uid).rejects.toThrow(denied('bookings'))
    }
  })

  it('the phone read is unchanged: staff read their studio only, master all, a member none', async () => {
    expect(await asUser(db, IDS.STAFF_A, ids)).toEqual([{ id: BK(1) }, { id: BK(2) }])
    expect(await asUser(db, IDS.STAFF_B, ids)).toEqual([{ id: BK(3) }])
    expect(await asUser(db, IDS.MASTER, ids)).toHaveLength(3)
    expect(await asUser(db, IDS.MEMBER_UID, ids)).toEqual([])
  })

  it('anon: every read and write is refused by the grant', async () => {
    await expect(asRole(db, 'anon', ids)).rejects.toThrow(denied('bookings'))
    await expect(asRole(db, 'anon', INSERT_A)).rejects.toThrow(denied('bookings'))
  })

  it('booking_reminder_sends still reads (its policy reads bookings as the caller)', async () => {
    expect(await asUser(db, IDS.STAFF_A, 'SELECT count(*)::int AS n FROM public.booking_reminder_sends')).toEqual([{ n: 1 }])
  })

  it('service_role inserts, updates and deletes, and the triggers still fire', async () => {
    const rows = await asRole(db, 'service_role',
      INSERT_A, UPDATE_1, DELETE_2,
      `SELECT (SELECT count(*)::int FROM public.bookings) AS n,
              (SELECT updated_at > '2001-01-01' FROM public.bookings WHERE id = '${BK(1)}') AS touched,
              (SELECT array_agg(status ORDER BY status) FROM public.booking_status_log) AS log`)
    expect(rows).toEqual([{ n: 3, touched: true, log: ['cancelled', 'created'] }])
  })
})

describe.each(PROD_STATES)('the pre-check and self-check abort the whole file, $label', ({ after677 }) => {
  let db
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    db = await boot({ ...baseSpec, after677, before })
    expect(await abortMessage(db, MIG)).toMatch(message)
    // Nothing applied: the write policies and the write grant are still there.
    const names = (await policiesOf(db, ['bookings'])).map((p) => p.policyname)
    expect(names).toEqual(expect.arrayContaining(['bookings_insert', 'bookings_update']))
    expect(await clientPrivileges(db, 'bookings')).toContain('authenticated:UPDATE')
  }

  it('when bookings carries a policy the file does not know', () => expectAbort(
    'CREATE POLICY bookings_extra ON public.bookings FOR UPDATE TO authenticated USING (true);',
    /mig 701: public\.bookings carries a policy this file does not know .*bookings_extra UPDATE/,
  ), 120_000)

  it('when a known policy has other text than prod', () => expectAbort(
    `DROP POLICY bookings_delete ON public.bookings;
     CREATE POLICY bookings_delete ON public.bookings FOR DELETE TO authenticated USING (private.auth_is_in_location(location_id));`,
    /mig 701: public\.bookings carries a policy this file does not know .*bookings_delete DELETE/,
  ), 120_000)

  it('when bookings_select (the phone read) is missing', () => expectAbort(
    'DROP POLICY bookings_select ON public.bookings;',
    /mig 701: public\.bookings has no bookings_select/,
  ), 120_000)

  it("when another grantor's UPDATE to authenticated survives the REVOKE", async () => {
    db = await boot({ ...baseSpec, after677, before: `
      GRANT ALL ON public.bookings TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor; GRANT UPDATE ON public.bookings TO authenticated; RESET ROLE;` })
    expect(await abortMessage(db, MIG))
      .toMatch(/mig 701: (client roles hold more than authenticated SELECT on public\.bookings: authenticated:UPDATE \(from other_grantor\)|authenticated holds UPDATE on public\.bookings)/)
    expect((await policiesOf(db, ['bookings'])).map((p) => p.policyname)).toContain('bookings_insert')
  }, 120_000)

  it('when INSERT is inherited through role membership', async () => {
    db = await boot({ ...baseSpec, after677, before: 'GRANT INSERT ON public.bookings TO sneaky; GRANT sneaky TO authenticated;' })
    expect(await abortMessage(db, MIG)).toMatch(/mig 701: authenticated holds INSERT on public\.bookings/)
  }, 120_000)

  it("when another grantor's column-level UPDATE (status) survives", async () => {
    db = await boot({ ...baseSpec, after677, before: `
      GRANT UPDATE (status) ON public.bookings TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor; GRANT UPDATE (status) ON public.bookings TO authenticated; RESET ROLE;` })
    expect(await abortMessage(db, MIG))
      .toMatch(/mig 701: (client roles hold more than authenticated SELECT on public\.bookings|authenticated holds column-level UPDATE on public\.bookings)/)
  }, 120_000)

  it('when RLS is off', async () => {
    db = await boot({ ...baseSpec, after677, before: 'ALTER TABLE public.bookings DISABLE ROW LEVEL SECURITY;' })
    expect(await abortMessage(db, MIG)).toMatch(/mig 701: row level security is off on public\.bookings/)
  }, 120_000)

  it('when the file loses its authenticated REVOKE', async () => {
    db = await boot({ ...baseSpec, after677 })
    const mutated = MIG.replace(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE[^;]*;/, '')
    expect(mutated).not.toBe(MIG)
    expect(await abortMessage(db, mutated)).toMatch(/mig 701: client roles hold more than authenticated SELECT on public\.bookings: .*authenticated:UPDATE/)
  }, 120_000)

  it('when the file keeps bookings_delete', async () => {
    db = await boot({ ...baseSpec, after677 })
    const mutated = MIG.replace('DROP POLICY IF EXISTS bookings_delete ON public.bookings;', '')
    expect(mutated).not.toBe(MIG)
    expect(await abortMessage(db, mutated)).toMatch(/mig 701: public\.bookings should keep exactly one policy, bookings_select/)
  }, 120_000)
})

describe.each(PROD_STATES)('idempotent and reversible, $label', ({ after677 }) => {
  let db
  afterEach(async () => { await db?.close() })

  it('a second run passes the pre-check and its own self-check', async () => {
    db = await boot({ ...baseSpec, after677, migrate: [MIG] })
    expect(await abortMessage(db, MIG)).toBeNull()
    expect(await policiesOf(db, ['bookings'])).toEqual([PROD_POLICIES[2]])
  }, 120_000)

  if (after677) {
    it("the file's ROLLBACK record restores prod's 4 policies and grants exactly (and so the holes)", async () => {
      db = await boot({ ...baseSpec, after677 })
      const privsBefore = await clientPrivileges(db, 'bookings')
      expect(await abortMessage(db, MIG)).toBeNull()
      expect(ROLLBACK).toMatch(/^BEGIN;[\s\S]*COMMIT;\s*$/)
      expect(await abortMessage(db, ROLLBACK)).toBeNull()
      expect(await policiesOf(db, ['bookings'])).toEqual(PROD_POLICIES)
      expect(await clientPrivileges(db, 'bookings')).toEqual(privsBefore)
      expect(await asUser(db, IDS.STAFF_A, UPDATE_1)).toEqual([{ id: BK(1) }])
    }, 120_000)
  }
})
