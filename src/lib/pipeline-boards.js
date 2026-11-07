// PIPEBUILD.5d — the board builder's library: list, create (switched off),
// edit, enable and disable an offer board at one studio.
//
// Every caller is a service-role route, so nothing here leans on RLS: every
// query is scoped to the studio it was given (location_id), and a board at
// another studio reads as not found. Every function answers
// { ok: true, … } | { ok: false, status, error, code?, issues? }.
//
// Rules this file owns (global constraints, PIPEBUILD PR 5):
//   - a board is created OFF; switching it on resets baseline_at and stamps
//     updated_at in the SAME compare-and-set write, so the nightly pass treats
//     the first placement after switch-on as silent (Task 3 guards its stamp
//     on the updated_at it read at run start);
//   - the entry rule, the set of stages, the day counts and the priority
//     change only while the board is off; its name, stage names, mia_notes
//     and the offer wording (offer_name, signer) change any time;
//   - a stage is removed only when no deal (any status) is in it and its
//     follow-up is off, rejected or absent; its follow-up sequences are
//     archived first (the rows cascade away, which would leave them unowned);
//   - stage names are unique per board (mig 597): the parser refuses a
//     repeat, the stage diff moves names through a temporary name, and any
//     23505 is a 409 with the real reason;
//   - built-in boards (board_type null) are read-only here;
//   - no offer boards at un1t.online studios yet (offer_un1t is PR 3b).

import { RECIPES } from '@shared/pipelines/recipes.js'
import { boardKeyFor, parseOfferConfig, stageSlugFor } from '@shared/pipelines/offer-config.js'
import { stagesFor } from '@shared/pipelines/offer.js'
import { readMembershipSource, UN1T_MEMBERSHIP_SOURCES } from './pipeline-offer-claims.js'
import { assertNotLegacyBoard } from './pipeline-board-guard.js'
import { archiveSupersededSequence } from './followup-owned-sequences.js'
import { logError } from './log.js'

const MODULE = 'pipeline-boards'
const PAGE = 1000
// A runaway guard on the open-deal read (100k open deals at one studio).
const MAX_DEAL_PAGES = 100

export const UN1T_STUDIO_ERROR = "Offer boards at un1t.online studios aren't available yet."
export const SWITCH_OFF_FIRST_ERROR = 'Switch the board off before changing its entry rule, stages or timings.'
// assertNotLegacyBoard's own words (it answers a NextResponse; this file answers data).
export const LEGACY_BOARD_ERROR = "This board is built in code and can't be changed here."
const ACTIVE_FOLLOWUP_STATES = new Set(['draft', 'awaiting_approval', 'live'])

// The three unique constraints a board write can hit (migs 594, 150, 597).
const KEY_UNIQUE = 'pipelines_location_key_unique'
const SLUG_UNIQUE = 'pipeline_stages_location_slug_unique'
const STAGE_NAME_UNIQUE = 'pipeline_stages_pipeline_name_unique'
export const STAGE_NAME_TAKEN_ERROR = "Two stages on this board can't share a name. Give each stage its own name."
const STAGE_SLUG_TAKEN_ERROR = 'A stage with that role and timing already exists at this studio. Change the stage or try again.'

/** The unique constraint a 23505 names (PostgREST puts it in message; details names the key). */
function uniqueConstraintOf(error) {
  const text = `${error?.message ?? ''} ${error?.details ?? ''}`
  for (const name of [KEY_UNIQUE, SLUG_UNIQUE, STAGE_NAME_UNIQUE]) if (text.includes(name)) return name
  return null
}

/** A 23505 on a stage write: 409 with the real reason. */
function stageConflict(error) {
  if (uniqueConstraintOf(error) === SLUG_UNIQUE) return fail(409, STAGE_SLUG_TAKEN_ERROR, { code: 'stage_slug_taken' })
  return fail(409, STAGE_NAME_TAKEN_ERROR, { code: 'stage_name_taken' })
}

