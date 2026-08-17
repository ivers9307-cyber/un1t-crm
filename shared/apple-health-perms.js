// Pure helper for the Apple Health re-sync nudge. iOS hides read-authorization
// status, so we can't detect "granted old types but not new" directly. Instead
// we version the read-types set: stamp the version on connect, and nudge a
// connected member whose stored version is behind the current one.

// Bump whenever HEALTHKIT_READ_TYPES gains a new type that needs a fresh grant.
// v2 added bodyMass + dateOfBirth + biologicalSex (Slice 2).
export const HEALTHKIT_READ_TYPES_VERSION = 2

/**
 * Should we show the "update Apple Health permissions" nudge?
 * @param {{ connected:boolean, storedVersion:number|null, currentVersion?:number }} args
 */
export function needsAppleHealthResync({ connected, storedVersion, currentVersion = HEALTHKIT_READ_TYPES_VERSION }) {
  if (!connected) return false
  const stored = Number.isFinite(Number(storedVersion)) ? Number(storedVersion) : 1
  return stored < currentVersion
}
