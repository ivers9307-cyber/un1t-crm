// PAGES.1 — test helper: every top-level route segment under src/app, route
// groups "(name)" walked, so the reserved-slug list in src/lib/page-slug.js can
// be proven complete against the real app tree. Node-only (fs), which is why it
// lives here and not in the module the editor bundles for the browser.
import fs from 'node:fs'
import path from 'node:path'

export function appRouteSegments(appDir) {
  const out = new Set()
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (/^\(.+\)$/.test(name)) { walk(path.join(dir, name)); continue }
      if (name.startsWith('[') || name.startsWith('_') || name.startsWith('.')) continue
      out.add(name)
    }
  }
  walk(appDir)
  return [...out].sort()
}
