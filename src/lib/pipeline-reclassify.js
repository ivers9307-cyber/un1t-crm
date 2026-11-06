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

import { logWarn, logError } from './log.js'
import { getBoardModule, PIPELINE_MODES } from '../../shared/pipelines/index.js'
import { membershipReadsFor, supportsRead } from './membership/reads/index.js'
import { un1tDealDates } from './membership/reads/un1t-pipeline-dates.js'
import { loadActiveElsewhere, leavesBoard, ELSEWHERE_MEMBER, ELSEWHERE_TRAINING } from './pipeline-other-studio-members.js'
import { triggerSequencesForPipelineStageChange } from './sequences/triggers.js'
import { writeRebookNotes } from './pipeline-rebook-notes.js'
// PIPE3 — one router places a contact on one of several contacts-input boards
// (acquisition / paid_trial / programmes at Stillorgan); the claims it needs
// are read once per run.
import { routeContact, CLAIM_BOARD_MODULES, OFFER_MODULES } from '../../shared/pipelines/router.js'
import { paidClaimFromSnapshot } from '../../shared/pipelines/paid-trial.js'
import {
  loadClaimsForLocation, loadProgrammeRules, pendingProgrammeClaims, upsertProgrammeClaims,
  upsertBoardClaims,
} from './pipeline-claims.js'
// PIPEBUILD.3d — configured offer boards (module `offer`): their config is
// parsed here and their claims loaded once per run.
import { splitOfferBoards, loadOfferClaimsForLocation, UN1T_MEMBERSHIP_SOURCES } from './pipeline-offer-claims.js'

// HATCHPIPE.2 — a board whose module declares this inputSource is classified
// from the location's membership read adapter (un1tOnlineReads.pipelineInputs:
// un1t_* rows at THIS studio), never from contacts columns. Every other board
// reads contacts exactly as before.
const UN1T_INPUT = 'un1t_online'
// REBOOK.1 — the un1t board's Rebook column (shared/pipelines/acquisition-un1t.js).
const REBOOK_SLUG = 'rebook'
// The module a disabled row is dry-run as (includeDisabled, below): Hatch's
// pre-740 acquisition row still named the Glofox module and was previewed as
// un1t. PIPE3 / HATCH39 — a disabled row on one of these modules (Stillorgan's
// claim boards before mig 798; Hatch's €39 board before mig 804) is dry-run as
// itself.
const DRY_RUN_DISABLED_MODULE = 'acquisition_un1t'
const DRY_RUN_SELF_MODULES = Object.freeze([...CLAIM_BOARD_MODULES, 'paid_trial_un1t', ...OFFER_MODULES])
// PIPEBUILD.3d — the pipelines columns a run reads: the board settings (mig 814)
// ride along so an offer board's config and priority reach the router.
// PIPEBUILD.5c — and baseline_at (mig 815): an offer board switched on and not
// yet baselined places silently this run and is stamped after it.
const PIPELINE_COLS = 'id, key, module, mode, enabled, is_primary, board_type, config, priority, baseline_at'
const OFFER_BOARD_TYPE = 'offer'
// PIPEBUILD.3d — UN1T_MEMBERSHIP_SOURCES (pipeline-offer-claims.js): the
// locations.membership_source values whose members live in un1t.online. An
// offer board reads contacts, so it is refused at these studios until PR 3b.
// TDSEQ.1 — more than this many deals moved into ONE stage in ONE run is a
// rule change, not people progressing: no sequence starts for that stage.
const STAGE_TRIGGER_MASS_MOVE = 50
// STILL39SEQ.1 — the contacts-input (Glofox) boards whose moves this pass
// fires the stage-change trigger for. Stillorgan's €39 board reaches Day 7 and
// Trial Done by TIME, so this pass makes those moves and nothing else would
// start a sequence for them. Acquisition is deliberately absent: it moves
// thousands of deals a night, and its moves fire through ensureDealForContact.
// PIPEBUILD.3d — offer boards too: like the €39 board their columns are reached
// by time and by claim, so this pass is the one place their moves happen.
const CONTACTS_STAGE_TRIGGER_MODULES = Object.freeze(['paid_trial', ...OFFER_MODULES])

// PIPELINES.3 — the columns a run selects are the UNION of what its enabled
// derived boards DECLARE, not a hand-maintained list. The list this replaced
// carried five comments all warning of the same defect: omit a field, the cron
// classifies on nulls, and every webhook-placed deal is dragged back overnight
// (PIPELINE-FLAP). A board that adds a signal now declares it in its own
// requiredFields and the orchestrator cannot forget it.
function selectColsFor(modules) {
  const cols = new Set(['id', 'name', 'email'])
  for (const mod of modules) for (const f of mod.requiredFields) cols.add(f)
  return [...cols].join(', ')
}

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
 * @param {string[]} [args.includeDisabled=[]]  pipeline keys whose DISABLED
 *   rows at the location are dry-run as acquisition_un1t. Honoured only with
 *   dryRun; ignored (no query) otherwise.
 * @param {string[]} [args.includeDisabledBoardIds=[]]  PIPEBUILD.3d — pipeline
 *   ids of DISABLED offer boards (module `offer`) to dry-run as themselves, so
 *   an offer board can be previewed before it is switched on. Other rows are
 *   skipped. Honoured only with dryRun; ignored (no query) otherwise.
 * @param {string[]} [args.silentBoardIds=[]]  PIPEBUILD.3d — pipeline ids whose
 *   placements are made but whose stage follow-ups (moves and creates) are not
 *   fired this run. PIPEBUILD.5c — every running offer board whose baseline_at
 *   is null joins this set on its own: its first pass after switch-on places
 *   the people who already qualify without messaging them, and a real run that
 *   ends ok with no errors stamps its baseline_at (the event paths hold the
 *   board until then: placementDescriptors).
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
 *   input_source?: 'contacts'|'un1t_online',
 *   unlinked?: number,             un1t path: clients with no contact
 *   skipped_no_contact?: number,   un1t path: clients whose contact is gone
 *   stage_histogram?: object,      dry runs only: { [target slug]: n }
 *   board_overlap?: object,        dry runs only, PIPEBUILD.5c: planned cross-board
 *                                  moves INTO an offer board,
 *                                  { [offer board key]: { [from board key]: n } }
 *   boards_baselined?: string[],   real runs, PIPEBUILD.5c: the keys of the offer
 *                                  boards this run stamped baseline_at on
 *   deals_left_board?: number,     PIPEEXCL.1 (acquisition_un1t boards only): open deals closed (status 'lost')
 *                                  because the person is an active member at
 *                                  another studio of the organisation
 *   creates_withheld: number,      PIPEEXCL.1: the same people with no deal here,
 *                                  for whom none was created
 *   other_studio_check: 'ok'|'unavailable',  PIPEEXCL.1: 'unavailable' = that
 *                                  read failed, so no deal left the board and no
 *                                  deal was created this run (creates_held)
 *   error?: string,
 * }>}
 */
