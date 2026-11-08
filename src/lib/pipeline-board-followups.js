// PIPEBUILD.5f — install, replace the wording of, or switch off one stage's
// follow-up on an offer board.
//
// The installer (installFollowupPack, src/lib/pipeline-followup-packs.js) owns
// the Meta submit, the draft sequence, the compare-and-set link and the
// publish. This file decides what to hand it and what to clear out of the way
// first, for the three things an operator can do from the board builder:
//
//   install  no row: install at version 1.
//            row awaiting_approval / live: the same call with the row's own
//            version; the installer returns the row, and its recheck
//            republishes a stranded one, so it doubles as "publish now". New
//            wording here is refused (409 use_replace): the installer would
//            drop it.
//            row draft: the same version, over the row (bodies allowed).
//            row rejected / off: Meta will not take the old template name
//            again, so install at version + 1.
//            Over a draft, rejected or off row the old sequence is stopped
//            first (deleted while a draft, the PR 4 "old draft left behind"
//            carry-over; paused if still active), since the installer points
//            the row at a new one.
//   replace  new wording on an existing row: stop the row's sequence (pause it
//            when active, delete it when a draft), set the row off, then
//            install at version + 1.
//   off      stop the row's sequence the same way, then set the row off.
//
// Retiring the old sequence (PIPEBUILD.5l): once the installer has re-pointed
// the row at a new sequence (or, on off, once the old one is paused), the old
// one is archived (archiveSupersededSequence). Ownership is read from the
// row's current sequence_id only, so a superseded sequence left paused would
// show again in Automations, unlocked, and could be switched back on beside
// its replacement. The sequence routes refuse to bring an archived follow-up
// sequence back. A failed archive is logged and never fails the action: the
// sequence is already stopped.
//
// THE RULE: a stage never has two follow-up sequences running at once. So on
// replace the old sequence is stopped BEFORE the new one exists, and if
// stopping it or switching the row off fails, nothing new is installed. And
// the wording is checked FIRST (renderPack, the installer's own renderer), so
// a typo is a 400 that leaves a live follow-up running, never one that
// switched it off on the way to failing.
//
// Service role: every read and write is scoped by location_id here. Every
// write destructures `error`; the ones that must touch a row select `id` and
// count it. Answers { ok: true, … } | { ok: false, status, error, code? }.
import { installFollowupPack } from '@/lib/pipeline-followup-packs'
import { archiveSupersededSequence } from '@/lib/followup-owned-sequences'
import { logError } from '@/lib/log'
import { RECIPES, renderPack, studioSlugFor } from '@shared/pipelines/recipes.js'

const MODULE = 'pipeline-board-followups'

export const FOLLOWUP_ACTIONS = Object.freeze(['install', 'replace', 'off'])

// Same-file literal so check:select-columns resolves it.
const FOLLOWUP_COLUMNS = 'id, location_id, pipeline_id, stage_id, sequence_id, whatsapp_template_id, pack_key, version, state, want_live, created_by, created_at, updated_at'

// The installer returns a row in one of these states as it stands (after its
// recovery recheck) instead of installing over it.
const CURRENT_STATES = new Set(['draft', 'awaiting_approval', 'live'])
// Spent: installing over one of these is a fresh install, owner work (RAILS.1).
export const SPENT_STATES = new Set(['rejected', 'off'])
// Submitted to Meta or live: the installer returns these as they stand.
const INSTALLED_STATES = new Set(['awaiting_approval', 'live'])

const LEGACY_BOARD_ERROR = "This board is built in code and can't be changed here."

const fail = (status, error, code) => (code ? { ok: false, status, error, code } : { ok: false, status, error })
const nowIso = () => new Date().toISOString()

/**
 * The pack, when it belongs to the board's recipe and fits the stage's role.
 * @returns {{ ok: true, pack: object } | { ok: false, status: 400, error: string, code: 'pack_not_for_stage' }}
 */
