// PIPEBUILD.4d — install one follow-up pack on one stage of an offer board:
// submit the pack's WhatsApp templates to Meta, create its sequence as an
// inactive draft, and link both to the stage in pipeline_stage_followups. If
// every template is already APPROVED (a reinstall), publish at once: no Meta
// webhook will ever arrive to do it.
//
// Service role, so every read and write is scoped by location here. Every
// failure it can name is a { ok: false, status, error, code? } result; the
// calls that reach Meta or another library (the template submits and the
// publish) are wrapped, so a throw from one becomes a 500 result too.
//
// Approval can land at any moment. The go-live decision is never taken from
// the statuses submit returned: after the link is written the template rows
// are re-read, so an approval the webhook delivered while this was still
// submitting (when the hook found no awaiting_approval row to move) is seen
// here. A reinstall over an awaiting_approval row runs the same re-check, and
// a `live` row whose sequence is still a draft (a publish failed and the
// revert write failed too) is put back and re-checked: either way a stranded
// follow-up recovers by installing it again.
//
// No half-installs: a template failure creates no sequence and no link row.
// Templates a failed run DID submit stay saved here; a reinstall meets them as
// a same-studio name clash and links them (submitWhatsappTemplate's
// `existing`), so a retry converges instead of piling up Meta templates.
//
// One row per (stage, pack). It is written with compare-and-set, not a blind
// upsert: an upsert racing a second install (a double click) could overwrite
// a LIVE row back to awaiting_approval and swap its sequence, leaving the old
// one active beside the new — two sequences sending the same follow-up.
import { submitWhatsappTemplate } from '@/lib/whatsapp-template-submit'
import { publishSequence } from '@/lib/sequences/publish'
import { parseGraphShape } from '@/lib/sequences/graph/schema'
import { logError } from '@/lib/log'
import { graphTemplateIds } from '@/lib/pipeline-followup-approval'
import { RECIPES, renderPack, studioSlugFor } from '../../shared/pipelines/recipes.js'

const MODULE = 'pipeline-followups'

// Same-file literal so check:select-columns resolves it.
const FOLLOWUP_COLUMNS = 'id, location_id, pipeline_id, stage_id, sequence_id, whatsapp_template_id, pack_key, version, state, want_live, created_by, created_at, updated_at'

// A row in one of these states is already installed; it is returned (after
// the recovery re-checks in step 2), never reinstalled over.
const INSTALLED_STATES = ['awaiting_approval', 'live']
// A saved template in one of these states can never be approved, so linking
// it on a reinstall would leave the follow-up waiting for ever.
const DEAD_TEMPLATE_STATUSES = ['REJECTED', 'DISABLED', 'PENDING_DELETION', 'DELETED']
const DEAD_TEMPLATE_WORDS = { REJECTED: 'rejected', DISABLED: 'disabled', PENDING_DELETION: 'deleted', DELETED: 'deleted' }

const LEGACY_BOARD_ERROR = "This board is built in code and can't be changed here."

const fail = (status, error, code) => (code ? { ok: false, status, error, code } : { ok: false, status, error })

/**
 * @param {object} db service-role client
 * @param {{
 *   locationId: string, pipelineId: string, stage: { id: string, slug?: string },
 *   recipeKey: string, packKey: string,
 *   render?: { studioName?, offerName?, durationDays?, signer?, bookingFlowId?, appLinks? },
 *   createdBy?: string|null, wantLive?: boolean,
 *   version?: number, bodies?: { [ref: string]: string },
 * }} opts
 * @returns {Promise<{ ok: true, followup: object, created: boolean, publishError?: string,
 *     code?: 'publish_failed_state_stuck' }
 *   | { ok: false, status: number, error: string, code?: string }>}
 *   `followup.state` is what is on disk: `code: 'publish_failed_state_stuck'`
 *   means a publish failed AND putting the row back failed, so it reads
 *   `live` over a draft sequence until a reinstall repairs it.
 */
