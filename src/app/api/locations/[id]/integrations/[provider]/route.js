// PUT / DELETE /api/locations/[id]/integrations/[provider]
//
// INTEG hub inline #4 (Phase 2). The single service-role mutation surface
// behind the Integrations-hub Manage drawer for the credential-bearing
// providers stored on the `locations` row: Glofox, Twilio sender, UniFi,
// AC/Climate (Sensibo + LG ThinQ), and BCA Submit. One route, a `provider`
// path param, and a per-provider descriptor (fields, secret fields, role
// tier, storage layout).
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
//     · Glofox / Twilio  = ADMIN_ROLES (owner+/manager/master)
//     · UniFi / AC / BCA  = MASTER-ONLY (mirrors the tabs' canEdit={isMaster};
//                           UniFi is additionally guarded DB-side by mig 034,
//                           which service-role writes bypass by design)
// Service-role DB; RLS is bypassed, so these app-code checks ARE the boundary.
// Disconnect = DEACTIVATE (clear the legacy slice → syncConnectionFromLegacy
// deactivates the registry row); NOT a hard delete and NO provider-side revoke.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { ADMIN_ROLES } from '@/lib/schemas'
import { syncConnectionFromLegacy } from '@/lib/connection-registry'
import { mergeSecretSlice, sliceHasValue } from '@/lib/integration-secret-merge'
import { validateAlphaSenderId } from '@/lib/twilio'
import { getBcaConfig, validateBcaConfig } from '@/lib/bca'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Columns off the `locations` row this route reads/writes. `settings` is the
// FULL JSONB so JSONB-slice writes are read-merge-write (a sibling slice —
// customer_agent, ads, unifi… — is never clobbered).
const LOCATION_COLUMNS =
  'id, name, features, settings, sensibo_api_key, thinq_pat, thinq_client_id, ' +
  'thinq_country_code, twilio_alpha_sender_id, bca_config'

const optStr = (max) => z.string().max(max).optional()

// ─────────────────────────────────────────────────────────────
// Per-provider descriptors
// ─────────────────────────────────────────────────────────────
//
//   roleTier      'admin' → ADMIN_ROLES ; 'master' → isMaster only
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
    platforms: ['glofox'],
    secretFields: ['api_key', 'api_token', 'webhook_secret'],
    schema: z.object({
      branch_id: optStr(200),
      namespace: optStr(200),
      api_key: optStr(4000),
      api_token: optStr(4000),
      webhook_secret: optStr(4000),
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

  twilio: {
    label: 'Twilio sender',
    roleTier: 'admin',
    platforms: ['twilio_sender'],
    secretFields: [], // an 11-char alpha sender ID is NOT a secret
    schema: z.object({ sender_id: optStr(11) }),
    readSlice: (loc) => ({ sender_id: loc.twilio_alpha_sender_id ?? null }),
    validate: (merged) => {
      const t = (merged.sender_id || '').trim()
      if (!t) return null
      const err = validateAlphaSenderId(t)
      return err ? `Sender ID: ${err}` : null
    },
    applyMerged: (loc, merged) => {
      const update = { twilio_alpha_sender_id: (merged.sender_id || '').trim() || null }
      return { update, nextLocation: { ...loc, ...update } }
    },
    disconnect: (loc) => {
      const update = { twilio_alpha_sender_id: null }
      return { update, nextLocation: { ...loc, ...update } }
    },
    echo: (loc) => ({
      connected: !!loc.twilio_alpha_sender_id,
      sender_id: loc.twilio_alpha_sender_id ?? null, // non-secret — full value
    }),
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

  return { descriptor, db, locationId, location }
}

// Re-sync every registry platform this provider maps to, IN-HANDLER (no
// fire-and-forget). Returns { [platform]: action | error-string }.
async function syncRegistry(db, locationId, descriptor, nextLocation) {
  const results = {}
  for (const platform of descriptor.platforms) {
    try {
      const { action } = await syncConnectionFromLegacy(db, locationId, platform, nextLocation)
      results[platform] = action
    } catch (e) {
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
  const { descriptor, db, locationId, location } = g

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

  const { error: upErr } = await db
    .from('locations')
    .update({ ...applied.update, updated_at: new Date().toISOString() })
    .eq('id', locationId)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })

  const registry = await syncRegistry(db, locationId, descriptor, applied.nextLocation)

  // Masked echo — has_* booleans + non-secret values only.
  return NextResponse.json({ success: true, data: { provider: descriptor.label, ...descriptor.echo(applied.nextLocation), registry } })
}

// ─────────────────────────────────────────────────────────────
// DELETE — explicit disconnect (deactivate, not hard-delete)
// ─────────────────────────────────────────────────────────────

export async function DELETE(_request, props) {
  const g = await guard(props)
  if (g.error) return g.error
  const { descriptor, db, locationId, location } = g

  const applied = descriptor.disconnect(location)
  const { error: upErr } = await db
    .from('locations')
    .update({ ...applied.update, updated_at: new Date().toISOString() })
    .eq('id', locationId)
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })

  // Clearing the legacy slice makes registryRowFromLegacy() return null →
  // syncConnectionFromLegacy deactivates the active registry row (is_active
  // = false). Deactivate, never hard-delete; no provider-side revoke.
  const registry = await syncRegistry(db, locationId, descriptor, applied.nextLocation)

  return NextResponse.json({ success: true, data: { provider: descriptor.label, disconnected: true, ...descriptor.echo(applied.nextLocation), registry } })
}
