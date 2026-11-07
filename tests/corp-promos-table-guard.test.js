// WAYSIN.1 (mig 816) guard: the corp_promos table is closed to every client
// session, seeds exactly today's two promos, and the one-live-Glofox-claim
// index keys on corp_promo_claims.platform instead of naming a promo key.
// Reads the migration TEXT (the controller applies it; the file's own DO
// block checks the post-state in the catalog). A floor, not a proof.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { CORP_PROMOS } from '../src/lib/corp-promos.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const FILE = path.join(ROOT, 'supabase/migrations/816_corp_promos.sql')

// Line comments out, so a mention in the header never satisfies a check.
const code = () => readFileSync(FILE, 'utf8').replace(/--[^\n]*/g, '')

/** The statement starting at the first match of `re`, up to its `;`. */
function statement(sql, re) {
  const m = sql.match(re)
  if (!m) return null
  const end = sql.indexOf(';', m.index)
  return sql.slice(m.index, end === -1 ? undefined : end + 1)
}

describe('mig 816 corp_promos', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('creates the table, RLS on, no policy, closed to anon and authenticated', () => {
    const sql = code()
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.corp_promos\s*\(/)
    expect(sql).toMatch(/ALTER TABLE public\.corp_promos ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/REVOKE ALL ON public\.corp_promos FROM anon, authenticated/)
    expect(sql).not.toMatch(/CREATE POLICY[^;]*\bON\s+(?:public\.)?corp_promos\b/i)
    expect(sql).not.toMatch(/GRANT[^;]*\bON\s+(?:TABLE\s+)?(?:public\.)?corp_promos\b[^;]*\bTO\s+(?:anon|authenticated|PUBLIC)/i)
  })

  it('pins the key shape, the platform list, the ranges, the uniqueness and the Glofox binding', () => {
    const create = statement(code(), /CREATE TABLE IF NOT EXISTS public\.corp_promos/)
    expect(create).toContain("key ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'")
    expect(create).toMatch(/platform IN \('un1t_online', 'glofox'\)/)
    expect(create).toMatch(/credits BETWEEN 1 AND 50/)
    expect(create).toMatch(/expires_in_days BETWEEN 1 AND 365/)
    expect(create).toMatch(/UNIQUE \(location_id, key\)/)
    expect(create).toMatch(/platform <> 'glofox'[\s\S]*glofox_membership_id IS NOT NULL[\s\S]*glofox_plan_code IS NOT NULL[\s\S]*glofox_plan_name IS NOT NULL/)
  })

  it('seeds exactly the two registry promos, by studio name', () => {
    const sql = code()
    const seeded = [...sql.matchAll(/INSERT INTO public\.corp_promos/g)]
    expect(seeded.length).toBe(1)
    for (const key of Object.keys(CORP_PROMOS)) expect(sql).toContain(`'${key}'`)
    expect(Object.keys(CORP_PROMOS).sort()).toEqual(['hatch-3-free', 'stillorgan-newstart'])
    expect(sql).toContain("'UN1T Hatch Street'")
    expect(sql).toContain("'UN1T Stillorgan'")
    // The Stillorgan plan ids of src/lib/corp-promo-glofox-plans.js.
    expect(sql).toContain("'6aec95d590a936f18c065d9f'")
    expect(sql).toContain("'1793889679121'")
    expect(sql).toContain("'New Start Free Trial'")
  })

  it('adds and backfills corp_promo_claims.platform', () => {
    const sql = code()
    expect(sql).toMatch(/ALTER TABLE public\.corp_promo_claims\s+ADD COLUMN IF NOT EXISTS platform text/)
    expect(sql).toMatch(/UPDATE public\.corp_promo_claims[\s\S]*platform/)
  })

  it('rebuilds the one-live index on platform, naming no promo key, statuses as mig 811', () => {
    const idx = statement(code(), /CREATE UNIQUE INDEX corp_promo_claims_one_live_per_contact/)
    expect(idx).not.toBeNull()
    expect(idx).not.toContain("'stillorgan-newstart'")
    expect(idx).not.toContain("'hatch-3-free'")
    expect(idx).toMatch(/status IN \('processing', 'granted', 'help_requested', 'handled'\)/)
    expect(idx).toMatch(/platform = 'glofox'/)
  })

  it('attaches the audit trigger and is listed as audited', async () => {
    const sql = code()
    expect(sql).toMatch(/CREATE TRIGGER audit_mutation AFTER INSERT OR UPDATE OR DELETE ON public\.corp_promos\s+FOR EACH ROW EXECUTE FUNCTION private\.log_mutation\('id', 'created_by'\)/)
    const { AUDITED_TABLES } = await import('./helpers/audit-secret-keys.js')
    expect(AUDITED_TABLES).toContain('corp_promos')
  })
})
