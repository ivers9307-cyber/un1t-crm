// PUT / DELETE /api/locations/[id]/integrations/[provider]
//
// INTEG hub inline #4 (Phase 2). The single service-role mutation surface
// behind the Integrations-hub Manage drawer for the credential-bearing
// providers stored on the `locations` row: Glofox, UniFi, AC/Climate
// (Sensibo + LG ThinQ), and BCA Submit. (The Twilio sender provider left
// with the SMS channel, TWILIO-RETIRE.1 — `twilio` is now an unknown provider.)
// One route, a `provider` path param, and a per-provider descriptor (fields,
// secret fields, role tier, storage layout).
//
// WHY a new route (vs the legacy tabs' browser-client writes):
//   The old tabs wrote their legacy `locations` fields via the BROWSER
//   supabase client and then fire-and-forgot POST …/connections/refresh to
//   re-sync the service-role registry — a race, and (for Glofox) it carried
//   the null-collapse trap. This route does the whole thing server-side and
//   in order: read the stored slice → write-only merge → write the
//   `locations` field → syncConnectionFromLegacy() IN-HANDLER → return a
//   MASKED echo. No secret is ever selected into the response.
//
// ── GLOFOX NULL-COLLAPSE GUARD ──
//   The write-only merge (src/lib/integration-secret-merge.js) carries every
//   stored secret forward on a blank/masked save, so a no-op save on
//   Stillorgan's LIVE Glofox connection yields a NON-EMPTY slice and is
//   persisted unchanged — the registry row stays active. The slice is only
//   cleared (and its registry row deactivated) by the explicit DELETE
//   disconnect path, NEVER by a blank PUT.
//
// Auth mirrors POST …/connections/refresh:
//   getCurrentUser → 401
//   assertLocationAccess(user, locationId) → 403
//   per-provider role gate → 403
//     · Glofox           = ADMIN_ROLES (owner+/manager/master)
//     · UniFi / AC / BCA  = MASTER-ONLY (mirrors the tabs' canEdit={isMaster};
//                           UniFi is additionally guarded DB-side by mig 034,
//                           which service-role writes bypass by design)
// Service-role DB; RLS is bypassed, so these app-code checks ARE the boundary.
// Disconnect = DEACTIVATE (clear the legacy slice → syncConnectionFromLegacy
// deactivates the registry row); NOT a hard delete and NO provider-side revoke.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { ADMIN_ROLES } from '@/lib/schemas'
import { syncConnectionFromLegacy } from '@/lib/connection-registry'
import { mergeSecretSlice, sliceHasValue } from '@/lib/integration-secret-merge'
import { getBcaConfig, validateBcaConfig } from '@/lib/bca'
import { logError } from '@/lib/log'
import { logMembershipSourceChange } from '@/lib/membership/audit'
import { resetMembershipStateCache } from '@/lib/membership/state-for-page'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Columns off the `locations` row this route reads/writes. `settings` is the
// FULL JSONB so JSONB-slice writes are read-merge-write (a sibling slice —
// customer_agent, ads, unifi… — is never clobbered).
const LOCATION_COLUMNS =
  'id, name, features, settings, sensibo_api_key, thinq_pat, thinq_client_id, ' +
  'thinq_country_code, bca_config, membership_source'

const optStr = (max) => z.string().max(max).optional()

// ─────────────────────────────────────────────────────────────
// Per-provider descriptors
// ─────────────────────────────────────────────────────────────
//
//   roleTier      'admin' → ADMIN_ROLES ; 'master' → isMaster only
//   membershipSource  (W1.M2) the locations.membership_source key this
//                 provider IS. A save that leaves COMPLETE credentials
//                 (membershipConnected) selects it when the studio is on
//                 'none'; DELETE puts a studio on this key back to 'none'.
//                 Any other value is left alone. OWNER/MASTER ONLY: the
//                 credential save stays at this provider's roleTier, but the
//                 setting is guardMasterOrOwner's (the dedicated route's
//                 gate), so a manager's save never moves the column.
//   membershipConnected  location → bool: are the credentials COMPLETE
//                 enough for the provider to answer (not "any value in the
//                 slice" — a trainer-names save must not select it)
//   platforms     channel_connections platform(s) to re-sync in-handler
//   secretFields  fields whose blank/masked-echo value KEEPS the stored one
//   schema        Zod for the incoming patch
//   readSlice     stored slice off a loaded location row (WITH secrets)
//   applyMerged   merged slice → { update, nextLocation } | { issues }
//   disconnect    location → { update, nextLocation } clearing the slice
//   echo          location → MASKED response (has_* booleans, no secrets)

