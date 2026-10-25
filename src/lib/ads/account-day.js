// src/lib/ads/account-day.js — TZ.11c. Which calendar day an ad account is on.
//
// Meta reports insights by day IN THE AD ACCOUNT'S OWN TIMEZONE (the account's
// `timezone_name`, set when the account was created and fixed after), so an
// ad_insights_daily.date is a day in that zone, not the studio's. Every
// since/until window asked of Meta, or read back from ad_insights_daily, is
// built here, in one place. It replaces four private copies of
// dublinDateStr(offsetDays) (read.js and the three sync routes).
//
// Zone order: ad_accounts.account_timezone (mig 358; an IANA name, compared
// through canonicalZone) → the account's location zone (locations.timezone) →
// the platform default. The location zone is the fallback because the column
// is empty unless an operator sets it (UN1T's live account: NULL on 11 Oct
// 2026), and a studio's Meta account is normally created in the studio's zone.
//
// "Yesterday" keeps the legacy rule exactly: the account-zone day of
// now - 24 h (not calendar-yesterday), so UN1T's windows are byte-identical.
import {
  canonicalZone, todayStrIn, zoneOfLocation, getLocationZone, DAY_MS, DEFAULT_TZ,
} from '@/lib/location-time'
import { logWarn } from '@/lib/log'

/** An ad_accounts read failed. Never read as "no account" (that would be a silent location zone). */
export class AdsZoneReadError extends Error {
  constructor(locationId, cause) {
    super(`ad_accounts unreadable: ${cause?.message || 'unknown error'}`)
    this.name = 'AdsZoneReadError'
    this.locationId = locationId
    this.cause = cause
  }
}

/**
 * The zone an ad account's insight days are in. No IO.
 * @param {{ account_timezone?: string|null, locations?: { id?: string, timezone?: string|null }|null }|null|undefined} account
 *   an ad_accounts row; select it with `locations(id, timezone)` embedded for the fallback
 * @returns {string} canonical IANA zone
 */
export function adAccountZone(account) {
  return canonicalZone(account?.account_timezone) ?? zoneOfLocation(account?.locations)
}

/**
 * 'YYYY-MM-DD' in the ad account's zone of now + offsetDays × 24 h.
 * @param {object} account see adAccountZone
 * @param {{ nowMs?: number, offsetDays?: number }} [opts]
 */
export function adAccountDay(account, { nowMs = Date.now(), offsetDays = 0 } = {}) {
  return todayStrIn(adAccountZone(account), nowMs + offsetDays * DAY_MS)
}

/**
 * The zone ad_insights_daily.date is in for one location: its active Meta
 * account's, else the location's. (One active account per location and
 * provider: ad_accounts_one_active, mig 358.)
 * @throws {AdsZoneReadError|import('@/lib/location-time').LocationZoneReadError} a read failed
 */
export async function adsDayZone(db, locationId) {
  const { data, error } = await db.from('ad_accounts')
    .select('account_timezone, locations(id, timezone)')
    .eq('location_id', locationId).eq('provider', 'meta').eq('is_active', true)
    .limit(1).maybeSingle()
  if (error) throw new AdsZoneReadError(locationId, error)
  if (data) return adAccountZone(data)
  return getLocationZone(db, locationId)
}

/**
 * adsDayZone for a DISPLAY (a dashboard window, a report): a failed read falls
 * back to the platform default, which is exactly the pre-TZ.11c window, and
 * says so in the log rather than blanking the page.
 */
export async function adsDayZoneForDisplay(db, locationId) {
  try {
    return await adsDayZone(db, locationId)
  } catch (err) {
    logWarn('ads-account-day', 'ad account zone unreadable; showing the platform-default window', { locationId, err: err?.message || String(err) })
    return DEFAULT_TZ
  }
}
