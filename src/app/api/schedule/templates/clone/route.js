import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { generateBlocksForTemplate } from '@/lib/roster'
import { logWarn } from '@/lib/log'
import { planTemplateClone, organizationCheck, CLONE_SKIP_REASONS } from '@/lib/shift-template-clone'

// TPLCLONE.1 — POST /api/schedule/templates/clone
//
// Copy shift templates from one studio into another studio of the SAME
// organisation. The caller needs a manager role (MANAGER_ROLES, the set that
// may create a template) AT BOTH studios; a master passes that, and is still
// held to one organisation.
//
// Why the organisation is read and not inferred: membership proves nothing
// about it. A master's user.locations is every active studio on the estate, an
// org admin's is every studio of every org they administer, and nothing keeps a
// person inside one organisation (ORGSCOPE.1). So both studios' rows are read
// and their organization_id compared, both present AND equal.
//
// 403 on every refusal of a body-param studio (assertLocationAccess's
// convention). The cross-organisation 403 discloses nothing: only a caller who
// is already a member of both studios can reach it.
//
// Every read and the write stay in THIS file, each pinned to its studio in the
// chain itself: check:location-scoping reads route files, not src/lib, and
// tests/shift-template-clone.guards.test.js checks each chain.
//
// The copy is one multi-row upsert, ON CONFLICT (location_id, name) DO
// NOTHING (the mig 010 unique key): all or nothing, and a template the target
// gains while this runs comes back as skipped rather than failing the batch.
// dry_run answers the same lists and writes nothing; the template manager's
// preview IS a dry run, so preview and copy cannot disagree.
//
// Weekdays are NOT copied unless copy_weekdays is true (an owner-level
// default). Copying days_of_week makes the target studio's calendar generate
// eight weeks of empty shifts at once (and nightly after that, via
// extend-roster-horizon) and switches its roster runway alerts on
// (fetchRosterRunways skips a studio with no weekday template). Without it,
// a copy lands as a one-off template (days_of_week = []).
//
// Filling the calendar is a follow-on, not the copy. With copy_weekdays, a
// copied template with weekdays gets its next 8 weeks of blocks now, as
// creating one by hand does; if that fails the copy stands, the answer
// carries a warning, and the nightly extend-roster-horizon run fills them.
const CloneTemplatesSchema = z.object({
  from_location_id: uuidLike,
  to_location_id: uuidLike,
  template_ids: z.array(uuidLike).min(1).max(200).optional(),
  copy_weekdays: z.boolean().optional(),
  dry_run: z.boolean().optional(),
}).refine((b) => b.from_location_id !== b.to_location_id, {
  message: 'Choose a different studio to copy from',
  path: ['from_location_id'],
})

const refuse = (status, error) => NextResponse.json({ success: false, error }, { status })