const PROVIDERS = {
  glofox: {
    label: 'Glofox',
    roleTier: 'admin',
    membershipSource: 'glofox',
    // The three-credential rule the runtime paths use
    // (missingGlofoxCredentialsForLocation): branch id, API key, API token.
    membershipConnected: (loc) => {
      const g = plainSlice(loc.settings?.glofox)
      return Boolean(g.branch_id && g.api_key && g.api_token)
    },
    platforms: ['glofox'],
    secretFields: ['api_key', 'api_token', 'webhook_secret'],
    schema: z.object({
      branch_id: optStr(200),
      namespace: optStr(200),
      api_key: optStr(4000),
      api_token: optStr(4000),
      webhook_secret: optStr(4000),
      // SECFIX.3b — the /settings/locations/[id] Glofox tab saves through this
      // route now (it used to write locations.settings from the browser), so
      // its non-secret fields ride here too. Absent = untouched.
      trial_membership_id: optStr(200),
      trial_plan_code: optStr(200),
      hidden_class_keywords: z.array(z.string().max(200)).max(200).nullable().optional(),
      trainer_names: z.record(z.string().max(64), z.string().max(200)).nullable().optional(),
    }),
    readSlice: (loc) => plainSlice(loc.settings?.glofox),
    applyMerged: (loc, merged) => writeSettingsSlice(loc, 'glofox', sliceHasValue(merged) ? merged : null),
    disconnect: (loc) => writeSettingsSlice(loc, 'glofox', null),
    echo: (loc) => {
      const g = plainSlice(loc.settings?.glofox)
      return {
        connected: sliceHasValue(g),
        branch_id: g.branch_id ?? null,
        namespace: g.namespace ?? null,
        has_api_key: !!g.api_key,
        has_api_token: !!g.api_token,
        has_webhook_secret: !!g.webhook_secret,
      }
    },
  },

  unifi: {
    label: 'UniFi Access',
    roleTier: 'master',
    platforms: ['unifi'],
    secretFields: ['api_token'],
    schema: z.object({
      host: optStr(500),
      api_token: optStr(4000),
      staff_policy_id: optStr(200),
      manager_policy_id: optStr(200),
      allow_self_signed: z.boolean().optional(),
    }),
    readSlice: (loc) => plainSlice(loc.settings?.unifi),
    applyMerged: (loc, merged) =>
      writeSettingsSlice(loc, 'unifi', sliceHasValue(merged, { ignore: ['allow_self_signed'] }) ? merged : null),
    disconnect: (loc) => writeSettingsSlice(loc, 'unifi', null),
    echo: (loc) => {
      const u = plainSlice(loc.settings?.unifi)
      return {
        connected: sliceHasValue(u, { ignore: ['allow_self_signed'] }),
        host: u.host ?? null,
        has_token: !!u.api_token,
        staff_policy_id: u.staff_policy_id ?? null,
        manager_policy_id: u.manager_policy_id ?? null,
        allow_self_signed: u.allow_self_signed === true,
      }
    },
  },

  ac: {
    label: 'Climate devices',
    roleTier: 'master',
    // AC creds map onto TWO registry platforms — re-sync both. (The
    // ac_devices device TABLE stays on the deep-link, not this route.)
    platforms: ['sensibo', 'thinq'],
    secretFields: ['sensibo_api_key', 'thinq_pat'],
    schema: z.object({
      sensibo_api_key: optStr(4000),
      thinq_pat: optStr(4000),
      thinq_client_id: optStr(200),
      thinq_country_code: optStr(8),
    }),
    readSlice: (loc) => ({
      sensibo_api_key: loc.sensibo_api_key ?? null,
      thinq_pat: loc.thinq_pat ?? null,
      thinq_client_id: loc.thinq_client_id ?? null,
      thinq_country_code: loc.thinq_country_code ?? null,
    }),
    // Column storage — each column written independently (no whole-slice
    // collapse); sensibo/thinq registry rows activate/deactivate on their own.
    applyMerged: (loc, merged) => {
      // Mirror the legacy tab: auto-generate the ThinQ client_id (uuid4) the
      // first time a PAT is present without one — the LG dispatcher needs it.
      let clientId = merged.thinq_client_id || null
      if (merged.thinq_pat && !clientId) clientId = crypto.randomUUID()
      const update = {
        sensibo_api_key: merged.sensibo_api_key || null,
        thinq_pat: merged.thinq_pat || null,
        thinq_client_id: clientId,
        thinq_country_code: merged.thinq_country_code || null,
      }
      return { update, nextLocation: { ...loc, ...update } }
    },
    disconnect: (loc) => {
      const update = { sensibo_api_key: null, thinq_pat: null, thinq_client_id: null, thinq_country_code: null }
      return { update, nextLocation: { ...loc, ...update } }
    },
    echo: (loc) => ({
      connected: !!(loc.sensibo_api_key || loc.thinq_pat),
      has_sensibo_key: !!loc.sensibo_api_key,
      has_thinq_pat: !!loc.thinq_pat,
      thinq_client_id: loc.thinq_client_id ?? null,
      thinq_country_code: loc.thinq_country_code ?? null,
    }),
  },

  bca: {
    label: 'BCA Submit',
    roleTier: 'master',
    platforms: ['bca'],
    // AUDIT: bca_config holds NO secrets — send-from/send-to/cc addresses +
    // subject/body templates + document-slot labels only (src/lib/bca.js).
    // So there is nothing to mask; every field sets normally. The
    // document-slot editor stays on the deep-link (Advanced settings).
    secretFields: [],
    requireFeature: 'bca_submit',
    schema: z.object({
      send_from: optStr(320),
      send_to: optStr(320),
      cc: optStr(320),
      subject_template: optStr(200),
      body_template: optStr(5000),
    }),
    readSlice: (loc) => plainSlice(loc.bca_config),
    applyMerged: (loc, merged) => {
      // Fill defaults (esp. the required document slots) so the whole config
      // validates even on a first partial save; documents are preserved from
      // the stored config via the merge's shallow copy.
      const filled = getBcaConfig({ features: { bca_submit: true }, bca_config: merged })
      const v = validateBcaConfig(filled)
      if (!v.ok) return { issues: v.errors }
      const update = { bca_config: v.value }
      return { update, nextLocation: { ...loc, bca_config: v.value } }
    },
    disconnect: (loc) => {
      const update = { bca_config: null }
      return { update, nextLocation: { ...loc, bca_config: null } }
    },
    echo: (loc) => {
      const c = plainSlice(loc.bca_config)
      return {
        connected: !!c.send_from,
        send_from: c.send_from ?? null,
        send_to: c.send_to ?? null,
        cc: c.cc ?? null,
        subject_template: c.subject_template ?? null,
        body_template: c.body_template ?? null,
        document_count: Array.isArray(c.documents) ? c.documents.length : 0,
      }
    },
  },
}

