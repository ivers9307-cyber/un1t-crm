// WAYSIN.5 — GET/PUT /api/locations/[id]/lead-sources: the studio's lead-source
// vocabulary (src/lib/lead-source-vocabulary.js) and the owner's own list.
//
//   locations.settings.lead_sources = ['clubhouse_partner', …]
//
//   GET → { sources: [{ value, label, origin }], studio_sources, can_edit }
//         sources = the nine defaults ∪ the owner's list ∪ every value seen on
//         a contact at the studio. Anyone holding Contacts at the studio may
//         read it (the pickers on ContactForm and AudienceBuilder need it);
//         a failed contacts read is a 503, never a shorter list.
//   PUT { sources: string[] } → { studio_sources, can_edit }
//         each trimmed and lowercased, then `^[a-z0-9][a-z0-9_-]{0,79}$`
//         (leadSourceSchema), at most 50, deduped. Master or owner AT the
//         studio (guardMasterOrOwner). The settings jsonb is merged through
//         mergeLocationSettings (SETTINGSWIPE.1), never clobbered. The key is
//         not secret-named, so the audit trigger records the change in clear,
//         which is right.
//
// Removing a value from the owner's list never rewrites a contact: a value
// still on contacts stays in the vocabulary as 'seen'.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { leadSourceSchema } from '@/lib/schemas'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
import {
  leadSourceVocabulary, studioLeadSourcesFromSettings, STUDIO_LEAD_SOURCES_MAX,
} from '@/lib/lead-source-vocabulary'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const LeadSourcesSchema = z.object({
  sources: z.array(leadSourceSchema).max(STUDIO_LEAD_SOURCES_MAX),
})

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: locationId } = await params
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'contacts')) {
    return NextResponse.json({ success: false, error: 'You need Contacts at this studio.' }, { status: 403 })
  }

  const db = createServerClient()
  const vocab = await leadSourceVocabulary(db, locationId)
  if (!vocab.ok) {
    logError('lead-sources', 'vocabulary read failed', { locationId, err: vocab.error })
    return NextResponse.json({ success: false, error: 'Could not read the lead sources just now. Try again.' }, { status: 503 })
  }
  const canEdit = guardMasterOrOwner(user, locationId) === null
  return NextResponse.json({ success: true, data: { sources: vocab.sources, studio_sources: vocab.studio, can_edit: canEdit } })
}

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: locationId } = await params
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners and masters can change the lead sources.' }, { status: 403 })
  }

  const validation = await validateBody(request, LeadSourcesSchema)
  if (!validation.ok) return validation.response
  const next = [...new Set(validation.data.sources)]

  const db = createServerClient()
  const result = await mergeLocationSettings(db, locationId, (current) => ({ ...current, lead_sources: next }), { scope: 'lead-sources' })
  if (!result.ok) return settingsSaveFailure(result)
  return NextResponse.json({ success: true, data: { studio_sources: studioLeadSourcesFromSettings(result.settings), can_edit: true } })
}
