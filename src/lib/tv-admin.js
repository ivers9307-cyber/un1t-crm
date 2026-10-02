// MEMBERWRITESWEEP.1f — the shared gate, schemas and validators for the TV
// admin's session routes:
//   /api/admin/tv-displays            GET list (+ content), POST register
//   /api/admin/tv-displays/[id]       PATCH rotation, DELETE
//   /api/admin/tv-displays/[id]/content  PUT push, DELETE clear
//   /api/admin/tv-templates           GET list, POST create
//   /api/admin/tv-templates/[id]      GET, PUT, DELETE
//
// Until this PR the web TV admin (TVAdmin.jsx, TemplateEditor.jsx) and the
// staff phone (mobile/lib/tv-api.js) read and wrote tv_displays, tv_content
// and tv_templates straight from a client session. The only fence was the
// membership policies (mig 160/190: `private.auth_is_in_location`), so any
// member of a studio, plain staff included, could read every TV's cast token,
// put any URL on the public cast page (javascript: and data: included) and
// choose pushed_by / created_by. Mig 685 (PR 1g) closes the three tables to
// clients once these routes are deployed and the phone OTA is adopted.
//
// The gate is D7's "keep today's gates exactly": the gate of the page, the
// phone screen and the upload routes (src/lib/tv-upload-gate.js). Order:
// session (401) → web OR mobile tv_displays somewhere (coarse 403, before
// any read) → the row by id (404) → the row's studio among the caller's
// (404, not 403, so ids are not enumerable) → web OR mobile tv_displays AT
// that studio (403). List and create take the studio from the query / body.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { tvUploadAnywhereGate } from '@/lib/tv-upload-gate'

export const TV_DISPLAY_COLUMNS = 'id, label, token, active, rotation, location_id, created_at'
export const TV_CONTENT_COLUMNS = 'tv_display_id, source_type, source_ref, label, template_values, pushed_at'
export const TV_TEMPLATE_COLUMNS = 'id, name, base_image_path, zones, location_id'

// tv_displays_rotation_check (mig 189).
export const TV_ROTATIONS = Object.freeze([0, 90, 180, 270])
// What a person may push. 'generated' (the fourth value of
// tv_content_source_type_check) is the Hyrox runner's, service role only.
export const TV_PUSH_SOURCE_TYPES = Object.freeze(['url', 'storage', 'template'])

// Postgres unique_violation: tv_displays (location_id, label),
// tv_templates (location_id, name).
export const UNIQUE_VIOLATION = '23505'

const NOT_AUTHORISED = () =>
  NextResponse.json({ success: false, error: 'Not authorised for TV displays' }, { status: 403 })
export const tvNotFound = (what = 'TV') =>
  NextResponse.json({ success: false, error: `${what} not found` }, { status: 404 })
export const tvBadRequest = (error) => NextResponse.json({ success: false, error }, { status: 400 })
export const tvConflict = (error) => NextResponse.json({ success: false, error }, { status: 409 })
export const tvServerError = (error) =>
  NextResponse.json({ success: false, error: error || 'Something went wrong' }, { status: 500 })

/** The coarse pre-check (the upload routes'): 401 signed out, 403 without the key anywhere. */
export const tvAdminAnywhereGate = tvUploadAnywhereGate

/**
 * The decision at a studio: 401 no session, 400 no studio, 404 not a member
 * there, 403 without web or mobile tv_displays there; null = allowed.
 */
export function authoriseTvLocation(user, locationId) {
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!locationId || !uuidLike.safeParse(locationId).success) return tvBadRequest('No location.')
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'tv_displays') && !hasMobilePermissionForLocation(user, locationId, 'tv_displays')) {
    return NOT_AUTHORISED()
  }
  return null
}

async function loadRowForUser(db, user, id, columns, table, what) {
  const coarse = tvAdminAnywhereGate(user)
  if (coarse) return { response: coarse }
  if (!uuidLike.safeParse(id).success) return { response: tvNotFound(what) }
  const { data: row, error } = await db.from(table).select(columns).eq('id', id).maybeSingle()
  if (error) return { response: tvServerError(`Could not read the ${what.toLowerCase()}`) }
  if (!row || !row.location_id) return { response: tvNotFound(what) }
  const gate = authoriseTvLocation(user, row.location_id)
  if (gate) return { response: gate }
  return { row }
}

/** A TV by id, gated at its own studio. `columns` must include location_id. → { display } | { response } */
export async function loadTvDisplayForUser(db, user, id, columns) {
  const { row, response } = await loadRowForUser(db, user, id, columns, 'tv_displays', 'TV')
  return response ? { response } : { display: row }
}

