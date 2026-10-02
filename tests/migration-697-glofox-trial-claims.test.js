// TRIALCLAIM.1 (C113) — behavioural test for migration 697.
//
// Models the tables the seed reads (locations, contacts,
// agent_membership_requests, glofox_push_events) with the client roles, runs
// the REAL 697 file in PGlite and proves:
//   * one live claim per (location, member): a second INSERT fails 23505 on
//     glofox_trial_claims_one_live; another member, another studio, or a
//     released claim does not conflict;
//   * the seed: actioned needs_credit_grant cards with no recorded grant, and
//     cards whose grant may have bought, by the grant's member id, else the
//     elected id, else the executing contact's link; mint 'created' push
//     events; never failed/expired cards, skips, refusals, other push
//     statuses or blank ids; one claim per pair, the earliest;
//   * service role only: RLS on, no policy, nothing for anon/authenticated;
//   * a rerun adds nothing; a wrong index under the name aborts; the rollback
//     record drops the table.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_697 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/697_glofox_trial_claims.sql'), 'utf8')
const ROLLBACK_697 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS public.glofox_trial_claims;
COMMIT;
`

const L1 = 'a0000000-0000-0000-0000-000000000001'
const L2 = 'a0000000-0000-0000-0000-000000000002'
const C1 = 'c0000000-0000-0000-0000-000000000001'
const C2 = 'c0000000-0000-0000-0000-000000000002'
const C3 = 'c0000000-0000-0000-0000-000000000003'
const req = (n) => `b0000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const evt = (n) => `e0000000-0000-0000-0000-${String(n).padStart(12, '0')}`