export function packForStage(board, stage, packKey) {
  const pack = RECIPES[board?.recipe_key]?.packs?.find((p) => p.key === packKey)
  if (!pack || !stage || pack.role !== stage.stage_role) {
    return fail(400, "This follow-up doesn't fit this stage.", 'pack_not_for_stage')
  }
  return { ok: true, pack }
}

// A link counts only when it is https (the same rule as appLinksFrom in
// un1t-online-app-links.js, which also returns copy we do not want here).
const httpsUrl = (v) => (typeof v === 'string' && v.trim().startsWith('https://') ? v.trim() : null)
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

/**
 * The fill-ins a pack is rendered with. Reads the studio's row by id with
 * named columns; `settings` stays in here: the result carries ONLY the keys
 * below, never the settings object or anything else from it.
 *
 *   studioName     locations.name
 *   offerName      config.offer_name, else the board's name
 *   durationDays   Number(config.duration_days)
 *   signer         config.signer, else the studio's name
 *   bookingFlowId  settings.whatsapp_flow.flow_id, only while that Flow is
 *                  switched on (enabled === true, the rule Mia's
 *                  send_booking_flow uses: src/lib/agent/booking-flow.js).
 *                  Left out otherwise, so the templates carry no Book button
 *                  and keep the reply-to-book line.
 *   appLinks       { iosUrl, androidUrl } from settings.un1t_online.app_links
 *                  (ios_url / android_url), only when BOTH are https links.
 *
 * @param {object} db service-role client
 * @param {{ name: string, config?: object, location_id?: string }} board
 * @param {string} [locationId] the board's studio (defaults to board.location_id)
 */
export async function renderInputsFor(db, board, locationId = board?.location_id) {
  if (!locationId) return fail(400, 'A studio is required.')
  const { data: loc, error } = await db.from('locations')
    .select('name, settings')
    .eq('id', locationId)
    .maybeSingle()                         // primary key; 0 rows = no studio
  if (error) {
    logError(MODULE, 'studio read failed', { locationId, err: error.message })
    return fail(503, 'Could not read the studio just now. Try again.')
  }
  if (!loc) return fail(404, 'Studio not found')

  const config = isObj(board?.config) ? board.config : {}
  const settings = isObj(loc.settings) ? loc.settings : {}
  const studioName = String(loc.name ?? '').trim()
  const offerName = String(config.offer_name ?? '').trim() || board?.name
  const signer = String(config.signer ?? '').trim() || studioName
  const render = { studioName, offerName, durationDays: Number(config.duration_days), signer }

  const flow = isObj(settings.whatsapp_flow) ? settings.whatsapp_flow : {}
  const flowId = String(flow.flow_id ?? '').trim()
  if (flow.enabled === true && flowId) render.bookingFlowId = flowId

  const un1t = isObj(settings.un1t_online) ? settings.un1t_online : {}
  const links = isObj(un1t.app_links) ? un1t.app_links : {}
  const iosUrl = httpsUrl(links.ios_url)
  const androidUrl = httpsUrl(links.android_url)
  if (iosUrl && androidUrl) render.appLinks = { iosUrl, androidUrl }

  return { ok: true, render }
}

// The row for (stage, pack) at this studio. UNIQUE (stage_id, pack_key), a
// composite unique, so at most one row: maybeSingle, 0 rows = none yet.
async function readFollowup(db, locationId, stageId, packKey) {
  const { data, error } = await db.from('pipeline_stage_followups')
    .select(FOLLOWUP_COLUMNS)
    .eq('location_id', locationId)
    .eq('stage_id', stageId)
    .eq('pack_key', packKey)
    .maybeSingle()
  if (error) {
    logError(MODULE, 'follow-up read failed', { locationId, stageId, packKey, err: error.message })
    return fail(500, "Could not read this stage's follow-up just now. Try again.")
  }
  return { ok: true, row: data || null }
}

