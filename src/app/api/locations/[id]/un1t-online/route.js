// GET / PUT / PATCH / DELETE /api/locations/[id]/un1t-online
//
// UN1TWRITE.12 — for a MASTER, GET also carries `write`: the writes switch,
// the trial product (an active €0 one-time un1t.online product at this
// studio; the picker lists only those) and the token's write permissions
// line. PATCH (master only) sets writes_enabled / trial_product_id under
// locations.settings.un1t_online through mergeLocationSettings, keeping every
// other key; an unreadable settings row is 503 and writes nothing.
//
// UN1TSYNC.7 — connect, inspect and disconnect Hatch Street's un1t.online
// token. The token is a per-studio bearer the operator creates at un1t.online
// (Settings > API tokens); it lives in the active channel_connections row
// (platform 'un1t_online') beside the studio it was issued for. The sync
// (src/lib/un1t-online-sync.js) and the membership-source provider read it from
// there.
//
// Gate on EVERY method, the membership-source route's order: getCurrentUser
// (401) -> assertLocationAccessOr404 (a detail route never confirms an id to a
// caller who is not at the studio) -> guardMasterOrOwner AT THE TARGET (a
// manager gets 403; it judges rolesByLocation[params.id], never `user.role`).
//
// PUT validates the token's SHAPE, then asks un1t.online who it is
// (GET /api-token): a refusal is 400 token_rejected, a token with allowed
// origins is a browser token that has no business in a server config (400
// browser_token), anything else upstream is 502 un1t_unreachable. Nothing is
// written on any of those. On success the active row is updated in place (or
// inserted), status reset to connected, and a studio still on membership_source
// 'none' moves to 'un1t_online' (audited, cache dropped) exactly as the Glofox
// connect does; a studio on any other source is left alone.
//
// A replacement token must be for the studio already connected here (409
// studio_changed; disconnect first), and a studio already active at ANOTHER
// location is refused (409 studio_already_connected; mig 726's partial unique
// index is the backstop, its 23505 maps to the same answer).
//
// DELETE deactivates the row and blanks the token. It never touches
// membership_source: that is the Membership source card's job.
//
// NO RESPONSE CONTAINS THE TOKEN (presentUn1tConnection picks fields; it never
// copies access_token). The `write_permissions` warning rides a connect whose
// token can change data on un1t.online: the CRM only reads, so a read-only
// token is safer.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { Un1tOnlineConnectSchema } from '@/lib/schemas'
import { createUn1tClient, Un1tAuthError } from '@/lib/un1t-online'
import { tokenFingerprint } from '@/lib/un1t-online-token'
import { readConnection, normalizeConnectionRow } from '@/lib/connection-registry'
import { presentUn1tConnection, hasWritePermissions } from '@/lib/un1t-online-status'
import { logMembershipSourceChange } from '@/lib/membership/audit'
import { resetMembershipStateCache } from '@/lib/membership/state-for-page'
import { logError } from '@/lib/log'
import { z } from 'zod'
import { mergeLocationSettings } from '@/lib/location-settings'
import { un1tWriteSettingsFrom } from '@/lib/un1t-online-settings'
import { createUn1tWriter } from '@/lib/un1t-online-write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PLATFORM = 'un1t_online'
const SOURCE_KEY = 'un1t_online'
const LOG = 'un1t-online-connect'

// Log a Supabase/PostgREST error as { code, message } ONLY. The raw error's
// `details` ("Failing row contains (...)") carries the whole channel_connections
// row, access_token included, and a log line must never hold the token.
function safeErr(err) {
  if (!err || typeof err !== 'object') return err ?? null
  return { code: err.code ?? null, message: err.message ?? null }
}

// Postgres unique_violation. On the connect write it is the one-studio-one-
// location index (channel_connections_un1t_online_studio_unique, mig 726),
// unless it is the one-active-per-location index (a double click racing itself).
function isUniqueViolation(err) {
  return err?.code === '23505'
}
function conflictResponse(err) {
  if (/one_active/.test(err?.message || '')) {
    return NextResponse.json({
      success: false,
      error: 'connection_conflict',
      code: 'connection_conflict',
      message: 'Another connect for this studio was in progress. Reload and try again.',
    }, { status: 409 })
  }
  return studioAlreadyConnected()
}
function studioAlreadyConnected() {
  return NextResponse.json({
    success: false,
    error: 'studio_already_connected',
    code: 'studio_already_connected',
    message: 'That un1t.online studio is already connected to another location. One studio can feed only one location.',
  }, { status: 409 })
}

