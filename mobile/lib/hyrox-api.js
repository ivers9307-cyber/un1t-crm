// HYROX-MOBILE — data helpers for the mobile Hyrox planner.
//
// Reads (block + sessions) go DIRECT to Supabase — hyrox_blocks/hyrox_sessions
// are authenticated-readable (SELECT-only RLS, mig 440), exactly like the web
// planner's browser client. We filter by the active location explicitly: RLS
// scopes a direct read to ALL the caller's locations, and the active-location
// header only applies to /api/* routes, not direct Supabase calls.
//
// Mutations (approve / send back / regenerate / push) go through the existing
// /api/hyrox/* routes via api() — they orchestrate (stamp approver, call Claude,
// upsert tv_content) and enforce the per-location permission.

import { supabase } from './supabase'
import { api } from './api'

/** The active block for a location + its sessions (week/slot ordered). */
export async function loadHyrox(locationId) {
  if (!locationId) return { success: true, data: { block: null, sessions: [] } }

  const { data: block, error: blockErr } = await supabase
    .from('hyrox_blocks')
    .select('*')
    .eq('location_id', locationId)
    .eq('status', 'active')
    .order('starts_on', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (blockErr) return { success: false, error: blockErr.message }
  if (!block) return { success: true, data: { block: null, sessions: [] } }

  const { data: sessions, error: sessErr } = await supabase
    .from('hyrox_sessions')
    .select('*')
    .eq('block_id', block.id)
    .order('week_no', { ascending: true })
    .order('slot', { ascending: true })
  if (sessErr) return { success: false, error: sessErr.message }

  return { success: true, data: { block, sessions: sessions || [] } }
}

/** One session by id (for the detail screen). */
export async function getSession(id) {
  const { data, error } = await supabase.from('hyrox_sessions').select('*').eq('id', id).maybeSingle()
  if (error) return { success: false, error: error.message }
  return { success: true, data }
}

/** Approve or send a session back to draft. status: 'approved' | 'draft'. */
export async function setSessionStatus(id, status) {
  return api(`/api/hyrox/sessions/${id}`, { method: 'PUT', body: { status } })
}

/** Regenerate a single session (re-runs generation, returns to draft). */
export async function regenerateSession(id) {
  return api(`/api/hyrox/sessions/${id}/regenerate`, { method: 'POST' })
}

/** Push a session's board onto the location's Hyrox TV(s) now. */
export async function pushSessionToTv(id) {
  return api(`/api/hyrox/sessions/${id}/push`, { method: 'POST' })
}
