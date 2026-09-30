// HYROX-STYLE — PUT /api/hyrox/settings: operator editor for the Hyrox
// charter + house style + style examples, stored on locations.settings.hyrox
// (jsonb). One key through mergeLocationSettings (SETTINGSWIPE.1), so sibling
// settings keys are never clobbered, and a failed read writes nothing.
// Collection-style write (location_id in the body) — Forbidden (403) on a
// missing per-location grant, unlike the detail routes' 404 IDOR posture.
//
// C32 HYROXSTAR.1 — style_examples is a list the page edits whole, but the
// exemplar route ("Save as style example") appends to the STORED list behind
// the page's back. A whole-array PUT therefore deleted any example starred
// after the page loaded. The page now sends `known_example_ids` (every id it
// has seen); a stored example whose id it never saw is kept (prepended, as the
// exemplar route adds them), one it saw and dropped is removed. Without the
// field (a page loaded before this shipped) the array replaces as before.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { MAX_STORED_EXAMPLES, MAX_STORED_EXAMPLE_CHARS } from '@/lib/hyrox/constants'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'

export const dynamic = 'force-dynamic'

const ExampleSchema = z.object({
  id: z.string().max(64).optional(),
  source: z.enum(['pasted', 'generated']).default('pasted'),
  label: z.string().max(120).optional(),
  text: z.string().min(1).max(MAX_STORED_EXAMPLE_CHARS),
  added_at: z.string().optional(),
})
const SettingsSchema = z.object({
  location_id: uuidLike,
  charter: z.string().max(8000).nullish(),
  house_style: z.string().max(8000).nullish(),
  style_examples: z.array(ExampleSchema).max(MAX_STORED_EXAMPLES).optional(),
  known_example_ids: z.array(z.string().max(64)).max(200).optional(),
})

/**
 * The examples to store: the page's list, plus any stored example the page
 * never saw (added elsewhere since it loaded). Pure.
 */
export function mergeStyleExamples(stored, sent, knownIds) {
  if (!Array.isArray(knownIds)) return sent
  const known = new Set(knownIds)
  const sentIds = new Set(sent.map((e) => e?.id).filter(Boolean))
  const unseen = (Array.isArray(stored) ? stored : [])
    .filter((e) => e?.id && !known.has(e.id) && !sentIds.has(e.id))
  return [...unseen, ...sent].slice(0, MAX_STORED_EXAMPLES)
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const v = await validateBody(request, SettingsSchema)
  if (!v.ok) return v.response
  const body = v.data
  if (!hasPermissionForLocation(user, body.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  // SETTINGSWIPE.1 — one key (settings.hyrox) through mergeLocationSettings;
  // this used to discard its read error and rewrite the whole column.
  const saved = await mergeLocationSettings(db, body.location_id, (settings) => {
    const hyrox = { ...(settings.hyrox || {}) }
    if (body.charter !== undefined) hyrox.charter = body.charter || null
    if (body.house_style !== undefined) hyrox.house_style = body.house_style || null
    if (body.style_examples !== undefined) {
      hyrox.style_examples = mergeStyleExamples(hyrox.style_examples, body.style_examples, body.known_example_ids)
    }
    settings.hyrox = hyrox
    return settings
  }, { scope: 'hyrox-settings' })
  if (!saved.ok) return settingsSaveFailure(saved)
  return NextResponse.json({ success: true, data: { hyrox: saved.settings.hyrox } })
}
