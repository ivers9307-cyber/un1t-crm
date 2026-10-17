import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody, uuidLike } from '@/lib/validate'
import { resolveAdminOrgId } from '@/lib/org-admin'
import { logError } from '@/lib/log'
import {
  DEFAULTS, OverriddenSchema, OrgSettingsSchema, ORG_REFUSED_KEYS, orgSettingsRefusals, buildOrgLayer,
} from '@/lib/agent/settings-contract'
import { mergeAgentSettings } from '@/lib/agent/settings-resolve'
import { initialOverridden } from '@/lib/agent/settings-overrides'
import { copyStudioIntoOrg } from '@/lib/agent/settings-org'

// MIAORG.1 Task 4 — Mia's ORGANISATION defaults (org_settings.customer_agent,
// mig 729). Every studio resolves DEFAULTS <- this layer <- its own blob
// (resolveAgentSettings), never inheriting a studio-only key.
//
// Who: a master, or an org admin of the organisation (resolveAdminOrgId,
// C18 ORGROLE.1). Anyone else, a foreign organisation, or no organisation at
// all is a 404, so organisation ids cannot be probed. A studio owner is not
// an organisation admin.
//
// GET ?organization_id= → { organization, settings (this layer over DEFAULTS,
//   studio-only keys left out), raw (the stored layer, null when none),
//   defaults, studios: [{ id, name, sets, mia_on }] } for every ACTIVE studio
//   of the organisation. `sets` is the leaf paths that studio stores itself
//   (initialOverridden of its blob), so the editor can say which studios use
//   each org value and which set their own (T4-A). Only id, name and the
//   paths leave the server: never a studio's blob or settings column.
// PUT { organization_id?, settings, overridden? } → stores only the fields
//   the organisation sets. A studio-only key, or `quiet_hours.off` (a studio's
//   opt-out), is a 400. quiet_hours.tz is never stored (T4-B).
// PUT { organization_id?, copy_from_location_id } → "Start from a studio's
//   settings" (T4-C): that studio's inheritable values, present and non-null,
//   overwrite the matching org fields; the other org fields are kept. The
//   studio must be an ACTIVE studio of the organisation (404 otherwise); its
//   blob is never written.
// The write is an upsert on organization_id (the table's primary key, mig
// 317) naming ONLY customer_agent (and updated_by), so no other org_settings
// column (branding, caps, legal identity) is touched, and a missing row is
// inserted. It runs as service_role, the only role mig 729's fence lets
// change customer_agent.

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const unreadable = () => NextResponse.json({
  success: false, code: 'org_settings_unreadable', error: 'Could not load the organisation defaults just now.',
}, { status: 500 })

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// The organisation this caller may act on, or null (answered as a 404).
function orgFor(user, requested) {
  const r = resolveAdminOrgId(user, requested || null)
  if (r.notFound || !r.orgId) return null
  return r.orgId
}

// The org layer as the editor shows it: over DEFAULTS, without the keys an
// organisation never sets.
function orgView(raw) {
  const { settings } = mergeAgentSettings({ org: raw, studio: null })
  for (const k of ORG_REFUSED_KEYS) delete settings[k]
  return settings
}

const ORG_DEFAULTS = Object.fromEntries(Object.entries(DEFAULTS).filter(([k]) => !ORG_REFUSED_KEYS.has(k)))

function studioSummary(row) {
  const blob = isPlainObject(row.customer_agent) ? row.customer_agent : null
  return {
    id: row.id,
    name: row.name || null,
    sets: initialOverridden(blob),
    // "(Mia off)" in the editor: she answers nobody there (not live, not in
    // test mode). Such a studio still inherits the value for when she is on.
    mia_on: blob?.enabled === true || blob?.test_mode === true,
  }
}

// One read of everything the editor shows. `organization` null = no such org.
async function readOrgState(db, orgId) {
  const [orgRes, layerRes, studiosRes] = await Promise.all([
    db.from('organizations').select('id, name').eq('id', orgId).maybeSingle(),
    db.from('org_settings').select('customer_agent').eq('organization_id', orgId).maybeSingle(),
    // Only the Mia blob, never the settings column (it holds credentials).
    db.from('locations').select('id, name, customer_agent:settings->customer_agent')
      .eq('organization_id', orgId).eq('active', true).order('name'),
  ])
  for (const [what, res] of [['organization', orgRes], ['org layer', layerRes], ['studios', studiosRes]]) {
    if (res.error) {
      logError('settings-customer-agent-org', 'read failed', { organizationId: orgId, what, err: res.error })
      return { ok: false, response: unreadable() }
    }
  }
  if (!orgRes.data) return { ok: false, response: notFound() }
  const raw = isPlainObject(layerRes.data?.customer_agent) ? layerRes.data.customer_agent : null
  return {
    ok: true,
    data: {
      organization: { id: orgRes.data.id ?? orgId, name: orgRes.data.name ?? null },
      settings: orgView(raw),
      raw,
      defaults: ORG_DEFAULTS,
      studios: (studiosRes.data || []).map(studioSummary),
    },
  }
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // A malformed id is "no such organisation" (404), never a database error
  // (a master's id goes straight into the query; Postgres refuses a non-uuid).
  const requested = new URL(request.url).searchParams.get('organization_id')
  if (requested && !uuidLike.safeParse(requested).success) return notFound()
  const orgId = orgFor(user, requested)
  if (!orgId) return notFound()
  const db = createServerClient()
  const state = await readOrgState(db, orgId)
  if (!state.ok) return state.response
  return NextResponse.json({ success: true, data: state.data })
}

