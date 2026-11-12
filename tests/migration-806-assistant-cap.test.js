// ASSISTCAP.1 — pin the PARTITION in the repo, not just in prod.
//
// mig 421's org_ai_spend_month_cents excludes source 'assistant_chat';
// mig 806's org_assistant_spend_month_cents is only it. Together they cover
// the anthropic_tokens ledger exactly once. The failure this guards is a
// plausible future "simplification": someone copies one body to the other and
// flips or drops the source predicate, at which point either the assistant's
// spend is counted against Mia's cap (so staff can pause customer replies) or
// a row is counted twice. Neither shows up in a unit test of the JS, because
// the JS just calls an rpc by name.
//
// Reading the migration TEXT is the right level here: these are SQL bodies
// with no JS to exercise, and the live-DB equivalent already ran as the
// migration's own self-check when it was applied.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const read = (name) => readFileSync(join(MIGRATIONS, name), 'utf8')

function bodyOf(sql, fnName) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`)
  expect(start, `${fnName} not found`).toBeGreaterThan(-1)
  const open = sql.indexOf('AS $$', start)
  const close = sql.indexOf('$$;', open)
  expect(open).toBeGreaterThan(-1)
  expect(close).toBeGreaterThan(open)
  return sql.slice(open, close)
}

const MIG_806 = (() => {
  const f = readdirSync(MIGRATIONS).find((n) => n.startsWith('806_'))
  expect(f, 'migration 806 missing').toBeTruthy()
  return read(f)
})()

const MIG_421 = read('421_usage_rollup_and_caps.sql')

describe('migration 806 — the assistant spend function', () => {
  const body = () => bodyOf(MIG_806, 'org_assistant_spend_month_cents')

  it('sums ONLY source assistant_chat', () => {
    expect(body()).toMatch(/ue\.source\s*=\s*'assistant_chat'/)
    expect(body()).not.toMatch(/ue\.source\s*<>\s*'assistant_chat'/)
  })

  it('still partitions against 421, which must keep EXCLUDING assistant_chat', () => {
    const ai = bodyOf(MIG_421, 'org_ai_spend_month_cents')
    expect(ai).toMatch(/ue\.source\s*<>\s*'assistant_chat'/)
    expect(ai).not.toMatch(/ue\.source\s*=\s*'assistant_chat'/)
  })

  it('attributes a row with only a location_id to its org, like its sibling', () => {
    // /api/assistant/chat records usage with locationId and no organizationId,
    // so without the COALESCE every assistant row would be invisible and the
    // cap could never trip.
    expect(body()).toMatch(/COALESCE\(ue\.organization_id,\s*l\.organization_id\)/)
    expect(body()).toMatch(/LEFT JOIN locations l/)
  })

  it('uses the same meter and the platform billing calendar as its sibling', () => {
    expect(body()).toMatch(/ue\.meter\s*=\s*'anthropic_tokens'/)
    expect(body()).toMatch(/AT TIME ZONE 'Europe\/Dublin'/)
  })

  it('is SECURITY INVOKER with a pinned search_path, and service_role only', () => {
    expect(MIG_806).toMatch(/SECURITY INVOKER/)
    expect(MIG_806).toMatch(/SET search_path = public, pg_temp/)
    expect(MIG_806).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.org_assistant_spend_month_cents\(uuid, date\) FROM PUBLIC, anon, authenticated;/,
    )
    expect(MIG_806).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.org_assistant_spend_month_cents\(uuid, date\) TO service_role;/,
    )
  })
})

describe('migration 806 — the two new org_settings columns', () => {
  it('adds the cap with a positive CHECK and no default, so shipping changes nothing', () => {
    expect(MIG_806).toMatch(/ADD COLUMN assistant_hard_cap_cents NUMERIC/)
    expect(MIG_806).toMatch(/assistant_hard_cap_cents IS NULL OR assistant_hard_cap_cents > 0/)
    // NULL = no cap is the shipped default; a DEFAULT would cap every org at once.
    expect(MIG_806).not.toMatch(/assistant_hard_cap_cents NUMERIC[^;]*DEFAULT/)
  })

  it('gives the assistant cap its OWN notice month', () => {
    // Sharing ai_cap_notice_month would mean only whichever cap crossed 80%
    // first in a month ever emailed anyone.
    expect(MIG_806).toMatch(/ADD COLUMN assistant_cap_notice_month TEXT/)
    expect(MIG_806).toMatch(/assistant_cap_notice_month ~ '\^\\d\{4\}-\\d\{2\}\$'/)
  })

  it('states the column-grant decision, as a new column on org_settings must', () => {
    expect(MIG_806).toMatch(/column-grant:/)
  })
})
