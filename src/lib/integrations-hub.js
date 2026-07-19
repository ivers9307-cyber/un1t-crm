// INTEG-B1/B2 — Integrations hub assembly.
//
// One place that turns today's scattered connection storage into the
// uniform card states the master-only hub page renders:
//
//   channel_connections  glofox / unifi / sensibo / thinq / twilio_sender /
//                        bca / instagram — the registry (migs 230/411/412),
//                        with legacy location-field fallback via the
//                        connection-registry pure mappers (dual-read, same
//                        rules as getConnection()).
//   xero_connections     per-location Xero OAuth binding (tenant + scopes).
//   whatsapp_numbers     per-location WA Cloud API numbers (read-only here).
//   ad_accounts          Meta/TikTok ad account presence (read-only here).
//   locations.settings   customer_agent block → the AI-agent live signal.
//
// Status model (mirrors channel_connections.status + the hub mockup):
//   connected | action_needed | error | not_connected
// (coming_soon / platform_managed are presentation-only tiers, not row
// states — the UI applies them to static cards.)
//
// SECRETS NEVER LEAVE THIS MODULE. The assembler selects no token
// columns from the registry / whatsapp_numbers, and maps
// ad_accounts.access_token straight to a has_access_token boolean
// (same posture as maskConnectionRow / maskAccountRow / publicShape).
//
// Pure helpers up top (unit-tested in integrations-hub.test.js); the
// single async assembler at the bottom does batched reads only — one
// query per table, never one per location (PostgREST row cap noted:
// every read here is bounded — locations are few, and each source
// table holds at most a handful of rows per location).

import { registryRowFromLegacy } from '@/lib/connection-registry'
import { EXPIRY_SOON_DAYS } from '@/lib/connection-health'
import { getSendBudget, tierDailyLimit } from '@/lib/whatsapp-budget'

export { EXPIRY_SOON_DAYS }

// Severity order for aggregating many rows into one card chip.
const STATUS_RANK = { error: 3, action_needed: 2, connected: 1, not_connected: 0 }

/**
 * Aggregate row statuses into a card-level status: any error wins,
 * then action_needed, then connected; no rows (or only unknown
 * strings) → not_connected. Pure.
 */
export function worstStatus(statuses) {
  let best = null
  for (const s of statuses || []) {
    if (!(s in STATUS_RANK)) continue
    if (best === null || STATUS_RANK[s] > STATUS_RANK[best]) best = s
  }
  if (best === null) return 'not_connected'
  // 'connected' outranks 'not_connected' for the card chip: a card with
  // one connected location and one unconnected shows Connected (the
  // per-location rows carry the detail) — matches the mockup's Glofox
  // card (Stillorgan connected, Hatch not).
  return best
}

/** Whole days until an ISO timestamp (ceil), or null when absent/invalid. Pure. */
export function daysUntil(value, now = new Date()) {
  if (!value) return null
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return null
  return Math.ceil((t - now.getTime()) / 86400000)
}

/**
 * Grade one whatsapp_numbers row into the hub status model. Read-only
 * mirror of the health columns the refresh-whatsapp-health cron and
 * template webhooks maintain (migs 329/393) — no WA send/routing code
 * is touched by the hub. Pure.
 */
export function gradeWhatsappNumber(row) {
  if (!row) return { status: 'not_connected', message: null }
  if (row.is_active === false) {
    return { status: 'not_connected', message: 'Number deactivated' }
  }
  if (row.token_invalid_at) {
    return {
      status: 'error',
      message: `Access token invalid since ${String(row.token_invalid_at).slice(0, 10)}`,
    }
  }
  if (row.quality_rating === 'RED') {
    return { status: 'action_needed', message: 'Meta quality rating is RED' }
  }
  return { status: 'connected', message: null }
}

