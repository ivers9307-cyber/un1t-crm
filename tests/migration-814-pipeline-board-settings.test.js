// PIPEBUILD.2a — migration 814: board settings, stage roles, follow-up links.
// Reads the SQL text (no DB), like the other migration text tests.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const FILE = path.resolve(import.meta.dirname, '../supabase/migrations/814_pipeline_board_settings_stage_roles.sql')
const raw = () => readFileSync(FILE, 'utf8')
const sql = () => sqlCode(raw())

const ROLES = ['new', 'first_class', 'class_n', 'checkpoint', 'done', 'converted', 'pile', 'custom']

// The UPDATE statement that sets a role, as one string.
function updateFor(role) {
  const re = new RegExp(`UPDATE public\\.pipeline_stages SET stage_role = '${role}'[^;]*;`, 'g')
  return (sql().match(re) || []).join('\n')
}

describe('migration 814', () => {
  it('addsBoardSettingsColumns', () => {
    const s = sql()
    for (const col of [
      'board_type text',
      'recipe_key text',
      "config jsonb NOT NULL DEFAULT '{}'",
      'priority integer NOT NULL DEFAULT 100',
      'created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL',
      'updated_at timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(s).toContain(`ADD COLUMN IF NOT EXISTS ${col}`)
    }
    expect(s).toContain('pipelines_board_type_module_chk')
    expect(s).toContain("module IN ('offer', 'offer_un1t')")
    expect(s).toContain('pipelines_board_type_chk')
    expect(s).toContain("board_type IN ('offer')")
    expect(raw()).toContain('-- grant: pipelines/pipeline_stages columns ride their existing table-level grants')
    expect(raw()).toContain('-- column-grant: n/a')
  })

  it('checkConstraintBoundsRoles', () => {
    const s = sql()
    const m = s.match(/pipeline_stages_stage_role_chk\s+CHECK \(stage_role IN \(([^)]*)\)\)/)
    expect(m).not.toBeNull()
    const listed = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
    expect(listed.sort()).toEqual([...ROLES].sort())
    expect(s).toContain("stage_role text NOT NULL DEFAULT 'custom'")
    expect(s).toContain("jsonb_typeof(role_config) = 'object'")
    expect(s).toContain('pipeline_stages_role_config_chk')
  })

  it('backfillsKnownSlugs', () => {
    const groups = {
      new: ['new_lead', 'paid_trial_new_lead', 'programme_lead', 'waitlist_new_enquiry', 'returning_booked'],
      first_class: ['first_class', 'paid_trial_first_class', 'programme_first_class', 'returning_first_class'],
      class_n: ['second_class', 'returning_second_class'],
      checkpoint: ['paid_trial_day_7'],
      done: ['trial_done', 'paid_trial_done', 'returning_final_class'],
      converted: ['converted', 'paid_trial_converted', 'programme_converted', 'waitlist_converted'],
      pile: ['member', 'pack_member', 'classpass', 'gympass', 'cold_lead', 'dormant'],
    }
    for (const [role, slugs] of Object.entries(groups)) {
      const u = updateFor(role)
      expect(u, role).not.toBe('')
      for (const slug of slugs) expect(u, `${role}:${slug}`).toContain(`'${slug}'`)
    }
    expect(updateFor('class_n')).toContain('"count":2')
    expect(updateFor('checkpoint')).toContain('"day":7')
    expect(sql()).not.toMatch(/slug IN \([^)]*'rebook'/)
  })

  it('backfillsUnknownSlugsSafely', () => {
    const s = sql()
    expect(s).toMatch(/SET stage_role = 'pile'\s+WHERE stage_role = 'custom' AND is_dormant = true/)
    // every slug backfill is scoped to rows still 'custom'
    for (const role of ROLES.filter((r) => r !== 'custom')) {
      const u = updateFor(role)
      if (u) expect(u).toContain("stage_role = 'custom'")
    }
    expect(s).toContain("stage_role text NOT NULL DEFAULT 'custom'")
  })

  it('followupsTableClosedToClients', () => {
    const s = sql()
    expect(s).toContain('CREATE TABLE IF NOT EXISTS public.pipeline_stage_followups')
    expect(s).toContain('ALTER TABLE public.pipeline_stage_followups ENABLE ROW LEVEL SECURITY')
    expect(s).toContain('REVOKE ALL ON public.pipeline_stage_followups FROM anon, authenticated')
    expect(s).not.toMatch(/CREATE POLICY/i)
    expect(s).toContain("CHECK (state IN ('draft', 'awaiting_approval', 'live', 'rejected', 'off'))")
    expect(s).toContain('UNIQUE (stage_id, pack_key)')
  })

  it('selfCheckPresent', () => {
    const s = sql()
    expect(s).toMatch(/^\s*BEGIN;/m)
    expect(s).toMatch(/COMMIT;\s*$/)
    expect(s).toContain("RAISE EXCEPTION 'mig 814:")
    expect(s).toContain('nothing was applied')
    expect(s).toContain("has_table_privilege('authenticated', 'public.pipeline_stage_followups'")
    expect(s).toContain("role_config->>'day'")
  })
})
