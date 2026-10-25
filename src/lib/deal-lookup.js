// PIPELINES.5 — the one way to find a contact's open deal on a given board.
//
// Three call sites assumed a contact had at most ONE open deal:
//   public/leads/route.js:118         .maybeSingle() — ERRORS on a second row
//   public/class-booking/route.js:148 .maybeSingle() — same
//   glofox-sync.js:417                .limit(1), no order — an ARBITRARY row
//
// The first two are live public forms. None are load-bearing while every
// location runs one board, but the FIRST second board turns them into a 500
// on the website lead capture, so they are fixed before that board exists.

/**
 * @param {object} db          service-role Supabase client
 * @param {string} contactId
 * @param {string} pipelineId
 * @returns {Promise<{id:string, stage_id:string, pipeline_id:string}|null>}
 */
export async function findOpenDealForPipeline(db, contactId, pipelineId) {
  if (!db || !contactId || !pipelineId) return null
  const { data, error } = await db
    .from('deals')
    .select('id, stage_id, pipeline_id')
    .eq('contact_id', contactId)
    .eq('pipeline_id', pipelineId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !Array.isArray(data) || data.length === 0) return null
  return data[0]
}

/**
 * Resolve the board a location's deals belong to by default.
 *
 * Every deal-insert site needs this: `deals.pipeline_id` is what the nightly
 * orchestrator scopes its read with (`.in('pipeline_id', …)`), and SQL IN
 * never matches NULL — so a deal written without one is invisible to the cron,
 * which then creates ANOTHER open deal for the same contact, every night.
 *
 * Never hardcode a pipeline id: the board is a property of the location, and
 * mig 594's partial unique index guarantees at most one primary row per
 * location (a location with none — a disabled-only location — resolves null,
 * and the caller decides what that means).
 *
 * `mode` comes back so a caller can refuse a manual board: a manual board's
 * deals move only by hand, so no automatic placement may write to one.
 *
 * @param {object} db          service-role Supabase client
 * @param {string} locationId
 * @returns {Promise<{id:string, mode:string}|null>}
 */
export async function findPrimaryPipeline(db, locationId) {
  if (!db || !locationId) return null
  const { data, error } = await db
    .from('pipelines')
    .select('id, mode')
    .eq('location_id', locationId)
    .eq('is_primary', true)
    .eq('enabled', true)
    .limit(1)
  if (error || !Array.isArray(data) || data.length === 0) return null
  return data[0]
}

/**
 * The stage a new deal enters a board at: its lowest `display_order` live
 * column. Both public forms (website lead capture and /start class booking)
 * used to hardcode the slug 'new_lead' — which is right for the acquisition
 * board and wrong for every other board a location might run. Derived from the
 * board itself, it stays right: at Stillorgan the acquisition board's
 * `new_lead` IS the lowest live column (display_order 301), so this resolves to
 * exactly what the hardcoded slug did.
 *
 * `archived=false` matters — mig 239 archived nine legacy stages that still sit
 * at display_order 1..9, so an unfiltered order() would put every new website
 * lead in a dead column.
 *
 * @param {object} db
 * @param {string} pipelineId
 * @returns {Promise<{id:string, slug:string}|null>}
 */
export async function findEntryStageForPipeline(db, pipelineId) {
  if (!db || !pipelineId) return null
  const { data, error } = await db
    .from('pipeline_stages')
    .select('id, slug')
    .eq('pipeline_id', pipelineId)
    .eq('archived', false)
    .order('display_order', { ascending: true })
    .limit(1)
  if (error || !Array.isArray(data) || data.length === 0) return null
  return data[0]
}