const BOARD_COLUMNS = 'id, location_id, key, name, board_type, recipe_key, enabled, baseline_at, priority, config, is_primary, display_order, updated_at'
const STAGE_COLUMNS = 'id, pipeline_id, slug, name, stage_role, role_config, display_order'
const FOLLOWUP_COLUMNS = 'id, pipeline_id, stage_id, pack_key, state, want_live, version, sequence_id, whatsapp_template_id'

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra })
const unreadable = (what) => fail(503, `Could not read ${what}.`)
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const nowIso = () => new Date().toISOString()

// jsonb hands keys back in its own order, so compare by sorted keys.
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/** The client's stages never carry a trusted slug: every slug is the key's. */
function withServerSlugs(config, boardKey) {
  if (!isObj(config) || !Array.isArray(config.stages)) return config
  return {
    ...config,
    stages: config.stages.map((s) => {
      if (!isObj(s)) return s
      return { ...s, slug: stageSlugFor(boardKey, s.role, { day: s.day, count: s.count }) }
    }),
  }
}

function parseIssues(errors) {
  return errors.map((message) => ({ path: 'config', message }))
}

async function refuseUn1tStudio(db, locationId) {
  const source = await readMembershipSource(db, locationId)
  if (!source.ok) return unreadable("the studio's membership source")
  if (UN1T_MEMBERSHIP_SOURCES.includes(source.source)) return fail(409, UN1T_STUDIO_ERROR, { code: 'un1t_studio' })
  return null
}

function legacyRefusal(board) {
  return assertNotLegacyBoard(board) ? fail(409, LEGACY_BOARD_ERROR, { code: 'legacy_board' }) : null
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

async function readBoardRow(db, locationId, boardId) {
  const { data, error } = await db
    .from('pipelines')
    .select(BOARD_COLUMNS)
    .eq('id', boardId)
    .eq('location_id', locationId)
    .maybeSingle()                         // primary key; 0 rows = not at this studio
  if (error) {
    logError(MODULE, 'board read failed', { locationId, boardId, err: error.message })
    return unreadable('the board')
  }
  if (!data) return fail(404, 'Board not found')
  return { ok: true, row: data }
}

async function openDealCounts(db, locationId, stageIds) {
  const counts = new Map()
  if (stageIds.length === 0) return { ok: true, counts }
  for (let page = 0; page < MAX_DEAL_PAGES; page += 1) {
    const from = page * PAGE
    const { data, error } = await db
      .from('deals')
      .select('id, stage_id')
      .eq('location_id', locationId)
      .eq('status', 'open')
      .in('stage_id', stageIds)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { ok: false }
    for (const d of data || []) counts.set(d.stage_id, (counts.get(d.stage_id) || 0) + 1)
    if (!data || data.length < PAGE) return { ok: true, counts }
  }
  logError(MODULE, 'open deal read hit its page cap', { locationId, pages: MAX_DEAL_PAGES })
  return { ok: false }
}

function shapeBoard(b, stages, followups, counts) {
  return {
    id: b.id,
    key: b.key,
    name: b.name,
    board_type: b.board_type,
    recipe_key: b.recipe_key,
    enabled: b.enabled,
    baseline_at: b.baseline_at,
    priority: b.priority,
    config: b.board_type != null ? b.config : null,
    is_primary: b.is_primary,
    stages: stages
      .filter((s) => s.pipeline_id === b.id)
      .map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        stage_role: s.stage_role,
        role_config: s.role_config,
        display_order: s.display_order,
        deal_count: counts.get(s.id) || 0,
      })),
    followups: followups
      .filter((f) => f.pipeline_id === b.id)
      .map((f) => ({
        id: f.id,
        stage_id: f.stage_id,
        pack_key: f.pack_key,
        state: f.state,
        want_live: f.want_live,
        version: f.version,
        sequence_id: f.sequence_id,
        whatsapp_template_id: f.whatsapp_template_id,
      })),
  }
}

