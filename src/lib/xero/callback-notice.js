// CHANNELREAD.1 — what the Xero OAuth callback tells the operator.
//
// GET /api/xero/callback used to redirect with free text (`?error=DB error:
// <pg message>`, `?connected=<org name>`) that no page ever read, so every
// outcome of a Xero connect (a refusal, a DB failure, even the XERO-ONE-ORG.1
// "this login grants N organisations, check this is the right one" warning)
// was invisible. Now the callback redirects with a CODE, and this module is
// the one place a code becomes copy:
//   - params are namespaced `xero_*`, because `/settings` is also the email
//     OAuth callback's fallback target and a bare `?error=` there is not ours;
//   - an unknown code (an old-format URL, a hand-typed one) gets the generic
//     line, and nothing from the URL is ever echoed onto the page;
//   - the raw detail (Xero's message, a Postgres error, which orgs are taken)
//     goes to the structured log in the callback, never to the URL.
// Staff-facing copy (not operator-editable), no em-dashes.
//
// Pure: no I/O, no imports. Rendered by src/components/settings/XeroCallbackNotice.jsx.

export const XERO_CALLBACK_PARAMS = Object.freeze({
  error: 'xero_error',
  connected: 'xero_connected',
  orgs: 'xero_orgs',
})

export const XERO_CALLBACK_ERRORS = Object.freeze({
  NOT_PERMITTED: 'not_permitted',
  DECLINED: 'declined',
  MISSING_CODE: 'missing_code',
  STATE_MISMATCH: 'state_mismatch',
  INVALID_STATE: 'invalid_state',
  NO_TENANTS: 'no_tenants',
  TAKEN_READ_FAILED: 'taken_read_failed',
  ALL_TAKEN: 'all_taken',
  SAVE_FAILED: 'save_failed',
  XERO_ERROR: 'xero_error',
})

export const XERO_GENERIC_ERROR = 'Xero did not connect, so nothing was changed. Try connecting again.'

const STATE_COPY = 'The Xero sign-in could not be matched to this browser, so nothing was changed. Start the connection again from this page.'

const ERROR_COPY = Object.freeze({
  not_permitted: 'Only an owner of this location can connect Xero, so nothing was changed.',
  declined: 'Xero did not grant access, so nothing was changed. Try connecting again if you meant to connect.',
  missing_code: 'Xero did not send back what was needed to finish connecting, so nothing was changed. Try connecting again.',
  state_mismatch: STATE_COPY,
  invalid_state: STATE_COPY,
  no_tenants: 'This Xero login does not give access to any organisation, so nothing was changed.',
  taken_read_failed: 'Could not check which Xero organisations are already connected, so nothing was changed. Try connecting again.',
  all_taken: 'Every Xero organisation this login gives access to is already connected to another location, so nothing was changed. Each location needs its own Xero organisation.',
  save_failed: 'The Xero connection could not be saved, so nothing was changed. Try connecting again.',
  xero_error: 'Xero did not connect: something went wrong talking to Xero, so nothing was changed. Try connecting again.',
})

// An org count worth mentioning: 2..999, digits only. Anything else is ignored.
function orgCount(raw) {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return null
  const n = Number(raw)
  return n >= 2 ? n : null
}

/**
 * @param {{ get(name: string): string | null } | null | undefined} params
 * @returns {{ tone: 'success' | 'error', text: string } | null}
 */
export function xeroCallbackNotice(params) {
  if (!params || typeof params.get !== 'function') return null
  const error = params.get(XERO_CALLBACK_PARAMS.error)
  if (error != null) {
    const text = Object.prototype.hasOwnProperty.call(ERROR_COPY, error) ? ERROR_COPY[error] : XERO_GENERIC_ERROR
    return { tone: 'error', text }
  }
  if (params.get(XERO_CALLBACK_PARAMS.connected) != null) {
    const n = orgCount(params.get(XERO_CALLBACK_PARAMS.orgs))
    return {
      tone: 'success',
      text: n
        ? `Xero connected. This login gives access to ${n} organisations and one was picked for this location, so check it is the right one.`
        : 'Xero connected.',
    }
  }
  return null
}

export function hasXeroCallbackParams(params) {
  if (!params || typeof params.has !== 'function') return false
  return Object.values(XERO_CALLBACK_PARAMS).some((p) => params.has(p))
}

// The query string with the callback params removed (no leading "?").
export function withoutXeroCallbackParams(params) {
  const next = new URLSearchParams(params ? params.toString() : '')
  for (const p of Object.values(XERO_CALLBACK_PARAMS)) next.delete(p)
  return next.toString()
}