export async function reclassifyAllContacts(db, args) {
  const {
    locationId, dryRun = false, source = 'cron', userId = null, includeDisabled = [],
    includeDisabledBoardIds = [], silentBoardIds = [],
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

  // 1b. Which boards run at this location.
  //
  // mode='manual' boards are NEVER read or written here. That fence is the
  // whole reason a manual board can exist: FUNNEL.1 removed drag-drop because
  // this pass overwrites manual moves, so a manual board the classifier can
  // see is one whose every staff action is reverted overnight.
  //
  // A derived board whose module is not registered is SKIPPED and REPORTED,
  // never fatal — Stillorgan has a 'returning' pipeline whose module is
  // deliberately unregistered (0 deals, and it cannot fill).
  const { data: pipelineRows, error: pipelinesErr } = await db
    .from('pipelines')
    .select(PIPELINE_COLS)
    .eq('location_id', locationId)
    .eq('enabled', true)
  if (pipelinesErr) {
    await markRun(db, runId, { status: 'failed', error_message: `pipeline load: ${pipelinesErr.message}` }, startedAt)
    return { ok: false, error: `pipeline load: ${pipelinesErr.message}`, run_id: runId }
  }

  // HATCHPIPE.2 — a dry run may preview a board that is still switched off
  // (Hatch's acquisition row before it is re-enabled). Its disabled rows with
  // the named keys are classified as acquisition_un1t. Never on a real run:
  // without dryRun this issues no query at all.
  const boardRows = [...(pipelineRows || [])]
  const pipelinesSkipped = []
  if (dryRun && Array.isArray(includeDisabled) && includeDisabled.length > 0) {
    const { data: disabledRows, error: disabledErr } = await db
      .from('pipelines')
      .select(PIPELINE_COLS)
      .eq('location_id', locationId)
      .eq('enabled', false)
      .in('key', includeDisabled)
    if (disabledErr) {
      return { ok: false, error: `pipeline load: ${disabledErr.message}`, run_id: runId }
    }
    for (const p of disabledRows || []) {
      boardRows.push({ ...p, mode: PIPELINE_MODES.DERIVED, module: DRY_RUN_SELF_MODULES.includes(p.module) ? p.module : DRY_RUN_DISABLED_MODULE })
    }
  }
  // PIPEBUILD.3d — a disabled OFFER board previewed by id, as itself. Never on
  // a real run (no query), and never a row that is not an offer board.
  if (dryRun && Array.isArray(includeDisabledBoardIds) && includeDisabledBoardIds.length > 0) {
    const { data: disabledRows, error: disabledErr } = await db
      .from('pipelines')
      .select(PIPELINE_COLS)
      .eq('location_id', locationId)
      .eq('enabled', false)
      .in('id', includeDisabledBoardIds)
    if (disabledErr) {
      return { ok: false, error: `pipeline load: ${disabledErr.message}`, run_id: runId }
    }
    const have = new Set(boardRows.map((p) => p.id))
    for (const p of disabledRows || []) {
      if (have.has(p.id)) continue
      if (!OFFER_MODULES.includes(p.module)) { pipelinesSkipped.push(p.key); continue }
      boardRows.push({ ...p, mode: PIPELINE_MODES.DERIVED })
    }
  }

  let activePipelines = []
  // PIPEBUILD.3d — an offer board whose config will not parse (or that is not
  // marked board_type 'offer') is HELD: it is reported as skipped, its stages
  // are not targets, and a person with an open deal on it is left alone this
  // run. Dropping it outright would read that person as deal-less and give
  // them a second deal on another board; routing them would drain the board.
  const heldPipelines = []
  for (const p of boardRows) {
    if (p.mode === PIPELINE_MODES.MANUAL) { pipelinesSkipped.push(p.key); continue }
    const mod = getBoardModule(p.module)
    if (!mod) {
      pipelinesSkipped.push(p.key)
      logWarn('pipeline-reclassify', 'no board module registered', { key: p.key, module: p.module, locationId })
      continue
    }
    if (OFFER_MODULES.includes(p.module)) {
      // Treated as running (a dry-run preview of a disabled row included).
      const parsed = p.board_type === OFFER_BOARD_TYPE ? splitOfferBoards([{ ...p, enabled: true }]).descriptors[0] : null
      if (!parsed) {
        pipelinesSkipped.push(p.key)
        heldPipelines.push(p)
        logWarn('pipeline-reclassify', 'offer board held', { key: p.key, locationId, reason: p.board_type === OFFER_BOARD_TYPE ? 'config_unparseable' : 'not_an_offer_board' })
        continue
      }
      activePipelines.push({ ...p, mod, offerConfig: parsed.config })
      continue
    }
    activePipelines.push({ ...p, mod })
  }

  // HATCHPIPE.2 — where this run's inputs come from. One location reads one
  // source: a location also running a contacts-input board refuses its un1t
  // boards (no such location exists or is planned), so the contacts path is
  // exactly the one that ran before.
  let inputSource = 'contacts'
  // PIPEBUILD.3d — an offer board reads contacts, so it cannot run at a
  // un1t.online studio yet (PR 3b). There it is the offer board that is refused,
  // never the studio's un1t boards: switching an offer board on must not move
  // the whole studio onto the contacts path. Refused, it is also held (a person
  // with a deal on it is left alone).
  const isUn1t = (p) => p.mod.inputSource === UN1T_INPUT
  const isOffer = (p) => OFFER_MODULES.includes(p.module)
  const refuseOffers = (reason) => {
    for (const p of activePipelines) {
      if (!isOffer(p)) continue
      pipelinesSkipped.push(p.key)
      heldPipelines.push(p)
      logWarn('pipeline-reclassify', 'board refused', { key: p.key, module: p.module, locationId, reason })
    }
    activePipelines = activePipelines.filter((p) => !isOffer(p))
  }
  // The studio's own membership source decides, so an offer board switched on
  // at a un1t.online studio whose un1t boards are off is refused too (it would
  // otherwise read contacts columns there, which at a dual-studio contact hold
  // the Glofox studio's state: HATCHPIPE.2). Read only when an offer board is
  // enabled, so a night without one makes exactly today's calls. A failed read
  // holds the offer boards for the run: never a guess of "contacts".
  if (activePipelines.some(isOffer)) {
    let membershipSource
    let sourceUnreadable = false
    try {
      const { data: locRow, error: locErr } = await db
        .from('locations')
        .select('membership_source')
        .eq('id', locationId)
        .maybeSingle()
      if (locErr || !locRow) {
        sourceUnreadable = true
        logWarn('pipeline-reclassify', 'membership source unreadable', { locationId, ...(locErr ? { err: boundedErr(locErr.message) } : { reason: 'no_location_row' }) })
      } else {
        membershipSource = locRow.membership_source
      }
    } catch (e) {
      sourceUnreadable = true
      logWarn('pipeline-reclassify', 'membership source unreadable', { locationId, err: boundedErr(e?.message || e) })
    }
    // PIPEBUILD.3h — an unreadable source beside a trial_purchase offer board
    // is "cannot tell" for the claims as well: holding the offer board would
    // leave its buyers' purchases in the €39 claim, so they could land on the
    // €39 board and its follow-ups. The run places nobody (failed, retried
    // next tick), like any unreadable claim. A studio whose boards are all
    // un1t.online (+ offer) is refused as mixed_input_sources below whatever
    // its source says, so it keeps that answer; offer boards without a trial
    // purchase are held as before.
    const trialPurchaseOffer = activePipelines.some((p) => isOffer(p) && p.offerConfig?.entry?.type === 'trial_purchase')
    const un1tOnly = activePipelines.some(isUn1t) && activePipelines.every((p) => isUn1t(p) || isOffer(p))
    if (sourceUnreadable && trialPurchaseOffer && !un1tOnly) {
      refuseOffers('membership_source_unreadable')
      const errorMessage = 'claims unavailable: membership_source_unreadable'
      await markRun(db, runId, { status: 'failed', error_message: errorMessage }, startedAt)
      return { ok: false, error: errorMessage, run_id: runId, input_source: inputSource, pipelines_skipped: pipelinesSkipped }
    }
    if (sourceUnreadable) refuseOffers('membership_source_unreadable')
    else if (UN1T_MEMBERSHIP_SOURCES.includes(membershipSource)) refuseOffers('un1t_online_studio')
  }
  if (activePipelines.some(isUn1t) && activePipelines.some(isOffer)
    && activePipelines.every((p) => isUn1t(p) || isOffer(p))) {
    // A studio running un1t boards whatever its label: the same refusal.
    refuseOffers('mixed_input_sources')
  }
  if (activePipelines.some((p) => p.mod.inputSource === UN1T_INPUT)) {
    if (activePipelines.some((p) => p.mod.inputSource !== UN1T_INPUT)) {
      for (const p of activePipelines) {
        if (p.mod.inputSource !== UN1T_INPUT) continue
        pipelinesSkipped.push(p.key)
        logWarn('pipeline-reclassify', 'board refused', { key: p.key, module: p.module, locationId, reason: 'mixed_input_sources' })
      }
      activePipelines = activePipelines.filter((p) => p.mod.inputSource !== UN1T_INPUT)
    } else {
      inputSource = UN1T_INPUT
    }
  }

  if (activePipelines.length === 0) {
    await markRun(db, runId, {
      status: 'success',
      contacts_seen: 0, deals_moved: 0, deals_unchanged: 0, deals_created: 0, errors: 0,
      movement_matrix: {}, samples: [],
    }, startedAt)
    return {
      ok: true, run_id: runId, contacts_seen: 0, deals_moved: 0, deals_unchanged: 0,
      deals_created: 0, errors: 0, movement_matrix: {}, samples: [],
      pipelines_skipped: pipelinesSkipped, input_source: inputSource,
    }
  }

  // HATCHPIPE.2 — a un1t.online board's inputs, from the location's read
  // adapter. Anything short of a configured un1t.online adapter whose
  // pipelineInputs answered skips the run (retried next tick): never a
  // fallback to contacts columns, which at a dual-studio contact hold
  // Stillorgan's Glofox state.
  const nowMs = startedAt.getTime()
  let un1tInputs = null
  let un1tClassify = null
  if (inputSource === UN1T_INPUT) {
    const loaded = await loadUn1tInputs(db, locationId, nowMs)
    if (!loaded.ok) {
      const errorMessage = `un1t inputs unavailable: ${loaded.reason}`
      logWarn('pipeline-reclassify', 'inputs unavailable', {
        locationId, source: loaded.source, state: loaded.state, reason: loaded.reason,
        // The adapter's own error text (a failed read), so the miss is not silent.
        ...(loaded.err ? { err: loaded.err } : {}),
      })
      await markRun(db, runId, { status: 'failed', error_message: errorMessage }, startedAt)
      return {
        ok: false, error: errorMessage, run_id: runId,
        input_source: inputSource, pipelines_skipped: pipelinesSkipped,
      }
    }
    un1tInputs = loaded.data
    // HATCH39 — the router places each person: the acquisition board's own
    // classify (acquisition_un1t, TRIALDONE.2) answers Cold/Gympass and the
    // fallback; a live paid claim (the snapshot's paid_trial_at) goes to the
    // €39 board. With the acquisition board alone this IS today's placement.
    un1tClassify = (activePipelines.find((p) => p.key === 'acquisition') ?? activePipelines[0]).mod.classify
  }

  const activePipelineIds = activePipelines.map((p) => p.id)
  // PIPEBUILD.3d — held boards' open deals are read (so their people are left
  // alone, below); no stage of theirs is a target.
  const heldPipelineIds = new Set(heldPipelines.map((p) => p.id))
  const dealPipelineIds = heldPipelineIds.size > 0 ? [...activePipelineIds, ...heldPipelineIds] : activePipelineIds
  const selectCols = selectColsFor(activePipelines.map((p) => p.mod))
  // PIPE3 / PIPEBUILD.3b — the boards running here, for the router, as
  // descriptors (pipelines.key; at Stillorgan key and module coincide). An
  // offer board carries its parsed config; every other board board_type null,
  // which the router reads exactly as today's Set of keys.
  const boardDescriptors = activePipelines.map((p) => (p.offerConfig
    ? { key: p.key, module: p.module, board_type: OFFER_BOARD_TYPE, priority: p.priority ?? 100, config: p.offerConfig }
    : { key: p.key, module: p.module, board_type: null, priority: p.priority ?? null, config: null }))
  const offerPipelines = activePipelines.filter((p) => p.offerConfig)
  const offerPipelineIds = new Set(offerPipelines.map((p) => p.id))
  // PIPEEXCL.1 — an offer board's Converted column is a customer stage here,
  // like the €39 board's: a person who joined through it keeps it.
  const offerCustomerSlugs = new Set(offerPipelines.flatMap((p) => p.offerConfig.stages
    .filter((st) => st.role === 'converted').map((st) => st.slug)))
  // Whether the contacts path needs claims loaded: the €39/Programmes claims
  // (trial_purchases, pipeline_board_claims, the programme rules) and, read
  // separately, the offer boards' claims (PIPEBUILD.3d). Neither table is read
  // at a studio running neither kind of board.
  const needsLegacyClaims = inputSource !== UN1T_INPUT && activePipelines.some((p) => CLAIM_BOARD_MODULES.includes(p.module))
  const needsOfferClaims = inputSource !== UN1T_INPUT && offerPipelines.length > 0
  const needsClaims = needsLegacyClaims || needsOfferClaims
  // STILL39SEQ.1 / PIPEBUILD.3d — the contacts-input boards here whose landed
  // moves (and, on an offer board, creates) fire.
  const triggerPipelineIds = new Set(inputSource === UN1T_INPUT ? [] : activePipelines
    .filter((p) => CONTACTS_STAGE_TRIGGER_MODULES.includes(p.module))
    .map((p) => p.id))
  // PIPEBUILD.3d — boards placed this run without starting any follow-up.
  // PIPEBUILD.5c — every running offer board not yet baselined is one of them
  // (the option's ids are kept beside it). A dry run builds the same set so its
  // counts describe the real run; it fires and stamps nothing either way.
  const unbaselinedOffers = offerPipelines.filter((p) => p.baseline_at == null)
  const silentIds = new Set([
    ...(Array.isArray(silentBoardIds) ? silentBoardIds : []),
    ...unbaselinedOffers.map((p) => p.id),
  ])

  // 2. Build the slug → stage_id lookup ONCE for this location.
  // PIPELINES.5 — pipeline_id comes back with the stage because the create
  // path below MUST stamp it on the deal it inserts. This orchestrator scopes
  // its own deal read with `.in('pipeline_id', …)` (step 4), and SQL IN never
  // matches NULL: a deal created here without one is invisible to the NEXT
  // run, which sees the contact as deal-less and creates another — nightly,
  // unbounded, for every new lead. Taking it off the stage rather than off the
  // iteration also keeps deals.pipeline_id and deals.stage_id in agreement by
  // construction.
  const { data: stages, error: stagesErr } = await db
    .from('pipeline_stages')
    .select('id, slug, pipeline_id')
    .eq('location_id', locationId)
    .in('pipeline_id', activePipelineIds)
  if (stagesErr) {
    await markRun(db, runId, { status: 'failed', error_message: `stage load: ${stagesErr.message}` }, startedAt)
    return { ok: false, error: `stage load: ${stagesErr.message}`, run_id: runId }
  }
  const stageIdBySlug = new Map((stages || []).map((s) => [s.slug, s.id]))
  const stageSlugById = new Map((stages || []).map((s) => [s.id, s.slug]))
  const stagePipelineById = new Map((stages || []).map((s) => [s.id, s.pipeline_id]))

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
  //
  //    HATCHPIPE.2 — on the un1t path the people are pipelineInputs' list
  //    (every contact a un1t client row at this studio links to, whoever owns
  //    the contact) and contacts is not read here at all.
  const PAGE_SIZE = 1000
  const HARD_LIMIT = 20_000
  const contacts = un1tInputs ? un1tInputs.contacts.slice() : []
  let pageErr = null

  if (!un1tInputs) {
    let pageStart = 0
    while (true) {
      const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
      const { data: page, error } = await db
        .from('contacts')
        .select(selectCols)
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
    // PIPEBUILD.5c — nobody to place is still a classified board: stamp it.
    const baselined = !dryRun && unbaselinedOffers.length > 0 ? await stampBaselines(db, locationId, unbaselinedOffers) : null
    return { ok: true, run_id: runId, contacts_seen: 0, deals_moved: 0, deals_unchanged: 0, deals_created: 0, errors: 0, movement_matrix: {}, samples: [], pipelines_skipped: pipelinesSkipped, ...un1tCounts(inputSource, un1tInputs), ...(baselined ? { boards_baselined: baselined } : {}), ...(dryRun ? { board_overlap: {} } : {}) }
  }

  // 3b. PIPE3 — the claims the router needs: the paid-trial rows and the
  //     recorded programme claims for this run's contacts, plus the studio's
  //     programme rules. An unreadable claim is "cannot tell", never "no
  //     claims": the run stops here (audit row failed, retried next tick)
  //     rather than moving every €39 buyer back to the acquisition board.
  //     New programme matches are recorded BEFORE routing on a real run and
  //     applied in memory on a dry run (claims_pending).
  //     PIPEBUILD.3d — and the offer boards' claims (pipeline-offer-claims.js),
  //     read only when an offer board runs here. Every read happens before any
  //     claim is written: an offer read failing after the programme claims were
  //     recorded would leave half a run's bookkeeping behind a failed run.
  let paidByContact = new Map()
  let programmeByContact = new Map()
  let offersByContact = new Map()
  let claimsPending = 0
  const failClaims = async (reason) => {
    const errorMessage = `claims unavailable: ${reason}`
    await markRun(db, runId, { status: 'failed', error_message: errorMessage }, startedAt)
    return { ok: false, error: errorMessage, run_id: runId, input_source: inputSource, pipelines_skipped: pipelinesSkipped }
  }
  let programmePending = []
  // The offer boards running here, as the claim loaders read them. Treated as
  // running (a dry-run preview of a disabled row included).
  const offerBoardRows = offerPipelines.map((p) => ({ id: p.id, key: p.key, priority: p.priority, board_type: p.board_type, config: p.config, enabled: true }))
  if (needsLegacyClaims) {
    const rules = await loadProgrammeRules(db, locationId)
    if (!rules.ok) return failClaims(rules.reason)
    // PIPEBUILD.3g — a purchase a trial_purchase offer board matches is that
    // board's claim, never also a €39 paid claim (offerBoards; no such board =
    // today's claims exactly).
    const claims = await loadClaimsForLocation(db, {
      locationId, contactIds: new Set(contacts.map((c) => c.id)), now: nowMs, offerBoards: offerBoardRows,
    })
    if (!claims.ok) return failClaims(claims.reason)
    paidByContact = claims.paidByContact
    programmeByContact = claims.programmeByContact
    programmePending = pendingProgrammeClaims(contacts, programmeByContact, rules.rules, nowMs)
  }
  let offerPending = []
  if (needsOfferClaims) {
    let offers
    try {
      offers = await loadOfferClaimsForLocation(db, {
        locationId,
        boards: offerBoardRows,
        contacts,
        now: nowMs,
      })
    } catch (e) {
      offers = { ok: false, reason: 'offer_claims_threw', err: boundedErr(e?.message || e) }
    }
    if (!offers?.ok) {
      logWarn('pipeline-reclassify', 'offer claims unavailable', { locationId, reason: offers?.reason || 'unknown', ...(offers?.err ? { err: offers.err } : {}) })
      return failClaims(offers?.reason || 'unknown')
    }
    offersByContact = offers.offersByContact instanceof Map ? offers.offersByContact : new Map()
    offerPending = Array.isArray(offers.pending) ? offers.pending : []
  }
  claimsPending = programmePending.length + offerPending.length
  if (programmePending.length > 0) {
    if (!dryRun) {
      const wrote = await upsertProgrammeClaims(db, locationId, programmePending, nowMs)
      // A lost claim write is never grounds to stop: the lead-source match is
      // re-derived next run (a plan match re-dates to that run). Logged by
      // the helper; the placement below still uses the in-memory claim.
      if (!wrote.ok) logWarn('pipeline-reclassify', 'programme claims not recorded', { locationId, pending: programmePending.length })
    }
    for (const row of programmePending) {
      programmeByContact.set(row.contact_id, { claimedAt: Date.parse(row.claimed_at), source: row.source })
    }
  }
  // The offer loader already placed its pending claims in offersByContact; a
  // real run records them (the same never-stop rule as the programme claims).
  if (offerPending.length > 0 && !dryRun) {
    const wrote = await upsertBoardClaims(db, locationId, offerPending, nowMs)
    if (!wrote.ok) logWarn('pipeline-reclassify', 'offer claims not recorded', { locationId, pending: offerPending.length })
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
      // PIPE3 — pipeline_id too: a move across boards must know the board it leaves.
      .select('id, contact_id, stage_id, pipeline_id')
      .eq('location_id', locationId)
      .eq('status', 'open')
      .in('pipeline_id', dealPipelineIds)
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
  // PIPE3 fix pass — EVERY open deal per contact. One is the rule (one open
  // deal per contact per board, mig 598, and the router keeps a person on one
  // board), but a public form racing a move can leave two: the loop below
  // keeps the deal on the contact's TARGET board and closes the surplus
  // 'lost' (mig 598's own rule for duplicates), so a person is never on two
  // boards and a cross-board move never collides with the unique index.
  const dealsByContact = new Map()
  for (const d of dealRows || []) {
    // Skip deals belonging to contacts we didn't load (a contact at
    // a different location somehow joined to a deal here, or a
    // contact deleted between the two queries).
    if (!contactIdSet.has(d.contact_id)) continue
    if (!dealsByContact.has(d.contact_id)) dealsByContact.set(d.contact_id, [])
    dealsByContact.get(d.contact_id).push(d)
  }

  // 4b. PIPEEXCL.1 — the people who are active members at ANOTHER studio of
  //     this organisation (Richard, 19 Oct 2026: a Stillorgan member is not a
  //     Hatch prospect). Unless the board already shows them as a customer
  //     HERE (leavesBoard), their open deal leaves the board and none is
  //     created for them.
  //
  //     PIPEEXCL.2 (Richard, 22 Oct 2026): the rule runs on EVERY derived
  //     acquisition board, Glofox and un1t.online, and "active elsewhere" also
  //     means TRAINING elsewhere (a live class booking at the other studio in
  //     the window, pipeline-other-studio-members.js). Hatch Street's
  //     customers and trialers had been Stillorgan's New Leads: their Stillorgan
  //     contact row (a race entry or a free-trial grant in Stillorgan's Glofox)
  //     classified as a lead, and PIPEEXCL.1 ran on Hatch's board only.
  //
  //     The classifier itself has never removed a deal: a contact who stops
  //     qualifying for the funnel moves to an off-funnel pile, still on the
  //     board. Leaving uses the one way a deal already leaves a board, the
  //     staff close (deals.status 'lost', PUT /api/deals/[id], the phone's
  //     Mark lost): the row and its history stay, every board reads open deals
  //     only, and if the membership elsewhere ends a NEW deal is created at the
  //     classifier's stage on a later run. Never a delete.
  //
  //     A failed read is never "nobody is a member there": this run closes
  //     nothing and creates nothing (a create could re-open a deal a person
  //     left the board with), logs why, and still makes the stage moves, so
  //     time-based decay keeps working. Manual boards are never read here.
  const excludeOtherStudio = activePipelines.some((p) => EXCLUDING_MODULES.has(p.module))
  let elsewhere = null
  if (excludeOtherStudio) {
    try {
      elsewhere = await loadActiveElsewhere(db, locationId)
    } catch (e) {
      elsewhere = { ok: false, reason: 'threw', err: boundedErr(e?.message || e) }
    }
  }
  const activeElsewhere = elsewhere?.ok ? elsewhere.contactIds : null
  // PIPEEXCL.2 — why each one leaves; absent (an older answer) reads as member.
  // And who trains HERE too: a training reason never removes them.
  const elsewhereReasons = elsewhere?.ok && elsewhere.reasons instanceof Map ? elsewhere.reasons : new Map()
  const trainingHere = elsewhere?.ok && elsewhere.trainingHere instanceof Set ? elsewhere.trainingHere : new Set()
  const elsewhereReason = (id) => (elsewhereReasons.get(id) === ELSEWHERE_TRAINING ? ELSEWHERE_TRAINING : ELSEWHERE_MEMBER)
  const exclusionFailed = excludeOtherStudio && !activeElsewhere

  // 5. Classify each contact + decide move / leave / create.
  let dealsMoved = 0
  let dealsUnchanged = 0
  let dealsCreated = 0
  let dealsLeftBoard = 0
  let boardsMoved = 0 // PIPE3 — deals that changed board (pipeline_id) this run
  let errors = 0
  const movementMatrix = {} // { from_slug: { to_slug: count } }
  const samples = []
  const movesToApply = [] // [{ deal_id, contact_id, from_slug, to_slug, target_stage_id, contact_name }]
  const createsToApply = [] // [{ contact_id, target_stage_id, target_slug, contact_name }]
  const movesLanded = [] // TDSEQ.1 / STILL39SEQ.1: real runs, firing boards: the moves whose write landed
  const rebookCreated = [] // REBOOK.1: real runs, the deals created straight into Rebook
  const leavesToApply = [] // PIPEEXCL.1: [{ deal_id, contact_id, from_slug, contact_name }]
  const duplicatesToClose = [] // PIPE3: surplus open deals, [{ deal_id, contact_id }]
  let duplicateDealsClosed = 0
  let createsWithheld = 0
  let createsHeld = 0
  let dealsHeld = 0 // PIPEBUILD.3d: people left alone because a deal of theirs sits on a held board
  const createsLanded = [] // PIPEBUILD.3d: real runs, offer boards: creates whose insert landed
  const stageHistogram = {} // dry runs only: { target_slug: count }
  const boardHistogram = {} // dry runs only, PIPE3: { board key: count }

  // HATCHPIPE.2 — the un1t path classifies the contact's snapshot (built from
  // this studio's un1t rows). No snapshot → null → counted as an error below.
  // HATCH39 — through the router: the snapshot's paid_trial_at is the €39 claim.
  const routeFromSnapshot = (contactId) => {
    const snapshot = un1tInputs.snapshots.get(contactId)
    if (!snapshot) return null
    return routeContact(
      snapshot,
      { paid: paidClaimFromSnapshot(snapshot), programme: null },
      nowMs,
      boardDescriptors,
      { classifyAcquisition: un1tClassify },
    )
  }

  // PIPE3 — the contacts path places through the router. The row carries
  // every column the active boards declared (selectColsFor), which is what the
  // old inline field list guaranteed for classifyContact; with the acquisition
  // board alone the router IS classifyContact. PIPEBUILD.3d — with the
  // person's offer claims (Map<boardKey, claim>), which the router reads only
  // for the offer boards among the descriptors.
  const routeFromRow = (c) => routeContact(
    c,
    { paid: paidByContact.get(c.id) ?? null, programme: programmeByContact.get(c.id) ?? null, offers: offersByContact.get(c.id) ?? null },
    nowMs,
    boardDescriptors,
  )

  for (const c of contacts) {
    // PIPEBUILD.3d — a person with an open deal on a held offer board is left
    // exactly as they are this run: no move, no create, no close.
    if (heldPipelineIds.size > 0 && (dealsByContact.get(c.id) || []).some((d) => heldPipelineIds.has(d.pipeline_id))) {
      dealsHeld++
      continue
    }
    const route = un1tInputs ? routeFromSnapshot(c.id) : routeFromRow(c)
    const targetSlug = route ? route.slug : null
    const targetStageId = stageIdBySlug.get(targetSlug)
    if (!targetStageId) {
      // Migration set should guarantee every slug exists; if not,
      // count + move on rather than crashing the whole run.
      errors++
      continue
    }
    // PIPE3 — the deal on the target board wins; any other open deal is surplus.
    const open = dealsByContact.get(c.id) || []
    const targetPipelineForPick = stagePipelineById.get(targetStageId) || null
    const existing = open.find((d) => d.pipeline_id && d.pipeline_id === targetPipelineForPick) || open[0] || undefined
    for (const d of open) {
      if (existing && d.id !== existing.id) duplicatesToClose.push({ deal_id: d.id, contact_id: c.id })
    }

    // PIPEEXCL.1 — an active member at another studio leaves this board.
    if (activeElsewhere && !offerCustomerSlugs.has(targetSlug)
      && leavesBoard(targetSlug, activeElsewhere.has(c.id), { reason: elsewhereReason(c.id), trainsHere: trainingHere.has(c.id) })) {
      if (existing) {
        leavesToApply.push({
          deal_id: existing.id,
          contact_id: c.id,
          from_slug: stageSlugById.get(existing.stage_id) || 'unknown',
          contact_name: c.name || c.email || null,
          reason: elsewhereReason(c.id),
        })
      } else {
        createsWithheld++
      }
      continue
    }

    if (dryRun) {
      stageHistogram[targetSlug] = (stageHistogram[targetSlug] || 0) + 1
      if (route) boardHistogram[route.boardKey] = (boardHistogram[route.boardKey] || 0) + 1
    }

    if (!existing) {
      // PIPEEXCL.1 — the other-studio read failed: hold every create this run.
      if (exclusionFailed) { createsHeld++; continue }
      // No open deal yet — create one in the right stage.
      createsToApply.push({
        contact_id: c.id,
        target_stage_id: targetStageId,
        target_pipeline_id: stagePipelineById.get(targetStageId) || null,
        target_slug: targetSlug,
        contact_name: c.name || c.email || (un1tInputs ? 'Member' : 'Glofox member'),
        // HATCHPIPE.5 — on the un1t path a NEW deal carries the real dates
        // (client creation; the evidence for its stage). Null = the column
        // default, now. A MOVE never sets them: the mig 458 trigger stamps
        // stage_entered_at when stage_id changes, i.e. when the CRM saw it.
        dates: un1tInputs ? un1tDealDates(targetSlug, un1tInputs.evidence?.get(c.id) ?? null, nowMs) : null,
      })
      continue
    }

    const fromSlug = stageSlugById.get(existing.stage_id) || 'unknown'
    if (fromSlug === targetSlug) {
      dealsUnchanged++
      continue
    }
    // PIPE3 — a deal follows the person across boards: the same row gets the
    // new pipeline_id with its new stage_id, in one update (never close and
    // recreate: history stays, lost counts stay honest).
    const targetPipelineId = stagePipelineById.get(targetStageId) || null
    const crossBoard = Boolean(existing.pipeline_id && targetPipelineId && existing.pipeline_id !== targetPipelineId)
    movesToApply.push({
      deal_id: existing.id,
      contact_id: c.id,
      from_slug: fromSlug,
      to_slug: targetSlug,
      target_stage_id: targetStageId,
      target_pipeline_id: targetPipelineId,
      from_pipeline_id: existing.pipeline_id || null,
      cross_board: crossBoard,
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
      // PIPE3 — a stage belongs to one board, so the group shares one target
      // pipeline_id; it is written only when a deal in the group changes board
      // (a same-board move keeps today's stage-only payload).
      const groupCrossBoard = moves.some((m) => m.cross_board)
      // TDSEQ.1 / STILL39SEQ.1 — every move in a group lands on one board: the
      // un1t boards and the contacts-path boards in CONTACTS_STAGE_TRIGGER_MODULES
      // fire the stage-change trigger, so their write is guarded and counted.
      const groupFires = inputSource === UN1T_INPUT || triggerPipelineIds.has(moves[0].target_pipeline_id)
      const movePatch = groupCrossBoard ? { stage_id: stageId, pipeline_id: moves[0].target_pipeline_id } : { stage_id: stageId }
      for (let i = 0; i < moves.length; i += BULK_UPDATE_CHUNK) {
        const chunk = moves.slice(i, i + BULK_UPDATE_CHUNK)
        const dealIds = chunk.map((m) => m.deal_id)
        // TDSEQ.1 — on a firing board the move is guarded on status 'open' and
        // returns the ids it changed: only those start a sequence (a deal
        // closed between the read and this write must not). Every other
        // contacts (Glofox) board's write is unchanged.
        const moveQuery = db
          .from('deals')
          .update(movePatch)
          .in('id', dealIds)
        const { data: movedRows, error: moveErr } = groupFires
          ? await moveQuery.eq('status', 'open').select('id')
          : await moveQuery
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
        boardsMoved += chunk.filter((m) => m.cross_board).length
        if (groupFires) {
          const changed = new Set((movedRows || []).map((r) => r.id))
          movesLanded.push(...chunk.filter((m) => changed.has(m.deal_id)))
        }
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
          pipeline_id: c.target_pipeline_id,
          location_id: locationId,
          status: 'open',
          // Mig 458's trigger is BEFORE UPDATE OF stage_id only: an insert
          // keeps both values as given. Absent → default now(), as before.
          ...(c.dates?.created_at ? { created_at: c.dates.created_at } : {}),
          ...(c.dates?.stage_entered_at ? { stage_entered_at: c.dates.stage_entered_at } : {}),
        })
      if (createErr) {
        errors++
        logWarn('pipeline-reclassify', `deal create failed for ${c.contact_id}`, { err: createErr.message })
        continue
      }
      dealsCreated++
      if (c.target_slug === REBOOK_SLUG) rebookCreated.push({ contact_id: c.contact_id })
      // PIPEBUILD.3d — a card first placed on an offer board starts that
      // column's follow-ups (null → slug), only once its insert landed.
      if (offerPipelineIds.has(c.target_pipeline_id) && triggerPipelineIds.has(c.target_pipeline_id)) {
        createsLanded.push({ contact_id: c.contact_id, from_slug: null, to_slug: c.target_slug, target_pipeline_id: c.target_pipeline_id })
      }
      movementMatrix[''] = movementMatrix[''] || {}
      movementMatrix[''][c.target_slug] = (movementMatrix[''][c.target_slug] || 0) + 1
    }

    // PIPEEXCL.1 — close the deals of people who are active members at another
    // studio. Guarded on this studio and on status 'open'; only the rows the
    // UPDATE returns are counted (a deal closed or moved off 'open' since the
    // read is not).
    const leftActivities = []
    for (let i = 0; i < leavesToApply.length; i += BULK_UPDATE_CHUNK) {
      const chunk = leavesToApply.slice(i, i + BULK_UPDATE_CHUNK)
      const { data: closed, error: closeErr } = await db
        .from('deals')
        .update({ status: 'lost' })
        .in('id', chunk.map((m) => m.deal_id))
        .eq('location_id', locationId)
        .eq('status', 'open')
        .select('id')
      if (closeErr) {
        errors += chunk.length
        logWarn('pipeline-reclassify', 'leave-board chunk failed', {
          err: boundedErr(closeErr.message), chunk_start: i, chunk_size: chunk.length, locationId,
        })
        continue
      }
      const closedIds = new Set((closed || []).map((r) => r.id))
      for (const m of chunk) {
        if (!closedIds.has(m.deal_id)) continue
        dealsLeftBoard++
        movementMatrix[m.from_slug] = movementMatrix[m.from_slug] || {}
        movementMatrix[m.from_slug][LEFT_BOARD] = (movementMatrix[m.from_slug][LEFT_BOARD] || 0) + 1
        leftActivities.push({
          ...LEFT_BOARD_ACTIVITY[m.reason] || LEFT_BOARD_ACTIVITY[ELSEWHERE_MEMBER],
          type: 'pipeline',
          contact_id: m.contact_id,
          deal_id: m.deal_id,
          done: true,
          location_id: locationId,
        })
      }
    }
    // The contact's timeline says why the deal closed. Best-effort: the close
    // already landed, and a lost note is not worth failing the run for.
    for (let i = 0; i < leftActivities.length; i += BULK_UPDATE_CHUNK) {
      const { error: actErr } = await db.from('activities').insert(leftActivities.slice(i, i + BULK_UPDATE_CHUNK))
      if (actErr) logWarn('pipeline-reclassify', 'leave-board activity write failed', { err: boundedErr(actErr.message), locationId })
    }

    // PIPE3 — surplus open deals (a person on two boards) close 'lost'.
    for (let i = 0; i < duplicatesToClose.length; i += BULK_UPDATE_CHUNK) {
      const chunk = duplicatesToClose.slice(i, i + BULK_UPDATE_CHUNK)
      const { data: closed, error: dupErr } = await db
        .from('deals')
        .update({ status: 'lost' })
        .in('id', chunk.map((m) => m.deal_id))
        .eq('location_id', locationId)
        .eq('status', 'open')
        .select('id')
      if (dupErr) {
        errors += chunk.length
        logWarn('pipeline-reclassify', 'duplicate-deal close failed', { err: boundedErr(dupErr.message), chunk_start: i, locationId })
        continue
      }
      duplicateDealsClosed += Array.isArray(closed) ? closed.length : 0
    }
    if (duplicateDealsClosed > 0) logWarn('pipeline-reclassify', 'duplicate open deals closed', { locationId, closed: duplicateDealsClosed })
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
    boardsMoved = movesToApply.filter((m) => m.cross_board).length
    duplicateDealsClosed = duplicatesToClose.length
    for (const m of leavesToApply) {
      movementMatrix[m.from_slug] = movementMatrix[m.from_slug] || {}
      movementMatrix[m.from_slug][LEFT_BOARD] = (movementMatrix[m.from_slug][LEFT_BOARD] || 0) + 1
    }
    dealsLeftBoard = leavesToApply.length
  }

  // PIPEBUILD.5c — on a dry run, who an offer board would take off another
  // board (keyed by board key), so the owner sees the overlap before switching
  // it on. Every board in boardRows is named (held and previewed ones included).
  const boardOverlap = {}
  if (dryRun) {
    const keyById = new Map(boardRows.map((p) => [p.id, p.key]))
    for (const m of movesToApply) {
      if (!m.cross_board || !offerPipelineIds.has(m.target_pipeline_id)) continue
      const to = keyById.get(m.target_pipeline_id)
      const from = keyById.get(m.from_pipeline_id) || 'unknown'
      if (!to) continue
      boardOverlap[to] = boardOverlap[to] || {}
      boardOverlap[to][from] = (boardOverlap[to][from] || 0) + 1
    }
  }

  // PIPEEXCL.1 — a failed other-studio read is logged once, structurally.
  let otherStudioError = null
  if (exclusionFailed) {
    otherStudioError = `other-studio members unavailable: ${elsewhere?.reason || 'unknown'}`
    logWarn('pipeline-reclassify', 'other-studio members unavailable', {
      locationId,
      reason: elsewhere?.reason || 'unknown',
      ...(elsewhere?.studioId ? { studioId: elsewhere.studioId } : {}),
      ...(elsewhere?.err ? { err: elsewhere.err } : {}),
      creates_held: createsHeld,
    })
  }

  // 7. Close the audit row.
  const status = errors === 0 ? 'success' : (dealsMoved + dealsCreated + dealsLeftBoard > 0 ? 'partial' : 'failed')
  await markRun(db, runId, {
    status,
    ...(otherStudioError ? { error_message: otherStudioError } : {}),
    contacts_seen: contacts.length,
    deals_moved: dealsMoved,
    deals_unchanged: dealsUnchanged,
    deals_created: dealsCreated,
    errors,
    movement_matrix: movementMatrix,
    samples,
  }, startedAt)

  // TDSEQ.1 — a landed MOVE on a un1t.online board (STILL39SEQ.1: or on a
  // contacts board in CONTACTS_STAGE_TRIGGER_MODULES) starts the board studio's
  // pipeline_stage_change sequences (never a create, a leave or a dry run:
  // movesLanded holds only real moves whose write succeeded). After every
  // write and the audit close, so a slow or failing enrolment can never fail
  // or hold up the run.
  // PIPEBUILD.3d — and a landed create on an offer board, counted per stage
  // with the moves for the mass guard. A silent board fires neither.
  const firing = [...movesLanded, ...createsLanded].filter((m) => !silentIds.has(m.target_pipeline_id))
  if (firing.length > 0) await fireStageTriggers(firing, locationId)

  // REBOOK.1 — a card that landed in Rebook gets a timeline note naming the
  // class it booked and what became of it. un1t.online boards only (the one
  // classify that answers 'rebook'); best-effort, after everything else.
  if (!dryRun && inputSource === UN1T_INPUT) {
    const rebookLanded = [
      ...movesLanded.filter((m) => m.to_slug === REBOOK_SLUG).map((m) => ({ contact_id: m.contact_id, deal_id: m.deal_id })),
      ...rebookCreated,
    ]
    if (rebookLanded.length > 0) await writeRebookNotes(db, { locationId, landed: rebookLanded, nowMs })
  }

  // PIPEBUILD.5c — a real run that placed everyone it meant to stamps the
  // offer boards it baselined silently, so tomorrow's newcomers get their
  // follow-ups and the event paths stop holding them. Not after any error (a
  // failed write may have left a qualifier unplaced, who would then be placed
  // loudly), and not when the other-studio read failed (every create was held,
  // so the people who already qualify are still to be placed). A failed stamp
  // is logged and leaves the board silent another night; the run stays ok.
  let baselined = null
  if (!dryRun && unbaselinedOffers.length > 0 && errors === 0 && !exclusionFailed) {
    baselined = await stampBaselines(db, locationId, unbaselinedOffers)
  }

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
    pipelines_skipped: pipelinesSkipped,
    ...(excludeOtherStudio ? {
      deals_left_board: dealsLeftBoard,
      creates_withheld: createsWithheld,
      other_studio_check: activeElsewhere ? 'ok' : 'unavailable',
      ...(activeElsewhere ? {} : { creates_held: createsHeld }),
    } : {}),
    ...un1tCounts(inputSource, un1tInputs),
    ...(dryRun ? { stage_histogram: stageHistogram } : {}),
    // PIPE3 / HATCH39
    boards_moved: boardsMoved,
    duplicate_deals_closed: duplicateDealsClosed,
    ...(needsClaims ? { claims_pending: claimsPending } : {}),
    ...(dryRun ? { board_histogram: boardHistogram } : {}),
    ...(heldPipelineIds.size > 0 ? { deals_held: dealsHeld } : {}),
    ...(dryRun ? { board_overlap: boardOverlap } : {}),
    ...(baselined ? { boards_baselined: baselined } : {}),
  }
}

// PIPEBUILD.5c — stamp baseline_at on offer boards a real run classified while
// they were unbaselined. Guarded on the studio and on baseline_at still null
// (a board stamped since, or switched off and on again, is left to its own
// state). Every failure is logged with ids only and never fails the run: the
// board just stays silent until a later pass stamps it.
async function stampBaselines(db, locationId, boards) {
  const nowIso = new Date().toISOString()
  const stamped = []
  for (const p of boards) {
    try {
      const { data, error } = await db
        .from('pipelines')
        .update({ baseline_at: nowIso, updated_at: nowIso })
        .eq('id', p.id)
        .eq('location_id', locationId)
        .is('baseline_at', null)
        .select('id')
      if (error) {
        logError('pipeline-reclassify', 'offer board baseline not stamped', { locationId, pipelineId: p.id, key: p.key, err: boundedErr(error.message) })
        continue
      }
      // Zero rows: stamped already, or no longer this studio's — nothing to do.
      if (Array.isArray(data) && data.length > 0) stamped.push(p.key)
    } catch (e) {
      logError('pipeline-reclassify', 'offer board baseline not stamped', { locationId, pipelineId: p.id, key: p.key, err: boundedErr(e?.message || e) })
    }
  }
  return stamped
}

// TDSEQ.1 — fire triggerSequencesForPipelineStageChange for each landed un1t
// board move, with the board's studio. Glofox (contacts-input) boards come here
// only when their module is in CONTACTS_STAGE_TRIGGER_MODULES (STILL39SEQ.1:
// the €39 board, whose Day 7 and Trial Done moves are made by time, in this
// pass); every other Glofox board fires through ensureDealForContact, and a
// nightly re-run of this pass is not a new event for it. Enrolment is once per
// person per sequence, so a move ensureDealForContact also fired is harmless. A move from an unknown
// stage (from_slug 'unknown') never fires. PIPEBUILD.3d — offer boards fire
// their moves AND their landed creates (from_slug null), one count per stage. Best-effort: a throw is
// logged and the next move still fires. A stage that took more than
// STAGE_TRIGGER_MASS_MOVE moves this run is held whole (a classifier rule
// change moving many deals at once is not N people progressing).
async function fireStageTriggers(moves, locationId) {
  const byStage = new Map()
  for (const m of moves) {
    // A deal on a stage id this run could not name is stage-id churn, not
    // someone progressing: no sequence starts from it.
    if (m.from_slug === 'unknown') continue
    if (!byStage.has(m.to_slug)) byStage.set(m.to_slug, [])
    byStage.get(m.to_slug).push(m)
  }
  for (const [toSlug, stageMoves] of byStage) {
    if (stageMoves.length > STAGE_TRIGGER_MASS_MOVE) {
      logWarn('pipeline-reclassify', 'stage trigger held: mass move', {
        locationId, to_slug: toSlug, moves: stageMoves.length, limit: STAGE_TRIGGER_MASS_MOVE,
      })
      continue
    }
    for (const m of stageMoves) {
      try {
        await triggerSequencesForPipelineStageChange(m.contact_id, m.from_slug, m.to_slug, { locationId })
      } catch (e) {
        logWarn('pipeline-reclassify', 'stage trigger failed', {
          locationId, contactId: m.contact_id, to_slug: m.to_slug, err: boundedErr(e?.message || e),
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HATCHPIPE.5 — one-off backfill of the real dates onto existing un1t deals.
// ---------------------------------------------------------------------------
const RESTAMP_SAMPLE = 10
// A deal is inserted with created_at = stage_entered_at = now(), so a stage
// date more than this after created_at was stamped by the mig 458 trigger on a
// later stage MOVE, and already holds the true time.
const RESTAMP_MOVED_GAP_MS = 1000
const msOrNull = (v) => {
  if (v == null) return null
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Re-date every OPEN deal on the location's enabled un1t.online boards from
 * the un1t evidence (un1tDealDates): created_at = funnel entry, and
 * stage_entered_at = entry to the stage the deal sits in NOW. Neither stage_id
 * nor any other column is written, so the stage never changes and the mig 458
 * trigger (BEFORE UPDATE OF stage_id) and the stage-change activity trigger do
 * not fire. The contacts.pipeline_stage_slug trigger (mig 736) runs on every
 * deals UPDATE but recomputes the same slug: the stage is unchanged, and
 * created_at only breaks ties between several open deals on the same tier,
 * which the reclassifier never makes (one open deal per contact per board).
 *
 * Each deal is updated on its own row, guarded on id, location, board, the
 * stage read and status 'open': a deal that moved or closed since the read is
 * skipped (skipped_changed), never stamped with the wrong stage's date. A
 * deal whose stage_entered_at is more than 1 s after its created_at has MOVED
 * stage since it was created (both are now() on insert), so the trigger's
 * stamp is kept and only created_at may change (kept_moved). A field with no
 * evidence is left as it is; a deal with no evidence for either
 * is counted no_evidence. created_at is never set later than the deal's
 * (new or kept) stage_entered_at. No audit row: it changes no stage.
 *
 * @param {SupabaseClient} db
 * @param {{ locationId: string, dryRun?: boolean, now?: number }} args
 * @returns {Promise<{ ok: boolean, dry_run: boolean, un1t_boards: string[],
 *   deals_seen: number, updated: number, unchanged: number, no_evidence: number,
 *   skipped_changed: number, kept_moved: number, errors: number,
 *   sample: Array<{ deal_id, stage_slug, created_at?: {from,to}, stage_entered_at?: {from,to} }>,
 *   error?: string }>}
 */
export async function restampUn1tDealDates(db, { locationId, dryRun = false, now = Date.now() } = {}) {
  const counts = { deals_seen: 0, updated: 0, unchanged: 0, no_evidence: 0, skipped_changed: 0, kept_moved: 0, errors: 0 }
  const base = { dry_run: dryRun, un1t_boards: [] }
  if (!locationId) return { ok: false, error: 'locationId required', ...base, ...counts, sample: [] }

  const { data: pipelineRows, error: pipelinesErr } = await db
    .from('pipelines')
    .select('id, key, module, mode, enabled, is_primary')
    .eq('location_id', locationId)
    .eq('enabled', true)
  if (pipelinesErr) {
    logWarn('pipeline-reclassify', 'restamp pipeline load failed', { locationId, err: pipelinesErr.message })
    return { ok: false, error: `pipeline load: ${pipelinesErr.message}`, ...base, ...counts, sample: [] }
  }
  const boards = (pipelineRows || []).filter((p) => p.mode !== PIPELINE_MODES.MANUAL
    && getBoardModule(p.module)?.inputSource === UN1T_INPUT)
  base.un1t_boards = boards.map((p) => p.key)
  if (boards.length === 0) return { ok: true, ...base, ...counts, sample: [] }

  const loaded = await loadUn1tInputs(db, locationId, now)
  if (!loaded.ok) {
    logWarn('pipeline-reclassify', 'restamp inputs unavailable', {
      locationId, source: loaded.source, state: loaded.state, reason: loaded.reason,
      ...(loaded.err ? { err: loaded.err } : {}),
    })
    return { ok: false, error: `un1t inputs unavailable: ${loaded.reason}`, ...base, ...counts, sample: [] }
  }
  const evidence = loaded.data.evidence instanceof Map ? loaded.data.evidence : new Map()

  const boardIds = boards.map((p) => p.id)
  const { data: stages, error: stagesErr } = await db
    .from('pipeline_stages')
    .select('id, slug, pipeline_id')
    .eq('location_id', locationId)
    .in('pipeline_id', boardIds)
  if (stagesErr) {
    logWarn('pipeline-reclassify', 'restamp stage load failed', { locationId, err: stagesErr.message })
    return { ok: false, error: `stage load: ${stagesErr.message}`, ...base, ...counts, sample: [] }
  }
  const slugById = new Map((stages || []).map((s) => [s.id, s.slug]))

  // Same .range() paging as the reclassifier (the 1,000-row cap).
  const PAGE_SIZE = 1000
  const HARD_LIMIT = 20_000
  const deals = []
  for (let from = 0; from < HARD_LIMIT; from += PAGE_SIZE) {
    const { data: page, error } = await db
      .from('deals')
      .select('id, contact_id, stage_id, pipeline_id, created_at, stage_entered_at')
      .eq('location_id', locationId)
      .eq('status', 'open')
      .in('pipeline_id', boardIds)
      .order('id', { ascending: true })
      .range(from, Math.min(from + PAGE_SIZE, HARD_LIMIT) - 1)
    if (error) {
      logWarn('pipeline-reclassify', 'restamp deal load failed', { locationId, err: error.message })
      return { ok: false, error: `deal load: ${error.message}`, ...base, ...counts, sample: [] }
    }
    if (!Array.isArray(page) || page.length === 0) break
    deals.push(...page)
    if (page.length < PAGE_SIZE) break
  }

  const sample = []
  for (const d of deals) {
    counts.deals_seen++
    const slug = slugById.get(d.stage_id) ?? null
    const dates = un1tDealDates(slug, evidence.get(d.contact_id) ?? null, now)
    if (!dates.created_at && !dates.stage_entered_at) { counts.no_evidence++; continue }
    // The deal has moved stage since it was created: the trigger's stamp is the
    // true entry to its current stage, so the stage date is kept as it is.
    const readCreatedMs = msOrNull(d.created_at)
    const readStageMs = msOrNull(d.stage_entered_at)
    const movedSinceCreate = readCreatedMs != null && readStageMs != null
      && readStageMs - readCreatedMs > RESTAMP_MOVED_GAP_MS
    if (movedSinceCreate) {
      counts.kept_moved++
      dates.stage_entered_at = null
    }

    const patch = {}
    const change = {}
    const stageMs = msOrNull(dates.stage_entered_at) ?? msOrNull(d.stage_entered_at)
    if (dates.stage_entered_at && msOrNull(dates.stage_entered_at) !== msOrNull(d.stage_entered_at)) {
      patch.stage_entered_at = dates.stage_entered_at
      change.stage_entered_at = { from: d.stage_entered_at ?? null, to: dates.stage_entered_at }
    }
    let createdMs = msOrNull(dates.created_at)
    if (createdMs != null && stageMs != null && createdMs > stageMs) createdMs = stageMs
    if (createdMs != null && createdMs !== msOrNull(d.created_at)) {
      const createdAt = new Date(createdMs).toISOString()
      patch.created_at = createdAt
      change.created_at = { from: d.created_at ?? null, to: createdAt }
    }
    if (Object.keys(patch).length === 0) { counts.unchanged++; continue }

    if (dryRun) {
      counts.updated++
      if (sample.length < RESTAMP_SAMPLE) sample.push({ deal_id: d.id, stage_slug: slug, ...change })
      continue
    }
    let res
    try {
      res = await db
        .from('deals')
        .update(patch)
        .eq('id', d.id)
        .eq('location_id', locationId)
        .eq('pipeline_id', d.pipeline_id)
        .eq('stage_id', d.stage_id)
        .eq('status', 'open')
        .select('id')
    } catch (e) {
      res = { data: null, error: { message: e?.message || String(e) } }
    }
    if (res?.error) {
      counts.errors++
      logWarn('pipeline-reclassify', 'restamp update failed', { deal_id: d.id, locationId, err: boundedErr(res.error.message) })
      continue
    }
    if (!Array.isArray(res?.data) || res.data.length === 0) { counts.skipped_changed++; continue }
    counts.updated++
    if (sample.length < RESTAMP_SAMPLE) sample.push({ deal_id: d.id, stage_slug: slug, ...change })
  }
  return { ok: true, ...base, ...counts, sample }
}

// PIPEEXCL.1 — the movement_matrix column a deal that left the board lands in,
// and the one board module the rule runs on (Hatch's un1t.online board).
const LEFT_BOARD = '(left board)'
// PIPEEXCL.2 — every derived acquisition board, Glofox (Stillorgan) and
// un1t.online (Hatch Street). PIPEEXCL.1 ran on acquisition_un1t only.
// PIPE3 — the two claim boards are acquisition boards too: a Hatch member is
// not a Stillorgan €39 prospect either.
// PIPEBUILD.3d — and every offer board, as the €39 board.
const EXCLUDING_MODULES = new Set(['acquisition', 'acquisition_un1t', 'paid_trial', 'programmes', 'paid_trial_un1t', ...OFFER_MODULES])
// The contact's timeline says why the deal closed, per reason.
const LEFT_BOARD_ACTIVITY = Object.freeze({
  [ELSEWHERE_MEMBER]: {
    subject: 'Pipeline: left the board (active member at another studio)',
    note: 'Active member at another studio of this organisation, so not a prospect here. '
      + 'A new deal opens on this board if that membership ends.',
  },
  [ELSEWHERE_TRAINING]: {
    subject: 'Pipeline: left the board (training at another studio)',
    note: 'Booked or attended classes at another studio of this organisation recently, so not a prospect here. '
      + 'A new deal opens on this board if they stop training there, or when they book here.',
  },
})

// HATCHPIPE.2 — the input fields a run result carries: always input_source,
// and on the un1t path the clients pipelineInputs could not place.
function un1tCounts(inputSource, un1tInputs) {
  if (!un1tInputs) return { input_source: inputSource }
  return {
    input_source: inputSource,
    unlinked: un1tInputs.unlinked ?? 0,
    skipped_no_contact: un1tInputs.skipped_no_contact ?? 0,
  }
}

// Free text from an adapter or a thrown error, capped before it reaches a log.
const ERR_LOG_MAX = 200
const boundedErr = (v) => String(v).slice(0, ERR_LOG_MAX)

/**
 * HATCHPIPE.2 — resolve the un1t.online classifier inputs for a location.
 *
 * Requires the seam to be a CONFIGURED un1t_online adapter that implements
 * pipelineInputs, and that read to succeed. `reason` is the seam state when it
 * is not configured ('unknown', 'unconfigured', 'none', 'no_location'), else
 * 'source_mismatch' (configured, but another source), 'read_unsupported', or
 * 'read_failed' (the read answered success:false or threw).
 *
 * @returns {Promise<{ ok: true, data: { contacts, snapshots, unlinked, skipped_no_contact } }
 *   | { ok: false, source: string|null, state: string, reason: string, err?: string }>}
 */
async function loadUn1tInputs(db, locationId, now) {
  let r
  try {
    r = await membershipReadsFor(db, locationId)
  } catch (e) {
    // A throwing seam is not silent: the cause rides the 'inputs unavailable' log, bounded.
    return { ok: false, source: null, state: 'unknown', reason: 'unknown', err: boundedErr(e?.message || e) }
  }
  const source = r?.source ?? null
  const state = r?.state ?? 'unknown'
  if (state !== 'configured') return { ok: false, source, state, reason: state }
  if (source !== UN1T_INPUT) return { ok: false, source, state, reason: 'source_mismatch' }
  if (!supportsRead(r, 'pipelineInputs')) return { ok: false, source, state, reason: 'read_unsupported' }
  let res
  try {
    res = await r.reads.pipelineInputs(db, locationId, { now })
  } catch (e) {
    res = { success: false, error: e?.message || String(e) }
  }
  const data = res?.success ? res.data : null
  if (!data || !Array.isArray(data.contacts) || !(data.snapshots instanceof Map)) {
    return { ok: false, source, state, reason: 'read_failed', err: res?.error ? boundedErr(res.error) : 'malformed answer' }
  }
  return { ok: true, data }
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
