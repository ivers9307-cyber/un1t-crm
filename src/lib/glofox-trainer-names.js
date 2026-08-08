// STUDIO-KPI.4 — the operator-editable trainer-name map
// (settings.glofox.trainer_names: { <24-hex trainer id>: 'Name' }).
// The Glofox settings tab edits it as "trainerId = Name" lines; these
// pure helpers round-trip between that text and the stored map.
//
// Ids are stored lowercase — Glofox event payloads carry lowercase
// Mongo ObjectIds, and resolveTrainerNames looks overrides up
// case-insensitively either way.

const LINE_RE = /^\s*([0-9a-f]{24})\s*[=:]\s*(.+?)\s*$/i

/**
 * Parse "id = Name" (or "id: Name") lines into a map. Junk lines are
 * ignored. Returns null (not {}) when nothing parses so callers can
 * store "no mapping" as an absent key rather than an empty object.
 */
export function parseTrainerNames(text) {
  const map = {}
  for (const line of String(text || '').split('\n')) {
    const m = line.match(LINE_RE)
    if (m) map[m[1].toLowerCase()] = m[2]
  }
  return Object.keys(map).length ? map : null
}

/** Format a stored map back into "id = Name" lines for the textarea. */
export function formatTrainerNames(map) {
  if (!map || typeof map !== 'object') return ''
  return Object.entries(map)
    .filter(([, name]) => typeof name === 'string' && name.trim())
    .map(([id, name]) => `${id} = ${name.trim()}`)
    .join('\n')
}