function plainSlice(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

// Read-merge-write a single JSONB slice under `locations.settings`, leaving
// every sibling slice byte-identical.
function writeSettingsSlice(loc, key, slice) {
  const nextSettings = { ...(loc.settings || {}), [key]: slice }
  return { update: { settings: nextSettings }, nextLocation: { ...loc, settings: nextSettings } }
}

// ─────────────────────────────────────────────────────────────
// Shared guard: resolve provider + user + location + role
// ─────────────────────────────────────────────────────────────

async function guard(props) {
  const params = await props.params
  const locationId = params.id
  const descriptor = PROVIDERS[params.provider]
  if (!descriptor) {
    return { error: NextResponse.json({ success: false, error: 'Unknown integration provider' }, { status: 404 }) }
  }

  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }

  const access = assertLocationAccess(user, locationId)
  if (access) return { error: access }

  // Per-provider role gate.
  if (descriptor.roleTier === 'master') {
    if (!user.isMaster) {
      return { error: NextResponse.json({ success: false, error: 'Forbidden — master only' }, { status: 403 }) }
    }
  } else {
    const role = user.isMaster ? 'master' : user.rolesByLocation?.[locationId]
    if (!ADMIN_ROLES.includes(role)) {
      return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
    }
  }

  const db = createServerClient()
  const { data: location, error } = await db.from('locations').select(LOCATION_COLUMNS).eq('id', locationId).single()
  if (error || !location) {
    return { error: NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 }) }
  }

  // Feature-gated providers (BCA) must be enabled at the location.
  if (descriptor.requireFeature && !location.features?.[descriptor.requireFeature]) {
    return { error: NextResponse.json({ success: false, error: `${descriptor.label} is not enabled for this location` }, { status: 400 }) }
  }

  return { descriptor, db, locationId, location, user, params }
}