// 401 / 404 / 403, in that order, or null when the caller may act on this studio.
async function gate(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return { refusal: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  const locationId = params.id
  const access = assertLocationAccessOr404(user, locationId)
  if (access) return { refusal: access }
  const role = guardMasterOrOwner(user, locationId)
  if (role) {
    return { refusal: NextResponse.json({ success: false, error: 'Only owners and masters can manage the un1t.online connection.' }, { status: 403 }) }
  }
  return { user, locationId }
}

export async function GET(request, props) {
  const g = await gate(props)
  if (g.refusal) return g.refusal
  const db = createServerClient()

  const { conn, error } = await readConnection(db, g.locationId, PLATFORM)
  if (error || !conn) {
    logError(LOG, 'connection read failed', { locationId: g.locationId, err: safeErr(error) })
    return NextResponse.json({ success: false, error: 'Could not read the connection.' }, { status: 500 })
  }

  const { data: runs, error: runErr } = await db
    .from('un1t_sync_runs')
    .select('id, started_at, finished_at, duration_ms, status, counts, first_error')
    .eq('location_id', g.locationId)
    .order('started_at', { ascending: false })
    .limit(1)
  if (runErr) {
    // The run summary is advisory: the connection itself answered.
    logError(LOG, 'last run read failed', { locationId: g.locationId, err: safeErr(runErr) })
  }
  const lastRun = Array.isArray(runs) ? runs[0] ?? null : null

  const data = presentUn1tConnection(conn, lastRun)
  // Every caller learns only whether writes are on (a boolean, never the
  // settings), so the tab never calls a write token unsafe while writes run.
  try {
    const { data: loc } = await db.from('locations').select('id, settings').eq('id', g.locationId).maybeSingle()
    data.writes_enabled = un1tWriteSettingsFrom(loc?.settings).writesEnabled
  } catch {
    data.writes_enabled = false
  }
  // The paid-trial block editor's product picker: product titles and prices
  // are not sensitive, so any owner or master who can open this gets the list.
  // Advisory, like the run summary: a thrown read is an empty list.
  try {
    data.paid_products = await paidProducts(db, g.locationId)
  } catch (err) {
    logError(LOG, 'paid products failed', { locationId: g.locationId, code: err?.code ?? err?.name ?? 'error' })
    data.paid_products = []
  }
  if (isMaster(g.user)) {
    // Advisory, like the run summary: the connection itself answered.
    try {
      data.write = await writeSection(db, g.locationId)
    } catch (err) {
      logError(LOG, 'write section failed', { locationId: g.locationId, code: err?.code ?? err?.name ?? 'error' })
      data.write = { unreadable: true }
    }
  }
  return NextResponse.json({ success: true, data })
}

const isMaster = (user) => user?.profileRole === 'master'

// The permissions line is read on page load, so it may never spend the
// studio's write budget in a loop: one attempt, no waits, a 4 s timeout, and
// a failed check is remembered for a minute per instance.
const PERMISSION_FAILURE_TTL_MS = 60_000
const permissionFailures = new Map() // locationId → atMs
const noWait = async () => { throw Object.assign(new Error('the permission check does not wait'), { code: 'no_wait' }) }
const oneShotFetch = async (url, init = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(4_000) })
  if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`un1t.online answered HTTP ${res.status}`), { status: res.status })
  return res
}
/** Test seam only. */
export function _resetPermissionFailuresForTests() { permissionFailures.clear() }

async function permissionLine(db, locationId) {
  const failedAt = permissionFailures.get(locationId)
  if (failedAt != null && Date.now() - failedAt < PERMISSION_FAILURE_TTL_MS) return { unreadable: true }
  try {
    const writer = await createUn1tWriter(db, locationId, { fetchImpl: oneShotFetch, sleep: noWait })
    const { missing, studioMatches } = await writer.permissionReport()
    permissionFailures.delete(locationId)
    if (!studioMatches) return { all_present: false, missing: [], wrong_studio: true }
    return { all_present: missing.length === 0, missing }
  } catch (err) {
    if (err?.code === 'UN1T_NOT_CONNECTED') return { not_connected: true }
    permissionFailures.set(locationId, Date.now())
    logError(LOG, 'write permission check failed', { locationId, code: err?.code ?? err?.name ?? 'error' })
    return { unreadable: true }
  }
}

