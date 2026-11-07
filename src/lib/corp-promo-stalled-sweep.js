// NEWSTART.1f — hands stuck Glofox promo claims (Stillorgan's /newstart) to
// the team. A claim that stays 'processing' for 15 minutes lost its run
// (a process kill, a timeout) before it filed or granted anything. This arm
// of the process-trial-purchases cron moves it to help_requested with the
// reason 'stalled' (the approvals card maps that exact code) and alerts the
// studio's organisation. It NEVER calls Glofox and never buys anything.
//
// A stuck row can carry a write-ahead `grant` marker ({ stage: 'purchasing' }
// written before the purchase, or an outcome whose final status stamp
// failed): the purchase may have gone through, so the alert says to check the
// member's €0 New Start invoice in Glofox before adding the plan by hand. No
// marker means nothing was bought.
//
// WAYSIN.2: a claim is a Glofox claim by its own platform column (mig 816),
// else, for a row not yet stamped, by its studio's corp_promos row of that key
// (read once per studio per run). A studio whose promos cannot be read leaves
// its unstamped claims for the next run and the run reports not ok.
import { listCorpPromos } from '@/lib/corp-promos'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { escapeHtml } from '@/lib/html-escape'
import { logError, logWarn } from '@/lib/log'

const LOG = 'corp-promo-stalled-sweep'
export const STALLED_AFTER_MS = 15 * 60_000
export const STALLED_REASON = 'stalled'
const BATCH = 100

/**
 * @param {object} db service-role client
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ ok: boolean, checked: number, filed: number, failed: number }>}
 */
export async function sweepStalledGlofoxCorpClaims(db, { now = Date.now() } = {}) {
  const cutoff = new Date(now - STALLED_AFTER_MS).toISOString()
  const { data, error } = await db.from('corp_promo_claims')
    .select('id, location_id, promo_key, platform, contact_id, first_name, last_name, customer_email, customer_phone, created_at, grant, glofox_member_id, status')
    .eq('status', 'processing').or('platform.eq.glofox,platform.is.null').lt('created_at', cutoff)
    .order('created_at', { ascending: true }).limit(BATCH)
  if (error) {
    logError(LOG, 'stalled claims read failed', { code: error.code ?? null })
    return { ok: false, checked: 0, filed: 0, failed: 0 }
  }
  const candidates = (data || []).filter((r) => r.platform == null || r.platform === 'glofox')
  if (!candidates.length) return { ok: true, checked: 0, filed: 0, failed: 0 }

  // Each studio's promos, once per run, by key (null: unreadable).
  let promosOk = true
  const promosByLoc = new Map()
  for (const locationId of new Set(candidates.map((r) => r.location_id))) {
    const res = await listCorpPromos(db, { locationId })
    if (!res.ok) {
      promosOk = false
      logError(LOG, 'studio promos read failed', { locationId })
      promosByLoc.set(locationId, null)
      continue
    }
    promosByLoc.set(locationId, new Map(res.promos.map((p) => [p.key, p])))
  }
  const promoOf = (row) => promosByLoc.get(row.location_id)?.get(row.promo_key) || null
  const rows = candidates.filter((r) => (r.platform || promoOf(r)?.platform) === 'glofox')
  if (!rows.length) return { ok: promosOk, checked: 0, filed: 0, failed: 0 }

  const locIds = [...new Set(rows.map((r) => r.location_id))]
  const { data: locs, error: locErr } = await db.from('locations').select('id, name, organization_id').in('id', locIds)
  if (locErr) {
    logError(LOG, 'locations read failed', { code: locErr.code ?? null })
    return { ok: false, checked: rows.length, filed: 0, failed: 0 }
  }
  const locById = new Map((locs || []).map((l) => [l.id, l]))

  let filed = 0
  let failed = 0
  for (const row of rows) {
    try {
      const patch = { status: 'help_requested', reason: STALLED_REASON }
      const { data: touched, error: upErr } = await db.from('corp_promo_claims').update(patch)
        .eq('id', row.id).eq('location_id', row.location_id).eq('status', 'processing').select('id')
      if (upErr) {
        failed++
        logError(LOG, 'stalled claim not filed', { claimId: row.id, locationId: row.location_id, code: upErr.code ?? null })
        continue
      }
      // Another run settled it first: not ours to file or alert.
      if (!touched || touched.length === 0) continue
      filed++
      logWarn(LOG, 'stalled claim handed to staff', { claimId: row.id, locationId: row.location_id, promo: row.promo_key, mayHavePurchased: Boolean(row.grant) })
      await alert(row, locById.get(row.location_id), promoOf(row))
    } catch (e) {
      failed++
      logError(LOG, 'stalled claim sweep threw', { claimId: row.id, errClass: e?.name })
    }
  }
  return { ok: promosOk && failed === 0, checked: rows.length, filed, failed }
}

async function alert(row, location, promo) {
  try {
    if (!location?.organization_id) return
    const promoName = promo?.name || row.promo_key
    const person = `${row.first_name || ''} ${row.last_name || ''}`.trim()
    const mayHavePurchased = Boolean(row.grant)
    const advice = mayHavePurchased
      ? 'The purchase may have gone through before it stopped. Check the member\'s €0 New Start invoice in Glofox before adding the plan by hand.'
      : 'Nothing was bought.'
    await sendOpsAlert({
      organizationId: location.organization_id,
      locationId: row.location_id,
      subject: `Promo needs a hand: ${person} (${location.name || 'studio'})`.replace(/\s+/g, ' '),
      htmlBody:
        `<p>Someone claimed the ${escapeHtml(promoName)} promo, but the claim stalled for more than 15 minutes and was never finished.</p>` +
        `<p>${escapeHtml(advice)}</p>` +
        `<p><strong>Person:</strong> ${escapeHtml(person)} &lt;${escapeHtml(row.customer_email || '')}&gt; ${escapeHtml(row.customer_phone || '')}<br/>` +
        (row.glofox_member_id ? `<strong>Glofox member id:</strong> ${escapeHtml(row.glofox_member_id)}<br/>` : '') +
        `<strong>Claim id:</strong> ${escapeHtml(row.id)}</p>` +
        `<p>If they qualify, add the ${escapeHtml(promoName)} plan${promo?.credits ? ` (${promo.credits} classes)` : ''} in Glofox by hand, then mark the card handled on the Approvals page.</p>`,
    })
  } catch (e) {
    logWarn(LOG, 'staff alert failed', { claimId: row.id, errClass: e?.name })
  }
}
