// tests/location-settings-writers.test.js
// SETTINGSWIPE.1 — locations.settings is one jsonb column holding every
// per-location config slice (Glofox credentials, UniFi, the CAPI token, the
// WhatsApp Flow, InBody, Mia…). Seven routes wiped it on a failed read: they
// read it with the error discarded (an id-pinned .single(), which
// guardrails/no-discarded-single-error deliberately exempts) and wrote
// `{ ...(loc?.settings || {}), key }` back.
//
// Rule: a file that writes `settings` on `locations` either goes through
// mergeLocationSettings (src/lib/location-settings.js), or is listed in
// REVIEWED with the reason its read is judged. A NEW writer fails this test
// until someone decides; a REVIEWED entry that stops writing fails too.
//
// A FLOOR, NOT A PROOF: it matches `.update({ … settings … })` and
// `update: { settings` in a file that names the locations table. A payload
// built in a variable (`.update(patch)`) is invisible, and so is a whole-column
// write through `.upsert(` or `.insert(`. The helper itself is exempt by name
// (HELPER below) and is its own contract (src/lib/location-settings.test.js).

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const NAMES_LOCATIONS = /from\(\s*['"]locations['"]\s*\)/
const WRITES_SETTINGS = [/\.update\(\s*\{[^}]*?\bsettings\b/, /\bupdate:\s*\{\s*settings\b/]
const code = (p) => stripComments(readFileSync(p, 'utf8'))

// file → why its read-merge-write is safe from the wipe. Each judges its read
// and writes NOTHING when it fails; what remains is the read-modify-write
// race, measured at 0 lost keys in 38 writes (28 Sep 2026).
export const REVIEWED = {
  'src/app/api/settings/ads/route.js': 'CHANNELREAD.1: recipients save 500s on a failed read, writes nothing.',
  'src/app/api/locations/[id]/comms-frequency-cap/route.js': 'read error → 404 before the write.',
  'src/app/api/locations/[id]/geofence-attendance/route.js': 'read error → 404 before the write.',
  'src/app/api/locations/[id]/integrations/route.js': 'a failed read leaves location null → 404 before the write.',
  'src/app/api/locations/[id]/integrations/[provider]/route.js': 'loadLocation: read error → 404 before applySlice.',
  'src/app/api/locations/[id]/stripe-connect/connect/route.js': 'readErr → 404 before the write.',
  'src/app/api/locations/[id]/stripe-connect/select/route.js': 'readErr → 404 before the write.',
  // SECFIX.3b removed the two browser writers (the Glofox and UniFi tabs):
  // they save through PUT /api/locations/[id]/integrations/[provider] above.
}

const HELPER = 'src/lib/location-settings.js'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx)$/.test(name) && !/\.test\./.test(name)) out.push(p)
  }
  return out
}
const rel = (p) => relative(repo, p).split('\\').join('/')
const writesSettings = (src) => NAMES_LOCATIONS.test(src) && WRITES_SETTINGS.some((re) => re.test(src))

export function undecidedWriters(root = repo) {
  const out = []
  for (const top of ['src', 'shared', 'mobile', 'scripts']) {
    const dir = join(root, top)
    if (!existsSync(dir)) continue
    for (const file of walk(dir)) {
      const r = rel(file)
      if (r === HELPER || REVIEWED[r]) continue
      if (writesSettings(code(file))) out.push(r)
    }
  }
  return out.sort()
}

describe('every writer of locations.settings goes through mergeLocationSettings', () => {
  it('no unreviewed whole-column writer', () => {
    expect(
      undecidedWriters(),
      'These files write locations.settings directly. A failed read there WIPES every other key ' +
      '(Glofox credentials, UniFi, CAPI…). Use mergeLocationSettings from src/lib/location-settings.js, ' +
      'or, if the read is judged and nothing is written on failure, add the file to REVIEWED with that reason. ' +
      'See docs/superpowers/plans/2026-09-27-followups/C23-SETTINGSWIPE.1.md.',
    ).toEqual([])
  })

  it('REVIEWED has no stale entries', () => {
    const stale = Object.keys(REVIEWED).filter((r) => {
      const p = join(repo, r)
      return !existsSync(p) || !writesSettings(code(p))
    })
    expect(stale, 'Remove these REVIEWED entries: the file no longer writes settings directly.').toEqual([])
  })

  it('the seven SETTINGSWIPE.1 routes use the helper', () => {
    for (const r of [
      'src/app/api/whatsapp/card-sets/route.js',
      'src/app/api/whatsapp/conversational-automation/route.js',
      'src/app/api/settings/customer-agent/route.js',
      'src/app/api/settings/scoring/route.js',
      'src/app/api/settings/status-page/route.js',
      'src/app/api/hyrox/settings/route.js',
      'src/app/api/hyrox/sessions/[id]/exemplar/route.js',
    ]) {
      expect(code(join(repo, r)), r).toMatch(/mergeLocationSettings\(/)
    }
  })
})
