// MIAHATCH.2 — ids Mia hands to the model and takes back.
//
// A Glofox event or booking id is a 24-hex string (or `manual-…` for a
// hand-made booking) and reaches the tools unchanged. A un1t.online id is a
// uuid-like string that could collide with nothing but is not recognisable on
// sight, so the read tools return it TAGGED (`un1t:<id>`) and the executors
// route on the tag. One id space for the model, two providers behind it.
//
// Pure and dependency-free.

export const UN1T_ID_PREFIX = 'un1t:'

/** The id the model sees for a un1t.online row. */
export function tagUn1tId(un1tId) {
  return `${UN1T_ID_PREFIX}${un1tId}`
}

/**
 * What an id the model passed back refers to. `un1t:<id>` is un1t.online;
 * anything else non-empty passes through as Glofox, so Glofox ids and
 * `manual-…` ids behave exactly as they did before tagging existed. A
 * non-string, an empty string and a bare prefix are null (no id at all).
 */
export function parseAgentId(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  if (raw.startsWith(UN1T_ID_PREFIX)) {
    const id = raw.slice(UN1T_ID_PREFIX.length)
    return id ? { provider: 'un1t_online', id } : null
  }
  return { provider: 'glofox', id: raw }
}
