// Pipeline API helpers for mobile.
//
// The web app's /api/deals, /api/contacts, /api/notes, /api/activities,
// /api/stages routes all use requireApiKey() (n8n integration only) —
// they don't accept session/JWT auth. The web KanbanBoard talks to
// Supabase directly via createBrowserClient, relying on RLS for per-
// location scoping. Mobile follows the same pattern for READS.
//
// Three writes deliberately go through /api/* (Bearer JWT via api()) instead:
//   - createNote → POST /api/contacts/[id]/notes — the session-authed
//     route is the ONLY path that fires the Glofox two-way note push
//     (create-only, echo-suppressed, mig 390). A direct notes insert
//     silently skips it, so mobile-authored notes never reached the
//     front desk's Glofox timeline (FUNNEL-M.1 fix).
//   - setPipelineCold → POST /api/contacts/[id]/pipeline-status — the
//     FUNNEL.4 Cold dismissal writes pipeline_dismissed_at AND re-runs
//     the classifier server-side so the deal moves immediately.
//   - moveDealToStage → POST /api/deals/[id]/stage — the WAITLIST-M.1
//     manual-board move. The route is the ONLY thing that checks the
//     `pipeline` permission, guards the location, validates that the
//     target stage lives on the deal's OWN board, fires the STAGETRIG.1
//     sequence trigger and writes the pipeline.manual_move audit row. A
//     direct deals.stage_id update would skip all five.
//
// Multi-location: we filter by activeLocationId for both reads and
// writes. RLS will additionally enforce that the caller belongs to
// that location, so the worst case is an empty result.

import { supabase } from './supabase'
import { api } from './api'