function previewOf({ source_id, source_days_of_week, row }) {
  return {
    source_id,
    name: row.name,
    start_time: row.start_time,
    end_time: row.end_time,
    // What the copy gets (empty unless copy_weekdays) and what the source
    // runs on, so the preview can say what copying the weekdays would add.
    days_of_week: row.days_of_week || [],
    source_days_of_week: source_days_of_week || [],
  }
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) return refuse(403, 'Unauthorized')

  const validation = await validateBody(request, CloneTemplatesSchema)
  if (!validation.ok) return validation.response
  const {
    from_location_id: fromId,
    to_location_id: toId,
    template_ids: templateIds = null,
    copy_weekdays: copyWeekdays = false,
    dry_run: dryRun = false,
  } = validation.data

  // Membership first, so a studio the caller is not at is answered as that,
  // not with a role complaint that confirms it exists.
  for (const id of [fromId, toId]) {
    const guard = assertLocationAccess(user, id)
    if (guard) return guard
  }
  if (!hasRoleAtLocation(user, fromId, MANAGER_ROLES) || !hasRoleAtLocation(user, toId, MANAGER_ROLES)) {
    return refuse(403, 'You need to be a manager at both studios to copy templates between them.')
  }

  const db = createServerClient()

  const { data: studios, error: studiosErr } = await db
    .from('locations')
    .select('id, organization_id')
    .in('id', [fromId, toId])
  if (studiosErr) return refuse(500, 'Could not check the two studios; nothing was copied.')
  const org = organizationCheck(studios, fromId, toId)
  if (org === 'not_found') return refuse(404, 'Studio not found')
  if (org !== 'same_org') return refuse(403, 'Templates can only be copied between studios in the same organisation.')

  // Neither read pages: a studio has tens of templates (the estate's largest
  // has 22), and the nightly horizon cron reads every template unpaged too.
  // select('*') on the source is deliberate: TEMPLATE_CLONE_COLUMNS decides
  // what is copied, so SHIFTTYPE.1's `kind` is a one-line change there.
  let sourceQuery = db
    .from('shift_templates')
    .select('*')
    .eq('location_id', fromId)
    .order('display_order')
    .order('start_time')
    .order('name')
  if (templateIds) sourceQuery = sourceQuery.in('id', templateIds)
  const [
    { data: source, error: sourceErr },
    { data: target, error: targetErr },
  ] = await Promise.all([
    sourceQuery,
    db.from('shift_templates').select('name, display_order').eq('location_id', toId),
  ])
  if (sourceErr || targetErr) return refuse(500, 'Could not read the templates; nothing was copied.')

  const plan = planTemplateClone({ sourceTemplates: source, targetTemplates: target, templateIds, copyWeekdays })

  if (dryRun || plan.toCreate.length === 0) {
    return NextResponse.json({
      success: true,
      data: {
        dry_run: dryRun,
        created: dryRun ? plan.toCreate.map(previewOf) : [],
        skipped: plan.skipped,
        generated_blocks: 0,
      },
    })
  }

  const { data: inserted, error: insertErr } = await db
    .from('shift_templates')
    .upsert(
      plan.toCreate.map(({ row }) => ({ ...row, location_id: toId })),
      { onConflict: 'location_id,name', ignoreDuplicates: true },
    )
    .select('id, location_id, name, start_time, end_time, days_of_week, min_coaches, max_coaches')
  if (insertErr) {
    logWarn('schedule/templates/clone', 'template copy insert failed', { from: fromId, to: toId, error: insertErr.message })
    return refuse(500, 'Could not copy the templates; nothing was copied.')
  }

  // ON CONFLICT DO NOTHING returns only the rows it inserted. A planned row
  // that is missing lost a race to a template of the same name.
  const insertedByName = new Map((inserted || []).map((t) => [t.name, t]))
  const created = []
  const skipped = [...plan.skipped]
  for (const p of plan.toCreate) {
    const t = insertedByName.get(p.row.name)
    if (t) created.push({ id: t.id, ...previewOf(p) })
    else skipped.push({ source_id: p.source_id, name: p.row.name, reason: CLONE_SKIP_REASONS.nameExists })
  }

  // Without copy_weekdays every inserted row has days_of_week = [], so this
  // loop does nothing and the calendar is left alone.
  let generatedBlocks = 0
  const unfilled = []
  for (const t of inserted || []) {
    if (!(t.days_of_week || []).length) continue
    try {
      const res = await generateBlocksForTemplate(db, t)
      generatedBlocks += res?.inserted || 0
    } catch (e) {
      unfilled.push(t.name)
      logWarn('schedule/templates/clone', 'block generation failed after a template copy', {
        template_id: t.id, location_id: toId, error: e?.message,
      })
    }
  }

  const body = { success: true, data: { dry_run: false, created, skipped, generated_blocks: generatedBlocks } }
  if (unfilled.length > 0) {
    body.warning = `Templates copied, but the calendar could not be filled for ${unfilled.join(', ')} yet. The nightly schedule run adds those shifts.`
  }
  return NextResponse.json(body, { status: 201 })
}
