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
