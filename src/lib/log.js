// Thin structured logger. Preserves the readable `[module] msg`
// shape that 100+ console.warn call-sites already use, while
// emitting JSON-shaped lines in production so Sentinel (or any
// log shipper) can match on `module` / `event` / `level` instead
// of regexping prose.
//
// Why this exists
//   • Sentinel watches Vercel runtime logs for structured signals.
//     Free-text console.error has been adding noise without telling
//     us *what* failed.
//   • A typo in a category prefix (`[sequencs]`) silently breaks
//     anyone grep'ing for that module's errors. A typed export
//     surface fails at lint/test time instead.
//
// Shape
//   logWarn('sequences', 'booking trigger failed', { bookingId, err })
//
//   • module — short stable name; matches the prefix convention
//     already used in the codebase. Sentinel keys signals by
//     module, so don't free-form it.
//   • message — human prose; keep short, no PII.
//   • meta    — any JSON-serialisable object. Errors are flattened
//     to { name, message, stack } so they survive JSON.stringify,
//     plus code/details/hint when the error carries them (a
//     PostgrestError does — see flattenError).
//
// In dev (NODE_ENV !== 'production'): emits exactly what
// console.warn would have, so existing terminal flow is unchanged.
//
// In prod: emits a single JSON line per call, structured for log
// shippers. ts/level/module/msg are always at the top level.

const IS_PROD = process.env.NODE_ENV === 'production'

/** @typedef {'info' | 'warn' | 'error'} Level */

function flattenError(err) {
  if (!err) return undefined
  if (err instanceof Error) {
    // supabase-js's PostgrestError EXTENDS Error, so it lands HERE, not in
    // the flat-object branch below — and this used to reduce it to
    // name/message/stack, throwing away the only fields that say WHICH
    // failure it was. In production a 23505 (duplicate key) was
    // indistinguishable from a 42703 (undefined column), which matters now
    // that MAILFIX-GUARDRAILS.1 (#1588) turned eight silent mail writes
    // into log-and-continue sites where this line is the only signal.
    // Carried only when present, so a plain Error's shape is unchanged and
    // anything parsing these lines keeps working.
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details ? { details: err.details } : {}),
      ...(err.hint ? { hint: err.hint } : {}),
    }
  }
  // Already-flat shapes (e.g. a hand-built {code, message}) survive as-is.
  if (typeof err === 'object') return err
  return { message: String(err) }
}

function flattenMeta(meta) {
  if (!meta || typeof meta !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'err' || k === 'error') {
      out[k] = flattenError(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function emit(level, module, message, meta) {
  const flat = flattenMeta(meta)
  if (IS_PROD) {
    // JSON line. Vercel preserves stdout/stderr; Sentinel can pick
    // these up by `level` and `module`. We don't try to dedupe here
    // — that's the watcher's job.
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      module,
      msg: message,
      ...flat,
    })
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
    return
  }
  // Dev: keep the existing prose shape. If meta is non-empty,
  // append it so the developer can see the bag without ceremony.
  const head = `[${module}] ${message}`
  const tail = Object.keys(flat).length ? flat : undefined
  if (level === 'error') tail ? console.error(head, tail) : console.error(head)
  else if (level === 'warn') tail ? console.warn(head, tail) : console.warn(head)
  else tail ? console.log(head, tail) : console.log(head)
}

/**
 * Informational — the kind of thing you'd put behind a debug flag
 * but that's useful in production for context.
 *
 * @param {string} module
 * @param {string} message
 * @param {Record<string, any>} [meta]
 */
export function logInfo(module, message, meta) {
  emit('info', module, message, meta)
}

/**
 * Warning — recoverable / best-effort path failed but the request
 * itself succeeded. Almost every existing console.warn maps here.
 *
 * @param {string} module
 * @param {string} message
 * @param {Record<string, any>} [meta]
 */
export function logWarn(module, message, meta) {
  emit('warn', module, message, meta)
}

/**
 * Error — request-fatal or "this needs human attention". Sentinel
 * weights these higher than warns when computing alerting cadence.
 *
 * @param {string} module
 * @param {string} message
 * @param {Record<string, any>} [meta]
 */
export function logError(module, message, meta) {
  emit('error', module, message, meta)
}