const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, glofox_member_id text);
  CREATE TABLE public.agent_membership_requests (
    id uuid PRIMARY KEY, location_id uuid NOT NULL, kind text NOT NULL, status text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb, contact_id uuid, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.glofox_push_events (
    id uuid PRIMARY KEY, location_id uuid, glofox_member_id text, status text NOT NULL, created_at timestamptz
  );
  INSERT INTO public.locations VALUES ('${L1}'), ('${L2}');
  INSERT INTO public.contacts VALUES ('${C1}', 'gm-linked'), ('${C2}', 'gm-exec'), ('${C3}', NULL);
`

// A card at L1, kind class_booking, reason needs_credit_grant unless overridden.
const card = (n, { status = 'actioned', details = {}, contact = C1, at = `2026-08-${String(n).padStart(2, '0')}T10:00:00Z`, loc = L1, kind = 'class_booking' } = {}) =>
  `INSERT INTO public.agent_membership_requests (id, location_id, kind, status, details, contact_id, created_at)
   VALUES ('${req(n)}', '${loc}', '${kind}', '${status}', '${JSON.stringify({ reason: 'needs_credit_grant', ...details })}'::jsonb, ${contact ? `'${contact}'` : 'NULL'}, '${at}');`
const push = (n, { member, status = 'created', loc = L1, at = `2026-07-${String(n).padStart(2, '0')}T10:00:00Z` }) =>
  `INSERT INTO public.glofox_push_events VALUES ('${evt(n)}', ${loc ? `'${loc}'` : 'NULL'}, ${member == null ? 'NULL' : `'${member}'`}, '${status}', '${at}');`

const run = (db, sql) => db['exec'](sql)
async function boot(extra = '') {
  const db = new PGlite()
  await run(db, SCHEMA)
  if (extra) await run(db, extra)
  return db
}
async function abortMessage(db, sql) {
  try {
    await run(db, sql)
    return null
  } catch (e) {
    await run(db, 'ROLLBACK;')
    return String(e.message || e)
  }
}
const claims = async (db) => (await db.query(
  `SELECT location_id, glofox_member_id, request_id, push_event_id, source, released_at
     FROM public.glofox_trial_claims ORDER BY location_id, glofox_member_id, claimed_at`)).rows
const claim = (loc, member, extra = '') =>
  `INSERT INTO public.glofox_trial_claims (location_id, glofox_member_id, source${extra ? ', request_id' : ''})
   VALUES ('${loc}', '${member}', 'approval'${extra ? `, '${extra}'` : ''})`

describe('migration 697 — glofox_trial_claims', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('one live claim per (location, member): the second insert fails 23505 on the index; others insert', async () => {
    db = await boot()
    expect(await abortMessage(db, MIG_697)).toBeNull()
    await db.query(claim(L1, 'gm-a'))
    let err
    try { await db.query(claim(L1, 'gm-a')) } catch (e) { err = e }
    expect(err?.code).toBe('23505')
    expect(String(err?.message)).toMatch(/glofox_trial_claims_one_live/)
    await db.query(claim(L1, 'gm-b'))
    await db.query(claim(L2, 'gm-a'))
    // A released claim no longer holds the pair.
    await db.query(`UPDATE public.glofox_trial_claims SET released_at = now(), release_reason = 'purchase_refused'
                     WHERE location_id = '${L1}' AND glofox_member_id = 'gm-a'`)
    await db.query(claim(L1, 'gm-a'))
    const live = (await db.query(`SELECT count(*)::int AS n FROM public.glofox_trial_claims WHERE released_at IS NULL`)).rows[0].n
    expect(live).toBe(3)
  })

  it('refuses a blank member, an unknown source, and a release without a reason', async () => {
    db = await boot()
    expect(await abortMessage(db, MIG_697)).toBeNull()
    await expect(db.query(claim(L1, '  '))).rejects.toThrow(/check constraint/)
    await expect(db.query(`INSERT INTO public.glofox_trial_claims (location_id, glofox_member_id, source) VALUES ('${L1}', 'gm-x', 'guess')`)).rejects.toThrow(/check constraint/)
    await expect(db.query(`INSERT INTO public.glofox_trial_claims (location_id, glofox_member_id, source, released_at) VALUES ('${L1}', 'gm-y', 'approval', now())`)).rejects.toThrow(/check constraint/)
  })

  it('seeds the trials already bought, earliest first, one per pair, and nothing else', async () => {
    db = await boot([
      // Fire-and-forget era: actioned, no recorded grant → member from the contact's link.
      card(1),
      // Elected account wins over the contact's link.
      card(2, { details: { elected_glofox_member_id: 'gm-elected' } }),
      // The executing contact (a sibling account) supplies the member.
      card(3, { contact: C3, details: { executing_contact_id: C2 } }),
      // A recorded grant that bought, with its own member id.
      card(4, { status: 'failed', details: { trial_grant: { ok: true, glofox_member_id: 'gm-granted' } } }),
      // A marker with no outcome, and an unknown outcome: may have bought.
      card(5, { status: 'approved', details: { trial_grant: { stage: 'purchasing', glofox_member_id: 'gm-marker' } } }),
      card(6, { status: 'failed', details: { trial_grant: { ok: false, outcome_unknown: true, glofox_member_id: 'gm-unknown' } } }),
      // Not seeded: a skip, a clear refusal, a failed card with no grant, an expired card, another kind.
      card(7, { details: { trial_grant: { ok: true, skipped: 'credits_present', glofox_member_id: 'gm-skip' } } }),
      card(8, { status: 'failed', details: { trial_grant: { ok: false, code: 'TRIAL_GRANT_FAILED', glofox_member_id: 'gm-refused' } } }),
      card(9, { status: 'failed', contact: C2 }),
      card(10, { status: 'expired', details: { elected_glofox_member_id: 'gm-expired' } }),
      card(11, { kind: 'cancellation', details: { elected_glofox_member_id: 'gm-cancel' } }),
      // No member resolvable: not seeded.
      card(12, { contact: C3 }),
      // A malformed executing_contact_id falls back to the card's contact.
      card(13, { loc: L2, details: { executing_contact_id: 'not-a-uuid' } }),
      // Mint rows: created → seeded; others not; blank / location-less not.
      push(1, { member: 'gm-mint' }),
      push(2, { member: 'gm-review', status: 'needs_review' }),
      push(3, { member: '   ' }),
      push(4, { member: 'gm-noloc', loc: null }),
      // The same pair from the mint (earlier) and a card (later): one claim, the mint's.
      push(5, { member: 'gm-elected', at: '2026-07-30T10:00:00Z' }),
    ].join('\n'))
    expect(await abortMessage(db, MIG_697)).toBeNull()
    expect(await claims(db)).toEqual([
      { location_id: L1, glofox_member_id: 'gm-elected', request_id: null, push_event_id: evt(5), source: 'mint_backfill', released_at: null },
      { location_id: L1, glofox_member_id: 'gm-exec', request_id: req(3), push_event_id: null, source: 'approval_backfill', released_at: null },
      { location_id: L1, glofox_member_id: 'gm-granted', request_id: req(4), push_event_id: null, source: 'approval_backfill', released_at: null },
      { location_id: L1, glofox_member_id: 'gm-linked', request_id: req(1), push_event_id: null, source: 'approval_backfill', released_at: null },
      { location_id: L1, glofox_member_id: 'gm-marker', request_id: req(5), push_event_id: null, source: 'approval_backfill', released_at: null },
      { location_id: L1, glofox_member_id: 'gm-mint', request_id: null, push_event_id: evt(1), source: 'mint_backfill', released_at: null },
      { location_id: L1, glofox_member_id: 'gm-unknown', request_id: req(6), push_event_id: null, source: 'approval_backfill', released_at: null },
      { location_id: L2, glofox_member_id: 'gm-linked', request_id: req(13), push_event_id: null, source: 'approval_backfill', released_at: null },
    ])
  })

  it('is service role only: RLS on, no policy, nothing for anon or authenticated', async () => {
    db = await boot()
    expect(await abortMessage(db, MIG_697)).toBeNull()
    const { rows: [t] } = await db.query(`SELECT relrowsecurity AS rls, relacl::text AS acl FROM pg_class WHERE oid = 'public.glofox_trial_claims'::regclass`)
    expect(t.rls).toBe(true)
    expect(t.acl).not.toMatch(/(^|[{,])(anon|authenticated)=/)
    expect(t.acl).toMatch(/service_role=arw\//)
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = 'public.glofox_trial_claims'::regclass`)).rows[0].n).toBe(0)
  })

  it('a second run adds nothing; the rollback record removes the table', async () => {
    db = await boot([card(1), push(1, { member: 'gm-mint' })].join('\n'))
    expect(await abortMessage(db, MIG_697)).toBeNull()
    const once = await claims(db)
    expect(once).toHaveLength(2)
    expect(await abortMessage(db, MIG_697)).toBeNull()
    expect(await claims(db)).toEqual(once)
    expect(await abortMessage(db, ROLLBACK_697)).toBeNull()
    expect((await db.query(`SELECT to_regclass('public.glofox_trial_claims') AS t`)).rows[0].t).toBeNull()
  })

  it('aborts WHOLE when an index already holds the name with another definition', async () => {
    db = await boot(`
      CREATE TABLE public.glofox_trial_claims (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, glofox_member_id text NOT NULL,
        request_id uuid, push_event_id uuid, source text NOT NULL, claimed_at timestamptz NOT NULL DEFAULT now(),
        released_at timestamptz, release_reason text);
      CREATE UNIQUE INDEX glofox_trial_claims_one_live ON public.glofox_trial_claims (location_id, glofox_member_id);
    ` + card(1))
    expect(await abortMessage(db, MIG_697)).toMatch(/mig 697: glofox_trial_claims_one_live is not a valid unique index/)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.glofox_trial_claims`)).rows[0].n).toBe(0)
  })

  it('aborts before anything when a table it reads is missing', async () => {
    db = new PGlite()
    await run(db, `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`)
    expect(await abortMessage(db, MIG_697)).toMatch(/mig 697: locations, agent_membership_requests, glofox_push_events and contacts must exist/)
    expect((await db.query(`SELECT to_regclass('public.glofox_trial_claims') AS t`)).rows[0].t).toBeNull()
  })
})
