// MCPEMAIL.1 mig 827: campaign_release_approvals (service role only, token
// stored as a hash) and campaigns.agent_blocks / created_via. Reads the
// migration text, comments stripped by sqlCode.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const FILE = path.resolve(import.meta.dirname, '../supabase/migrations/827_mcp_email_campaigns.sql')
const sql = sqlCode(readFileSync(FILE, 'utf8'))
const flat = sql.replace(/\s+/g, ' ')

describe('mig 827 MCPEMAIL.1', () => {
  it('creates campaign_release_approvals closed to every client role', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.campaign_release_approvals/)
    expect(sql).toMatch(/ALTER TABLE public\.campaign_release_approvals ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/REVOKE ALL ON public\.campaign_release_approvals FROM anon, authenticated/)
    expect(sql).not.toMatch(/CREATE POLICY[^;]*campaign_release_approvals/i)
    expect(sql).not.toMatch(/GRANT[^;]*campaign_release_approvals/i)
  })

  it('has the columns, foreign keys and index the approval needs', () => {
    expect(flat).toMatch(/campaign_id uuid NOT NULL REFERENCES public\.campaigns\(id\) ON DELETE CASCADE/)
    expect(flat).toMatch(/profile_id uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/)
    expect(flat).toMatch(/token_hash text NOT NULL UNIQUE/)
    expect(flat).toMatch(/content_key text NOT NULL/)
    expect(flat).toMatch(/audience_eligible integer NOT NULL/)
    expect(flat).toMatch(/send_at timestamptz,/)
    expect(flat).toMatch(/expires_at timestamptz NOT NULL/)
    expect(flat).toMatch(/used_at timestamptz,/)
    expect(flat).toMatch(/voided_at timestamptz,/)
    expect(flat).toMatch(/created_at timestamptz NOT NULL DEFAULT now\(\)/)
    expect(sql).toMatch(/ON public\.campaign_release_approvals \(campaign_id, created_at DESC\)/i)
  })

  it('stores only a token hash, never the token', () => {
    expect(sql).not.toMatch(/\btoken\s+(text|uuid)/i)
    expect(sql).not.toMatch(/\bplain_token\b|\braw_token\b/i)
  })

  it('adds both campaigns columns idempotently', () => {
    expect(flat).toMatch(/ALTER TABLE public\.campaigns ADD COLUMN IF NOT EXISTS agent_blocks jsonb/)
    expect(flat).toMatch(/ALTER TABLE public\.campaigns ADD COLUMN IF NOT EXISTS created_via text NOT NULL DEFAULT 'web'/)
    expect(flat).toMatch(/CHECK \(created_via IN \('web', 'mcp'\)\)/)
  })

  it('grants nothing on campaigns (closed to clients since mig 684)', () => {
    expect(sql).not.toMatch(/GRANT[^;]*campaigns/i)
  })
})
