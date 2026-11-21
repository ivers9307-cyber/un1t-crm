// PIPE3.8 — GET/PUT /api/locations/[id]/pipeline-programmes: who is a
// PROGRAMME lead at this studio (the Programmes pipeline board, spec
// docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md).
//
//   locations.settings.pipelines.programmes = {
//     lead_sources:         ['meta_50plus', …],   landing-page lead sources
//     glofox_plan_patterns: ['elites trial', …],  substrings of a Glofox trial plan name
//   }
//
// A SETTING, not code, so /postnatal plugs in by adding its lead source here.
// The match is made once per contact and recorded as a claim
// (pipeline_board_claims, mig 797); the router reads the claim, so a change
// here places NEW matches and never un-places anyone.
//
//   GET → { has_board, lead_sources, glofox_plan_patterns, can_edit }
//   PUT { lead_sources: string[], glofox_plan_patterns: string[] }
//
// Gate (the payroll route's shape): membership first (assertLocationAccess),
// then master or owner AT this studio for the write (guardMasterOrOwner). Any
// member may read: the lists are configuration, not a credential. The settings
// jsonb is merged through mergeLocationSettings (SETTINGSWIPE.1), never
// clobbered. Neither key is secret-named, so the audit trigger records the
// change in clear, which is right.
//
// withAuth's 'param' mode is the membership check, as on the payroll route: a
// studio the caller is not at is now 404 (was 403), signed out is its 401.
// guardMasterOrOwner still names the path studio explicitly.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { guardMasterOrOwner } from '@/lib/auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import { programmeRulesFromSettings } from '@/lib/pipeline-claims'
import { BOARD_KEYS } from '@shared/pipelines/router.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const entry = z.string().trim().min(1).max(80)
export const ProgrammeRulesSchema = z.object({
  lead_sources: z.array(entry).max(20),
  glofox_plan_patterns: z.array(entry).max(20),
})

function shape(settings, hasBoard, canEdit) {
  const rules = programmeRulesFromSettings(settings)
  return { has_board: hasBoard, lead_sources: rules.lead_sources, glofox_plan_patterns: rules.glofox_plan_patterns, can_edit: canEdit }
}

// Does this studio have a Programmes board at all (enabled or not)? The card
// hides itself otherwise. A failed read reads as "no board": the lists still
// come back, and the card simply does not draw.
async function hasProgrammesBoard(db, locationId) {
  const { data, error } = await db
    .from('pipelines')
    .select('id')
    .eq('location_id', locationId)
    .eq('key', BOARD_KEYS.PROGRAMMES)
    .limit(1)
  if (error) return false
  return Array.isArray(data) && data.length > 0
}

export const GET = withAuth({ permission: null, location: 'param' }, async ({ user, db, locationId }) => {
  const { data: location, error } = await db
    .from('locations')
    .select('id, settings')
    .eq('id', locationId)
    .maybeSingle()                         // primary key; 0 rows = not found
  if (error) {
    logError('pipeline-programmes', 'location read failed', { locationId, err: error })
    return NextResponse.json({ success: false, error: 'Could not read the studio settings. Try again.' }, { status: 500 })
  }
  if (!location) return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })

  const hasBoard = await hasProgrammesBoard(db, locationId)
  const canEdit = guardMasterOrOwner(user, locationId) === null
  return NextResponse.json({ success: true, data: shape(location.settings, hasBoard, canEdit) })
})

export const PUT = withAuth({ permission: null, location: 'param' }, async ({ user, db, request, locationId }) => {
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners and masters can change the Programmes board rules.' }, { status: 403 })
  }

  const validation = await validateBody(request, ProgrammeRulesSchema)
  if (!validation.ok) return validation.response
  const clean = (list) => [...new Set(list.map((v) => v.trim().toLowerCase()).filter(Boolean))]
  const next = { lead_sources: clean(validation.data.lead_sources), glofox_plan_patterns: clean(validation.data.glofox_plan_patterns) }

  const result = await mergeLocationSettings(db, locationId, (current) => {
    const pipelines = { ...(current.pipelines || {}) }
    pipelines.programmes = next
    return { ...current, pipelines }
  }, { scope: 'pipeline-programmes' })
  if (!result.ok) return settingsSaveFailure(result)
  const hasBoard = await hasProgrammesBoard(db, locationId)
  return NextResponse.json({ success: true, data: shape(result.settings, hasBoard, true) })
})