// WAITLIST.5 — the location's boards, for a phone that has to name them.
// PIPELINES.6 moved the board axis onto the `pipelines` table (mig 594), and
// the web board tabs read exactly this set; mobile could not see it at all, so
// it had no way to say WHICH board the stages below belong to.
//
// `enabled = true` here, unlike listStages() directly below — and the
// difference is deliberate, not an oversight. listStages() omits the filter
// because CCF Autos / SourceIt / Test Studio hold a DISABLED primary row (their
// stray stage rows needed a parent) and dropping it would blank their pipeline
// tab. A LIST of boards has no such hostage: a disabled board is one the web
// app already hides, so showing it here would offer a phone a tab the web board
// does not have.
//
// READ-ONLY. WAITLIST-M.1 opened the write path, but not here and not as
// drag-drop: dragging a card between horizontally-scrolling columns on a phone
// is a poor interaction, and the web board stays the working surface. The move
// lives on the deal DETAIL screen as a stage picker, and it goes through
// moveDealToStage() below — i.e. through /api/deals/[id]/stage, which is the
// fence for a move the classifier could otherwise contest (the FUNNEL.1
// failure that removed drag-drop in the first place).
export async function listPipelines(locationId) {
  let q = supabase.from('pipelines')
    .select('id, key, name, mode, display_order')
    .eq('enabled', true)
    .order('display_order', { ascending: true })
  if (locationId) q = q.eq('location_id', locationId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}

// FUNNEL-M.1 — mirrors the web board query (src/app/(sales)/pipeline/page.js):
// non-archived stages only, ordered by display_order, and ships
// is_dormant so the screen can split Funnel vs Off-funnel views via
// shared/pipeline-classifier's splitStagesByFunnel().
//
// PIPELINES.6 — that split used to partition on `pipeline_stages.board` as
// well, which is what kept Stillorgan's five parked `returning_*` rows out of
// this screen. The board axis moved to the `pipelines` table (mig 594), so the
// CALLER now has to scope to one board or those five columns reappear in the
// Funnel strip. Scope to the location's PRIMARY board — mig 594's partial
// unique index guarantees at most one per location, and every location's
// primary is its acquisition board, so this is exactly the set that rendered
// before.
//
// Deliberately no `enabled` filter: CCF Autos / SourceIt / Test Studio hold a
// DISABLED primary row (their stray stage rows needed a parent), and this
// screen shows their stages today. Web now hides a disabled board; making
// mobile match is a product decision for the mobile task, not this one.
//
// Fails OPEN — an unreadable `pipelines` row leaves the query unscoped, i.e.
// exactly today's behaviour. A board with five extra columns beats a blank
// pipeline tab.
export async function listStages(locationId) {
  let pipelineId = null
  if (locationId) {
    const { data: primary } = await supabase.from('pipelines')
      .select('id')
      .eq('location_id', locationId)
      .eq('is_primary', true)
      .limit(1)
    pipelineId = Array.isArray(primary) && primary.length > 0 ? primary[0].id : null
  }

  let q = supabase.from('pipeline_stages')
    .select('id, name, slug, color, display_order, is_dormant')
    .eq('archived', false)
    .order('display_order', { ascending: true })
  if (locationId) q = q.eq('location_id', locationId)
  if (pipelineId) q = q.eq('pipeline_id', pipelineId)
  const { data, error } = await q
  return error ? { success: false, error: error.message } : { success: true, data }
}

// WAITLIST-M.1 — one board by id, for the deal detail screen.
//
// The screen has to know the board's `mode` before it may offer a stage
// move: on a derived board the classifier owns every column and
// /api/deals/[id]/stage refuses the move anyway, so the picker must not
// be drawn there at all. Resolved from the DEAL's own pipeline_id, not
// from the location's primary board — a location can run more than one
// board, and the card belongs to exactly one of them.
//
// Fails CLOSED, unlike listStages() above, and deliberately: an
// unreadable pipelines row leaves the caller with no mode, the caller
// draws no picker, and the screen is exactly as read-only as it is
// today. Guessing "probably manual" would offer a move the server would
// then refuse.
export async function getPipeline(pipelineId) {
  if (!pipelineId) return { success: false, error: 'Missing pipeline' }
  const { data, error } = await supabase.from('pipelines')
    .select('id, key, name, mode')
    .eq('id', pipelineId)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  return data ? { success: true, data } : { success: false, error: 'Pipeline not found' }
}

// WAITLIST-M.1 — the live columns of ONE board, in board order.
//
// listStages() above answers "the stages of this location's PRIMARY
// board" (that is what the pipeline tab renders); this answers "the
// stages of THIS card's board", which is what a move has to offer. They
// coincide at Hatch today because the waitlist board is primary, and
// would quietly diverge the day a location runs a second board — the
// picker would then list columns the route rejects with
// unknown_stage_for_pipeline.
//
// archived=false matters for the same reason it does in
// findEntryStageForPipeline: mig 239 archived nine legacy stages that
// still sit at display_order 1..9, and an unfiltered list would offer
// dead columns.
export async function listStagesForPipeline(pipelineId) {
  if (!pipelineId) return { success: false, error: 'Missing pipeline' }
  const { data, error } = await supabase.from('pipeline_stages')
    .select('id, name, slug, color, display_order')
    .eq('pipeline_id', pipelineId)
    .eq('archived', false)
    .order('display_order', { ascending: true })
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

// WAITLIST-M.1 — move a card to another column on a MANUAL board.
//
// FUNNEL.1 removed the old moveDeal() because it wrote deals.stage_id
// straight through the supabase client, and on a classifier-derived
// board the next sync silently reverted the operator's move. This is
// its replacement, and the difference is not "we changed our minds":
// mig 594's pipelines.mode gives a board that nothing derives, and this
// call goes through the session-authed route rather than the table.
//
// POST /api/deals/[id]/stage carries five things a direct update does
// not: the `pipeline` permission check, the in-location guard, the
// same-BOARD stage validation (Hatch can run two boards at one
// location, so a location filter alone would let a waitlist card be
// parked in a gym column), the STAGETRIG.1 sequence trigger, and the
// pipeline.manual_move audit row that makes "who moved this card?"
// answerable on a board where every move is a human decision. Same
// reasoning as createNote and setPipelineCold above.
//
// It also REFUSES a derived board (400 pipeline_is_derived), so the
// server stays the fence even if a screen ever offers this by mistake.
// The envelope comes back untouched: a caller must be able to tell the
// operator the card did not move, and leave it where it was.
export async function moveDealToStage(dealId, stageId) {
  if (!dealId || !stageId) {
    return { success: false, error: 'Missing deal or stage' }
  }
  return api(`/api/deals/${dealId}/stage`, {
    method: 'POST',
    body: { stage_id: stageId },
  })
}

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
