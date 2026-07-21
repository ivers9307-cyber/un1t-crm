// Normalise operator-typed links. People type bare domains
// ("un1tdublin.com/start") but Meta's cta_url and zod's .url() both need a
// scheme. Prefix https:// when no scheme is present; leave anything that
// already carries a scheme (http, https, or otherwise) untouched so genuinely
// invalid values still fail validation loudly instead of being mangled.
export function normalizeUrlish(value) {
  const s = String(value || '').trim()
  if (!s) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`
}

// Validate an untrusted post-login / post-action redirect target before it is
// handed to router.push()/window.location. Only same-origin, root-relative
// paths are allowed; anything that could navigate off-origin or execute a
// scheme (protocol-relative "//host", "https://", "javascript:", backslash
// tricks browsers normalise to "//", or control/whitespace smuggling) falls
// back to `fallback` (default "/"). Mirrors the guard at
// src/app/api/assistant/chat/route.js navigate_user, centralised so every
// caller shares one hardened implementation. See docs/LESSONS.md.
export function safeInternalPath(value, fallback = '/') {
  const s = String(value ?? '')
  if (s === '') return fallback
  // Whitespace, control chars and backslashes are either malformed or used to
  // slip past naive startsWith checks (browsers strip/normalise them).
  if (/[\s\x00-\x1F\x7F\\]/.test(s)) return fallback
  if (!s.startsWith('/')) return fallback // must be root-relative
  if (s.startsWith('//')) return fallback // protocol-relative → off-origin
  return s
}
