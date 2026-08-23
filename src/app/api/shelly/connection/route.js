// SHELLY-UI.3 — the Shelly account a location controls its plugs through:
// read it (any device_control holder), link/re-paste it and disconnect it
// (owner or master only).
//
// THE ONLY CONNECTION SHAPE THIS FILE RETURNS IS publicConnectionView(). The
// row carries `auth_key` and `auth_key_fingerprint`; neither may reach a
// response or a log line, and the fingerprint is as sensitive as the key for
// this purpose — it is a sha256 OF the key, so publishing it turns "is this
// the account?" into an offline check anyone holding a candidate key can run.
// That is why the stored-row read below names its two columns instead of
// select('*'), and why every error that could have been minted while the key
// was in scope goes through redactSecret().
//
// locationId ALWAYS comes from withAuth's ctx (the session's active
// location). No handler here reads a location from the request — spec
// "Tenancy": one Shelly account per location, and nothing in a body or a
// query string can move a caller to another one.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { guardMasterOrOwner } from '@/lib/auth'
import { logWarn, logError } from '@/lib/log'
import { normaliseShellyHost, fingerprintAuthKey, keyHint, redactSecret } from '@/lib/shelly/client'
import {
  classifyFingerprintClash,
  findFingerprintRows,
  loadPublicConnection,
  publicConnectionView,
  probeConnection,
} from '@/lib/shelly/connections'
import { ShellyConnectionPut, MIN_AUTH_KEY_LENGTH } from '@/lib/shelly/schemas'
import { mergeSecretSlice } from '@/lib/integration-secret-merge'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// EXACTLY the columns publicConnectionView projects — the upsert's returning
// select is the same allowlist as connections.js's NON_SECRET, re-stated here
// because this is a different query. Adding a column to the table cannot make
// it appear in a response without an edit in both places.
const NON_SECRET_RETURNING = 'host, key_hint, status, last_ok_at, last_error, last_error_at'

// The one sentence that tells an operator what an account server looks like
// lives inside normaliseShellyHost and is not exported, so it is ASKED FOR
// with an input guaranteed to fail rather than re-typed here. A re-typed copy
// is the kind that drifts the day someone improves one of the two, and this
// route would then answer a bad host with different words depending on which
// branch caught it.
const HOST_HELP = normaliseShellyHost('').error

const bad = (error, status, extra = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status })

/**
 * GET — what the connection panel renders. Never the key, never the
 * fingerprint; `can_manage` tells the client whether to show the form at all
 * (the PUT/DELETE gate below is the enforcement, this is only the affordance).
 */
export const GET = withAuth({ permission: 'device_control' }, async ({ user, db, locationId }) => {
  const loaded = await loadPublicConnection(db, locationId)
  if (!loaded.ok && loaded.reason === 'db_error') {
    // A read failure is NOT "not connected". Answering null here would show a
    // live studio the first-connect form and invite an owner to re-paste a
    // credential that is working fine — a wrong answer dressed as a normal
    // one. Fail visibly instead; the panel retries on the next poll.
    logError('shelly-connection', 'connection read failed', { locationId, reason: loaded.error })
    return bad('Could not read the Shelly connection', 500)
  }

  // head + count: the panel only needs "how many plugs would survive a
  // disconnect", never the rows.
  const { count, error: countError } = await db
    .from('shelly_devices')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
  if (countError) {
    // Best-effort: a missing count costs a line of copy, so it must never
    // cost the operator the connection panel itself. null reads as "unknown"
    // in the UI rather than as a confident zero.
    logWarn('shelly-connection', 'device count failed', { locationId, reason: countError.message })
  }

  return NextResponse.json({
    success: true,
    connection: loaded.ok ? loaded.connection : null,
    can_manage: guardMasterOrOwner(user, locationId) === null,
    device_count: countError ? null : (count ?? 0),
  })
})

/**
 * PUT — link a Shelly account, or re-paste an existing one.
 *
 * Order is deliberate: normalise the host, merge the key (a blank key on
 * re-paste keeps the stored one), PROVE the pair works against the cloud,
 * THEN check the fingerprint is not another organisation's, and only then
 * write. Probing before writing is what stops a typo being persisted as a
 * credential that fails forever with an unreadable cloud error; checking the
 * fingerprint after the probe means a key that cannot work is never even
 * compared against another tenant's.
 */
