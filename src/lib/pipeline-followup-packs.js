// PIPEBUILD.4d — install one follow-up pack on one stage of an offer board:
// submit the pack's WhatsApp templates to Meta, create its sequence as an
// inactive draft, and link both to the stage in pipeline_stage_followups. If
// every template is already APPROVED (a reinstall), publish at once: no Meta
// webhook will ever arrive to do it.
//
// Service role, so every read and write is scoped by location here. Never
// throws: every failure is a { ok: false, status, error, code? } result.
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
import { RECIPES, renderPack, studioSlugFor } from '../../shared/pipelines/recipes.js'

const MODULE = 'pipeline-followups'

// Same-file literal so check:select-columns resolves it.
const FOLLOWUP_COLUMNS = 'id, location_id, pipeline_id, stage_id, sequence_id, whatsapp_template_id, pack_key, state, want_live, created_by, created_at, updated_at'

// A row in one of these states is already installed; return it untouched.
const INSTALLED_STATES = ['awaiting_approval', 'live']
// A saved template in one of these states can never be approved, so linking
// it on a reinstall would leave the follow-up waiting for ever.
const DEAD_TEMPLATE_STATUSES = ['REJECTED', 'DISABLED', 'PENDING_DELETION', 'DELETED']

const LEGACY_BOARD_ERROR = "This board is built in code and can't be changed here."

const fail = (status, error, code) => (code ? { ok: false, status, error, code } : { ok: false, status, error })

/**
 * @param {object} db service-role client
 * @param {{
 *   locationId: string, pipelineId: string, stage: { id: string, slug?: string },
 *   recipeKey: string, packKey: string,
 *   render?: { studioName?, offerName?, durationDays?, signer?, bookingFlowId?, appLinks? },
 *   createdBy?: string|null, wantLive?: boolean,
 * }} opts
 * @returns {Promise<{ ok: true, followup: object, created: boolean, publishError?: string }
 *   | { ok: false, status: number, error: string, code?: string }>}
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
} = {}) {
  if (!locationId || !pipelineId || !stage?.id || !recipeKey || !packKey) {
    return fail(400, 'A studio, board, stage, recipe and pack are all required.')
  }

  // 1. The board, at this studio, built by the builder (board_type set).
  const { data: board, error: boardErr } = await db.from('pipelines')
    .select('id, key, name, location_id, board_type')
    .eq('id', pipelineId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (boardErr) return fail(500, 'Could not read the board just now. Try again.')
  if (!board) return fail(404, 'Board not found')
  if (board.board_type == null) return fail(409, LEGACY_BOARD_ERROR)

  // The stage must be on this board. Its stored slug is the one the graph and
  // the enrolment trigger key on, not whatever the caller passed.
  const { data: stageRow, error: stageErr } = await db.from('pipeline_stages')
    .select('id, slug')
    .eq('id', stage.id)
    .eq('pipeline_id', pipelineId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (stageErr) return fail(500, 'Could not read the stage just now. Try again.')
  if (!stageRow) return fail(404, 'Stage not found on this board')

  const { data: location, error: locErr } = await db.from('locations')
    .select('name')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) return fail(500, 'Could not read the studio just now. Try again.')
  if (!location) return fail(404, 'Studio not found')

  // 2. Already installed → return it as it stands.
  const { data: existing, error: existingErr } = await db.from('pipeline_stage_followups')
    .select(FOLLOWUP_COLUMNS)
    .eq('location_id', locationId)
    .eq('stage_id', stageRow.id)
    .eq('pack_key', packKey)
    .maybeSingle()
  if (existingErr) return fail(500, 'Could not read this stage\'s follow-ups just now. Try again.')
  if (existing && INSTALLED_STATES.includes(existing.state)) {
    return { ok: true, followup: existing, created: false }
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
    })
    packName = RECIPES[recipeKey].packs.find((p) => p.key === packKey).name
    const placeholders = Object.fromEntries(rendered.templates.map((t) => [t.ref, `pending_${t.ref}`]))
    const preflight = parseGraphShape(rendered.buildGraph(placeholders, stageRow.slug))
    if (!preflight.ok) throw new Error(`the ${packKey} pack builds an invalid sequence`)
  } catch (err) {
    return fail(400, err.message)
  }

  const templateIds = {}
  const templateStatuses = []
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
      templateStatuses.push(submitted.template.status)
      continue
    }
    // A reinstall: this studio already holds the template (same name and
    // language on its WABA). Link it instead of failing.
    if (submitted.code === 'name_clash' && submitted.existing?.id) {
      const linked = await readOwnTemplate(db, locationId, submitted.existing.id, t.name)
      if (!linked.ok) return linked
      templateIds[t.ref] = linked.template.id
      templateStatuses.push(linked.template.status)
      continue
    }
    return fail(submitted.status || 500, submitted.error || 'Could not submit the WhatsApp template.', submitted.code)
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

  // 6. Every template already approved: go live now (same claim pattern as
  // the approval hook, so the two can never both publish).
  const allApproved = templateStatuses.length > 0 && templateStatuses.every((s) => s === 'APPROVED')
  if (!wantLive || !allApproved) return { ok: true, followup, created: true }

  const { data: claimed, error: claimErr } = await db.from('pipeline_stage_followups')
    .update({ state: 'live', updated_at: new Date().toISOString() })
    .eq('id', followup.id)
    .eq('location_id', locationId)
    .eq('state', 'awaiting_approval')
    .select('id')
  if (claimErr) {
    logError(MODULE, 'install: live claim failed', { followupId: followup.id, err: claimErr.message })
    return { ok: true, followup, created: true, publishError: 'Could not switch the follow-up on just now.' }
  }
  // 0 rows: the approval hook claimed it first and is publishing it.
  if (!claimed?.length) return { ok: true, followup, created: true }

  const published = await publishSequence(db, { sequenceId: sequence.id })
  if (published.ok) return { ok: true, followup: { ...followup, state: 'live' }, created: true }

  const { error: revertErr } = await db.from('pipeline_stage_followups')
    .update({ state: 'awaiting_approval', updated_at: new Date().toISOString() })
    .eq('id', followup.id)
    .eq('location_id', locationId)
    .eq('state', 'live')
  logError(MODULE, 'install: publish failed', {
    followupId: followup.id,
    sequenceId: sequence.id,
    err: published.error,
    revertErr: revertErr?.message,
  })
  return { ok: true, followup, created: true, publishError: published.error }
}

// The clashing row submitWhatsappTemplate named, re-read at THIS studio.
async function readOwnTemplate(db, locationId, templateId, name) {
  const { data, error } = await db.from('whatsapp_templates')
    .select('id, status')
    .eq('id', templateId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return fail(500, 'Could not read the saved WhatsApp template just now. Try again.')
  if (!data) return fail(409, `The template ${name} could not be found at this studio.`, 'name_clash')
  if (DEAD_TEMPLATE_STATUSES.includes(data.status)) {
    return fail(409, `Meta has ${String(data.status).toLowerCase()} the template ${name}. Change its wording before installing this follow-up again.`, 'template_rejected')
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
