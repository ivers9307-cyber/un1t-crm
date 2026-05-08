// contact_devices CRUD + lookup helpers.
//
// Persistent member→device registry. Members can have multiple
// devices (chest strap + future Apple Watch + …) but typically
// just one. The bridge ingestion path uses lookupByIdentifier to
// auto-route samples without per-class manual pairing.
//
// Identifier validation: chest_strap MACs are normalised through
// canonicaliseMac before storage. Watch identifiers (vendor IDs)
// are stored verbatim — vendor format varies and we don't try
// to canonicalise across vendors.

import { canonicaliseMac } from '@/lib/bridge-samples'

export const DEVICE_TYPES = ['chest_strap', 'watch']
export const KNOWN_MANUFACTURERS = ['polar', 'wahoo', 'coospo', 'garmin', 'apple', 'whoop', 'unknown']

/**
 * Validate + normalise the input shape for a new device.
 * Returns { ok: true, normalised } OR { ok: false, error }.
 *
 * The caller is responsible for the actual insert — this is the
 * pure validation step shared between the CRM admin route and the
 * champ-app self-service route.
 */
export function validateDeviceInput(input) {
  const deviceType = String(input?.device_type || '').trim()
  if (!DEVICE_TYPES.includes(deviceType)) {
    return { ok: false, error: `device_type must be one of: ${DEVICE_TYPES.join(', ')}` }
  }

  let identifier = String(input?.identifier || '').trim()
  if (!identifier) return { ok: false, error: 'identifier is required' }

  if (deviceType === 'chest_strap') {
    const canonical = canonicaliseMac(identifier)
    if (!canonical) {
      return { ok: false, error: 'identifier must be a valid MAC address (e.g. AA:BB:CC:DD:EE:FF)' }
    }
    identifier = canonical
  } else {
    // Watch: keep as-is, just length-bound it.
    if (identifier.length > 200) {
      return { ok: false, error: 'identifier too long (max 200 chars)' }
    }
  }

  const label = input?.label != null ? String(input.label).trim().slice(0, 80) : null
  let manufacturer = input?.manufacturer != null ? String(input.manufacturer).toLowerCase().trim() : null
  if (manufacturer && !KNOWN_MANUFACTURERS.includes(manufacturer)) manufacturer = 'unknown'

  return {
    ok: true,
    normalised: {
      device_type: deviceType,
      identifier,
      label: label || null,
      manufacturer: manufacturer || null,
    },
  }
}

/**
 * Look up a contact_devices row by identifier. Used by the bridge
 * ingestion path when a sample arrives — the bridge doesn't know
 * which contact owns the strap, so we resolve here.
 *
 * Returns { contactId, locationId, label } or null. Joins to
 * contacts to fetch location_id (the bridge's location must match
 * for the auto-association to fire — the auto-route lookup is
 * always location-scoped to prevent a strap MAC at one studio
 * accidentally routing to a member at another).
 *
 * @param {SupabaseClient} db   service-role client (caller is bridge ingestion)
 * @param {string} identifier   pre-canonicalised
 * @param {string} locationId   bridge's location
 * @returns {Promise<{ contactId: string, locationId: string, label: string|null } | null>}
 */
export async function lookupByIdentifier(db, identifier, locationId) {
  if (!identifier || !locationId) return null
  const { data } = await db
    .from('contact_devices')
    .select('contact_id, label, contacts!inner(id, location_id)')
    .eq('identifier', identifier)
    .eq('is_active', true)
    .eq('contacts.location_id', locationId)
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return {
    contactId: data.contact_id,
    locationId,
    label: data.label,
  }
}

/**
 * List a contact's devices (active first, then inactive).
 * RLS handles access — caller is either the contact themselves
 * (champ-app) or staff at the contact's location (CRM).
 */
export async function listForContact(db, contactId) {
  const { data, error } = await db
    .from('contact_devices')
    .select('id, device_type, identifier, label, manufacturer, is_active, added_by_contact, created_at')
    .eq('contact_id', contactId)
    .order('is_active', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) return { devices: [], error }
  return { devices: data || [], error: null }
}