/**
 * Grade one xero_connections row. Registry semantics: 'error' = the
 * last operation failed, see message (the three *_sync_error columns
 * are exactly that — a failed token refresh surfaces there too).
 * expires_at is deliberately NOT graded: Xero access tokens refresh
 * lazily on use (src/lib/xero/client.js), so a past expires_at just
 * means no recent API call. Pure.
 */
export function gradeXeroConnection(row) {
  if (!row || !row.tenant_id) return { status: 'not_connected', message: null }
  const syncError = row.accounts_sync_error || row.contacts_sync_error || row.tax_rates_sync_error
  if (syncError) return { status: 'error', message: String(syncError).slice(0, 300) }
  return { status: 'connected', message: null }
}

/**
 * The AI-agent live signal from locations.settings.customer_agent.
 * INVARIANT (CLAUDE.md): enabled=true is LIVE FOR EVERYONE regardless
 * of test_mode — real test mode is enabled=false + test_mode=true. Pure.
 */
export function agentSignal(customerAgent) {
  const s = customerAgent || {}
  if (s.enabled) return 'live'
  if (s.test_mode) return 'test'
  return 'off'
}

/** Deep link to the existing per-location integrations tab. Pure. */
export function locationTabHref(locationId, tabKey) {
  return `/settings/locations/${locationId}?tab=${tabKey}`
}

// Card labels used by the attention strip.
const CARD_LABELS = {
  glofox: 'Glofox',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  xero: 'Xero',
  ads: 'Meta Ads',
  unifi: 'UniFi Access',
  climate: 'Climate devices',
  bca: 'BCA Submit',
}

/**
 * Build the "Needs attention" strip from assembled card rows.
 * Ordering (per the hub spec): error rows first, then tokens expiring
 * within `expirySoonDays`, then not_connected rows with evidence of a
 * partial setup (a registry row exists but is graded not_connected, or
 * a deactivated WhatsApp number) — bare absence never nags. Pure.
 *
 * @param {Array<{cardKey:string, locationId:string, locationName:string,
 *   status:string, message?:string|null, tokenExpiresAt?:string|null,
 *   partialSetup?:boolean, href:string}>} rows
 */
export function buildAttention(rows, { now = new Date(), expirySoonDays = EXPIRY_SOON_DAYS } = {}) {
  const errors = []
  const expiring = []
  const setup = []
  for (const r of rows || []) {
    const label = CARD_LABELS[r.cardKey] || r.cardKey
    if (r.status === 'error') {
      errors.push({
        severity: 'error',
        cardKey: r.cardKey,
        label,
        locationId: r.locationId,
        locationName: r.locationName,
        message: r.message || 'Connection error — see the integration page.',
        href: r.href,
      })
      continue
    }
    const days = daysUntil(r.tokenExpiresAt, now)
    if (days !== null && days <= expirySoonDays) {
      expiring.push({
        severity: 'warning',
        cardKey: r.cardKey,
        label,
        locationId: r.locationId,
        locationName: r.locationName,
        message: days <= 0
          ? 'Access token has expired. Reconnect to resume.'
          : `Access token expires in ${days} day${days === 1 ? '' : 's'}.`,
        href: r.href,
      })
      continue
    }
    if (r.status === 'action_needed') {
      expiring.push({
        severity: 'warning',
        cardKey: r.cardKey,
        label,
        locationId: r.locationId,
        locationName: r.locationName,
        message: r.message || 'Needs attention — see the integration page.',
        href: r.href,
      })
      continue
    }
    if (r.status === 'not_connected' && r.partialSetup) {
      setup.push({
        severity: 'info',
        cardKey: r.cardKey,
        label,
        locationId: r.locationId,
        locationName: r.locationName,
        message: r.message || 'Setup incomplete.',
        href: r.href,
      })
    }
  }
  return [...errors, ...expiring, ...setup]
}

// ─────────────────────────────────────────────────────────────
// Async assembler — batched reads, one query per table
// ─────────────────────────────────────────────────────────────

