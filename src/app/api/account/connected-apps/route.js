// src/app/api/account/connected-apps/route.js
// MCP.1 — GET: how the CALLER's connected apps (Claude, via the Supabase OAuth
// server) have been used, from mcp_tool_calls.
//
//   { clients: [{ client_id, last_used_at, calls_7d }] }  — last 7 days.
//
// The grant list itself (names, revoke) is read in the browser by
// ConnectedAppsCard through supabase.auth.oauth: a grant belongs to the signed
// in session and this route has no business listing or revoking it.
//
// SCOPE: service-role client, so `.eq('profile_id', user.id)` IS the gate. The
// rows are per-person (the log's other readers are the org switch's counts);
// no id parameter exists, so nobody can ask for another person's usage.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { selectAll } from '@/lib/select-all'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const WINDOW_DAYS = 7

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return json({ success: false, error: 'Unauthorized' }, 401)

  const db = createServerClient()
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  let rows
  try {
    // Paged: a busy week can pass the 1,000-row cap, and a truncated page
    // would undercount the calls and pick the wrong last_used_at.
    rows = await selectAll((from, to) => db.from('mcp_tool_calls')
      .select('client_id, created_at')
      .eq('profile_id', user.id)
      .gte('created_at', cutoff)
      .order('id')
      .range(from, to))
  } catch (err) {
    logError('connected-apps', 'usage read failed', { err })
    return json({ success: false, error: 'Could not read your connected apps.' }, 500)
  }

  const byClient = new Map()
  for (const r of rows) {
    if (!r.client_id) continue
    const cur = byClient.get(r.client_id) || { client_id: r.client_id, last_used_at: r.created_at, calls_7d: 0 }
    cur.calls_7d += 1
    if (r.created_at > cur.last_used_at) cur.last_used_at = r.created_at
    byClient.set(r.client_id, cur)
  }
  return json({ success: true, data: { clients: [...byClient.values()] } })
}