// The trial picker's choices: active €0 one-time products at this studio
// (A's isTrialProduct), by title. A failed read is an empty list, logged.
async function trialProducts(db, locationId) {
  const { data, error } = await db
    .from('un1t_products')
    .select('un1t_id, title, type, status, price_cents')
    .eq('location_id', locationId)
    .eq('status', 'active')
    .eq('type', 'one_time')
    .eq('price_cents', 0)
  if (error) {
    logError(LOG, 'trial products read failed', { locationId, err: safeErr(error) })
    return { rows: [], error }
  }
  const rows = (data || [])
    .filter((p) => p.status === 'active' && p.type === 'one_time' && p.price_cents === 0 && p.un1t_id)
    .map((p) => ({ un1t_id: String(p.un1t_id), title: p.title || String(p.un1t_id) }))
    .sort((a, b) => a.title.localeCompare(b.title))
  return { rows, error: null }
}

// The paid-trial block's product picker: active ONE-OFF products with a price
// at this studio, by title. Never a recurring product: the /trial card says
// "charged once; nothing renews" (paidTrialConfigFromBlocks refuses one too).
// A failed read is an empty list, logged.
async function paidProducts(db, locationId) {
  const { data, error } = await db
    .from('un1t_products')
    .select('un1t_id, title, type, status, price_cents, currency')
    .eq('location_id', locationId)
    .eq('status', 'active')
    .eq('type', 'one_time')
    .gt('price_cents', 0)
  if (error) {
    logError(LOG, 'paid products read failed', { locationId, err: safeErr(error) })
    return []
  }
  return (data || [])
    .filter((p) => p.status === 'active' && p.type === 'one_time' && Number(p.price_cents) > 0 && p.un1t_id)
    .map((p) => ({
      un1t_id: String(p.un1t_id),
      title: p.title || String(p.un1t_id),
      price_cents: Number(p.price_cents),
      currency: p.currency || 'EUR',
      type: p.type || null,
    }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

async function writeSection(db, locationId) {
  const { data: loc, error } = await db.from('locations').select('id, settings').eq('id', locationId).maybeSingle()
  if (error || !loc) {
    logError(LOG, 'write settings read failed', { locationId, err: safeErr(error) })
    return { unreadable: true }
  }
  const { rows } = await trialProducts(db, locationId)
  const permissions = await permissionLine(db, locationId)
  return { ...writeFields(loc.settings), trial_products: rows, permissions }
}

// UN1TWRITE.12/24 — what the Writes section shows: booleans and the typed
// deny-list only, never the settings object.
function writeFields(settings) {
  const s = un1tWriteSettingsFrom(settings)
  const raw = settings?.un1t_online?.hidden_class_keywords
  return {
    writes_enabled: s.writesEnabled,
    // As stored, so the switch shows what a master set even while writes are off.
    funnel_enabled: settings?.un1t_online?.funnel_enabled === true,
    trial_product_id: s.trialProductId,
    hidden_class_keywords: typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(', ') : '',
    un1t_sends_welcome: s.sendsWelcome,
    un1t_welcome_sets_login: s.welcomeSetsLogin,
    un1t_sends_booking_confirmation: s.sendsBookingConfirmation,
  }
}

const WriteSettingsSchema = z.object({
  writes_enabled: z.boolean().optional(),
  trial_product_id: z.string().trim().min(1).max(64).nullable().optional(),
  // UN1TWRITE.24 — the funnel switch, the class deny-list and the three
  // "un1t.online sends its own email" flags.
  funnel_enabled: z.boolean().optional(),
  hidden_class_keywords: z.string().max(500).optional(),
  un1t_sends_welcome: z.boolean().optional(),
  un1t_welcome_sets_login: z.boolean().optional(),
  un1t_sends_booking_confirmation: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' })

export async function PATCH(request, props) {
  const g = await gate(props)
  if (g.refusal) return g.refusal
  if (!isMaster(g.user)) {
    return NextResponse.json({ success: false, error: 'Only a master can change un1t.online write settings.' }, { status: 403 })
  }
  const validation = await validateBody(request, WriteSettingsSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  if (typeof body.trial_product_id === 'string') {
    const { rows, error } = await trialProducts(db, g.locationId)
    if (error) return NextResponse.json({ success: false, error: 'Could not read the trial products. Nothing was saved.' }, { status: 503 })
    if (!rows.some((p) => p.un1t_id === body.trial_product_id)) {
      return NextResponse.json({ success: false, error: 'The trial product must be an active, free, one-time product at this studio.' }, { status: 400 })
    }
  }

  const patch = {}
  for (const k of ['writes_enabled', 'trial_product_id', 'funnel_enabled', 'hidden_class_keywords', 'un1t_sends_welcome', 'un1t_welcome_sets_login', 'un1t_sends_booking_confirmation']) {
    if (body[k] !== undefined) patch[k] = body[k]
  }
  // The funnel takes new people through un1t.online, so it needs writes on
  // (now, or in this same change). Judged inside the merge, on the row it writes.
  let refusedFunnel = false
  const merged = await mergeLocationSettings(db, g.locationId, (current) => {
    const block = current.un1t_online && typeof current.un1t_online === 'object' ? current.un1t_online : {}
    const next = { ...block, ...patch }
    // Writes off switches the funnel off too, so writes coming back on never
    // brings the public path back live without anyone asking for it.
    if (patch.writes_enabled === false) next.funnel_enabled = false
    if (patch.funnel_enabled === true && next.writes_enabled !== true) {
      refusedFunnel = true
      return null
    }
    return { ...current, un1t_online: next }
  }, { scope: LOG })
  if (refusedFunnel) return NextResponse.json({ success: false, error: 'Turn writes on first.' }, { status: 400 })
  if (!merged.ok) {
    if (merged.reason === 'not_found') return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    if (merged.reason === 'write_failed') return NextResponse.json({ success: false, error: 'Could not save just now. Try again.' }, { status: 500 })
    return NextResponse.json({ success: false, error: 'Could not read this studio\'s settings. Nothing was saved.' }, { status: 503 })
  }
  return NextResponse.json({ success: true, data: { write: writeFields(merged.settings) } })
}

export async function PUT(request, props) {
  const g = await gate(props)
  if (g.refusal) return g.refusal
  const { user, locationId } = g

  const validation = await validateBody(request, Un1tOnlineConnectSchema)
  if (!validation.ok) return validation.response
  const { token } = validation.data

  // Who does un1t.online say this token is? Nothing is written until it answers.
  let self
  try {
    self = await createUn1tClient({ token }).getSelf()
  } catch (err) {
    if (err instanceof Un1tAuthError) {
      return NextResponse.json({
        success: false,
        code: 'token_rejected',
        error: 'un1t.online rejected that token. Check it was copied whole and has not been revoked or expired.',
      }, { status: 400 })
    }
    logError(LOG, 'un1t.online token check failed', { locationId, errName: err?.name, status: err?.status ?? null })
    return NextResponse.json({
      success: false,
      code: 'un1t_unreachable',
      error: 'Could not reach un1t.online to check that token. Try again in a minute.',
    }, { status: 502 })
  }

  if (!self?.studio?.id) {
    logError(LOG, 'un1t.online answered with no studio', { locationId })
    return NextResponse.json({
      success: false,
      code: 'un1t_unreachable',
      error: 'un1t.online did not say which studio that token belongs to.',
    }, { status: 502 })
  }
  if (Array.isArray(self.allowed_origins) && self.allowed_origins.length > 0) {
    return NextResponse.json({
      success: false,
      code: 'browser_token',
      error: 'That token is restricted to browser origins, so a server cannot use it. Create a server token with no allowed origins and paste that.',
    }, { status: 400 })
  }

  const db = createServerClient()

  // `id` is the primary key; null = gone between the gate and now.
  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, name, membership_source')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) {
    logError(LOG, 'location read failed', { locationId, err: safeErr(locErr) })
    return NextResponse.json({ success: false, error: 'Could not read the location.' }, { status: 500 })
  }
  if (!location) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const permissions = Array.isArray(self.permissions) ? self.permissions : []
  const fields = {
    access_token: token,
    external_account_id: String(self.studio.id),
    display_name: self.studio.title ?? null,
    token_expires_at: self.expires_at ?? null,
    status: 'connected',
    last_error: null,
    config: {
      token_id: self.id ?? null,
      // Rotation keeps token_id; this tells a rotated secret from the old one.
      token_fingerprint: tokenFingerprint(token),
      token_name: self.name ?? null,
      studio_title: self.studio.title ?? null,
      permissions,
    },
    updated_at: new Date().toISOString(),
  }

  const studioId = String(self.studio.id)

  // Select-then-write (the one-active guarantee is a PARTIAL unique index,
  // which PostgREST upsert cannot target; syncConnectionFromLegacy does the same).
  const { data: existing, error: readErr } = await db
    .from('channel_connections')
    .select('id, external_account_id')
    .eq('location_id', locationId)
    .eq('platform', PLATFORM)
    .eq('is_active', true)
    .maybeSingle()
  if (readErr) {
    logError(LOG, 'registry read failed', { locationId, err: safeErr(readErr) })
    return NextResponse.json({ success: false, error: 'Could not read the connection.' }, { status: 500 })
  }

  // A replacement token must be for the SAME studio. Rewriting
  // external_account_id would defeat the sync's studio_mismatch guard (it
  // compares the token's studio with the stored one) and the next run would
  // end every Hatch membership. Switching studio = disconnect first.
  if (existing?.external_account_id && existing.external_account_id !== studioId) {
    return NextResponse.json({
      success: false,
      error: 'studio_changed',
      code: 'studio_changed',
      message: 'That token is for a different un1t.online studio than the one connected here. Disconnect first, then connect the new token.',
    }, { status: 409 })
  }

  // One un1t.online studio feeds ONE CRM location. Judged in code so the
  // refusal is readable; mig 726's partial unique index is the backstop.
  const { data: sameStudio, error: bindErr } = await db
    .from('channel_connections')
    .select('location_id')
    .eq('platform', PLATFORM)
    .eq('is_active', true)
    .eq('external_account_id', studioId)
  if (bindErr) {
    logError(LOG, 'studio binding read failed', { locationId, err: safeErr(bindErr) })
    return NextResponse.json({ success: false, error: 'Could not read the connection.' }, { status: 500 })
  }
  if ((sameStudio || []).some((r) => r.location_id !== locationId)) return studioAlreadyConnected()

  if (existing) {
    const { data, error } = await db
      .from('channel_connections')
      .update(fields)
      .eq('id', existing.id)
      .select('id')
    if (isUniqueViolation(error)) return conflictResponse(error)
    if (error || !Array.isArray(data) || data.length === 0) {
      logError(LOG, 'registry update failed', { locationId, err: error ? safeErr(error) : 'no row updated' })
      return NextResponse.json({ success: false, error: 'Could not save the connection.' }, { status: 500 })
    }
  } else {
    const { data, error } = await db
      .from('channel_connections')
      .insert({ location_id: locationId, platform: PLATFORM, is_active: true, ...fields })
      .select('id')
    if (isUniqueViolation(error)) return conflictResponse(error)
    if (error || !Array.isArray(data) || data.length === 0) {
      logError(LOG, 'registry insert failed', { locationId, err: error ? safeErr(error) : 'no row inserted' })
      return NextResponse.json({ success: false, error: 'Could not save the connection.' }, { status: 500 })
    }
  }

  // membership_source follows the connection, only off 'none' (a studio on
  // glofox is left alone). The update is conditional on the value still being
  // 'none' and judged by the rows it touched, so a change made since the read
  // above wins. The credential is saved either way: a failed or lost flip is
  // logged and reported (membership_source_set:false), never a failed connect.
  const previous = location.membership_source ?? 'none'
  let sourceSet = previous === SOURCE_KEY
  if (previous === 'none') {
    const { data: flipRows, error: flipErr } = await db
      .from('locations')
      .update({ membership_source: SOURCE_KEY, updated_at: new Date().toISOString() })
      .eq('id', locationId)
      .eq('membership_source', 'none')
      .select('id')
    if (flipErr) {
      logError(LOG, 'locations.membership_source update failed', { locationId, err: safeErr(flipErr) })
    } else if (Array.isArray(flipRows) && flipRows.length > 0) {
      sourceSet = true
      resetMembershipStateCache(locationId)
      await logMembershipSourceChange({ user, location, from: previous, to: SOURCE_KEY, via: 'integrations/un1t-online', request })
    }
  }

  const body = {
    success: true,
    data: {
      ...presentUn1tConnection(normalizeConnectionRow({
        platform: PLATFORM,
        location_id: locationId,
        is_active: true,
        ...fields,
      })),
      membership_source_set: sourceSet,
    },
  }
  if (hasWritePermissions(permissions)) body.warning = 'write_permissions'
  return NextResponse.json(body)
}

export async function DELETE(request, props) {
  const g = await gate(props)
  if (g.refusal) return g.refusal
  const db = createServerClient()

  const { error } = await db
    .from('channel_connections')
    .update({ is_active: false, access_token: null, status: 'not_connected', updated_at: new Date().toISOString() })
    .eq('location_id', g.locationId)
    .eq('platform', PLATFORM)
    .eq('is_active', true)
    .select('id')
  if (error) {
    logError(LOG, 'disconnect failed', { locationId: g.locationId, err: safeErr(error) })
    return NextResponse.json({ success: false, error: 'Could not disconnect.' }, { status: 500 })
  }
  // Zero rows is fine: already disconnected. membership_source is deliberately
  // untouched (the Membership source card owns it); the page's membership
  // state may read "unconfigured" now, so drop the cached answer.
  resetMembershipStateCache(g.locationId)
  return NextResponse.json({ success: true, data: { disconnected: true } })
}
