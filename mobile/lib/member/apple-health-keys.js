// Per-contact HealthKit SecureStore keys. HK state (connected flag, sync
// cursor, perms version) MUST be namespaced by contact_id: the keys live on
// the device, but the data they gate belongs to one member. A shared/hand-me-
// down device (or the Apple Review demo login) must never inherit another
// member's connection. Callers pass the CURRENT contact id; a null id means
// "no member" and callers must no-op.
//
// contact ids are UUIDs, which fit SecureStore's [A-Za-z0-9._-] key charset;
// the '.' separator is legal there too.
export const hkConnectedKey = (contactId) => `apple_health_connected.${contactId}`
export const hkCursorKey = (contactId) => `apple_health_cursor.${contactId}`
export const hkPermsVersionKey = (contactId) => `apple_health_perms_version.${contactId}`
