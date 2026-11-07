import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations')
const sql = readFileSync(path.join(MIGRATIONS, '815_pipeline_builder.sql'), 'utf8')
const code = sqlCode(sql)

describe('mig 815 — PIPEBUILD.5a', () => {
  it('adds baseline_at and version', () => {
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS baseline_at timestamptz/)
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1/)
    expect(code).toMatch(/CHECK \(version >= 1\)/)
  })

  it('creates the RPC and closes it to every client role', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.create_configured_pipeline/)
    expect(code).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.create_configured_pipeline[\s\S]*?FROM PUBLIC, anon, authenticated/,
    )
  })

  it('drops the three browser write policies and revokes only the write privileges', () => {
    for (const p of ['pipeline_stages_ins', 'pipeline_stages_upd', 'pipeline_stages_del']) {
      expect(code).toMatch(new RegExp(`DROP POLICY IF EXISTS ${p} ON public\\.pipeline_stages`))
    }
    expect(code).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.pipeline_stages FROM authenticated/)
    expect(code).not.toMatch(/REVOKE ALL ON public\.pipeline_stages/i)
    expect(code).not.toMatch(/REVOKE SELECT ON public\.pipeline_stages/i)
    expect(code).not.toMatch(/REVOKE ALL ON (TABLE )?public\.pipeline_stages/i)
  })

  it('no later migration reopens pipeline_stages writes', () => {
    const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && parseInt(f, 10) > 815)
    for (const f of later) {
      const t = sqlCode(readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      expect(t, f).not.toMatch(/CREATE POLICY\s+\S+\s+ON\s+(public\.)?pipeline_stages\s+(AS\s+\w+\s+)?FOR\s+(INSERT|UPDATE|DELETE|ALL)/i)
      expect(t, f).not.toMatch(/GRANT[^;]*\b(INSERT|UPDATE|DELETE|ALL)\b[^;]*ON\s+(TABLE\s+)?(public\.)?pipeline_stages\s+TO[^;]*authenticated/i)
    }
  })
})
