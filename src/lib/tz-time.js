// src/lib/tz-time.js — SHELLY.1's module, now a compatibility shim onto
// @shared/zoned-time (TZ.1). The solver, the DST contract (GAP resolves
// earlier except a day start, which resolves later; OVERLAP is one
// deterministic instant) and the 12-zone measurement now live there, so the
// phone and shared/ can use them too. Do not add exports here; new code
// imports @/lib/location-time.
import { zonedWallClockToInstant } from '@shared/zoned-time'

export {
  DEFAULT_TZ, isValidZone as isValidTz, resolveZone as resolveTz,
  strictDayStrIn as dayStrInTz, strictDayStartMsIn as dayStartMsInTz, nextLocalMidnightMs,
} from '@shared/zoned-time'

// tz-time accepted HH:MM only (zonedWallClockToInstant also takes a Postgres
// TIME's HH:MM:SS); keep that strictness for its existing callers.
export function wallMsInTz(dateStr, hhmm, tz) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(hhmm ?? '')) ? zonedWallClockToInstant(dateStr, hhmm, tz) : null
}