export async function installFollowupPack(db, {
  locationId,
  pipelineId,
  stage,
  recipeKey,
  packKey,
  render = {},
  createdBy = null,
  wantLive = true,
  version,
  bodies,
} = {}) {
  if (!locationId || !pipelineId || !stage?.id || !recipeKey || !packKey) {
    return fail(400, 'A studio, board, stage, recipe and pack are all required.')
  }

  // 1. The board, at this studio, built by the builder (board_type set).
  const { data: board, error: boardErr } = await db.from('pipelines')
    .select('id, key, name, location_id, board_type, recipe_key')
    .eq('id', pipelineId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (boardErr) return fail(500, 'Could not read the board just now. Try again.')
  if (!board) return fail(404, 'Board not found')
  if (board.board_type == null) return fail(409, LEGACY_BOARD_ERROR)

  // The stage must be on this board. Its stored slug is the one the graph and
  // the enrolment trigger key on, not whatever the caller passed.
  const { data: stageRow, error: stageErr } = await db.from('pipeline_stages')
    .select('id, slug, stage_role, role_config')
    .eq('id', stage.id)
    .eq('pipeline_id', pipelineId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (stageErr) return fail(500, 'Could not read the stage just now. Try again.')
  if (!stageRow) return fail(404, 'Stage not found on this board')

  // The pack must belong to the board's recipe and to this kind of stage: a
  // book-the-first-class nudge on a Done stage would text the wrong people.
  if (board.recipe_key !== recipeKey) {
    return fail(409, 'This pack does not belong to this board\'s recipe.', 'recipe_mismatch')
  }
  const packDef = RECIPES[recipeKey]?.packs.find((p) => p.key === packKey)
  const packRole = packDef?.role
  if (packRole && packRole !== stageRow.stage_role) {
    return fail(409, 'This pack does not fit this stage.', 'stage_role_mismatch')
  }
  // A check-in message is written for its own day ({days_left} counts from
  // it): on a stage moved to another day it would tell people the wrong
  // number of days left. Refused before anything reaches Meta.
  if (packDef?.day != null && stageRow.role_config?.day !== packDef.day) {
    return fail(409, `This check-in message is written for day ${packDef.day}. Set the stage back to day ${packDef.day} to use it.`, 'pack_day_mismatch')
  }

  const { data: location, error: locErr } = await db.from('locations')
    .select('name')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) return fail(500, 'Could not read the studio just now. Try again.')
  if (!location) return fail(404, 'Studio not found')

  // 2. Already installed → return it (a stranded one is recovered first:
  // recheckInstalled).
  const { data: existing, error: existingErr } = await db.from('pipeline_stage_followups')
    .select(FOLLOWUP_COLUMNS)
    .eq('location_id', locationId)
    .eq('stage_id', stageRow.id)
    .eq('pack_key', packKey)
    .maybeSingle()
  if (existingErr) return fail(500, 'Could not read this stage\'s follow-ups just now. Try again.')
  if (existing && INSTALLED_STATES.includes(existing.state)) {
    return recheckInstalled(db, locationId, existing)
  }
  // An `off` row whose old sequence still runs: installing over it would
  // leave that sequence active beside the new one, two sequences sending the
  // same follow-up.
  if (existing?.state === 'off' && existing.sequence_id) {
    const { data: oldSeq, error: oldSeqErr } = await db.from('email_sequences')
      .select('id, status')
      .eq('id', existing.sequence_id)
      .eq('location_id', locationId)
      .maybeSingle()
    if (oldSeqErr) return fail(500, 'Could not read this follow-up\'s sequence just now. Try again.')
    if (oldSeq?.status === 'active') {
      return fail(409, 'This follow-up is switched off but its old sequence is still running. Pause that sequence first, then install again.', 'old_sequence_active')
    }
  }

  // 3. Render the pack. A bad fill-in or an unknown recipe/pack throws; the
  // graph is built once with placeholder ids so a broken pack fails here,
  // before anything reaches Meta.
  let rendered
  let packName
  try {
    rendered = renderPack(recipeKey, packKey, {
      ...render,
      boardKey: board.key,
      studioSlug: studioSlugFor(location.name),
      ...(version != null ? { version } : {}),
      ...(bodies != null ? { bodies } : {}),
    })
    packName = RECIPES[recipeKey].packs.find((p) => p.key === packKey).name
    const placeholders = Object.fromEntries(rendered.templates.map((t) => [t.ref, `pending_${t.ref}`]))
    const preflight = parseGraphShape(rendered.buildGraph(placeholders, stageRow.slug))
    if (!preflight.ok) throw new Error(`the ${packKey} pack builds an invalid sequence`)
  } catch (err) {
    return fail(400, err.message)
  }

  // The statuses submit returns are NOT kept: they are stale the moment Meta
  // approves, which can happen before this run finishes (step 6 re-reads).
  const templateIds = {}
  try {
    for (const t of rendered.templates) {
      const submitted = await submitWhatsappTemplate(db, {
        locationId,
        name: t.name,
        category: t.category,
        language: t.language,
        components: t.components,
        createdBy,
      })
      if (submitted.ok) {
        templateIds[t.ref] = submitted.template.id
        continue
      }
      // A reinstall: this studio already holds the template (same name and
      // language on its WABA). Link it instead of failing.
      if (submitted.code === 'name_clash' && submitted.existing?.id) {
        const linked = await readOwnTemplate(db, locationId, submitted.existing.id, t.name, t.components)
        if (!linked.ok) return linked
        templateIds[t.ref] = linked.template.id
        continue
      }
      return fail(submitted.status || 500, submitted.error || 'Could not submit the WhatsApp template.', submitted.code)
    }
  } catch (err) {
    logError(MODULE, 'template submit threw', { locationId, pipelineId, packKey, err: err?.message || String(err) })
    return fail(500, 'Could not submit the WhatsApp templates just now. Install it again to finish.')
  }

  const parsed = parseGraphShape(rendered.buildGraph(templateIds, stageRow.slug))
  if (!parsed.ok) return fail(500, `The ${packKey} pack built an invalid sequence.`)

  // 4. The sequence, as an inactive draft. The ROW's trigger is what
  // enrolment reads, so it matches the graph's.
  const { data: sequence, error: seqErr } = await db.from('email_sequences').insert({
    name: `${board.name} · ${packName}`,
    trigger_type: 'pipeline_stage_change',
    trigger_config: { to_status: stageRow.slug },
    status: 'draft',
    location_id: locationId,
    created_by: createdBy,
    draft_graph: parsed.data,
  }).select('id').single()
  if (seqErr || !sequence) {
    logError(MODULE, 'sequence insert failed', { locationId, pipelineId, packKey, err: seqErr?.message })
    return fail(500, 'The templates were submitted, but the follow-up sequence could not be created. Install it again to finish.')
  }

  // 5. Link it to the stage.
  const now = new Date().toISOString()
  const fields = {
    location_id: locationId,
    pipeline_id: pipelineId,
    stage_id: stageRow.id,
    sequence_id: sequence.id,
    whatsapp_template_id: templateIds[rendered.templates[0].ref] ?? null,
    pack_key: packKey,
    ...(version != null ? { version } : {}),
    state: 'awaiting_approval',
    want_live: Boolean(wantLive),
    created_by: createdBy,
    updated_at: now,
  }
  let linkRes
  if (existing) {
    // Re-install over a draft / rejected / off row: only if it has not moved.
    linkRes = await db.from('pipeline_stage_followups')
      .update(fields)
      .eq('id', existing.id)
      .eq('location_id', locationId)
      .eq('state', existing.state)
      .select(FOLLOWUP_COLUMNS)
  } else {
    linkRes = await db.from('pipeline_stage_followups')
      .insert(fields)
      .select(FOLLOWUP_COLUMNS)
  }
  const followup = linkRes.data?.[0]
  if (linkRes.error || !followup) {
    // Nothing links the sequence, it is a draft (never enrols) and it is
    // seconds old, so removing it is safe and keeps the sequences list free
    // of an orphan that would look like a second install.
    await removeSequence(db, locationId, sequence.id)
    const raced = linkRes.error?.code === '23505' || (!linkRes.error && !followup)
    if (raced) return fail(409, 'This follow-up was installed or changed at the same time. Refresh and check it.', 'install_raced')
    logError(MODULE, 'follow-up link failed', { locationId, pipelineId, packKey, err: linkRes.error?.message })
    return fail(500, 'The templates were submitted, but the follow-up could not be linked to the stage. Install it again to finish.')
  }

  // 6. Every template approved: go live now. Judged on the template rows
  // AS THEY ARE NOW, read after the link exists: from here on an approval
  // finds the awaiting_approval row (the hook publishes it), and one that
  // landed before the link is caught by this read. Same claim pattern as the
  // hook, so the two can never both publish.
  if (!wantLive) return { ok: true, followup, created: true }
  const outcome = await publishIfAllApproved(db, locationId, followup, sequence.id, Object.values(templateIds))
  return { ok: true, ...outcome, created: true }
}

// A claim that has held `live` over a draft sequence for longer than this is
// stuck (publish failed AND its revert failed). Younger than this it may be a
// publish still in flight (this installer or the approval hook), which must be
// left alone: reverting it would let a second caller publish again, and the
// first caller's revert would then undo the second caller's claim.
export const STUCK_LIVE_LEASE_MS = 5 * 60 * 1000

// Step 2: an installed row is returned as it stands, unless it is stranded.
//  - `live` over a sequence that is still a draft, claimed more than
//    STUCK_LIVE_LEASE_MS ago: a publish failed and the revert write failed
//    too, so nothing sends and no approval will ever move it. Put it back to
//    awaiting_approval (only if nobody re-claimed it since), then re-check.
//  - `awaiting_approval` (want_live): every template may already be approved
//    (an approval that landed mid-install, or a publish that failed after the
//    claim). Re-read the statuses at this studio and publish if so.
async function recheckInstalled(db, locationId, existing) {
  const asIs = { ok: true, followup: existing, created: false }
  if (!existing.sequence_id) return asIs
  if (existing.state === 'awaiting_approval' && !existing.want_live) return asIs

  const { data: seq, error: seqErr } = await db.from('email_sequences')
    .select('id, status, graph, draft_graph')
    .eq('id', existing.sequence_id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (seqErr) {
    logError(MODULE, 'reinstall: sequence read failed', { followupId: existing.id, err: seqErr.message })
    return fail(500, 'Could not read this follow-up\'s sequence just now. Try again.')
  }
  if (!seq) return asIs

  let followup = existing
  if (existing.state === 'live') {
    if (seq.status !== 'draft') return asIs
    if (claimIsFresh(existing.updated_at)) return asIs
    let revert = db.from('pipeline_stage_followups')
      .update({ state: 'awaiting_approval', updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .eq('location_id', locationId)
      .eq('state', 'live')
    // Only the claim we judged stale: a newer claim has a newer updated_at.
    if (existing.updated_at) revert = revert.eq('updated_at', existing.updated_at)
    const { data: reverted, error: revertErr } = await revert.select('id')
    if (revertErr) {
      logError(MODULE, 'reinstall: stuck live follow-up could not be put back', { followupId: existing.id, sequenceId: seq.id, err: revertErr.message })
      return fail(500, 'This follow-up is marked live but its sequence never went live, and it could not be repaired just now. Try again.', 'publish_failed_state_stuck')
    }
    // 0 rows: it moved under us (another install or the hook); leave it.
    if (!reverted?.length) return asIs
    followup = { ...existing, state: 'awaiting_approval' }
    if (!existing.want_live) return { ok: true, followup, created: false }
  }

  const outcome = await publishIfAllApproved(db, locationId, followup, seq.id, graphTemplateIds(seq.draft_graph ?? seq.graph))
  return { ok: true, ...outcome, created: false }
}

// Fresh statuses of every template the follow-up sends, at THIS studio only
// (an id from another studio never counts as approved here). All APPROVED →
// claim and publish. Returns { followup, publishError?, code? }.
async function publishIfAllApproved(db, locationId, followup, sequenceId, templateIds) {
  const ids = [...new Set(templateIds.filter(Boolean).map(String))]
  if (ids.length === 0) return { followup }
  const { data: rows, error } = await db.from('whatsapp_templates')
    .select('id, status')
    .eq('location_id', locationId)
    .in('id', ids)
  if (error) {
    logError(MODULE, 'install: template status re-read failed', { followupId: followup.id, err: error.message })
    return { followup, publishError: 'Could not check whether Meta has approved the templates just now. Install it again to finish.' }
  }
  const approved = new Set((rows || []).filter((t) => t.status === 'APPROVED').map((t) => String(t.id)))
  if (!ids.every((id) => approved.has(id))) return { followup }
  return claimAndPublish(db, locationId, followup, sequenceId)
}

// True while a `live` claim is young enough to be a publish still in flight.
// An unreadable timestamp counts as stale, so a stuck row is never kept stuck.
function claimIsFresh(updatedAt, now = Date.now()) {
  const at = Date.parse(updatedAt ?? '')
  return Number.isFinite(at) && now - at < STUCK_LIVE_LEASE_MS
}

async function claimAndPublish(db, locationId, followup, sequenceId) {
  // The claim's own timestamp: the revert below matches on it, so a failed
  // publish can only undo THIS claim, never a newer one.
  const claimAt = new Date().toISOString()
  const { data: claimed, error: claimErr } = await db.from('pipeline_stage_followups')
    .update({ state: 'live', updated_at: claimAt })
    .eq('id', followup.id)
    .eq('location_id', locationId)
    .eq('state', 'awaiting_approval')
    .select('id')
  if (claimErr) {
    logError(MODULE, 'install: live claim failed', { followupId: followup.id, err: claimErr.message })
    return { followup, publishError: 'Could not switch the follow-up on just now.' }
  }
  // 0 rows: the approval hook claimed it first and is publishing it. Report
  // the row as it now stands.
  if (!claimed?.length) return { followup: await rereadFollowup(db, locationId, followup) }

  let published
  try {
    published = await publishSequence(db, { sequenceId })
  } catch (err) {
    published = { ok: false, error: err?.message || String(err) }
  }
  if (published?.ok) return { followup: { ...followup, state: 'live', updated_at: claimAt } }

  const { data: reverted, error: revertErr } = await db.from('pipeline_stage_followups')
    .update({ state: 'awaiting_approval', updated_at: new Date().toISOString() })
    .eq('id', followup.id)
    .eq('location_id', locationId)
    .eq('state', 'live')
    .eq('updated_at', claimAt)
    .select('id')
  if (!revertErr && !reverted?.length) {
    // Someone re-claimed it after our claim (a reinstall's repair once the
    // lease ran out). Their claim stands; report the row as it now is.
    logError(MODULE, 'install: publish failed; the follow-up was re-claimed meanwhile, left as it is', {
      followupId: followup.id, sequenceId, err: published?.error,
    })
    return { followup: await rereadFollowup(db, locationId, followup), publishError: published?.error }
  }
  if (revertErr) {
    // The row reads live over a draft sequence. Say so: reporting
    // awaiting_approval would be a lie about what is on disk. A reinstall
    // repairs it (recheckInstalled).
    logError(MODULE, 'install: publish failed and the follow-up could not be put back; it reads live over a draft sequence', {
      followupId: followup.id, sequenceId, err: published?.error, revertErr: revertErr.message,
    })
    return { followup: { ...followup, state: 'live' }, publishError: published?.error, code: 'publish_failed_state_stuck' }
  }
  logError(MODULE, 'install: publish failed', { followupId: followup.id, sequenceId, err: published?.error })
  return { followup: { ...followup, state: 'awaiting_approval' }, publishError: published?.error }
}

async function rereadFollowup(db, locationId, followup) {
  const { data, error } = await db.from('pipeline_stage_followups')
    .select(FOLLOWUP_COLUMNS)
    .eq('id', followup.id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error || !data) return followup
  return data
}

// The clashing row submitWhatsappTemplate named, re-read at THIS studio.
const bodyTextOf = (components) => {
  const body = Array.isArray(components)
    ? components.find((c) => String(c?.type || '').toUpperCase() === 'BODY')
    : null
  return typeof body?.text === 'string' ? body.text.trim() : null
}

async function readOwnTemplate(db, locationId, templateId, name, wantedComponents) {
  const { data, error } = await db.from('whatsapp_templates')
    .select('id, status, components')
    .eq('id', templateId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return fail(500, 'Could not read the saved WhatsApp template just now. Try again.')
  if (!data) return fail(409, `The template ${name} could not be found at this studio.`, 'name_clash')
  // Template names are fixed per studio, board and pack, so new wording under
  // the same name is not a way out; replacing the template is an admin job.
  if (DEAD_TEMPLATE_STATUSES.includes(data.status)) {
    return fail(409, `This step's WhatsApp template (${name}) was ${DEAD_TEMPLATE_WORDS[data.status]} by Meta. Ask an admin to replace it before installing again.`, 'template_rejected')
  }
  // Same name, different wording: a failed run left old wording under this
  // name. Linking it would send words nobody chose, so refuse (the caller
  // moves to a fresh version). Same wording is a retry converging.
  const have = bodyTextOf(data.components)
  const want = bodyTextOf(wantedComponents)
  if (have == null || want == null || have !== want) {
    return fail(409, 'A template with this name already exists with different wording.', 'template_wording_differs')
  }
  return { ok: true, template: data }
}

async function removeSequence(db, locationId, sequenceId) {
  const { error } = await db.from('email_sequences')
    .delete()
    .eq('id', sequenceId)
    .eq('location_id', locationId)
    .eq('status', 'draft')
  if (error) logError(MODULE, 'orphan draft sequence not removed', { locationId, sequenceId, err: error.message })
}
