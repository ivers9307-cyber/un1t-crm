// GAPS-P1.1 — shape guard for migration 511 (contacts.last_email_open_at /
// last_email_click_at).
//
// WHY THIS FILE EXISTS
// ────────────────────
// Three places in the app drove contacts.last_email_open_at — the inactivity
// cron's signal whitelist, the SequenceSettings dropdown, and BOTH packaged
// win-back templates — while the column did not exist on public.contacts (live
// information_schema query, 2026-08-09). Nothing caught it: mocked tests and
// `next build` cannot see a missing column. This migration makes the column
// real; these assertions pin the parts that are load-bearing and cheap to lose
// on a rebase.
//
// The property this file cares about most is AGREEMENT. The backfill takes
// max(opened_at) per contact from email_sends; the webhook then stamps the same
// quantity on every Open. Those only stay the same quantity if neither side can
// ever move the stamp BACKWARDS — a stamp that regressed would make "opened in
// the last 30 days" quietly wrong, which is the exact silent class this
// programme keeps finding. Hence: GREATEST in the backfill, and a monotonic
// predicate inside each stamp RPC.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const FILE = path.resolve(
  import.meta.dirname,
  '../supabase/migrations/511_contact_email_engagement_stamps.sql',
)

// Structural assertions run against the STATEMENTS, not the prose — the header
// above discusses the very shapes being asserted. `COMMENT ON` is a statement,
// not a `--` comment, so it survives stripping.
const sql = existsSync(FILE)
  ? readFileSync(FILE, 'utf8').replace(/--[^\n]*/g, '').toLowerCase()
  : ''

describe('migration 511 — contact email engagement stamps', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('adds both timestamptz columns to contacts', () => {
    expect(sql).toMatch(/alter table (public\.)?contacts/)
    expect(sql).toMatch(/add column if not exists last_email_open_at\s+timestamptz/)
    expect(sql).toMatch(/add column if not exists last_email_click_at\s+timestamptz/)
  })

  it('indexes both columns', () => {
    expect(sql).toMatch(/create index if not exists \S+\s+on public\.contacts \(last_email_open_at\)/)
    expect(sql).toMatch(/create index if not exists \S+\s+on public\.contacts \(last_email_click_at\)/)
  })

  it('comments both columns', () => {
    expect(sql).toMatch(/comment on column public\.contacts\.last_email_open_at is/)
    expect(sql).toMatch(/comment on column public\.contacts\.last_email_click_at is/)
  })

  // The maintenance side. Arg names are load-bearing: PostgREST resolves rpc
  // arguments BY NAME, so these must match the processor's call sites verbatim.
  it('creates a stamp RPC per column taking the event timestamp', () => {
    expect(sql).toMatch(
      /create or replace function public\.stamp_contact_email_open\(p_contact_id uuid, p_at timestamptz\)/,
    )
    expect(sql).toMatch(
      /create or replace function public\.stamp_contact_email_click\(p_contact_id uuid, p_at timestamptz\)/,
    )
    expect(sql).toMatch(/set search_path = ''/)
  })

  // THE NEVER-MOVE-BACKWARDS GUARD. A replayed or late-arriving Postmark event
  // carrying an older timestamp, or two Open events racing on the same contact,
  // must not regress the stamp.
  it('guards each stamp so it can only move forwards', () => {
    expect(sql).toMatch(
      /set last_email_open_at = p_at\s+where id = p_contact_id\s+and \(last_email_open_at is null or last_email_open_at < p_at\)/,
    )
    expect(sql).toMatch(
      /set last_email_click_at = p_at\s+where id = p_contact_id\s+and \(last_email_click_at is null or last_email_click_at < p_at\)/,
    )
  })

  // Same rule as mig 508's counter RPCs: nothing web-facing moves engagement
  // state, and Postgres grants EXECUTE to PUBLIC by default.
  it('locks both RPCs down to service_role', () => {
    for (const fn of ['stamp_contact_email_open', 'stamp_contact_email_click']) {
      expect(sql).toMatch(
        new RegExp(`revoke execute on function public\\.${fn}\\(uuid, timestamptz\\)\\s+from public, anon, authenticated`),
      )
      expect(sql).toMatch(
        new RegExp(`grant\\s+execute on function public\\.${fn}\\(uuid, timestamptz\\)\\s+to service_role`),
      )
    }
  })

  // The backfill must compute the SAME quantity the webhook maintains:
  // max(opened_at) / max(clicked_at) per contact off email_sends.
  it('backfills from email_sends with max() per contact', () => {
    expect(sql).toMatch(/max\(opened_at\)/)
    expect(sql).toMatch(/max\(clicked_at\)/)
    expect(sql).toMatch(/from public\.email_sends/)
    expect(sql).toMatch(/where contact_id is not null/)
    expect(sql).toMatch(/group by contact_id/)
  })

  // GREATEST ignores NULLs in Postgres, so this is the backfill's own
  // never-backwards guard — it can only ever advance an existing stamp. It is
  // a no-op on a virgin column and stays correct if the migration is re-run
  // after the webhook has already started stamping.
  it('never lets the backfill move an existing stamp backwards', () => {
    expect(sql).toMatch(/greatest\(c\.last_email_open_at, agg\.last_open\)/)
    expect(sql).toMatch(/greatest\(c\.last_email_click_at, agg\.last_click\)/)
  })
})