// ─────────────────────────────────────────────────────────────
// W1.M2 — membership_source follows the connection (Glofox today)
// ─────────────────────────────────────────────────────────────
//
// Returns { from, to } when this save/disconnect should also move
// locations.membership_source, else null. Only a descriptor that declares
// `membershipSource` ever does; the setting itself is PUT
// /api/locations/[id]/membership-source (the only DIRECT writer), and this
// flip holds itself to that route's gate: owner AT THIS LOCATION or master
// (guardMasterOrOwner — profileRole for the master bypass, never
// `user.role`). The credential write that carries the flip stays at the
// provider's roleTier (ADMIN_ROLES for Glofox: a manager may rotate a key).

function mayMoveMembershipSource(user, locationId) {
  return guardMasterOrOwner(user, locationId) === null
}

function membershipFlipOnSave(descriptor, location, nextLocation, user, locationId) {
  const key = descriptor.membershipSource
  if (!key) return null
  if (!mayMoveMembershipSource(user, locationId)) return null
  const current = location.membership_source ?? 'none'
  if (current !== 'none') return null
  if (!descriptor.membershipConnected?.(nextLocation)) return null
  return { from: current, to: key }
}

function membershipFlipOnDisconnect(descriptor, location, user, locationId) {
  const key = descriptor.membershipSource
  if (!key) return null
  if (!mayMoveMembershipSource(user, locationId)) return null
  const current = location.membership_source ?? 'none'
  if (current !== key) return null
  return { from: current, to: 'none' }
}

// W1.M3a caches membershipStateForPage 60 s per location, per lambda
// instance. A successful write here can move that answer two ways: the flip
// moves the source, or the write rewrites the credentials of the provider
// that IS the studio's source (configured <-> unconfigured, e.g. a manager's
// key rotation or disconnect, which never flips). Either way this instance
// drops its entry; other instances age out within the TTL. Any other write
// (a non-membership provider, a manager's save on a 'none' studio) leaves
// the state as it was, and the cache alone.
function membershipStateMayHaveMoved(descriptor, location, flip) {
  if (flip) return true
  const key = descriptor.membershipSource
  return !!key && (location.membership_source ?? 'none') === key
}

// Re-sync every registry platform this provider maps to, IN-HANDLER (no
// fire-and-forget). Returns { [platform]: action | error-string }.
// REGISTRYREAD.1a — a failed sync is logged structurally: on a disconnect it
// can leave the registry row ACTIVE after the legacy slice was cleared, and
// the only other trace is an error string in a response nobody reads. The
// response itself is unchanged.
async function syncRegistry(db, locationId, descriptor, nextLocation) {
  const results = {}
  for (const platform of descriptor.platforms) {
    try {
      const { action } = await syncConnectionFromLegacy(db, locationId, platform, nextLocation)
      results[platform] = action
    } catch (e) {
      logError('integrations', 'registry sync failed', { locationId, platform, err: e })
      results[platform] = `error: ${e?.message || e}`
    }
  }
  return results
}

