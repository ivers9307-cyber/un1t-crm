// POLICYATOMIC.1 — behavioural test for migration 841 (October audit A10, A23).
// Boots PGlite with the live shape of policies / policy_versions / policy_views
// (columns and indexes read 15 Nov 2026) and runs the REAL file. Fictional ids.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/841_policy_publish_and_view_end_atomic.sql'), 'utf8')

const POL = 'a0000000-0000-0000-0000-000000000001'
const POL2 = 'a0000000-0000-0000-0000-000000000002'
const V1 = 'b0000000-0000-0000-0000-000000000001'
const VIEW = 'c0000000-0000-0000-0000-000000000001'
const ME = 'd0000000-0000-0000-0000-000000000001'
const OTHER = 'd0000000-0000-0000-0000-000000000002'

const BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE TABLE public.policies (id uuid PRIMARY KEY, slug text);
  CREATE TABLE public.policy_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id uuid NOT NULL REFERENCES public.policies(id),
    version_number integer NOT NULL,
    body_markdown text NOT NULL,
    change_summary text,
    effective_date date NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    published_by uuid,
    is_current boolean NOT NULL DEFAULT true
  );
  CREATE UNIQUE INDEX policy_versions_policy_version_unique ON public.policy_versions (policy_id, version_number);
  CREATE UNIQUE INDEX policy_versions_one_current_per_policy_idx ON public.policy_versions (policy_id) WHERE is_current = true;
  CREATE TABLE public.policy_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_version_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    total_duration_seconds integer,
    section_dwell jsonb
  );
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
  INSERT INTO public.policies VALUES ('${POL}', 'aup'), ('${POL2}', 'other');
  INSERT INTO public.policy_versions (id, policy_id, version_number, body_markdown, effective_date)
    VALUES ('${V1}', '${POL}', 1, 'v1', '2026-01-01');
  INSERT INTO public.policy_views (id, policy_version_id, profile_id) VALUES ('${VIEW}', '${V1}', '${ME}');
`

let db
const run = (sql) => db['exec'](sql)
const publish = (policy, body, date = '2026-11-15') => db.query(
  'SELECT * FROM public.publish_policy_version($1::uuid, $2, $3, $4::date, $5::uuid)', [policy, body, 'note', date, ME])
const current = async (policy = POL) => (await db.query(
  'SELECT version_number, body_markdown FROM public.policy_versions WHERE policy_id = $1 AND is_current', [policy])).rows
const viewEnd = (dur, dwell, who = ME) => db.query(
  'SELECT * FROM public.record_policy_view_end($1::uuid, $2::uuid, $3::integer, $4::jsonb)',
  [VIEW, who, dur, dwell == null ? null : JSON.stringify(dwell)])
const view = async () => (await db.query('SELECT total_duration_seconds, section_dwell, ended_at FROM public.policy_views WHERE id = $1', [VIEW])).rows[0]

beforeEach(async () => {
  db = new PGlite()
  await run(BASE)
  await run(MIG)
})
afterEach(async () => { await db.close() })

describe('841 — publish_policy_version (A10)', () => {
  it('publishes the next version as the only current one', async () => {
    const { rows } = await publish(POL, 'v2')
    expect(rows[0].version_number).toBe(2)
    expect(await current()).toEqual([{ version_number: 2, body_markdown: 'v2' }])
    const old = (await db.query('SELECT is_current FROM public.policy_versions WHERE id = $1', [V1])).rows[0]
    expect(old.is_current).toBe(false)
  })

  it('a failed insert leaves the old version current', async () => {
    // body_markdown is NOT NULL: the insert fails after the old current was cleared in the same transaction.
    await expect(publish(POL, null)).rejects.toThrow()
    expect(await current()).toEqual([{ version_number: 1, body_markdown: 'v1' }])
  })

  it('an impossible date is refused with the old version still current', async () => {
    await expect(publish(POL, 'v2', '2026-02-30')).rejects.toThrow()
    expect(await current()).toEqual([{ version_number: 1, body_markdown: 'v1' }])
  })

  it('an unknown policy is refused', async () => {
    await expect(publish('a0000000-0000-0000-0000-00000000dead', 'x')).rejects.toThrow(/not found/)
  })

  it('a first version of a policy with none is number 1', async () => {
    const { rows } = await publish(POL2, 'first')
    expect(rows[0].version_number).toBe(1)
  })
})

describe('841 — record_policy_view_end (A23)', () => {
  it('a shorter reading arriving last never lowers the stored one', async () => {
    await viewEnd(60, { Intro: 40 })
    await viewEnd(30, { Intro: 10 })
    expect(await view()).toMatchObject({ total_duration_seconds: 60, section_dwell: { Intro: 40 } })
  })

  it('section times merge, keeping the larger per section', async () => {
    await viewEnd(20, { Intro: 15, Pay: 5 })
    await viewEnd(25, { Pay: 9, Leave: 3 })
    expect((await view()).section_dwell).toEqual({ Intro: 15, Pay: 9, Leave: 3 })
  })

  it('a request with no section times keeps the stored ones', async () => {
    await viewEnd(20, { Intro: 15 })
    await viewEnd(40, null)
    await viewEnd(45, {})
    expect(await view()).toMatchObject({ total_duration_seconds: 45, section_dwell: { Intro: 15 } })
  })

  it("another person's call changes nothing and returns no row", async () => {
    const { rows } = await viewEnd(99, { Intro: 99 }, OTHER)
    expect(rows).toHaveLength(0)
    expect(await view()).toMatchObject({ total_duration_seconds: null, ended_at: null })
  })

  it('stamps ended_at and returns the row', async () => {
    const { rows } = await viewEnd(12, null)
    expect(rows[0].total_duration_seconds).toBe(12)
    expect(rows[0].ended_at).toBeTruthy()
  })
})

describe('841 — privileges', () => {
  it('both functions are SECURITY INVOKER and service_role only', async () => {
    for (const f of ['public.publish_policy_version(uuid, text, text, date, uuid)', 'public.record_policy_view_end(uuid, uuid, integer, jsonb)']) {
      const { rows } = await db.query('SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure', [f])
      expect(rows[0].prosecdef).toBe(false)
      for (const role of ['anon', 'authenticated']) {
        const { rows: r } = await db.query('SELECT has_function_privilege($1, $2, \'EXECUTE\') AS h', [role, f])
        expect(r[0].h).toBe(false)
      }
    }
  })
})
