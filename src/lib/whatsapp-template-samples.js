// Meta message-template variable examples. Body and TEXT-header content with
// {{n}} placeholders require example (sample) values at CREATE time, or Meta
// rejects the template. Operators enter these in the template builder; these
// pure helpers turn them into Meta's example payload shape and validate them.

/** Distinct {{n}} variable indexes in a template string, ascending. */
export function extractVariableIndexes(text) {
  const out = new Set()
  for (const m of String(text ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    out.add(parseInt(m[1], 10))
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Meta BODY example object `{ body_text: [[s1, s2, ...]] }` (one example set,
 * one sample per variable in index order), or null when the body has no vars.
 */
export function buildBodyExample(bodyText, samples = {}) {
  const idxs = extractVariableIndexes(bodyText)
  if (!idxs.length) return null
  return { body_text: [idxs.map((i) => String(samples[i] ?? ''))] }
}

/**
 * Meta TEXT-HEADER example object `{ header_text: [s, ...] }`, or null when the
 * header text has no variables.
 */
export function buildHeaderTextExample(headerText, samples = {}) {
  const idxs = extractVariableIndexes(headerText)
  if (!idxs.length) return null
  return { header_text: idxs.map((i) => String(samples[i] ?? '')) }
}

/** Turn a Meta example array (`['Sarah', 'UN1T']`) into a `{1:'Sarah', 2:'UN1T'}` map. */
export function samplesFromExample(arr) {
  const out = {}
  if (Array.isArray(arr)) arr.forEach((v, i) => { out[i + 1] = String(v ?? '') })
  return out
}

/**
 * First missing/blank sample as a user-facing error string, or null when every
 * variable (body first, then header) has a non-empty sample.
 */
export function missingSampleError({ bodyText = '', headerText = '', bodySamples = {}, headerSamples = {} } = {}) {
  for (const i of extractVariableIndexes(bodyText)) {
    if (!String(bodySamples[i] ?? '').trim()) return `Add a sample value for body variable {{${i}}}`
  }
  for (const i of extractVariableIndexes(headerText)) {
    if (!String(headerSamples[i] ?? '').trim()) return `Add a sample value for header variable {{${i}}}`
  }
  return null
}