// The wording and fill-ins, checked with the installer's own renderer before
// anything is touched. Every throw is a 400 (a bad word, a fill-in that is
// missing or too long, a duration the pack cannot take).
function checkRender({ board, packKey, render, version, bodies }) {
  try {
    renderPack(board.recipe_key, packKey, {
      ...render,
      boardKey: board.key,
      studioSlug: studioSlugFor(render.studioName),
      version,
      ...(bodies != null ? { bodies } : {}),
    })
    return null
  } catch (err) {
    return fail(400, err?.message || 'This wording cannot be used.', 'bad_wording')
  }
}

// Delete a sequence only while it is still a draft (a draft never enrols).
// A failed delete is an error result; 0 rows is fine (gone, or not a draft).
async function deleteDraftSequence(db, locationId, sequenceId) {
  const { data, error } = await db.from('email_sequences')
    .delete()
    .eq('id', sequenceId)
    .eq('location_id', locationId)
    .eq('status', 'draft')
    .select('id')
  if (error) {
    logError(MODULE, 'draft sequence delete failed', { locationId, sequenceId, err: error.message })
    return fail(500, "Could not remove this follow-up's old draft just now. Nothing was changed. Try again.")
  }
  return { ok: true, deleted: (data || []).length }
}

// Stop a row's sequence: pause it when active (compare-and-set from active),
// delete it when a draft. Paused, archived or gone is already stopped. Any
// other answer, or a failed read or write, stops the caller: nothing new may
// be installed while the old sequence might still send.
async function stopSequence(db, locationId, sequenceId) {
  if (!sequenceId) return { ok: true }
  const { data: paused, error: pauseErr } = await db.from('email_sequences')
    .update({ status: 'paused', updated_at: nowIso() })
    .eq('id', sequenceId)
    .eq('location_id', locationId)
    .eq('status', 'active')
    .select('id')
  if (pauseErr) {
    logError(MODULE, 'sequence pause failed', { locationId, sequenceId, err: pauseErr.message })
    return fail(500, "Could not pause this follow-up's sequence just now. Nothing was changed. Try again.")
  }
  if (paused?.length) return { ok: true }

  // 0 rows: it was not active. Re-read what it is.
  const { data: seq, error: readErr } = await db.from('email_sequences')
    .select('id, status')
    .eq('id', sequenceId)
    .eq('location_id', locationId)
    .maybeSingle()                         // primary key
  if (readErr) {
    logError(MODULE, 'sequence re-read failed', { locationId, sequenceId, err: readErr.message })
    return fail(500, "Could not check this follow-up's sequence just now. Nothing was changed. Try again.")
  }
  if (!seq || seq.status === 'paused' || seq.status === 'archived') return { ok: true }
  if (seq.status === 'draft') {
    const del = await deleteDraftSequence(db, locationId, sequenceId)
    if (!del.ok) return del
    if (del.deleted) return { ok: true }
    // Not deleted: it stopped being a draft in between (a publish). Judge it
    // again rather than guess.
    return fail(409, "This follow-up's sequence changed while it was being stopped. Refresh and try again.", 'sequence_changed')
  }
  // 'active' again (published between the two reads), or a status this file
  // does not know: never install beside it.
  logError(MODULE, 'sequence could not be stopped', { locationId, sequenceId, status: seq.status })
  return fail(409, "This follow-up's sequence changed while it was being stopped. Refresh and try again.", 'sequence_changed')
}

const CHANGED_WHILE_OFF = 'This follow-up changed while it was being switched off. Switch it off or change the wording again.'

// One compare-and-set of the row to off from `fromState`. → { error } | { touched }
async function casRowOff(db, locationId, rowId, fromState, updatedAt) {
  const { data, error } = await db.from('pipeline_stage_followups')
    .update({ state: 'off', updated_at: updatedAt })
    .eq('id', rowId)
    .eq('location_id', locationId)
    .eq('state', fromState)
    .select('id')
  if (error) return { error }
  return { touched: (data || []).length }
}

