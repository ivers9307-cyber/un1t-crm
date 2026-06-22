// InBody / Lookin'Body WebAPI webhook — pure helpers for the notification
// receiver (/api/webhooks/inbody).
//
// The InBody webhook is a NOTIFY, not the data: each completed scan POSTs a
// small payload (phone + scan datetime + device + account), NOT the
// measurements — those are pulled from the Lookin'Body REST API in a later
// enrich step. Auth is a shared secret we define in the InBody portal (Step 3
// custom header) and verify here against INBODY_WEBHOOK_SECRET.
//
// Sample payload (from the InBody API-KEY setup page):
//   { "EquipSerial":"CC71700163", "TelHP":"01012344733", "UserID":"1234",
//     "TestDatetimes":"20190811120103", "Account":"stillorganun1t",
//     "Equip":"InBody770", "Type":"InBody", "IsTempData":"false" }

import { safeEqual } from './webhook-auth'

// Verify the secret header InBody sends (the custom header we configured in
// their portal) against our INBODY_WEBHOOK_SECRET. Constant-time; false on any
// missing/blank input. Named verify* so the route-guard check recognises it.
export function verifyInbodySecret(headerValue, secret) {
  if (!secret || !headerValue) return false
  return safeEqual(String(headerValue), String(secret))
}

// InBody TestDatetimes is 'YYYYMMDDHHMMSS' in the scanner's local (Dublin)
// wall-clock. Return a plain 'YYYY-MM-DDTHH:MM:SS' string (no Z) — do NOT
// stamp a timezone (same wall-clock caveat as bookings). null if unparseable.
export function inbodyDatetimeToIso(raw) {
  if (!raw || typeof raw !== 'string') return null
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`
}

function parseTempFlag(v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true'
  return null
}

// Map the raw webhook body into our staging-row fields. Tolerant of missing
// keys (returns nulls) — the full body is kept in `payload` regardless.
export function parseInbodyNotification(body) {
  const b = body && typeof body === 'object' ? body : {}
  return {
    account: b.Account ?? null,
    telHp: b.TelHP != null ? String(b.TelHP) : null,
    userId: b.UserID != null ? String(b.UserID) : null,
    testDatetime: b.TestDatetimes != null ? String(b.TestDatetimes) : null,
    scannedAt: inbodyDatetimeToIso(b.TestDatetimes != null ? String(b.TestDatetimes) : null),
    equip: b.Equip ?? null,
    equipSerial: b.EquipSerial ?? null,
    isTempData: parseTempFlag(b.IsTempData),
    type: b.Type ?? null,
  }
}
