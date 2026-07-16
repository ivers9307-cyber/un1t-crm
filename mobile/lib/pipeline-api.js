// Pipeline API helpers for mobile.
//
// The web app's /api/deals, /api/contacts, /api/notes, /api/activities,
// /api/stages routes all use requireApiKey() (n8n integration only) —
// they don't accept session/JWT auth. The web KanbanBoard talks to
// Supabase directly via createBrowserClient, relying on RLS for per-
// location scoping. Mobile follows the same pattern for READS.
//
// Two writes deliberately go through /api/* (Bearer JWT via api()) instead:
//   - createNote → POST /api/contacts/[id]/notes — the session-authed
//     route is the ONLY path that fires the Glofox two-way note push
//     (create-only, echo-suppressed, mig 390). A direct notes insert
//     silently skips it, so mobile-authored notes never reached the
//     front desk's Glofox timeline (FUNNEL-M.1 fix).
//   - setPipelineCold → POST /api/contacts/[id]/pipeline-status — the
//     FUNNEL.4 Cold dismissal writes pipeline_dismissed_at AND re-runs
//     the classifier server-side so the deal moves immediately.
//
// Multi-location: we filter by activeLocationId for both reads and
// writes. RLS will additionally enforce that the caller belongs to
// that location, so the worst case is an empty result.

import { supabase } from './supabase'
import { api } from './api'

// FUNNEL-M.1 — mirrors the web board query (src/app/pipeline/page.js):
// non-archived stages only, ordered by display_order, and ships
// is_dormant so the screen can split Funnel vs Off-funnel views via
// shared/pipeline-classifier's splitStagesByFunnel().
export async function listStages(locationId) {
  let q = supabase.from('pipeline_stages')
    .select('id, name, slug, color, display_order, is_dormant')
    .eq('archived', false)
    .order('display_order', { ascending: true })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}

// FUNNEL-M.1 — HEAD count of open deals in a stage (no row payload).
// The stage pills used to fetch every stage's full deal list just to
// .length it — the off-funnel piles hold thousands of rows and every
// select is silently capped at 1,000 (repo invariant), so those counts
// were both heavy AND wrong. This mirrors the web tab-badge queries.
// NOTE: count/head options are only read on the FIRST .select() after
// .from() (PostgREST trap) — keep .select() before the filters.
export async function countOpenDealsForStage(stageId, locationId) {
  let q = supabase.from('deals')
    .select('id', { count: 'exact', head: true })
    .eq('stage_id', stageId)
    .eq('status', 'open')
  if (locationId) q = q.eq('location_id', locationId)
  const { count, error } = await q
  return error ? { success: false, error: error.message } : { success: true, count: count || 0 }
}

export async function listDealsByStage(stageId, locationId) {
  let q = supabase.from('deals')
    .select(`
      id, title, status, value, stage_id, created_at, updated_at, location_id,
      contacts:contact_id (id, name, first_name, last_name, pipeline_stage_slug, phone, wa_phone, email)
    `)
    .eq('stage_id', stageId)
    .eq('status', 'open')
    .order('updated_at', { ascending: false })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function getDeal(id) {
  const { data, error } = await supabase.from('deals')
    .select(`
      *,
      contacts:contact_id (*),
      pipeline_stages:stage_id (id, name, slug, color, display_order)
    `)
    .eq('id', id)
    .single()
  return error ? { success: false, error: error.message } : { success: true, data }
}

// FUNNEL.1 — moveDeal() was removed: stage placement is classifier-
// derived (webhook + nightly cron), so a manual deals.stage_id write
// is silently reverted by the next sync.

export async function setDealStatus(dealId, status) {
  // status: 'open' | 'won' | 'lost'
  const { data, error } = await supabase.from('deals')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', dealId)
    .select()
    .single()
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function listActivitiesForContact(contactId) {
  const { data, error } = await supabase.from('activities')
    .select('id, subject, type, due_date, due_time, note, done, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(20)
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function listNotesForContact(contactId) {
  const { data, error } = await supabase.from('notes')
    .select('id, content, deal_id, created_at')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(20)
  return error ? { success: false, error: error.message } : { success: true, data }
}

export async function logActivity({ contactId, dealId, type, subject, note, locationId }) {
  // RLS doesn't enforce profile_id on insert here — we set it explicitly
  // so timeline ownership is correct.
  const { data, error } = await supabase.from('activities').insert({
    contact_id: contactId,
    deal_id: dealId || null,
    type: type || 'note',
    subject: subject || (type === 'call' ? 'Call' : type === 'email' ? 'Email' : 'Note'),
    note: note || null,
    done: type === 'note' || type === 'call' || type === 'email', // log entries are completed events
    location_id: locationId || null,
  }).select().single()
  return error ? { success: false, error: error.message } : { success: true, data }
}

// FUNNEL-M.1 fix — notes go through the session-authed route, NOT a
// direct Supabase insert. Only /api/contacts/[id]/notes fires the
// Glofox two-way note push (create-only, echo-suppressed, mig 390) and
// attributes the author; the old direct insert silently skipped both.
// Signature kept so callers don't churn: dealId is accepted but no
// longer persisted — the route is contact-scoped (same payload the web
// composer sends) and both timelines list notes by contact_id anyway.
// locationId is unused too (the route derives location from the contact
// row — never trusts a client-supplied location).
export async function createNote({ contactId, dealId: _dealId, content, locationId: _locationId }) {
  return api(`/api/contacts/${contactId}/notes`, {
    method: 'POST',
    body: { content },
  })
}

// FUNNEL.4 Cold toggle (FUNNEL-M.1 brings it to mobile) — POST the
// pipeline-status route rather than writing pipeline_dismissed_at
// directly: the route authorizes (pipeline permission + in-location
// check), validates, and re-places the deal via the classifier so the
// board updates immediately. cold=true dismisses; cold=false returns
// the lead to the funnel. The classifier auto-revives a cold lead the
// moment they attend a class after the dismissal.
export async function setPipelineCold(contactId, cold) {
  return api(`/api/contacts/${contactId}/pipeline-status`, {
    method: 'POST',
    body: { cold: Boolean(cold) },
  })
}