// ─────────────────────────────────────────────────────────────
// PUT — save (write-only merge)
// ─────────────────────────────────────────────────────────────

export async function PUT(request, props) {
  const g = await guard(props)
  if (g.error) return g.error
  const { descriptor, db, locationId, location, user, params } = g

  const parsed = await validateBody(request, descriptor.schema)
  if (!parsed.ok) return parsed.response
  const patch = parsed.data

  // Write-only merge: blank/masked secrets keep the stored value; a fresh
  // secret overwrites; non-secret fields set normally. NEVER collapses the
  // slice to null on a blank save (the Glofox guard).
  const stored = descriptor.readSlice(location)
  const merged = mergeSecretSlice({ stored, patch, secretFields: descriptor.secretFields })

  if (descriptor.validate) {
    const err = descriptor.validate(merged)
    if (err) return NextResponse.json({ success: false, error: err }, { status: 400 })
  }

  const applied = descriptor.applyMerged(location, merged)
  if (applied.issues) {
    return NextResponse.json({ success: false, error: 'Invalid configuration', issues: applied.issues }, { status: 400 })
  }

  // W1.M2 — an owner/master connecting a membership provider on a studio
  // with no source selects it, in the SAME update (no second write, no
  // second step for the operator). A save that leaves the credentials
  // incomplete, or a manager's save, never does.
  const flip = membershipFlipOnSave(descriptor, location, applied.nextLocation, user, locationId)
  if (flip) applied.update.membership_source = flip.to

  const { error: upErr } = await db
    .from('locations')
    .update({ ...applied.update, updated_at: new Date().toISOString() })
    .eq('id', locationId)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })
  if (membershipStateMayHaveMoved(descriptor, location, flip)) resetMembershipStateCache(locationId)
  if (flip) {
    applied.nextLocation.membership_source = flip.to
    await logMembershipSourceChange({ user, location, from: flip.from, to: flip.to, via: `integrations/${params.provider}`, request })
  }

  const registry = await syncRegistry(db, locationId, descriptor, applied.nextLocation)

  // Masked echo — has_* booleans + non-secret values only.
  return NextResponse.json({ success: true, data: { provider: descriptor.label, ...descriptor.echo(applied.nextLocation), membership_source: applied.nextLocation.membership_source ?? null, registry } })
}

// ─────────────────────────────────────────────────────────────
// DELETE — explicit disconnect (deactivate, not hard-delete)
// ─────────────────────────────────────────────────────────────

export async function DELETE(request, props) {
  const g = await guard(props)
  if (g.error) return g.error
  const { descriptor, db, locationId, location, user, params } = g

  const applied = descriptor.disconnect(location)
  // W1.M2 — an owner/master disconnecting the provider that IS the studio's
  // membership source puts it back on 'none' in the same update; a studio on
  // another source, or a manager's disconnect, is left alone.
  const flip = membershipFlipOnDisconnect(descriptor, location, user, locationId)
  if (flip) applied.update.membership_source = flip.to

  const { error: upErr } = await db
    .from('locations')
    .update({ ...applied.update, updated_at: new Date().toISOString() })
    .eq('id', locationId)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })
  if (membershipStateMayHaveMoved(descriptor, location, flip)) resetMembershipStateCache(locationId)
  if (flip) {
    applied.nextLocation.membership_source = flip.to
    await logMembershipSourceChange({ user, location, from: flip.from, to: flip.to, via: `integrations/${params.provider}`, request })
  }

  // Clearing the legacy slice makes registryRowFromLegacy() return null →
  // syncConnectionFromLegacy deactivates the active registry row (is_active
  // = false). Deactivate, never hard-delete; no provider-side revoke.
  const registry = await syncRegistry(db, locationId, descriptor, applied.nextLocation)

  return NextResponse.json({ success: true, data: { provider: descriptor.label, disconnected: true, ...descriptor.echo(applied.nextLocation), membership_source: applied.nextLocation.membership_source ?? null, registry } })
}