export const PUT = withAuth(
  { permission: 'device_control', schema: ShellyConnectionPut },
  async ({ user, db, locationId, input }) => {
    const guard = guardMasterOrOwner(user, locationId)
    if (guard) return guard

    const normalised = normaliseShellyHost(input.server)
    if (!normalised.ok) return bad(normalised.error, 400)

    // location_id is UNIQUE (mig 562), so this is 0 or 1 rows by
    // construction. 0 is the ordinary first-connect answer, not an error —
    // hence .maybeSingle() rather than .single().
    const { data: stored, error: storedError } = await db
      .from('shelly_connections')
      .select('host, auth_key')
      .eq('location_id', locationId)
      .maybeSingle()
    if (storedError) {
      // Treating an unreadable stored row as "no stored row" would send a
      // blank re-paste down the no-key branch and tell an already-connected
      // owner to paste a key they cannot see. Refuse instead.
      logError('shelly-connection', 'stored connection read failed', {
        locationId,
        error: redactSecret(storedError, input.auth_key),
      })
      return bad('Could not read the current Shelly connection', 500)
    }

    // Write-only secret merge: the UI renders the key as "••••abcd" and posts
    // it back blank, so a blank or absent auth_key KEEPS the stored one and
    // only a fresh value overwrites it. Without this, "change only the
    // server" would wipe the credential.
    const merged = mergeSecretSlice({
      stored: { host: stored?.host ?? null, auth_key: stored?.auth_key ?? null },
      patch: { host: normalised.host, auth_key: input.auth_key },
      secretFields: ['auth_key'],
    })
    const host = merged.host
    const key = typeof merged.auth_key === 'string' ? merged.auth_key : ''
    if (!key) return bad('Paste the cloud auth key from the Shelly app', 400)
    if (key.length < MIN_AUTH_KEY_LENGTH) return bad("That doesn't look like a Shelly auth key", 400)

    const probe = await probeConnection({ host, auth_key: key })
    if (!probe.ok) {
      // Only `auth` means the KEY is wrong. `config` is a host this client
      // refuses (it re-validates, so nothing was sent); everything else is
      // the cloud being unreachable or busy — and a busy cloud is most often
      // the same owner's other studio mid-reconcile on the shared 1 req/sec
      // budget. Blaming the key for any of those is a false accusation that
      // sends an owner hunting for a new credential.
      if (probe.kind === 'auth') {
        return bad(
          'Shelly rejected that auth key — copy it again from the Shelly app (User settings → Authorization cloud key)',
          400,
          { code: 'key_rejected' },
        )
      }
      if (probe.kind === 'config') return bad(HOST_HELP, 400)
      return bad('Shelly cloud did not answer — try again in a minute', 502, { code: probe.kind })
    }

    const fp = fingerprintAuthKey(key)
    const holders = await findFingerprintRows(db, fp)
    if (!holders.ok) {
      // EVERY doubtful case refuses (connections.js header): a truncated or
      // failed read is the one that might have contained the foreign holder.
      // The reason is logged, never returned — it describes our database, not
      // the operator's account.
      logWarn('shelly-connection', 'fingerprint check refused the link', {
        locationId,
        reason: holders.reason,
      })
      return bad('Could not verify this Shelly account right now', 409)
    }
    const clash = classifyFingerprintClash(holders.rows, user.activeLocation?.organization_id, locationId)
    if (!clash.ok) {
      // Generic by design: naming the other business would leak one tenant's
      // estate to another. Same rule as chooseTenantToBind.
      return bad('This Shelly account is already linked to another business', 409)
    }

    const nowIso = new Date().toISOString()
    const { data: row, error: upsertError } = await db
      .from('shelly_connections')
      .upsert(
        {
          location_id: locationId,
          host,
          auth_key: key,
          auth_key_fingerprint: fp,
          key_hint: keyHint(key),
          // A successful re-paste MUST clear the error state: the hub card and
          // the panel banner are driven by `status`, so leaving 'action_needed'
          // behind would tell an owner who just fixed the connection that it
          // still needs fixing. last_error/last_error_at go with it — a stale
          // sentence under a green chip is its own kind of wrong.
          status: 'connected',
          last_error: null,
          last_error_at: null,
          last_ok_at: nowIso,
          linked_by: user.id,
          updated_at: nowIso,
        },
        { onConflict: 'location_id' },
      )
      .select(NON_SECRET_RETURNING)
      .single()
    if (upsertError) {
      // The CHECK/UNIQUE messages echo column values, so they are never
      // surfaced and never logged raw — redactSecret strips every form the
      // key can leave this module in.
      if (upsertError.code === '23514') {
        logWarn('shelly-connection', 'connection upsert failed a CHECK', {
          locationId,
          error: redactSecret(upsertError, key),
        })
        return bad('Shelly rejected the server or key format', 400)
      }
      if (upsertError.code === '23505') {
        logWarn('shelly-connection', 'connection upsert hit a unique constraint', {
          locationId,
          error: redactSecret(upsertError, key),
        })
        return bad('Could not link this Shelly account', 409)
      }
      logError('shelly-connection', 'connection upsert failed', {
        locationId,
        error: redactSecret(upsertError, key),
      })
      return bad('Could not save the Shelly connection', 500)
    }
    if (!row) {
      // .single() errors on any row count but one, so this is belt-and-braces
      // — but it is the braces that matter: publicConnectionView(null) is a
      // well-formed all-null connection with has_auth_key false, i.e. a
      // successful save would render as "not connected" and nothing would
      // look broken.
      logError('shelly-connection', 'connection upsert returned no row', { locationId })
      return bad('Could not save the Shelly connection', 500)
    }

    return NextResponse.json({
      success: true,
      connection: publicConnectionView(row),
      // "Connected, 0 devices found" is a real and different state from
      // "connected" — it is what a Shelly account in maintenance looks like,
      // and without this number the operator would go hunting in discovery.
      devices_seen: probe.deviceCount,
      // Same-org siblings only, for copy like "also linked at Hatch Street".
      shared_with: clash.shared_with,
    })
  },
)

/**
 * DELETE — unlink the account. Idempotent: disconnecting a location that has
 * no connection is a success, not a 404.
 *
 * The adopted devices are deliberately LEFT ALONE. Deleting them would cascade
 * their energy history (mig 562), so a mis-click while chasing a bad key would
 * destroy months of kWh readings to fix a credential. Re-linking restores
 * control of every device that is still there.
 */
export const DELETE = withAuth({ permission: 'device_control' }, async ({ user, db, locationId }) => {
  const guard = guardMasterOrOwner(user, locationId)
  if (guard) return guard

  const { error } = await db.from('shelly_connections').delete().eq('location_id', locationId)
  if (error) {
    // A delete that failed must not answer "Disconnected" — the operator
    // would walk away believing the key is gone while the cron keeps using it.
    logError('shelly-connection', 'disconnect failed', { locationId, reason: error.message })
    return bad('Could not disconnect the Shelly account', 500)
  }

  return NextResponse.json({
    success: true,
    message: 'Disconnected. Your adopted devices are kept; re-link to control them again.',
  })
})