// Row → off, compare-and-set on the state it was read in. Called only after
// the row's sequence is stopped, so nothing sends whatever happens here.
//
// A miss usually means the approval hook moved the row between our read and
// this write (awaiting_approval → live as it published the sequence we have
// since paused). Re-read once: if it still points at the SAME sequence and is
// now live or awaiting_approval, retry from that state. Anything else (a new
// sequence, a second click that already switched it off or re-installed) is
// a 409: the caller must look again before acting.
async function switchRowOff(db, locationId, row) {
  if (row.state === 'off') return { ok: true, followup: row }
  const updatedAt = nowIso()
  const first = await casRowOff(db, locationId, row.id, row.state, updatedAt)
  if (first.error) {
    logError(MODULE, 'follow-up switch-off failed', { locationId, followupId: row.id, err: first.error.message })
    return fail(500, "Could not switch this follow-up off just now. Its sequence is stopped. Try again.")
  }
  if (first.touched) return { ok: true, followup: { ...row, state: 'off', updated_at: updatedAt } }

  const { data: now, error: rereadErr } = await db.from('pipeline_stage_followups')
    .select(FOLLOWUP_COLUMNS)
    .eq('id', row.id)
    .eq('location_id', locationId)
    .maybeSingle()                         // primary key
  if (rereadErr) {
    logError(MODULE, 'follow-up re-read after a missed switch-off failed', { locationId, followupId: row.id, err: rereadErr.message })
    return fail(500, "Could not switch this follow-up off just now. Its sequence is stopped. Try again.")
  }
  const retryable = now
    && now.sequence_id === row.sequence_id
    && (now.state === 'live' || now.state === 'awaiting_approval')
  if (retryable) {
    const again = await casRowOff(db, locationId, row.id, now.state, updatedAt)
    if (again.error) {
      logError(MODULE, 'follow-up switch-off retry failed', { locationId, followupId: row.id, err: again.error.message })
      return fail(500, "Could not switch this follow-up off just now. Its sequence is stopped. Try again.")
    }
    if (again.touched) return { ok: true, followup: { ...now, state: 'off', updated_at: updatedAt } }
  }
  logError(MODULE, 'follow-up changed before it could be switched off', {
    locationId, followupId: row.id, readState: row.state, nowState: now?.state ?? null,
    sameSequence: now ? now.sequence_id === row.sequence_id : null,
  })
  return fail(409, CHANGED_WHILE_OFF, 'followup_changed')
}

/**
 * @param {object} db service-role client
 * @param {{
 *   user: { id?: string },
 *   board: { id: string, key: string, name: string, board_type: string|null, recipe_key: string, config: object, location_id?: string },
 *   stage: { id: string, slug: string, stage_role: string },
 *   action: 'install'|'replace'|'off',
 *   packKey: string,
 *   bodies?: { [ref: string]: string },
 *   locationId?: string,
 * }} opts
 * @returns {Promise<{ ok: true, followup: object, created?: boolean, unchanged?: boolean, publishError?: string, code?: string }
 *   | { ok: false, status: number, error: string, code?: string }>}
 */