/** A template by id, gated at its own studio. `columns` must include location_id. → { template } | { response } */
export async function loadTvTemplateForUser(db, user, id, columns) {
  const { row, response } = await loadRowForUser(db, user, id, columns, 'tv_templates', 'Template')
  return response ? { response } : { template: row }
}

/** Each TV with its one content row (`content`), or null when it is idle. */
export function mergeTvContent(displays, contents) {
  const byDisplay = new Map((contents || []).map((c) => [c.tv_display_id, c]))
  return (displays || []).map((d) => ({ ...d, content: byDisplay.get(d.id) || null }))
}

// ── Schemas ──────────────────────────────────────────────────────────────

export const TvRegisterSchema = z.object({
  location_id: uuidLike,
  label: z.string().trim().min(1, 'A label is required.').max(80, 'Keep the label under 80 characters.'),
})

export const TvRotationSchema = z.object({
  rotation: z.number().int().refine((r) => TV_ROTATIONS.includes(r), 'Rotation must be 0, 90, 180 or 270.'),
})

export const TvPushSchema = z.object({
  source_type: z.string().min(1),
  source_ref: z.string().min(1).max(2048),
  label: z.string().max(200).nullable().optional(),
  template_values: z.unknown().optional(),
})

const Zones = z.array(z.object({}).passthrough()).max(100)
export const TvTemplateSaveSchema = z.object({
  name: z.string().trim().min(1, 'A template name is required.').max(120),
  base_image_path: z.string().min(1, 'A base image is required.').max(500),
  zones: Zones.default([]),
})
export const TvTemplateCreateSchema = TvTemplateSaveSchema.extend({ location_id: uuidLike })

// A new template base image outside the template's studio folder (C118).
export const BASE_IMAGE_ELSEWHERE = "The base image must be uploaded at this template's studio. Pick the image again."

// ── Validators (DECISION 4) ──────────────────────────────────────────────

const hasTraversal = (p) => p.includes('..') || p.includes('\\') || p.includes('//')

/** A template's base image sits in its studio's templates folder (the upload routes' prefix). */
export function isTemplateBaseImagePath(path, locationId) {
  if (typeof path !== 'string' || !locationId) return false
  const prefix = `${locationId}/templates/`
  return path.startsWith(prefix) && path.length > prefix.length && !hasTraversal(path)
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Is this push something the public cast page may render for this TV?
 *   url      — http: or https: only (never javascript:, data:, file:, ftp:)
 *   storage  — a file in this studio's tv-content folder, no traversal
 *   template — a template OF THIS STUDIO, with zone values as an object
 * template_values is null unless a template is pushed (TVAdmin's rule), so a
 * previous board's text never lingers on the row.
 *
 * @param {{ source_type, source_ref, label?, template_values? }} push
 * @param {{ locationId: string, templateLocationOf: (id: string) => Promise<string|null> }} ctx
 *   templateLocationOf answers the template's location_id, or null when there
 *   is no such template; it throws on a read error (the route answers 500).
 * @returns {Promise<{ ok: true, value } | { ok: false, error: string }>}
 */
export async function validateTvPush(push, { locationId, templateLocationOf }) {
  const type = push?.source_type
  const ref = typeof push?.source_ref === 'string' ? push.source_ref.trim() : ''
  if (!TV_PUSH_SOURCE_TYPES.includes(type)) return { ok: false, error: 'Push a URL, a photo or a template.' }
  if (!ref) return { ok: false, error: 'Nothing to push.' }
  const label = typeof push.label === 'string' && push.label.trim() ? push.label.trim() : null

  if (type === 'url') {
    let url = null
    try { url = new URL(ref) } catch { url = null }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return { ok: false, error: 'The URL must start with http:// or https://.' }
    }
    return { ok: true, value: { source_type: type, source_ref: ref, label, template_values: null } }
  }

  if (type === 'storage') {
    const prefix = `${locationId}/`
    if (!ref.startsWith(prefix) || ref.length === prefix.length || hasTraversal(ref)) {
      return { ok: false, error: "That photo is not in this TV's studio. Upload it again." }
    }
    return { ok: true, value: { source_type: type, source_ref: ref, label, template_values: null } }
  }

  // template
  if (!uuidLike.safeParse(ref).success) return { ok: false, error: 'Pick a template.' }
  if (!isPlainObject(push.template_values)) return { ok: false, error: 'The template text is missing.' }
  const templateLocation = await templateLocationOf(ref)
  if (!templateLocation || templateLocation !== locationId) {
    return { ok: false, error: "That template is not one of this TV's studio." }
  }
  return { ok: true, value: { source_type: type, source_ref: ref, label, template_values: push.template_values } }
}