async function loadBoards(db, locationId, boardId = null) {
  let q = db
    .from('pipelines')
    .select(BOARD_COLUMNS)
    .eq('location_id', locationId)
  if (boardId) q = q.eq('id', boardId)
  const { data: boards, error: boardsError } = await q
    .order('display_order', { ascending: true })
    .range(0, PAGE - 1)
  if (boardsError) {
    logError(MODULE, 'boards read failed', { locationId, err: boardsError.message })
    return unreadable('the boards')
  }
  const rows = boards || []
  if (rows.length === 0) return { ok: true, boards: [] }
  const ids = rows.map((b) => b.id)

  const { data: stages, error: stagesError } = await db
    .from('pipeline_stages')
    .select(STAGE_COLUMNS)
    .eq('location_id', locationId)
    .in('pipeline_id', ids)
    .eq('archived', false)
    .order('display_order', { ascending: true })
    .range(0, PAGE - 1)
  if (stagesError) {
    logError(MODULE, 'stages read failed', { locationId, err: stagesError.message })
    return unreadable('the stages')
  }

  const { data: followups, error: followupsError } = await db
    .from('pipeline_stage_followups')
    .select(FOLLOWUP_COLUMNS)
    .eq('location_id', locationId)
    .in('pipeline_id', ids)
    .order('created_at', { ascending: true })
    .range(0, PAGE - 1)
  if (followupsError) {
    logError(MODULE, 'follow-ups read failed', { locationId, err: followupsError.message })
    return unreadable('the follow-ups')
  }

  const stageRows = stages || []
  const counts = await openDealCounts(db, locationId, stageRows.map((s) => s.id))
  if (!counts.ok) return unreadable('the deal counts')

  return { ok: true, boards: rows.map((b) => shapeBoard(b, stageRows, followups || [], counts.counts)) }
}

/** Every board at the studio, enabled or not, with its stages and follow-ups. */
export async function listBoards(db, locationId) {
  return loadBoards(db, locationId)
}

