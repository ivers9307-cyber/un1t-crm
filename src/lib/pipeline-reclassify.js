// PIPELINE5.6 + 5.7 — orchestrator that runs the classifier across
// every contact at a location and moves their deals to the target
// stage when the classifier says so.
//
// Used by:
//   - Nightly cron (/api/cron/pipeline-classify) — keeps stages
//     in sync with time-based decay (FUNNEL.1: a lead ages out to
//     dormant, a converted member falls off the 60d window to
//     member, without needing a Glofox event).
//   - Manual one-shot via the admin UI / PIPELINE5.7 — operator-
//     triggered re-classification of the whole 8k contact base
//     after the classifier first ships.
//
// Pure orchestration — calls classifyContact() (PIPELINE5.2) for
// the rules and ensureDealForContact() (PIPELINE5.4) for the deal
// move. Records to pipeline_classification_runs (mig 149) for
// audit.
//
// Idempotent: classifier returns the same slug for the same
// inputs, so a no-op re-run produces 'unchanged' for every
// contact. Safe to run hourly if needed.

import { classifyContact } from './pipeline-classifier.js'
import { logWarn } from './log.js'

// Fields the classifier needs from the contacts row.
const SELECT_COLS = [
  'id',
  'name',
  'email',
  'glofox_membership_status',
  'glofox_membership_state',
  'glofox_membership_expiry',
  'last_attended_at',
  'total_attended_7d',
  'total_attended_30d',
  'last_payment_at',
  'joined_at',
  'created_at',
  'trial_credits_remaining',
  // FUNNEL.1 — the funnel classifier keys on attended counts
  // (recent_bookings) and the Converted-column gate (converted_at).
  // The nightly run MUST read the same signals as the webhook path
  // (applyMemberSync) or it re-classifies with attended=0 /
  // converted_at=null and drags every webhook-placed deal back
  // overnight (PIPELINE-FLAP).
  'recent_bookings',
  'converted_at',
  // FUNNEL.3 — the sticky Class Pack stamp; same parity rule applies.
  'pack_customer_at',
  // FUNNEL.4 — operator Cold dismissal; same parity rule (else the
  // nightly cron flaps a cold lead back onto the board).
  'pipeline_dismissed_at',
  // GYMPASS.2 — parks Gympass users in the off-funnel gympass pile; the
  // classifier reads it, so the cron must select it or it flaps them back.
  'gympass_member_id',
  // RETURNPIPE.3 — re-entering a public funnel form revokes a Cold dismissal.
  // Same parity rule: without this the nightly run reads it as null, decides
  // they are still cold, and drags them off the board overnight.
  'last_lead_source_at',
].join(', ')

/**
 * Re-classify every contact at a location and move deals to match.
 *
 * @param {SupabaseClient} db
 * @param {object} args
 * @param {string} args.locationId
 * @param {boolean} [args.dryRun=false]   true → no DB writes; just return plan
 * @param {string}  [args.source='cron']  audit field
 * @param {string}  [args.runId]          optional pre-allocated audit row id
 * @param {string}  [args.userId]         created_by for audit
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   contacts_seen: number,
 *   deals_moved: number,
 *   deals_unchanged: number,
 *   deals_created: number,
 *   errors: number,
 *   movement_matrix: object,
 *   samples: object[],
 *   run_id: string|null,
 *   error?: string,
 * }>}
 */
