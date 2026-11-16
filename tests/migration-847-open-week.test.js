// OPENWEEK.1 — mig 847: open week promos and the classes a claim picked.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FILE = join(process.cwd(), 'supabase/migrations/847_open_week_promos.sql')
const sql = () => readFileSync(FILE, 'utf8')
// Comments out, whitespace squashed: a comment never satisfies a check.
const code = () => sql().replace(/--[^\n]*/g, '').replace(/\s+/g, ' ')

describe('mig 847 open week promos', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true)
  })

  it('adds the kind, the window and the limits to corp_promos', () => {
    const s = code()
    expect(s).toContain("ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'promo'")
    expect(s).toContain("CHECK (kind IN ('promo', 'open_week'))")
    expect(s).toContain('ADD COLUMN IF NOT EXISTS window_starts_on date')
    expect(s).toContain('ADD COLUMN IF NOT EXISTS window_ends_on date')
    expect(s).toContain('ADD COLUMN IF NOT EXISTS max_classes integer')
    expect(s).toContain('CHECK (max_classes IS NULL OR max_classes BETWEEN 1 AND 20)')
    expect(s).toContain('ADD COLUMN IF NOT EXISTS max_per_day integer')
    expect(s).toContain('CHECK (max_per_day IS NULL OR max_per_day BETWEEN 1 AND 5)')
    expect(s).toContain("CHECK (kind <> 'open_week' OR (window_starts_on IS NOT NULL AND window_ends_on IS NOT NULL AND window_ends_on >= window_starts_on AND max_classes IS NOT NULL AND max_per_day IS NOT NULL))")
  })

  it('creates corp_promo_claim_classes, service-role only, one row per claim and class', () => {
    const s = code()
    expect(s).toContain('CREATE TABLE IF NOT EXISTS public.corp_promo_claim_classes')
    expect(s).toContain('claim_id uuid NOT NULL REFERENCES public.corp_promo_claims(id) ON DELETE CASCADE')
    expect(s).toContain('UNIQUE (claim_id, class_event_id)')
    expect(s).toContain('ALTER TABLE public.corp_promo_claim_classes ENABLE ROW LEVEL SECURITY')
    expect(s).toContain('REVOKE ALL ON public.corp_promo_claim_classes FROM anon, authenticated')
    expect(s).not.toMatch(/CREATE POLICY/i)
  })

  it('seeds the Hatch open week promo switched off, by studio name', () => {
    const s = code()
    expect(s).toContain("WHERE name = 'UN1T Hatch Street'")
    expect(s).toContain('RAISE EXCEPTION')
    expect(s).toMatch(/\(hatch, 'hatch-open-week', 'Open Week \(Hatch Street\)', 'un1t_online', 5, 14, false, 'hatch-open-week', 'corp_promo', 'open_week', '2026-11-23', '2026-11-30', 5, 1\)/)
    expect(s).toContain('ON CONFLICT (location_id, key) DO NOTHING')
  })

  it('checks its post-state from the catalog', () => {
    const s = code()
    expect(s).toContain('information_schema.table_privileges')
  })
})
