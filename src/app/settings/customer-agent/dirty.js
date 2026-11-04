// MIASETTINGS.2a — unsaved changes on the Mia settings page. "Changed" means
// different from the snapshot of { settings, overridden } taken after the
// last load or save (spec, Saving). Pure: no React here.

import { sectionForPath } from './sections'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
// Blank text and no value read the same: a field typed into and emptied again
// is not an unsaved change.
const isBlank = (v) => v === null || v === undefined || v === ''

// Leaf paths of a settings object: objects descend, arrays and scalars are leaves.
function leaves(obj) {
  const out = new Map()
  const walk = (v, path) => {
    if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k)
    } else if (path) out.set(path, v)
  }
  walk(obj, '')
  return out
}

function sameValue(a, b) {
  if (isBlank(a) && isBlank(b)) return true
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  return Object.is(a, b)
}

/**
 * The settings paths whose value differs between two editor states, plus
 * `overridden:<path>` for each override that changed on a path whose value
 * did not (a "Use default" click that lands on the same value). Sorted.
 * @param {{ settings: object|null, overridden: string[] }|null} before
 * @param {{ settings: object|null, overridden: string[] }|null} after
 * @returns {string[]}
 */
export function changedPaths(before, after) {
  const a = leaves(before?.settings)
  const b = leaves(after?.settings)
  const out = new Set()
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    if (!sameValue(a.get(p), b.get(p))) out.add(p)
  }
  const oa = new Set(before?.overridden || [])
  const ob = new Set(after?.overridden || [])
  for (const p of new Set([...oa, ...ob])) {
    if (oa.has(p) !== ob.has(p) && !out.has(p)) out.add(`overridden:${p}`)
  }
  return [...out].sort()
}

/**
 * The sections holding these unsaved changes (the menu's dots).
 * @param {string[]} paths  changedPaths' result
 * @returns {Set<string>} section keys
 */
export function dirtySections(paths) {
  const out = new Set()
  for (const p of paths) {
    const section = sectionForPath(p.startsWith('overridden:') ? p.slice('overridden:'.length) : p)
    if (section) out.add(section)
  }
  return out
}
