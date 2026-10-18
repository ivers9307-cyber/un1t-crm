// UN1TWRITE.3 — the pure un1t.online write judge, the permission table and the
// error_events row for a failed write.
//
// Pure on purpose: no fetch, no db, no logger. The transport
// (un1t-online-write.js) does the I/O and asks this module what an answer
// means, so every rule here is testable with literals.
//
// The rules (spec 6.1, global constraints):
// - done = a 2xx AND success !== false AND the op's id. A 2xx with no id is
//   UNKNOWN (the dedupe read decides), never "failed": an id-required rule
//   once mislabelled a real Glofox booking (CLAUDE.md, Glofox).
// - refused = a 2xx with success:false, or a 4xx, with un1t.online's own
//   error.code and words (surfaced verbatim; scrubMessage runs before storage).
// - A book answer that describes another event, user or studio is unknown
//   (RF5: a proxy bug or a stale cache must not read as our booking).
// - already booked is a done book with no new id.

export const UN1T_WRITE_OPS = Object.freeze(['create_client', 'forgot_password', 'trial', 'book', 'cancel', 'checkout'])
const OPS = new Set(UN1T_WRITE_OPS)

// From the token's `GET /api-token` permissions[]. Fail closed.
export const REQUIRED_PERMISSIONS = Object.freeze({
  book: Object.freeze(['bookings:create', 'bookings:read']),
  cancel: Object.freeze(['bookings:update', 'bookings:read']),
  create_client: Object.freeze(['users:create', 'users:read']),
  trial: Object.freeze(['purchases:create', 'products:read', 'credits:read']),
  checkout: Object.freeze(['purchases:create', 'products:read']),
  forgot_password: Object.freeze([]),
})

/**
 * The permissions `op` needs that `permissions` lacks, in table order.
 * An unreadable list (not an array) is every permission missing.
 * @param {string} op
 * @param {string[]} permissions
 * @returns {string[]}
 */
export function missingPermissions(op, permissions) {
  if (!OPS.has(op)) throw new TypeError(`missingPermissions: unknown un1t.online write op '${op}'`)
  const held = new Set(Array.isArray(permissions) ? permissions : [])
  return REQUIRED_PERMISSIONS[op].filter((p) => !held.has(p))
}

/** Staff-facing text for UN1T_PERMISSION_MISSING (exact, global constraints). */
export function permissionMissingMessage(studioName, permission) {
  return `The un1t.online token for ${studioName} is missing the '${permission}' permission, so nothing was sent. Add it to the token in the un1t.online owner console, or issue a new token and paste it in Settings, Integrations, un1t.online.`
}

/**
 * un1t.online error.code → refusal kind. The codes are not documented: the
 * MIA TEST run records the real ones here (PR 6). Callers read it only
 * through classifyRefusal, so filling it changes no caller.
 * @typedef {'no_credits'|'class_full'|'already_booked'|'trial_used'|'email_in_use'|'late_cancel'} Un1tRefusalKind
 * @type {Readonly<Record<string, Un1tRefusalKind>>}
 */
export const UN1T_REFUSAL_CODES = Object.freeze({})

/** Kinds E relays to the customer; every other kind, or null, is a staff card. */
export const CUSTOMER_ANSWERABLE_REFUSALS = new Set(['class_full', 'already_booked', 'late_cancel'])

/** Answers, not faults: logged and on the ledger, no error_events row. */
export const KNOWN_BUSINESS_REFUSALS = new Set(['no_credits', 'class_full', 'already_booked', 'trial_used', 'email_in_use', 'late_cancel'])

// Word fallbacks while the table is empty. `[\s_-]*` so a code spelled
// ALREADY_BOOKED / EMAIL_IN_USE matches as well as the words.
// trial_used is NEVER guessed: an unmapped trial refusal must reach staff,
// not tell a customer their trial was used.
const ALREADY_BOOKED_WORDS = /already[\s_-]*booked/i
const EMAIL_IN_USE_WORDS = /email.*(in[\s_-]*use|exists|taken|already)/i

