// MCP.1 mig 801: org_settings.mcp_enabled (the organisation switch, off by
// default) and mcp_tool_calls (a PII-free call log written by service-role
// code only). Reads the migration text, comments stripped by sqlCode.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'

const FILE = path.resolve(import.meta.dirname, '../supabase/migrations/801_mcp_server.sql')
const sql = sqlCode(readFileSync(FILE, 'utf8'))

describe('mig 801 MCP.1', () => {
  it('adds mcp_enabled with a false default and keeps org_settings closed', () => {
    expect(sql).toMatch(/ALTER TABLE public\.org_settings\s+ADD COLUMN IF NOT EXISTS mcp_enabled boolean NOT NULL DEFAULT false/i)
    expect(sql).not.toMatch(/GRANT[^;]*org_settings/i)
  })

  it('creates mcp_tool_calls closed to every client role, RLS on, no policy', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.mcp_tool_calls/)
    expect(sql).toMatch(/ALTER TABLE public\.mcp_tool_calls ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/REVOKE ALL ON public\.mcp_tool_calls FROM anon, authenticated/)
    expect(sql).not.toMatch(/CREATE POLICY[^;]*mcp_tool_calls/i)
    expect(sql).not.toMatch(/GRANT[^;]*mcp_tool_calls/i)
  })

  it('has the columns, foreign keys and indexes the log needs', () => {
    // Whitespace-tolerant: the migration aligns its column types.
    const flat = sql.replace(/\s+/g, ' ')
    expect(flat).toMatch(/profile_id uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/)
    expect(flat).toMatch(/organization_id uuid REFERENCES public\.organizations\(id\) ON DELETE SET NULL/)
    expect(flat).toMatch(/location_id uuid REFERENCES public\.locations\(id\) ON DELETE SET NULL/)
    expect(flat).toMatch(/client_id text NOT NULL/)
    expect(flat).toMatch(/tool text NOT NULL/)
    expect(flat).toMatch(/ok boolean NOT NULL/)
    expect(flat).toMatch(/error_code text,/)
    expect(flat).toMatch(/duration_ms integer,/)
    expect(flat).toMatch(/created_at timestamptz NOT NULL DEFAULT now\(\)/)
    expect(sql).toMatch(/ON public\.mcp_tool_calls \(profile_id, created_at DESC\)/i)
    expect(sql).toMatch(/ON public\.mcp_tool_calls \(created_at\)/i)
  })

  it('never stores arguments or results', () => {
    expect(sql).not.toMatch(/\b(args|arguments|input|result|payload)\b\s+(jsonb|text)/i)
  })

  it('adds no heartbeat row (the purge cron owns its own migration)', () => {
    expect(sql).not.toMatch(/cron_heartbeats/i)
  })
})