export async function applyFollowupAction(db, {
  user, board, stage, action, packKey, bodies, locationId = board?.location_id,
} = {}) {
  if (!locationId || !board?.id || !stage?.id) return fail(400, 'A studio, board and stage are all required.')
  if (!FOLLOWUP_ACTIONS.includes(action)) return fail(400, 'Unknown action.')
  if (board.board_type == null) return fail(409, LEGACY_BOARD_ERROR, 'legacy_board')
  const packCheck = packForStage(board, stage, packKey)
  if (!packCheck.ok) return packCheck

  const read = await readFollowup(db, locationId, stage.id, packKey)
  if (!read.ok) return read
  const row = read.row

  if (action === 'off') {
    if (!row) return fail(409, 'This stage has no follow-up to switch off.', 'no_followup')
    if (row.state === 'off') return { ok: true, followup: row, unchanged: true }
    const stopped = await stopSequence(db, locationId, row.sequence_id)
    if (!stopped.ok) return stopped
    const off = await switchRowOff(db, locationId, row)
    if (!off.ok) return off
    await archiveSupersededSequence(db, locationId, row.sequence_id, { followupId: row.id, action: 'off' })
    return { ok: true, followup: off.followup }
  }

  if (action === 'replace' && !row) return fail(409, 'This stage has no follow-up to change yet. Install it first.', 'no_followup')
  // New wording on a follow-up that is already submitted or live would be
  // dropped by the installer (it returns the row as it stands). A draft row
  // has no published wording, so it may take bodies.
  if (action === 'install' && bodies != null && row && INSTALLED_STATES.has(row.state)) {
    return fail(409, 'This follow-up is already set up. Use Change wording to send new wording.', 'use_replace')
  }

  const inputs = await renderInputsFor(db, board, locationId)
  if (!inputs.ok) return inputs
  const render = inputs.render

  // The version the install runs at: a row that is still current keeps its
  // own (its templates exist under that name); anything else takes a new one.
  let version = 1
  if (row) version = action === 'install' && CURRENT_STATES.has(row.state) ? row.version : row.version + 1
  const badRender = checkRender({ board, packKey, render, version, bodies })
  if (badRender) return badRender

  if (action === 'replace') {
    // 1. Stop the old sequence. 2. Switch the row off. Only then 3. install.
    const stopped = await stopSequence(db, locationId, row.sequence_id)
    if (!stopped.ok) return stopped
    const off = await switchRowOff(db, locationId, row)
    if (!off.ok) return off
  } else if (row && (SPENT_STATES.has(row.state) || row.state === 'draft') && row.sequence_id) {
    // The installer re-points the row at a NEW sequence, so the old one must
    // be stopped first: deleted while a draft (nothing links to it any more),
    // paused if it is somehow still active, refused on any other answer. A
    // spent row's old sequence left active would run beside the new one.
    const stopped = await stopSequence(db, locationId, row.sequence_id)
    if (!stopped.ok) return stopped
  }

  const installArgs = {
    locationId,
    pipelineId: board.id,
    stage: { id: stage.id, slug: stage.slug },
    recipeKey: board.recipe_key,
    packKey,
    render,
    createdBy: user?.id ?? null,
    wantLive: true,
    version,
    ...(bodies != null ? { bodies } : {}),
  }
  let installed = await installFollowupPack(db, installArgs)
  // Old wording under the same template names (a failed run submitted them):
  // retry ONCE at the next version, so every template of the pack is fresh.
  if (!installed.ok && installed.code === 'template_wording_differs') {
    installed = await installFollowupPack(db, { ...installArgs, version: version + 1 })
  }
  if (!installed.ok && action === 'replace') {
    // The old sequence is stopped and the row is off: nothing sends. Say so,
    // so "install again" is the obvious next step (it converges: templates a
    // failed run submitted are linked by name).
    logError(MODULE, 'replace: new wording not installed; the follow-up is off', {
      locationId, followupId: row.id, status: installed.status, code: installed.code,
    })
    return { ...installed, error: `${installed.error} The old follow-up is switched off until this installs.` }
  }
  // The row now points at a new sequence: the old one (stopped above) is no
  // longer owned, so retire it before anyone can switch it back on.
  const newSequenceId = installed.ok ? installed.followup?.sequence_id : null
  if (row?.sequence_id && newSequenceId && newSequenceId !== row.sequence_id) {
    await archiveSupersededSequence(db, locationId, row.sequence_id, { followupId: row.id, action })
  }
  return installed
}