/**
 * The kind of a refusal, or null when it is not one we know.
 * @param {{ code?: string|null, message?: string|null }} refusal
 * @param {Readonly<Record<string, Un1tRefusalKind>>} [table] test seam; callers omit it
 * @returns {Un1tRefusalKind|null}
 */
export function classifyRefusal({ code, message } = {}, table = UN1T_REFUSAL_CODES) {
  const c = code == null ? '' : String(code)
  if (c && Object.hasOwn(table, c)) return table[c]
  const m = message == null ? '' : String(message)
  if (ALREADY_BOOKED_WORDS.test(c) || ALREADY_BOOKED_WORDS.test(m)) return 'already_booked'
  if (EMAIL_IN_USE_WORDS.test(c) || EMAIL_IN_USE_WORDS.test(m)) return 'email_in_use'
  return null
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const idOf = (v) => ((typeof v === 'string' && v.trim()) || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim() : null)
const sameId = (a, b) => a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

// un1t.online's error.code and words. Also reads a framework-shaped body
// ({ statusCode, message: string|string[], error: 'Bad Request' }).
function refusalOf(body) {
  if (!isObj(body)) return { code: null, message: null }
  const err = isObj(body.error) ? body.error : null
  const code = idOf(err?.code) ?? idOf(body.code)
  const raw = err?.message ?? body.message ?? (typeof body.error === 'string' ? body.error : null)
  const message = Array.isArray(raw)
    ? raw.filter((x) => typeof x === 'string' && x).join('; ') || null
    : typeof raw === 'string' && raw ? raw : null
  return { code, message }
}

function isHttpsUrl(v) {
  if (typeof v !== 'string' || !v) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && !!u.hostname
  } catch {
    return false
  }
}

// The book answer must describe the booking we asked for (RF5). A field the
// request names but the answer leaves out cannot be checked, so it fails too.
function bookMatches(data, expect) {
  const pairs = [
    [expect.eventId, data.event_id ?? (isObj(data.event) ? data.event.id : undefined)],
    [expect.userId, data.user_id ?? (isObj(data.user) ? data.user.id : undefined)],
    [expect.studioId, data.studio_id ?? (isObj(data.studio) ? data.studio.id : undefined)],
  ]
  return pairs.every(([want, got]) => want == null || sameId(want, got))
}

const verdict = (v, { id = null, code = null, message = null, alreadyBooked = false } = {}) => ({ verdict: v, id, code, message, alreadyBooked })

/**
 * What a write's answer means.
 * @param {string} op one of UN1T_WRITE_OPS
 * @param {{ status: number|null, body: any, expect?: { eventId?: string, userId?: string, studioId?: string, bookingId?: string } }} answer
 * @returns {{ verdict: 'done'|'refused'|'unknown', id: string|null, code: string|null, message: string|null, alreadyBooked: boolean }}
 */
