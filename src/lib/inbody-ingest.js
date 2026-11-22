// InBody scan ingestion — shared IO core used by both the webhook-enrich path
// (POST /api/bridge/inbody/ingest) and the on-demand backfill path
// (POST /api/bridge/inbody/backfill-ingest). The Pi fetches the raw
// GetFullInBodyData payload; this maps it into inbody_scans, matches the phone
// to a contact, and upserts idempotently.

import { createServerClient } from '@/lib/supabase'
import { parseFullInBodyData } from '@/lib/inbody-scan'
import { inbodyDatetimeToIso } from '@/lib/inbody-webhook'
import { normalisePhone9 } from '@/lib/person-links'
import { applyWeightObservation } from '@/lib/body-metrics'

const SOURCE = 'lookinbody'

// Resolve the single contact whose phone matches `telHp` (last-9-digit), or
// null if there's no unambiguous match. Pre-filters with an ilike on the digit
// tail (the established phone-search pattern), then confirms with the
// format-agnostic normalisePhone9 and requires exactly one distinct contact.
//
// INBODYSCOPE.1 (October audit A03): the search used to run across every
// contact in the estate, so a scan taken at one organisation's studio could
// attach to (and write the body weight of) another organisation's contact,
// and a phone shared across organisations defeated a valid match. It now
// searches only the organisation that owns the scanning studio: contacts are
// shared across an organisation's studios (ORGCONTACTS), so a member scanned
// at a sibling studio still matches. No organisation, no match.
export async function matchContactId(db, telHp, organizationId) {
  const tail = normalisePhone9(telHp)
  if (!tail || !organizationId) return null
  const { data, error } = await db
    .from('contacts')
    .select('id, phone, wa_phone')
    .eq('organization_id', organizationId)
    .or(`phone.ilike.%${tail}%,wa_phone.ilike.%${tail}%`)
    .limit(20)
  if (error || !data) return null
  const ids = new Set(
    data
      .filter((c) => normalisePhone9(c.phone) === tail || normalisePhone9(c.wa_phone) === tail)
      .map((c) => c.id),
  )
  return ids.size === 1 ? [...ids][0] : null
}

// The organisation that owns a studio, or null (no studio, unknown studio,
// or a failed read: an unmatched scan is safe, a cross-tenant match is not).
async function organizationOfLocation(db, locationId) {
  if (!locationId) return null
  const { data, error } = await db.from('locations').select('organization_id').eq('id', locationId).maybeSingle()
  if (error || !data) return null
  return data.organization_id || null
}

// INBODYDEDUPE.1 (mig 871): a scan is one person at one studio at one second.
// The key is (location_id, matched_phone9, scanned_at); matched_phone9 is a
// generated column (last nine digits of matched_phone, the normalisePhone9
// rule), so the webhook's 0871234567 and a backfill's +353871234567 are the
// same scan. external_id (`${telHp}_${testDatetime}`) is still written but no
// longer decides identity: its spelling of the phone varies by road.
export const SCAN_CONFLICT_TARGET = 'location_id,matched_phone9,scanned_at'

// Is this scan already recorded? true / false, or null when the read failed
// (the upsert below stays safe either way: the index decides, not this read).
async function scanExists(db, { locationId, phone9, scannedAt }) {
  const { data, error } = await db
    .from('inbody_scans')
    .select('id')
    .eq('location_id', locationId)
    .eq('matched_phone9', phone9)
    .eq('scanned_at', scannedAt)
    .limit(1)
  if (error) return null
  return (data || []).length > 0
}

// Map + match + upsert one scan. `db` is a service-role client (caller may pass
// one to share across a batch). Idempotent on SCAN_CONFLICT_TARGET: a repeat
// delivery by any road updates the one row in place (same measurements, and a
// re-sync can link a scan that landed unlinked) and never adds a second.
// Returns { ok, linked, contactId, duplicate } where duplicate = the scan was
// already recorded before this call.
// Skips (ok:false, reason:'bad_input') when the datetime is unparseable, the
// phone has under nine digits or there is no studio: without those there is
// no key, and a keyless row could be doubled.
export async function ingestScan(db, { telHp, testDatetime, raw, locationId }) {
  const client = db || createServerClient()
  const scannedAt = inbodyDatetimeToIso(testDatetime)
  const phone9 = normalisePhone9(telHp)
  if (!scannedAt || !phone9 || !locationId) return { ok: false, reason: 'bad_input' }

  const externalId = `${telHp}_${testDatetime}`
  const measurements = parseFullInBodyData(raw)
  const organizationId = await organizationOfLocation(client, locationId)
  const contactId = await matchContactId(client, telHp, organizationId)
  const duplicate = (await scanExists(client, { locationId, phone9, scannedAt })) === true

  const { error } = await client
    .from('inbody_scans')
    .upsert({
      source: SOURCE,
      external_id: externalId,
      location_id: locationId,
      contact_id: contactId,
      matched_phone: telHp,
      scanned_at: scannedAt,
      ...measurements,
      raw: raw ?? null,
    }, { onConflict: SCAN_CONFLICT_TARGET })

  if (error) return { ok: false, reason: 'upsert_failed', error: error.message }

  // Feed the canonical body weight (freshest-wins) so calories can use it.
  if (contactId && Number.isFinite(Number(measurements?.weight_kg))) {
    await applyWeightObservation(client, {
      contactId, weightKg: measurements.weight_kg, source: 'inbody', observedAt: scannedAt,
    })
  }

  return { ok: true, linked: !!contactId, contactId, duplicate }
}