// Registry columns the hub reads. NO access_token / app_secret — the
// hub never needs secrets, so it never selects them.
const REGISTRY_HUB_COLUMNS =
  'id, location_id, platform, status, is_active, label, display_name, ' +
  'external_account_id, config, token_expires_at, last_error, last_ok_at'

const REGISTRY_PLATFORMS = ['glofox', 'unifi', 'sensibo', 'thinq', 'twilio_sender', 'bca', 'instagram']

function pickRegistry(rows, locationId, platform) {
  return (rows || []).find((r) => r.location_id === locationId && r.platform === platform) || null
}

/**
 * Assemble the full hub payload for a set of locations. Master-only
 * callers (the /settings/integrations-hub page + GET /api/integrations/hub)
 * — the caller has already authorised; this only reads.
 *
 * @param {object} db  createServerClient() — service role
 * @param {Array<object>} locations  full location rows (id, name, settings,
 *   sensibo_api_key, sensibo_pod_id, thinq_pat, thinq_client_id,
 *   thinq_country_code, twilio_alpha_sender_id, bca_config, features)
 * @param {{ now?: Date }} [opts]
 */
export async function assembleIntegrationsHub(db, locations, { now = new Date() } = {}) {
  const locs = Array.isArray(locations) ? locations : []
  const ids = locs.map((l) => l.id)
  const nameById = Object.fromEntries(locs.map((l) => [l.id, l.name]))

  // One batched query per table (never per location).
  const [regRes, xeroRes, waRes, adsRes] = await Promise.all([
    db.from('channel_connections')
      .select(REGISTRY_HUB_COLUMNS)
      .in('location_id', ids)
      .eq('is_active', true)
      .in('platform', REGISTRY_PLATFORMS),
    db.from('xero_connections')
      .select('location_id, tenant_id, tenant_name, tenant_type, connected_at, last_refreshed_at, scopes, accounts_last_synced_at, contacts_last_synced_at, tax_rates_last_synced_at, accounts_sync_error, contacts_sync_error, tax_rates_sync_error')
      .in('location_id', ids),
    db.from('whatsapp_numbers')
      .select('id, location_id, label, display_phone, source, token_type, connected_via, is_default, is_active, quality_rating, messaging_limit_tier, token_invalid_at')
      .in('location_id', ids)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true }),
    db.from('ad_accounts')
      .select('id, location_id, provider, external_account_id, display_name, is_active, access_token')
      .in('location_id', ids),
  ])

  const regRows = regRes.data || []
  const xeroRows = xeroRes.data || []
  const waRows = waRes.data || []
  // Map token presence to a boolean immediately — the raw value goes no
  // further than this line (maskAccountRow posture, without the echo).
  const adRows = (adsRes.data || []).map(({ access_token, ...rest }) => ({
    ...rest,
    has_access_token: Boolean(access_token),
  }))

  const attentionInputs = []

  // ── Glofox — per-location rows (registry first, legacy fallback) ──
  const glofox = locs.map((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'glofox')
    const legacy = registryRowFromLegacy('glofox', loc) // presence only — secrets stay here
    const status = reg ? reg.status : (legacy ? 'connected' : 'not_connected')
    const row = {
      locationId: loc.id,
      status,
      branchId: reg ? reg.external_account_id : (legacy?.external_account_id ?? null),
      lastOkAt: reg?.last_ok_at ?? null,
      lastError: reg?.last_error ?? null,
      source: reg ? 'registry' : 'legacy',
      href: locationTabHref(loc.id, 'glofox'),
    }
    attentionInputs.push({
      cardKey: 'glofox', locationId: loc.id, locationName: nameById[loc.id],
      status, message: row.lastError, tokenExpiresAt: reg?.token_expires_at ?? null,
      partialSetup: !!reg && status === 'not_connected', href: row.href,
    })
    return row
  })

  // ── WhatsApp — per-location numbers + optional tier budget meter ──
  const whatsapp = await Promise.all(locs.map(async (loc) => {
    const numbers = waRows.filter((n) => n.location_id === loc.id).map((n) => {
      const grade = gradeWhatsappNumber(n)
      return {
        id: n.id,
        label: n.label,
        displayPhone: n.display_phone,
        source: n.source,
        connectedVia: n.connected_via,
        isDefault: n.is_default,
        isActive: n.is_active,
        qualityRating: n.quality_rating || null,
        tier: n.messaging_limit_tier || null,
        status: grade.status,
        message: grade.message,
      }
    })
    const status = worstStatus(numbers.map((n) => n.status))
    const href = locationTabHref(loc.id, 'whatsapp')

    // Daily tier budget (WA-BUDGET) — only when a default active number
    // carries a gated tier; UNLIMITED/unknown tiers have no meter.
    let budget = null
    const gated = numbers.find((n) => n.isActive && n.tier && tierDailyLimit(n.tier) != null)
    if (gated) {
      try {
        budget = await getSendBudget(db, { locationId: loc.id, tier: gated.tier })
      } catch {
        budget = null // meter is decorative — never fail the hub for it
      }
    }

    const errNumber = numbers.find((n) => n.status === 'error')
    attentionInputs.push({
      cardKey: 'whatsapp', locationId: loc.id, locationName: nameById[loc.id],
      status, message: errNumber?.message || numbers.find((n) => n.message)?.message || null,
      partialSetup: numbers.length > 0 && status === 'not_connected', href,
    })
    return { locationId: loc.id, status, numbers, budget, href }
  }))

  // ── Instagram — registry rows (health cron maintains status) ──
  const instagram = locs.flatMap((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'instagram')
    if (!reg) return []
    const href = locationTabHref(loc.id, 'instagram')
    attentionInputs.push({
      cardKey: 'instagram', locationId: loc.id, locationName: nameById[loc.id],
      status: reg.status, message: reg.last_error,
      tokenExpiresAt: reg.token_expires_at, partialSetup: reg.status === 'not_connected', href,
    })
    return [{
      locationId: loc.id,
      status: reg.status,
      displayName: reg.display_name || reg.label || null,
      externalAccountId: reg.external_account_id || null,
      tokenExpiresAt: reg.token_expires_at || null,
      tokenDaysLeft: daysUntil(reg.token_expires_at, now),
      lastOkAt: reg.last_ok_at || null,
      lastError: reg.last_error || null,
      href,
    }]
  })

  // ── Xero — per-location OAuth binding (mirrors XeroIntegrationTab) ──
  const xero = locs.flatMap((loc) => {
    const row = xeroRows.find((x) => x.location_id === loc.id) || null
    const grade = gradeXeroConnection(row)
    const href = locationTabHref(loc.id, 'xero')
    if (!row && grade.status === 'not_connected') return [] // never connected — no card row
    attentionInputs.push({
      cardKey: 'xero', locationId: loc.id, locationName: nameById[loc.id],
      status: grade.status, message: grade.message, partialSetup: false, href,
    })
    return [{
      locationId: loc.id,
      status: grade.status,
      message: grade.message,
      tenantName: row.tenant_name || row.tenant_id,
      tenantType: row.tenant_type || null,
      connectedAt: row.connected_at || null,
      lastRefreshedAt: row.last_refreshed_at || null,
      scopes: Array.isArray(row.scopes) ? row.scopes : (typeof row.scopes === 'string' ? row.scopes.split(' ').filter(Boolean) : []),
      href,
    }]
  })

  // ── Ad accounts — presence only (per /api/settings/ads semantics) ──
  const ads = locs.flatMap((loc) => {
    return adRows.filter((a) => a.location_id === loc.id && a.provider === 'meta').map((a) => {
      const status = a.is_active && a.has_access_token ? 'connected' : 'not_connected'
      const href = locationTabHref(loc.id, 'ads')
      attentionInputs.push({
        cardKey: 'ads', locationId: loc.id, locationName: nameById[loc.id],
        status, message: null, partialSetup: status === 'not_connected', href,
      })
      return {
        locationId: loc.id,
        status,
        externalAccountId: a.external_account_id || null,
        displayName: a.display_name || null,
        href,
      }
    })
  })

  // ── SMS sender (platform-managed card's live signal) ──
  const sms = locs.map((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'twilio_sender')
    const senderId = reg?.config?.sender_id ?? loc.twilio_alpha_sender_id ?? null
    return {
      locationId: loc.id,
      senderId,
      source: reg ? 'registry' : 'legacy',
      href: locationTabHref(loc.id, 'twilio'),
    }
  })

  // ── AI agent live signal (locations.settings.customer_agent) ──
  const agent = locs.map((loc) => ({
    locationId: loc.id,
    mode: agentSignal(loc.settings?.customer_agent),
    agentName: loc.settings?.customer_agent?.agent_name || null,
  }))

  // ── Hidden tier: UniFi / Climate / BCA from the registry ──
  const unifi = locs.flatMap((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'unifi')
    const legacy = registryRowFromLegacy('unifi', loc)
    if (!reg && !legacy) return []
    const status = reg ? reg.status : 'connected'
    const href = locationTabHref(loc.id, 'unifi')
    attentionInputs.push({
      cardKey: 'unifi', locationId: loc.id, locationName: nameById[loc.id],
      status, message: reg?.last_error ?? null, partialSetup: false, href,
    })
    return [{ locationId: loc.id, status, lastOkAt: reg?.last_ok_at ?? null, lastError: reg?.last_error ?? null, href }]
  })

  const climate = locs.flatMap((loc) => {
    const vendors = []
    const sensiboReg = pickRegistry(regRows, loc.id, 'sensibo')
    const sensiboLegacy = registryRowFromLegacy('sensibo', loc)
    if (sensiboReg || sensiboLegacy) {
      vendors.push({ vendor: 'sensibo', status: sensiboReg ? sensiboReg.status : 'connected', lastError: sensiboReg?.last_error ?? null })
    }
    const thinqReg = pickRegistry(regRows, loc.id, 'thinq')
    const thinqLegacy = registryRowFromLegacy('thinq', loc)
    if (thinqReg || thinqLegacy) {
      vendors.push({ vendor: 'thinq', status: thinqReg ? thinqReg.status : 'connected', lastError: thinqReg?.last_error ?? null })
    }
    if (!vendors.length) return []
    const status = worstStatus(vendors.map((v) => v.status))
    const href = locationTabHref(loc.id, 'ac-devices')
    attentionInputs.push({
      cardKey: 'climate', locationId: loc.id, locationName: nameById[loc.id],
      status, message: vendors.find((v) => v.lastError)?.lastError ?? null, partialSetup: false, href,
    })
    return [{ locationId: loc.id, status, vendors, href }]
  })

  const bca = locs.flatMap((loc) => {
    const reg = pickRegistry(regRows, loc.id, 'bca')
    const legacy = registryRowFromLegacy('bca', loc)
    if (!reg && !legacy) return []
    const status = reg ? reg.status : 'connected'
    const href = locationTabHref(loc.id, 'bca')
    attentionInputs.push({
      cardKey: 'bca', locationId: loc.id, locationName: nameById[loc.id],
      status, message: reg?.last_error ?? null, partialSetup: false, href,
    })
    return [{ locationId: loc.id, status, href }]
  })

  return {
    generatedAt: now.toISOString(),
    expirySoonDays: EXPIRY_SOON_DAYS,
    locations: locs.map((l) => ({ id: l.id, name: l.name })),
    glofox,
    whatsapp,
    instagram,
    xero,
    ads,
    sms,
    agent,
    unifi,
    climate,
    bca,
    attention: buildAttention(attentionInputs, { now }),
  }
}