export function judgeUn1tWrite(op, { status, body, expect = {} } = {}) {
  if (!OPS.has(op)) return verdict('unknown')
  const s = Number.isInteger(status) ? status : null
  const is2xx = s != null && s >= 200 && s < 300
  const is4xx = s != null && s >= 400 && s < 500

  // No reply, a 5xx, a redirect: nothing to judge on.
  if (!is2xx && !is4xx) return verdict('unknown')

  if (is4xx || (isObj(body) && body.success === false)) {
    const { code, message } = refusalOf(body)
    if (op === 'book' && classifyRefusal({ code, message }) === 'already_booked') {
      return verdict('done', { code, message, alreadyBooked: true })
    }
    return verdict('refused', { code, message })
  }

  const data = isObj(body) && isObj(body.data) ? body.data : null
  switch (op) {
    case 'cancel': {
      // 200 with no body schema: the requested booking is the id.
      const id = idOf(expect.bookingId)
      return id ? verdict('done', { id }) : verdict('unknown')
    }
    case 'forgot_password':
      return isObj(body) && body.success === true ? verdict('done') : verdict('unknown')
    case 'book': {
      const id = idOf(data?.id)
      if (!id) return verdict('unknown')
      return bookMatches(data, expect) ? verdict('done', { id }) : verdict('unknown', { code: 'response_mismatch' })
    }
    case 'create_client': {
      // Only the id leaves: the body also carries reset_password_token, email and phone.
      const id = idOf(data?.id)
      return id ? verdict('done', { id }) : verdict('unknown')
    }
    case 'trial': {
      const id = idOf(data?.transactionId)
      return id ? verdict('done', { id }) : verdict('unknown')
    }
    case 'checkout':
      return isHttpsUrl(data?.checkoutUrl) ? verdict('done', { id: data.checkoutUrl }) : verdict('unknown')
    default:
      return verdict('unknown')
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `text` with every secret removed (case-insensitive, longest first), then cut
 * to 500 chars. Removal runs before the cut so no part of a secret survives.
 * @param {string} text
 * @param {string[]} [secrets]
 * @returns {string}
 */
export function scrubMessage(text, secrets = []) {
  let out = text == null ? '' : String(text)
  const list = (Array.isArray(secrets) ? secrets : [])
    .filter((s) => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length)
  for (const s of list) out = out.replace(new RegExp(escapeRegExp(s), 'gi'), '[redacted]')
  return out.slice(0, 500)
}

const UN1T_ID_SEGMENT = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{16,}$/i,                                              // 16+ hex
  /^\d{6,}$/,                                                      // 6+ digits
]

/**
 * An id-free route label: 'un1t:<METHOD> <path>', the query and fragment
 * dropped and every id-like segment replaced by ':id'.
 */
export function un1tRoutePathLabel(method, path) {
  const m = String(method || 'GET').toUpperCase()
  let p = String(path || '')
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname } catch { /* keep the raw string */ }
  }
  p = p.split(/[?#]/)[0]
  const label = p.split('/').map((seg) => (UN1T_ID_SEGMENT.some((re) => re.test(seg)) ? ':id' : seg)).join('/')
  return `un1t:${m} ${label}`
}

const UN1T_WRITE_FAILURE_TEXT = {
  '5xx': 'un1t.online failed, and the check read could not tell whether it went through',
  '429': 'still throttled after every retry, so it was not done',
  no_reply: 'no reply from un1t.online (network error), so the outcome is unknown',
  unclear: 'the answer did not say clearly whether it went through',
  auth: 'the token was refused, so nothing more was sent',
  refused: 'un1t.online refused it with a reason the CRM does not know',
}

/**
 * The error_events row for a failed un1t.online write. Pure; no ids, no
 * un1t.online words (they can hold an email), no em-dash.
 * @param {{ method: string, path: string, status: number|null, reason: '5xx'|'429'|'no_reply'|'unclear'|'auth'|'refused', attempts: number }} args
 */
export function un1tWriteFailureEvent({ method, path, status, reason, attempts }) {
  if (!Object.hasOwn(UN1T_WRITE_FAILURE_TEXT, reason)) {
    throw new TypeError(`un1tWriteFailureEvent: unknown reason '${reason}'`)
  }
  const m = String(method || 'POST').toUpperCase()
  const routePath = un1tRoutePathLabel(m, path)
  const answer = reason === 'no_reply' || status == null ? 'no reply' : `HTTP ${status}`
  return {
    vercel_id: null,
    runtime: process.env.NEXT_RUNTIME || null,
    route_path: routePath,
    route_type: 'un1t_write',
    method: m,
    name: `un1t_write_${reason}`,
    message: `${routePath.slice('un1t:'.length)} on un1t.online answered ${answer} after ${attempts} attempt(s); ${UN1T_WRITE_FAILURE_TEXT[reason]}`.slice(0, 500),
    digest: null,
  }
}
