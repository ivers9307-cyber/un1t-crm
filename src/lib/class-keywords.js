// Operator deny-list keyword parser, shared by the Glofox public listing
// (settings.glofox.hidden_class_keywords) and the un1t.online one
// (settings.un1t_online.hidden_class_keywords). Pure and dependency-free on
// purpose: it was lifted out of public-classes.js so light modules (the
// un1t.online settings reader) can use it without importing Glofox.
//
// Accepts a list or a comma / newline separated string; returns trimmed,
// lower-cased, non-empty keywords. Anything else is [].
export function parseHiddenKeywords(raw) {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : []
  return arr.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
}