export async function reclassifyAllContacts(db, args) {
  const {
    locationId, dryRun = false, source = 'cron', userId = null,
  } = args || {}
  const startedAt = new Date()

  if (!locationId) {
    return { ok: false, error: 'locationId required' }
  }

  // 1. Open an audit row up front so the operator sees in-progress
  //    runs and the cron heartbeat catches stalls. dry-runs don't
  //    log a row — they're just diagnostic.
  let runId = null
  if (!dryRun) {
    const { data: runRow, error: runErr } = await db
      .from('pipeline_classification_runs')
      .insert({
        location_id: locationId,
        source,
        dry_run: false,
        status: 'running',
        created_by: userId,
      })
      .select('id')
      .single()
    // SINGLEERR.1 — best-effort audit row, but never silent. The error comes back
    // in the result object, so discarding it meant a rejected insert produced
    // runId=null and every later markRun() no-op'd against nothing.
    if (runErr) {
      logWarn('pipeline-reclassify', 'audit run row insert failed', { err: runErr.message, locationId })
    }
    runId = runRow?.id || null
  }

  // 2. Build the slug → stage_id lookup ONCE for this location.
  const { data: stages, error: stagesErr } = await db
    .from('pipeline_stages')
    .select('id, slug')
    .eq('location_id', locationId)
  if (stagesErr) {
    await markRun(db, runId, { status: 'failed', error_message: `stage load: ${stagesErr.message}` }, startedAt)
    return { ok: false, error: `stage load: ${stagesErr.message}`, run_id: runId }
  }
  const stageIdBySlug = new Map((stages || []).map((s) => [s.slug, s.id]))
  const stageSlugById = new Map((stages || []).map((s) => [s.id, s.slug]))

  // 3. Pull every contact at the location with the classifier inputs.
  //
  //    PIPELINE5.8c fix: .limit(20_000) was being silently capped by
  //    PostgREST at 1000 rows (the operator hit "1000 contacts seen"
  //    on an 8.1k pile). Switch to .range() paging — the only
  //    reliable way to read >1000 rows out of a Supabase project that
  //    has the default db-max-rows setting.
  //
  //    20k hard ceiling is plenty for UN1T (~8k today). Crossing it
  //    means we should switch to per-stage streaming, not just
  //    bumping the number again.
  const PAGE_SIZE = 1000
  const HARD_LIMIT = 20_000
  const contacts = []
  let pageStart = 0
  let pageErr = null
   
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('contacts')
      .select(SELECT_COLS)
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)
    if (error) { pageErr = error; break }
    if (!Array.isArray(page) || page.length === 0) break
    contacts.push(...page)
    if (page.length < PAGE_SIZE) break          // ran out of rows
    if (contacts.length >= HARD_LIMIT) break     // hit the safety cap
    pageStart += PAGE_SIZE
  }
  const contactsErr = pageErr
  if (contactsErr) {
    await markRun(db, runId, { status: 'failed', error_message: `contact load: ${contactsErr.message}` }, startedAt)
    return { ok: false, error: `contact load: ${contactsErr.message}`, run_id: runId }
  }
  if (!Array.isArray(contacts) || contacts.length === 0) {
    await markRun(db, runId, {
      status: 'success',
      contacts_seen: 0, deals_moved: 0, deals_unchanged: 0, deals_created: 0, errors: 0,
      movement_matrix: {}, samples: [],
    }, startedAt)
    return { ok: true, run_id: runId, contacts_seen: 0, deals_moved: 0, deals_unchanged: 0, deals_created: 0, errors: 0, movement_matrix: {}, samples: [] }
  }

  // 4. Pull every open deal at the location in one query.
  //
  //    PIPELINE5.8 fix: original implementation did
  //    .in('contact_id', contactIds) where contactIds was the full
  //    8k UUID array — which builds a query string longer than
  //    PostgREST's URL length limit and 400s with "Bad Request"
  //    (the operator hit this on the first manual run).
  //
  //    Filtering by location_id is equivalent at this scale (deals
  //    are 1:1 with contacts at the same location) and stays well
  //    inside the URL budget. The `dealByContact` map below still
  //    only resolves deals whose contact_id is in our `contacts`
  //    set, so deals belonging to contacts we somehow didn't load
  //    are silently ignored — which matches the previous behaviour.
  // Same .range() paging as contacts — db-max-rows caps any single
  // response at 1000 even when we ask for more. Deals are roughly 1:1
  // with contacts at this scale (~8k each).
  const contactIdSet = new Set(contacts.map((c) => c.id))
  const dealRows = []
  let dealsErr = null
  let dealStart = 0
   
  while (true) {
    const dealEnd = Math.min(dealStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('deals')
      .select('id, contact_id, stage_id')
      .eq('location_id', locationId)
      .eq('status', 'open')
      .order('id', { ascending: true })
      .range(dealStart, dealEnd)
    if (error) { dealsErr = error; break }
    if (!Array.isArray(page) || page.length === 0) break
    dealRows.push(...page)
    if (page.length < PAGE_SIZE) break
    if (dealRows.length >= HARD_LIMIT) break
    dealStart += PAGE_SIZE
  }
  if (dealsErr) {
    await markRun(db, runId, { status: 'failed', error_message: `deal load: ${dealsErr.message}` }, startedAt)
    return { ok: false, error: `deal load: ${dealsErr.message}`, run_id: runId }
  }
  const dealByContact = new Map()
  for (const d of dealRows || []) {
    // Skip deals belonging to contacts we didn't load (a contact at
    // a different location somehow joined to a deal here, or a
    // contact deleted between the two queries).
    if (!contactIdSet.has(d.contact_id)) continue
    // Multiple open deals per contact shouldn't happen (the rest of
    // the codebase enforces "one open"), but if it does we keep the
    // first one — moving multiples would be ambiguous.
    if (!dealByContact.has(d.contact_id)) dealByContact.set(d.contact_id, d)
  }

  // 5. Classify each contact + decide move / leave / create.
  let dealsMoved = 0
  let dealsUnchanged = 0
  let dealsCreated = 0
  let errors = 0
  const movementMatrix = {} // { from_slug: { to_slug: count } }
  const samples = []
  const movesToApply = [] // [{ deal_id, contact_id, from_slug, to_slug, target_stage_id, contact_name }]
  const createsToApply = [] // [{ contact_id, target_stage_id, target_slug, contact_name }]

  for (const c of contacts) {
    const targetSlug = classifyContact({
      glofox_membership_status: c.glofox_membership_status,
      glofox_membership_state: c.glofox_membership_state,
      glofox_membership_expiry: c.glofox_membership_expiry,
      last_attended_at: c.last_attended_at,
      total_attended_7d: c.total_attended_7d,
      total_attended_30d: c.total_attended_30d,
      last_payment_at: c.last_payment_at,
      joined_at: c.joined_at,
      created_at: c.created_at,
      trial_credits_remaining: c.trial_credits_remaining,
      // FUNNEL.1 — must reach the classifier or nightly runs see
      // attended=0 / never-converted and flap webhook-placed deals.
      recent_bookings: c.recent_bookings,
      converted_at: c.converted_at,
      pack_customer_at: c.pack_customer_at,
      pipeline_dismissed_at: c.pipeline_dismissed_at,
      last_lead_source_at: c.last_lead_source_at,
      // GYMPASS.2 — parks Gympass users in the off-funnel gympass pile.
      gympass_member_id: c.gympass_member_id,
    })
    const targetStageId = stageIdBySlug.get(targetSlug)
    if (!targetStageId) {
      // Migration set should guarantee every slug exists; if not,
      // count + move on rather than crashing the whole run.
      errors++
      continue
    }

    const existing = dealByContact.get(c.id)
    if (!existing) {
      // No open deal yet — create one in the right stage.
      createsToApply.push({
        contact_id: c.id,
        target_stage_id: targetStageId,
        target_slug: targetSlug,
        contact_name: c.name || c.email || 'Glofox member',
      })
      continue
    }

    const fromSlug = stageSlugById.get(existing.stage_id) || 'unknown'
    if (fromSlug === targetSlug) {
      dealsUnchanged++
      continue
    }
    movesToApply.push({
      deal_id: existing.id,
      contact_id: c.id,
      from_slug: fromSlug,
      to_slug: targetSlug,
      target_stage_id: targetStageId,
      contact_name: c.name || c.email || null,
    })
  }

  // 6. Apply moves + creates. Skip writes on dry-run.
  if (!dryRun) {
    // Bulk-friendly: group moves by target_stage_id, then UPDATE in
    // batches with .in('id', [...]). Faster than per-deal UPDATE.
    const movesByStage = new Map()
    for (const m of movesToApply) {
      if (!movesByStage.has(m.target_stage_id)) movesByStage.set(m.target_stage_id, [])
      movesByStage.get(m.target_stage_id).push(m)
    }
    // Chunk size for bulk UPDATE batches. PostgREST encodes the
    // .in('id', [...]) into a query string ?id=in.(uuid1,uuid2,...)
    // and 400s "Bad Request" past ~16KB. UUIDs are 36 chars + comma
    // = 37 bytes each. 500 IDs ≈ 18.5KB plus URL framing, comfortably
    // under the cap. We hit this on the operator's first commit
    // (5,810 errors — single batch of ~4,400 deals to Dormant
    // exploded the URL).
    const BULK_UPDATE_CHUNK = 500
    for (const [stageId, moves] of movesByStage) {
      let stageMoved = 0
      let stageErrored = 0
      for (let i = 0; i < moves.length; i += BULK_UPDATE_CHUNK) {
        const chunk = moves.slice(i, i + BULK_UPDATE_CHUNK)
        const dealIds = chunk.map((m) => m.deal_id)
        const { error: moveErr } = await db
          .from('deals')
          .update({ stage_id: stageId })
          .in('id', dealIds)
        if (moveErr) {
          stageErrored += chunk.length
          logWarn('pipeline-reclassify', `bulk-move chunk failed for stage ${stageId}`, {
            err: moveErr.message,
            chunk_start: i,
            chunk_size: chunk.length,
          })
          continue
        }
        stageMoved += chunk.length
        // Movement matrix + samples populated only for chunks that
        // actually landed — failed chunks still show in the error
        // counter but not as movement.
        for (const m of chunk) {
          movementMatrix[m.from_slug] = movementMatrix[m.from_slug] || {}
          movementMatrix[m.from_slug][m.to_slug] = (movementMatrix[m.from_slug][m.to_slug] || 0) + 1
          if (samples.length < 25) {
            samples.push({
              contact_id: m.contact_id,
              contact_name: m.contact_name,
              from_slug: m.from_slug,
              to_slug: m.to_slug,
            })
          }
        }
      }
      dealsMoved += stageMoved
      errors += stageErrored
    }

    // Creates one-by-one (only matters for contacts without deals,
    // which should be rare post-import). Could batch later.
    for (const c of createsToApply) {
      const { error: createErr } = await db
        .from('deals')
        .insert({
          title: c.contact_name,
          contact_id: c.contact_id,
          stage_id: c.target_stage_id,
          location_id: locationId,
          status: 'open',
        })
      if (createErr) {
        errors++
        logWarn('pipeline-reclassify', `deal create failed for ${c.contact_id}`, { err: createErr.message })
        continue
      }
      dealsCreated++
      movementMatrix[''] = movementMatrix[''] || {}
      movementMatrix[''][c.target_slug] = (movementMatrix[''][c.target_slug] || 0) + 1
    }
  } else {
    // Dry-run — populate movement_matrix + samples for the operator
    // preview without touching DB.
    for (const m of movesToApply) {
      movementMatrix[m.from_slug] = movementMatrix[m.from_slug] || {}
      movementMatrix[m.from_slug][m.to_slug] = (movementMatrix[m.from_slug][m.to_slug] || 0) + 1
      if (samples.length < 25) {
        samples.push({
          contact_id: m.contact_id,
          contact_name: m.contact_name,
          from_slug: m.from_slug,
          to_slug: m.to_slug,
        })
      }
    }
    dealsMoved = movesToApply.length
    dealsCreated = createsToApply.length
  }

  // 7. Close the audit row.
  const status = errors === 0 ? 'success' : (dealsMoved + dealsCreated > 0 ? 'partial' : 'failed')
  await markRun(db, runId, {
    status,
    contacts_seen: contacts.length,
    deals_moved: dealsMoved,
    deals_unchanged: dealsUnchanged,
    deals_created: dealsCreated,
    errors,
    movement_matrix: movementMatrix,
    samples,
  }, startedAt)

  return {
    ok: true,
    run_id: runId,
    contacts_seen: contacts.length,
    deals_moved: dealsMoved,
    deals_unchanged: dealsUnchanged,
    deals_created: dealsCreated,
    errors,
    movement_matrix: movementMatrix,
    samples,
  }
}

async function markRun(db, runId, fields, startedAt) {
  if (!runId) return
  const finishedAt = new Date()
  try {
    await db
      .from('pipeline_classification_runs')
      .update({
        ...fields,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
      })
      .eq('id', runId)
  } catch (e) {
    logWarn('pipeline-reclassify', 'audit close failed', { err: e?.message, run_id: runId })
  }
}
