// CORPPROMO.1 — mig 787: the promo_grant ledger op and the claims table.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/787_corp_promo.sql'), 'utf8')
const squash = (s) => s.replace(/\s+/g, ' ')

describe('mig 787 corp promo', () => {
  const s = squash(sql)

  it('admits op promo_grant and keeps every earlier op', () => {
    expect(s).toContain("CHECK (op IN ('create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout', 'trial_regrant', 'fee_charge', 'move', 'promo_grant'))")
  })

  it('admits origin corp_promo and keeps every earlier origin', () => {
    expect(s).toContain("CHECK (origin IN ('staff', 'funnel', 'approval', 'mia', 'test_account', 'web_trial', 'fee_run', 'corp_promo'))")
  })

  it('a promo_grant row names its person and promo, once per person and promo', () => {
    expect(s).toContain("CHECK (op <> 'promo_grant' OR (un1t_user_id IS NOT NULL AND target IS NOT NULL))")
    expect(s).toContain("CREATE UNIQUE INDEX IF NOT EXISTS un1t_write_events_one_promo_grant ON public.un1t_write_events (location_id, un1t_user_id, target) WHERE op = 'promo_grant' AND stage IN ('done', 'sent', 'unknown')")
  })

  it('corp_promo_claims is service-role only, one granted claim per contact and promo', () => {
    expect(s).toContain('CREATE TABLE IF NOT EXISTS public.corp_promo_claims')
    expect(s).toContain('ALTER TABLE public.corp_promo_claims ENABLE ROW LEVEL SECURITY')
    expect(s).toContain('REVOKE ALL ON public.corp_promo_claims FROM anon, authenticated, PUBLIC')
    expect(s).not.toMatch(/CREATE POLICY/i)
    expect(s).toContain("ON public.corp_promo_claims (location_id, contact_id, promo_key) WHERE status = 'granted'")
  })

  it('checks its post-state from the catalog', () => {
    expect(s).toContain('DO $$')
    expect(s).toContain('information_schema.table_privileges')
  })
})
