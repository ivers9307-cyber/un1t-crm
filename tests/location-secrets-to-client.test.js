// SECFIX.3a guard. A `locations` row read with `*` carries six stored
// credentials (src/lib/location-secrets.js). Every such read in src/,
// shared/ and mobile/ is on the exact list below, with what happens to the
// row. A new one, a changed count, or a stale entry fails. The list can only
// shrink by deletion (the role-at-target posture).
//
//   redacted     the file references a redaction function
//                (redactLocationSecrets / redactProfileLocations /
//                toClientLocation) before the rows
//                reach a client component or a JSON response
//   server-only  the rows never leave the server (reason given)
//   api-key-json the rows ARE returned as JSON, but only to an API-key
//                holder (never a browser session), by design (reason given)
//   (pending-3b, the disposition for "still crosses today", was emptied by
//   SECFIX.3b and removed, so no entry can take it again)
//
// A floor, not a proof: a select string built at runtime is invisible here.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

// src/lib/auth.js is NOT here: after Task 3a-2 getCurrentUser names
// USER_LOCATION_COLUMNS, so a star-read reappearing there fails this guard.
// The two /settings/staff pages are NOT here: STAFFFORMSETTINGS.1 names their columns (loadStaffFormLocations).
// The staff API, its POST echo and /admin/matrix are NOT here: STAFFPROFILEPICK.1 names their columns (src/lib/staff-fields.js, USER_LOCATION_COLUMNS).
export const STAR_READS = {
  'src/app/api/staff/[id]/route.js': { count: 3, disposition: 'server-only', why: 'PUT targetBefore (UniFi revoke/sync via getUnifiConfig) and refreshed (role recompute), and the DELETE read (UniFi revoke); the PUT response re-reads STAFF_MANAGED_SELECT (CLIENT_LOCATION_COLUMNS embed)' },
  'src/app/api/staff/[id]/permanent/route.js': { count: 1, disposition: 'server-only', why: 'master-only; the embed feeds the UniFi revoke; the response is the tombstone RPC result' },
  'src/app/settings/page.js': { count: 1, disposition: 'server-only', why: 'server-rendered list (name, address, slug, active); no client component receives the rows' },
  'src/app/settings/locations/[id]/page.js': { count: 1, disposition: 'redacted' },
}