const OrgPutSchema = z.object({
  organization_id: uuidLike.optional(),
  // Validated below (OrgSettingsSchema), after the refusals, so a studio-only
  // key is named as one rather than as an unknown key.
  settings: z.record(z.string(), z.unknown()).optional(),
  overridden: OverriddenSchema.optional(),
  copy_from_location_id: uuidLike.optional(),
})

const badRequest = (error, issues) => NextResponse.json({ success: false, error, ...(issues ? { issues } : {}) }, { status: 400 })

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const v = await validateBody(request, OrgPutSchema)
  if (!v.ok) return v.response
  const body = v.data
  const orgId = orgFor(user, body.organization_id)
  if (!orgId) return notFound()

  const copyFrom = body.copy_from_location_id
  if (copyFrom && body.settings) return badRequest('Send settings or copy_from_location_id, not both')
  if (!copyFrom && !body.settings) return badRequest('Nothing to save')

  const db = createServerClient()

  // The organisation must exist (a master may name any id), and the current
  // layer must be READABLE before a copy merges into it: a failed read taken
  // as "no layer" would wipe every other org field.
  const [orgRes, layerRes] = await Promise.all([
    db.from('organizations').select('id').eq('id', orgId).maybeSingle(),
    db.from('org_settings').select('customer_agent').eq('organization_id', orgId).maybeSingle(),
  ])
  for (const [what, res] of [['organization', orgRes], ['org layer', layerRes]]) {
    if (res.error) {
      logError('settings-customer-agent-org', 'read before write failed', { organizationId: orgId, what, err: res.error })
      return unreadable()
    }
  }
  if (!orgRes.data) return notFound()

  let layer
  if (copyFrom) {
    // T4-C / T4-D — the source studio only from THIS organisation, and only
    // an active one (the studios the picker offers); anything else is a 404.
    const { data: loc, error: locErr } = await db.from('locations')
      .select('id, organization_id, customer_agent:settings->customer_agent')
      .eq('id', copyFrom)
      .eq('organization_id', orgId)
      .eq('active', true)
      .maybeSingle()
    if (locErr) {
      logError('settings-customer-agent-org', 'copy source read failed', { organizationId: orgId, locationId: copyFrom, err: locErr })
      return unreadable()
    }
    if (!loc) return notFound()
    const current = isPlainObject(layerRes.data?.customer_agent) ? layerRes.data.customer_agent : null
    const { layer: copied } = copyStudioIntoOrg(current, isPlainObject(loc.customer_agent) ? loc.customer_agent : null)
    // A studio blob may predate today's contract; never store what the org
    // editor itself would refuse.
    const check = OrgSettingsSchema.safeParse(copied)
    if (!check.success) {
      return NextResponse.json({
        success: false,
        error: 'That studio holds a value the organisation defaults cannot take; fix it at the studio first.',
        issues: check.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }, { status: 422 })
    }
    layer = Object.keys(copied).length ? copied : null
  } else {
    const sent = body.settings
    const overridden = body.overridden ?? initialOverridden(sent)
    const refusals = orgSettingsRefusals(sent, overridden)
    if (refusals.length) return badRequest('These are set per studio, not for the organisation', refusals)
    const parsed = OrgSettingsSchema.safeParse(sent)
    if (!parsed.success) {
      return badRequest('Invalid request body', parsed.error.issues.map((i) => ({ path: ['settings', ...i.path].join('.'), message: i.message })))
    }
    layer = buildOrgLayer(parsed.data, overridden, { sent })
  }

  const { error: writeErr } = await db.from('org_settings')
    // updated_by: org_settings.updated_by REFERENCES profiles(id) (mig 317);
    // user.id is the caller's profiles id (getCurrentUser, as org-branding).
    // updated_at is the touch trigger's on UPDATE, the column default on INSERT.
    .upsert({ organization_id: orgId, customer_agent: layer, updated_by: user.id }, { onConflict: 'organization_id' })
    .select('organization_id')
    .single()
  if (writeErr) {
    logError('settings-customer-agent-org', 'write failed', { organizationId: orgId, err: writeErr })
    return NextResponse.json({ success: false, error: 'Could not save the organisation defaults just now.' }, { status: 500 })
  }

  // Answer with what the editor shows. The write went through, so a failed
  // re-read still answers success with the layer just stored.
  const state = await readOrgState(db, orgId)
  if (state.ok) return NextResponse.json({ success: true, data: state.data })
  return NextResponse.json({
    success: true,
    data: { organization: { id: orgId, name: null }, settings: orgView(layer), raw: layer, defaults: ORG_DEFAULTS, studios: null },
  })
}