/** One board at the studio (404 when it is not there). */
export async function getBoard(db, locationId, boardId) {
  const res = await loadBoards(db, locationId, boardId)
  if (!res.ok) return res
  if (res.boards.length === 0) return fail(404, 'Board not found')
  return { ok: true, board: res.boards[0] }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Create an offer board, switched OFF, with its stages (one transaction, mig 815).
 * @param {object} db
 * @param {{ locationId: string, name: string, recipeKey: string, config: object, priority?: number, createdBy?: string|null }} input
 */
export async function createBoard(db, { locationId, name, recipeKey, config, priority, createdBy } = {}) {
  const refused = await refuseUn1tStudio(db, locationId)
  if (refused) return refused

  if (!Object.prototype.hasOwnProperty.call(RECIPES, recipeKey)) {
    return fail(400, 'Unknown recipe.', { code: 'unknown_recipe' })
  }

  const { data: existing, error: keysError } = await db
    .from('pipelines')
    .select('key')
    .eq('location_id', locationId)
    .range(0, PAGE - 1)
  if (keysError) {
    logError(MODULE, 'board keys read failed', { locationId, err: keysError.message })
    return unreadable("the studio's boards")
  }
  const taken = new Set((existing || []).map((r) => r.key))
  const boardName = String(name ?? '').trim()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const key = boardKeyFor(boardName, taken)
    const parsed = parseOfferConfig(withServerSlugs(config, key), { boardKey: key })
    if (!parsed.ok) {
      return fail(400, 'The board setup has problems.', { code: 'invalid_config', issues: parseIssues(parsed.errors) })
    }
    const { data: newId, error } = await db.rpc('create_configured_pipeline', {
      p_location_id: locationId,
      p_key: key,
      p_name: boardName,
      p_board_type: 'offer',
      p_module: 'offer',
      p_recipe_key: recipeKey,
      p_config: parsed.config,
      p_priority: priority ?? 100,
      p_created_by: createdBy ?? null,
      p_stages: stagesFor(parsed.config),
    })
    if (error?.code === '23505') {
      const constraint = uniqueConstraintOf(error)
      if (constraint === KEY_UNIQUE || constraint === SLUG_UNIQUE) {
        // Another board took this key (or one of its stage slugs) since we
        // read the keys: try once more with a fresh one.
        taken.add(key)
        continue
      }
      // Two stages share a name (parseOfferConfig refuses that, so this is
      // the database's own word), or a unique this file does not know: a
      // fresh key would clash the same way, so never retry it.
      logError(MODULE, 'create_configured_pipeline unique violation', { locationId, key, constraint, err: error.message })
      if (constraint === STAGE_NAME_UNIQUE) return fail(409, STAGE_NAME_TAKEN_ERROR, { code: 'stage_name_taken' })
      return fail(409, 'The board clashes with one that already exists. Change its name or stages and try again.', { code: 'conflict' })
    }
    if (error || !newId) {
      logError(MODULE, 'create_configured_pipeline failed', { locationId, key, err: error?.message || 'no id returned' })
      return fail(500, 'Could not create the board.')
    }
    const read = await getBoard(db, locationId, newId)
    if (!read.ok) {
      // The board exists; only the read-back failed.
      return { ok: true, board: { id: newId, key, name: boardName, board_type: 'offer', recipe_key: recipeKey, enabled: false } }
    }
    return { ok: true, board: read.board }
  }
  return fail(409, 'Another board took that name at the same moment. Try again.', { code: 'key_taken' })
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

function stageSlugs(config) {
  return new Set((isObj(config) && Array.isArray(config.stages) ? config.stages : [])
    .map((s) => s?.slug)
    .filter((s) => typeof s === 'string' && s))
}

function sameSet(a, b) {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

/** Does going from `stored` to `next` touch anything that needs the board off? */
function structuralChange(stored, next, row, patch) {
  if (patch.priority !== undefined && patch.priority !== row.priority) return true
  if (!next) return false
  const s = isObj(stored) ? stored : {}
  if (stableJson(s.entry) !== stableJson(next.entry)) return true
  if (!sameSet(stageSlugs(s), stageSlugs(next))) return true
  for (const k of ['duration_days', 'quiet_days', 'converted_window_days']) {
    if ((s[k] ?? null) !== (next[k] ?? null)) return true
  }
  return false
}

/**
 * Change a board's name, priority or config.
 * @param {object} db
 * @param {{ locationId: string, boardId: string, patch: { name?: string, priority?: number, config?: object } }} input
 */
export async function updateBoard(db, { locationId, boardId, patch = {} } = {}) {
  const read = await readBoardRow(db, locationId, boardId)
  if (!read.ok) return read
  const row = read.row
  const legacy = legacyRefusal(row)
  if (legacy) return legacy

  let next = null
  if (patch.config !== undefined) {
    const parsed = parseOfferConfig(withServerSlugs(patch.config, row.key), { boardKey: row.key })
    if (!parsed.ok) {
      return fail(400, 'The board setup has problems.', { code: 'invalid_config', issues: parseIssues(parsed.errors) })
    }
    next = parsed.config
  }

  const structural = structuralChange(row.config, next, row, patch)
  if (structural && row.enabled) return fail(409, SWITCH_OFF_FIRST_ERROR, { code: 'switch_off_first' })

  if (next) {
    const stages = await applyStageDiff(db, { locationId, row, next })
    if (!stages.ok) return stages
  }

  const update = { updated_at: nowIso() }
  if (patch.name !== undefined) update.name = String(patch.name).trim()
  if (patch.priority !== undefined) update.priority = patch.priority
  if (next) update.config = next

  let q = db
    .from('pipelines')
    .update(update)
    .eq('id', row.id)
    .eq('location_id', locationId)
  // A structural edit holds only while the board is still off.
  if (structural) q = q.eq('enabled', false)
  const { data: touched, error } = await q.select('id')
  if (error) {
    logError(MODULE, 'board update failed', { locationId, boardId, err: error.message })
    return fail(500, 'Could not save the board.')
  }
  if (!touched || touched.length !== 1) {
    if (structural) return fail(409, SWITCH_OFF_FIRST_ERROR, { code: 'switch_off_first' })
    return fail(404, 'Board not found')
  }

  return getBoard(db, locationId, row.id)
}

// A temporary stage name no real stage can hold: a kept stage parks here
// while names move, so (pipeline_id, name) never holds two rows at once.
const tempStageName = (stageId) => `__tmp_${stageId}`

// The order matters because pipeline_stages carries UNIQUE (pipeline_id, name)
// (mig 597) as well as UNIQUE (location_id, slug):
//   1. check every removal (nothing written yet, so a refusal changes nothing);
//   2. retire the removed stages' follow-up sequences (their rows cascade away
//      with the stage, which would leave the sequences unowned);
//   3. delete the removed stages, so a new stage may take a removed one's name
//      (Day 7 → Day 10 keeps the name "Day 7" under a new slug);
//   4. park every kept stage whose name changes on a temporary unique name,
//      so a swap (A↔B) or a new stage taking a kept stage's old name works;
//   5. insert the added stages;
//   6. set the kept stages' final names and display_order.
// A 23505 anywhere is a 409 with the real reason, never a 500.
async function applyStageDiff(db, { locationId, row, next }) {
  const { data: stageRows, error: stagesError } = await db
    .from('pipeline_stages')
    .select('id, slug, name, display_order')
    .eq('location_id', locationId)
    .eq('pipeline_id', row.id)
    .range(0, PAGE - 1)
  if (stagesError) {
    logError(MODULE, 'board stages read failed', { locationId, boardId: row.id, err: stagesError.message })
    return unreadable("the board's stages")
  }
  const bySlug = new Map((stageRows || []).map((s) => [s.slug, s]))
  const storedSlugs = stageSlugs(row.config)
  const nextSlugs = stageSlugs(next)
  const nextRows = stagesFor(next)

  // 0. A final name that an orphan or archived row on the board already holds
  //    would only fail the UNIQUE (pipeline_id, name) halfway through the
  //    edit, so it is refused here, before any write. Same comparison as the
  //    parser's duplicate-name rule: case-insensitive, trimmed.
  const normName = (n) => String(n ?? '').trim().toLowerCase()
  const heldByOthers = new Set(
    (stageRows || [])
      .filter((s) => !nextSlugs.has(s.slug) && !storedSlugs.has(s.slug))
      .map((s) => normName(s.name)),
  )
  if (nextRows.some((s) => heldByOthers.has(normName(s.name)))) {
    return fail(409, STAGE_NAME_TAKEN_ERROR, { code: 'stage_name_taken' })
  }

  // 1. Every removal is checked before anything is written, so a refusal
  //    leaves the board exactly as it was.
  const removals = []
  for (const slug of storedSlugs) {
    if (nextSlugs.has(slug)) continue
    const stage = bySlug.get(slug)
    if (!stage) continue
    const { count, error: dealsError } = await db
      .from('deals')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('stage_id', stage.id)
    if (dealsError) {
      logError(MODULE, 'stage deal count failed', { locationId, stageId: stage.id, err: dealsError.message })
      return unreadable('the deals in that stage')
    }
    if ((count || 0) > 0) {
      return fail(409, `The stage "${stage.name}" still has deals in it. Move them out before removing it.`, { code: 'stage_not_empty' })
    }
    const { data: followups, error: followupsError } = await db
      .from('pipeline_stage_followups')
      .select('id, state, sequence_id')
      .eq('location_id', locationId)
      .eq('stage_id', stage.id)
      .range(0, PAGE - 1)
    if (followupsError) {
      logError(MODULE, 'stage follow-ups read failed', { locationId, stageId: stage.id, err: followupsError.message })
      return unreadable("that stage's follow-ups")
    }
    if ((followups || []).some((f) => ACTIVE_FOLLOWUP_STATES.has(f.state))) {
      return fail(409, `Turn off the follow-up on "${stage.name}" before removing the stage.`, { code: 'followup_active' })
    }
    removals.push({ stage, followups: followups || [] })
  }

  // 2. The removed stages' follow-up sequences (off or rejected rows, so
  //    paused or draft) are retired before the rows cascade away. Best-effort:
  //    they are already stopped; a failure is logged by the helper.
  for (const { stage, followups } of removals) {
    for (const f of followups) {
      if (!f.sequence_id) continue
      await archiveSupersededSequence(db, locationId, f.sequence_id, { followupId: f.id, stageId: stage.id, action: 'stage_removed' })
    }
  }

  // 3. Removed stages. A deal that landed since the check makes the delete
  //    fail on deals.stage_id (23503), which is the same refusal.
  for (const { stage } of removals) {
    const { data: removed, error } = await db
      .from('pipeline_stages')
      .delete()
      .eq('id', stage.id)
      .eq('location_id', locationId)
      .eq('pipeline_id', row.id)
      .select('id')
    if (error?.code === '23503') {
      return fail(409, `The stage "${stage.name}" still has deals in it. Move them out before removing it.`, { code: 'stage_not_empty' })
    }
    if (error || !removed || removed.length !== 1) {
      logError(MODULE, 'stage delete failed', { locationId, stageId: stage.id, err: error?.message || 'row count' })
      return fail(500, 'Could not remove a stage.')
    }
  }

  const updateStage = async (stageId, change, what) => {
    const { data: changed, error } = await db
      .from('pipeline_stages')
      .update(change)
      .eq('id', stageId)
      .eq('location_id', locationId)
      .eq('pipeline_id', row.id)
      .select('id')
    if (error?.code === '23505') {
      logError(MODULE, `stage ${what} hit a unique`, { locationId, stageId, err: error.message })
      return stageConflict(error)
    }
    if (error || !changed || changed.length !== 1) {
      logError(MODULE, `stage ${what} failed`, { locationId, stageId, err: error?.message || 'row count' })
      return fail(500, 'Could not update a stage.')
    }
    return null
  }

  // 4. Kept stages whose name changes park on a temporary name first.
  const renamed = nextRows
    .map((s) => ({ s, existing: bySlug.get(s.slug) }))
    .filter(({ s, existing }) => existing && existing.name !== s.name)
  const stillParked = new Set()
  // What each renamed stage is called in the database right now.
  const currentName = new Map(renamed.map(({ existing }) => [existing.id, existing.name]))
  const rename = async (stageId, name) => {
    const { error } = await db
      .from('pipeline_stages')
      .update({ name })
      .eq('id', stageId)
      .eq('location_id', locationId)
      .eq('pipeline_id', row.id)
      .select('id')
    if (error) return error
    currentName.set(stageId, name)
    return null
  }
  // A failure after parking puts every renamed stage back on its ORIGINAL
  // name, so a board never shows a __tmp_ column. Step 6 renames that already
  // landed are first undone (in reverse order) back onto a temporary name, so
  // an original name is never wanted while another stage still holds it; then
  // every parked stage goes home. Each write is retried once (the undo on a
  // fresh temporary name); what is still wrong is logged exactly.
  const unpark = async () => {
    for (const { existing } of [...renamed].reverse()) {
      const now = currentName.get(existing.id)
      if (now === existing.name || now === tempStageName(existing.id)) continue
      let error = await rename(existing.id, tempStageName(existing.id))
      if (error) error = await rename(existing.id, `${tempStageName(existing.id)}_${Date.now().toString(36)}`)
      if (error) logError(MODULE, 'renamed stage not re-parked', { locationId, stageId: existing.id, err: error.message })
    }
    for (const { existing } of renamed) {
      if (currentName.get(existing.id) === existing.name) continue
      let error = await rename(existing.id, existing.name)
      if (error) error = await rename(existing.id, existing.name)
      if (error) logError(MODULE, 'parked stage name not restored', { locationId, stageId: existing.id, name: currentName.get(existing.id), originalName: existing.name, err: error.message })
    }
    const left = renamed.filter(({ existing }) => currentName.get(existing.id) !== existing.name)
    if (left.length) {
      logError(MODULE, 'stage names left changed after a failed edit', {
        locationId,
        boardId: row.id,
        stages: left.map(({ existing }) => ({ stageId: existing.id, name: currentName.get(existing.id), originalName: existing.name })),
      })
    }
  }
  for (const { existing } of renamed) {
    const failed = await updateStage(existing.id, { name: tempStageName(existing.id) }, 'park')
    if (failed) {
      await unpark()
      return failed
    }
    currentName.set(existing.id, tempStageName(existing.id))
    stillParked.add(existing.id)
  }

  // 5. Added stages (no row yet) are inserted with their stagesFor fields.
  const inserts = nextRows
    .filter((s) => !bySlug.has(s.slug))
    .map((s) => ({ ...s, pipeline_id: row.id, location_id: locationId }))
  if (inserts.length) {
    const { data: inserted, error } = await db.from('pipeline_stages').insert(inserts).select('id')
    if (error?.code === '23505') {
      logError(MODULE, 'stage insert hit a unique', { locationId, boardId: row.id, err: error.message })
      await unpark()
      return stageConflict(error)
    }
    if (error || !inserted || inserted.length !== inserts.length) {
      logError(MODULE, 'stage insert failed', { locationId, boardId: row.id, err: error?.message || 'row count' })
      await unpark()
      return fail(500, 'Could not add the new stages.')
    }
  }

  // 6. Kept stages take their final name AND column position from the
  //    stagesFor row for their slug (900 + index in the new order), so an
  //    inserted or reordered stage never leaves two columns on one
  //    display_order.
  const parked = new Set(stillParked)
  for (const s of nextRows) {
    const existing = bySlug.get(s.slug)
    if (!existing) continue
    const change = {}
    if (parked.has(existing.id)) change.name = s.name
    if (existing.display_order !== s.display_order) change.display_order = s.display_order
    if (Object.keys(change).length === 0) continue
    const failed = await updateStage(existing.id, change, 'update')
    if (failed) {
      await unpark()
      return failed
    }
    if (change.name) currentName.set(existing.id, change.name)
    stillParked.delete(existing.id)
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

/**
 * Switch a board on or off. Switching on resets baseline_at and stamps
 * updated_at in the same compare-and-set write.
 * @param {object} db
 * @param {{ locationId: string, boardId: string, enabled: boolean }} input
 */
export async function setBoardEnabled(db, { locationId, boardId, enabled } = {}) {
  const read = await readBoardRow(db, locationId, boardId)
  if (!read.ok) return read
  const row = read.row
  const legacy = legacyRefusal(row)
  if (legacy) return legacy

  const target = enabled === true
  if (row.enabled === target) {
    const board = await getBoard(db, locationId, row.id)
    if (!board.ok) return board
    return { ok: true, board: board.board, unchanged: true }
  }

  let update
  if (target) {
    const parsed = parseOfferConfig(row.config, { boardKey: row.key })
    if (!parsed.ok) {
      return fail(409, 'The board setup has problems. Fix them before switching it on.', { code: 'invalid_config', issues: parseIssues(parsed.errors) })
    }
    const refused = await refuseUn1tStudio(db, locationId)
    if (refused) return refused
    update = { enabled: true, baseline_at: null, updated_at: nowIso() }
  } else {
    update = { enabled: false, updated_at: nowIso() }
  }

  const { data: touched, error } = await db
    .from('pipelines')
    .update(update)
    .eq('id', row.id)
    .eq('location_id', locationId)
    .eq('enabled', !target)
    .select('id')
  if (error) {
    logError(MODULE, 'board switch failed', { locationId, boardId, enabled: target, err: error.message })
    return fail(500, target ? 'Could not switch the board on.' : 'Could not switch the board off.')
  }
  if (!touched || touched.length !== 1) {
    // Someone else switched it first: answer what it is now.
    const board = await getBoard(db, locationId, row.id)
    if (!board.ok) return board
    if (board.board.enabled === target) return { ok: true, board: board.board, unchanged: true }
    return fail(409, 'The board changed while you were saving. Try again.', { code: 'conflict' })
  }

  const board = await getBoard(db, locationId, row.id)
  if (!board.ok) return board
  return { ok: true, board: board.board }
}

// ---------------------------------------------------------------------------
// route support
// ---------------------------------------------------------------------------

/**
 * The studio a board belongs to, read by id alone so a detail route can run
 * assertLocationAccessOr404 on it (another studio's board is then a 404).
 * The ONLY unscoped read in this file; it returns nothing but location_id.
 * @returns {Promise<{ ok: true, locationId: string } | { ok: false, status: number, error: string }>}
 */
export async function boardLocationId(db, boardId) {
  const { data, error } = await db
    .from('pipelines')
    .select('location_id')
    .eq('id', boardId)
    .maybeSingle()                         // primary key; 0 rows = no board
  if (error) {
    logError(MODULE, 'board location read failed', { boardId, err: error.message })
    return unreadable('the board')
  }
  if (!data) return fail(404, 'Not found')
  return { ok: true, locationId: data.location_id }
}