const PATTERNS = [
  // embed locations(*) / locations(*, …), hinted locations!fk(*) /
  // locations!inner(*), and any alias in front (location:locations(*))
  /\blocations(?:!\w+)?\s*\(\s*\*\s*[,)]/g,
  // an embed through the FK COLUMN: location_id(*), x:location_id(*),
  // locations:location_id!inner(*)
  /\blocation_id(?:!\w+)?\s*\(\s*\*\s*[,)]/g,
  // from('locations').select('*') and select('*, …')
  /from\(\s*['"`]locations['"`]\s*\)\s*\.select\(\s*['"`]\s*\*\s*[,'"`]/g,
  /from\(\s*['"`]locations['"`]\s*\)[^;]{0,200}?\.select\(\s*\)/g, // from('locations')….select()
]
const REDACTORS = /\b(redactLocationSecrets|redactProfileLocations|toClientLocation)\b/

// A redactor must be USED, not merely imported or named in a comment: both
// of those survive deleting the call that does the work.
export function usesRedactor(text) {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1') // line comments (not a URL's //)
    .replace(/^\s*import\b[\s\S]*?\bfrom\s*['"][^'"]+['"];?/gm, '') // import statements
  return REDACTORS.test(code)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(m?js|jsx)$/.test(name) && !/\.test\.(m?js|jsx)$/.test(name)) out.push(full)
  }
  return out
}

export function countStarReads(text) {
  return PATTERNS.reduce((n, p) => n + [...text.matchAll(p)].length, 0)
}

describe('every star-read of locations is reviewed (SECFIX.3a)', () => {
  const found = {}
  for (const file of ['src', 'shared', 'mobile'].flatMap((d) => walk(path.join(ROOT, d)))) {
    const n = countStarReads(readFileSync(file, 'utf8'))
    if (n) found[path.relative(ROOT, file)] = n
  }

  it('the files and counts are exactly the reviewed list', () => {
    const listed = Object.fromEntries(Object.entries(STAR_READS).map(([f, e]) => [f, e.count]))
    expect(found, 'a new or changed star-read of locations: name the columns, or redact and add it here').toEqual(listed)
  })

  it.each(Object.entries(STAR_READS).filter(([, e]) => e.disposition === 'redacted'))('%s redacts before the rows leave the server', (file) => {
    expect(usesRedactor(readFileSync(path.join(ROOT, file), 'utf8'))).toBe(true)
  })

  it('every entry has a known disposition, and every non-redacted one says why', () => {
    for (const [file, e] of Object.entries(STAR_READS)) {
      expect(['redacted', 'server-only', 'api-key-json'], file).toContain(e.disposition)
      if (e.disposition !== 'redacted') expect(e.why, file).toBeTruthy()
    }
  })

  it('the counter sees each form', () => {
    expect(countStarReads(`select('*, profile_locations(*, locations(*))')`)).toBe(1)
    expect(countStarReads(`db.from('locations').select('*').eq('active', true)`)).toBe(1)
    expect(countStarReads(`db\n  .from('locations')\n  .select('*')`)).toBe(1)
    expect(countStarReads(`db.from('locations').update(p).eq('id', x).select().single()`)).toBe(1)
    expect(countStarReads(`db.from('locations').select('id, name')`)).toBe(0)
    expect(countStarReads(`locations(id, name)`)).toBe(0)
  })

  // Review N2 — the star forms the first cut missed.
  it('the counter sees a star with more columns, hinted embeds and FK-column embeds', () => {
    expect(countStarReads(`db.from('locations').select('*, organizations(name)')`)).toBe(1)
    expect(countStarReads(`db.from("locations").select("*,features")`)).toBe(1)
    expect(countStarReads(`db\n  .from('locations')\n  .select(\`\n    *, organizations(name)\`)`)).toBe(1)
    expect(countStarReads(`select('id, locations!profile_locations_location_id_fkey(*)')`)).toBe(1)
    expect(countStarReads(`select('id, locations!inner(*, organizations(name))')`)).toBe(1)
    expect(countStarReads(`select('id, locations(*, organizations(name))')`)).toBe(1)
    expect(countStarReads(`select('id, location:location_id(*)')`)).toBe(1)
    expect(countStarReads(`select('id, locations:location_id(*)')`)).toBe(1)
    expect(countStarReads(`select('id, loc:location_id!inner(*)')`)).toBe(1)
    expect(countStarReads(`select('id, location_id(*)')`)).toBe(1)
    expect(countStarReads(`select('id, location:locations!fk(*)')`)).toBe(1)
    // and still not the named forms
    expect(countStarReads(`select('id, location:location_id(id, name)')`)).toBe(0)
    expect(countStarReads(`select('id, locations!inner(id, name)')`)).toBe(0)
    expect(countStarReads(`select('*, profile_locations(location_id)')`)).toBe(0)
    expect(countStarReads(`db.from('locations_audit').select('*')`)).toBe(0)
  })

  it('an import or a comment alone is not a redaction', () => {
    expect(usesRedactor(`const rows = (data || []).map(redactLocationSecrets)`)).toBe(true)
    expect(usesRedactor(`return { data: redactProfileLocations(final) }`)).toBe(true)
    expect(usesRedactor(`import { redactLocationSecrets } from '@/lib/location-secrets'\nconst rows = data`)).toBe(false)
    expect(usesRedactor(`import {\n  redactLocationSecrets,\n} from '@/lib/location-secrets'\nconst rows = data`)).toBe(false)
    expect(usesRedactor(`// rows go through redactLocationSecrets\nconst rows = data`)).toBe(false)
    expect(usesRedactor(`/* toClientLocation */ const u = 'https://x.example'`)).toBe(false)
  })
})
