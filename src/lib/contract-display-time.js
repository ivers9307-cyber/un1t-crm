// src/lib/contract-display-time.js — TZ.16 (D3 = A). The timestamps the
// contract pages print (issued/declined/revoked/signed, a template version's
// date), in the contract's studio zone. One copy for the four pages that each
// carried their own Dublin-pinned `fmtDate`.
//
// Server-only (contractZone reads the location row through location-time).
import { zoneOfLocation } from '@/lib/location-time'
import { formatRecordTime } from '@/lib/record-time'

const STAMP = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
const DAY = { day: 'numeric', month: 'short', year: 'numeric' }
// Date#toLocaleString's defaults when no field is named: what the signature
// line printed ("7/9/2026, 13:34:00").
const SIGNED = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }

/**
 * The zone a contract's times are shown in: its own studio (`contracts.location_id`,
 * embedded as `location:locations!location_id ( id, timezone )`), else, for a
 * contract with no studio anchor (the column is nullable, mig 106), the
 * viewer's active studio.
 * @param {{ location?: { id?: string, timezone?: string|null }|null }|null} contract
 * @param {{ activeLocation?: { id?: string, timezone?: string|null } }|null} user
 */
export function contractZone(contract, user) {
  return zoneOfLocation(contract?.location || user?.activeLocation || null)
}

/** "9 Oct 2026, 14:05" ('' when absent). */
export function contractStamp(iso, zone, viewerZone = null) {
  if (!iso) return ''
  return formatRecordTime(iso, zone, STAMP, 'en-IE', viewerZone)
}

/** "9 Oct 2026" ('' when absent): the member's own contract list. */
export function contractDay(iso, zone, viewerZone = null) {
  if (!iso) return ''
  return formatRecordTime(iso, zone, DAY, 'en-IE', viewerZone)
}

/** The signature line's stamp, "9/10/2026, 14:05:33". */
export function contractSignedStamp(timestamp, zone, viewerZone = null) {
  return formatRecordTime(new Date(timestamp), zone, SIGNED, 'en-IE', viewerZone)
}
