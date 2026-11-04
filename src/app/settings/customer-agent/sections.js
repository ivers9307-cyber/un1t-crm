// MIASETTINGS.2a — the sections of the Mia settings page. For now only
// sectionForPath (the unsaved-change dots and the save bar's holds need it);
// MIASETTINGS.2b adds the section list and the URL parsing here.

import { AGENT_FIELDS } from './fields'

// Every registry settings path and the section it lives in.
const PATH_SECTIONS = AGENT_FIELDS.flatMap((f) => f.paths.map((p) => [p, f.section]))

/**
 * The section a settings path belongs to, from the field registry: the
 * longest registry path that equals `path` or is a prefix of it at a dot
 * boundary ('cancellation_form.reason_labels.price' → cancellation,
 * 'quiet_hours.start' → overview). A whole object key whose registry fields
 * all sit in one section ('followups') maps there. Null when nothing matches.
 * @param {string} path
 * @returns {string|null} one of SECTION_KEYS, or null
 */
export function sectionForPath(path) {
  let best = null
  for (const [p, section] of PATH_SECTIONS) {
    if ((path === p || path.startsWith(`${p}.`)) && (!best || p.length > best.p.length)) best = { p, section }
  }
  if (best) return best.section
  const under = new Set(PATH_SECTIONS.filter(([p]) => p.startsWith(`${path}.`)).map(([, s]) => s))
  return under.size === 1 ? [...under][0] : null
}
