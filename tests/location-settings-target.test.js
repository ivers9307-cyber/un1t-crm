// ACDEVLOC.1 — the per-location settings page acts on the location in its
// URL, so every API call its components make must name that location. A
// floor, not a proof (the check:select-columns posture).
//
// The AC devices tab lives on /settings/locations/<id> but listed, discovered
// and added units through /api/studio-management/ac/*, which act on the
// caller's ACTIVE studio (withAuth's locationId). Each of those routes was
// right on its own terms, so neither server guard (role-at-path.test.js,
// role-at-target.test.js) could see it: the mismatch was between a page's URL
// and the route its component called.
//
// Rule: start at src/app/settings/locations/[id]/page.js and follow every
// component import (the `@/components/…` alias, and relative imports that land
// under src/components). In every file reached, a fetch() of an /api path must
// be `/api/locations/${…}/…` (the target is in the path), or its path must be
// in REVIEWED with the reason it names the location another way (query or
// body). A fetch whose URL is a variable or starts with `${…}` must be in
// REVIEWED_DYNAMIC. External URLs (http…) are ignored. The lists are exact: an
// entry that no longer matches FAILS.
//
// BLIND SPOTS (a reviewer's job): a call through a wrapper other than fetch()
// (only the wrapper's inner fetch(url) is seen, hence REVIEWED_DYNAMIC),
// navigation (href, window.location, a form action), a component reached
// through a dynamic import or passed as a prop, and whether a listed route
// really scopes to the location it is given (role-at-target's job).

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const PAGE = 'src/app/settings/locations/[id]/page.js'
const IMPORT_RE = /\bfrom\s+['"](@\/components\/[^'"]+|\.{1,2}\/[^'"]+)['"]/g
const FETCH_RE = /\bfetch\(\s*(?:([`'"])((?:(?!\1)[\s\S])*?)\1|([A-Za-z_$][\w$.]*))/g

// An /api path (query stripped) that is not /api/locations/${…} but names the
// location in its query or body. Checked 28 Sep 2026 against origin/main.
const REVIEWED = {
  '/api/locations': 'LocationForm create mode only (POST /api/locations makes a NEW location); on this page the form is in edit mode and saves through RLS.',
  '/api/settings/branding': 'BrandingSettings and SignatureLinksCard pass location_id (query on GET, body on PUT); the route falls back to the active studio only when it is absent.',
  '/api/settings/branding/upload': 'BrandingSettings appends location_id to the FormData; the route judges membership + guardMasterOrOwner at it.',
  '/api/settings/org-branding': 'Organisation-level: OrgBrandingSettings passes organization_id (query on GET, body on PUT).',
  '/api/settings/ads': 'AdsIntegrationTab passes locationId (query on GET, body on both PUTs).',
  '/api/settings/ads/test': 'AdsIntegrationTab passes locationId in the body; the route asserts membership at it.',
  '/api/whatsapp/conversational-automation': 'WhatsAppIntegrationTab passes location_id in the body (required by its schema).',
  '/api/whatsapp/card-sets': 'WhatsAppIntegrationTab passes location_id in the body (required by its schema).',
  '/api/whatsapp/templates/upload-media/sign': 'The carousel image uploader passes location_id in the body.',
  '/api/whatsapp/templates/upload-media': 'The carousel image uploader passes location_id in the body.',
  '/api/xero/disconnect': 'XeroLocationCard passes location_id in the body.',
  '/api/xero/select-tenant': 'XeroLocationCard passes location_id (query on GET, body on POST).',
}

// `file :: expression` for a fetch whose URL is not a literal.
const REVIEWED_DYNAMIC = {
  'src/components/customer-agent/ConnectionsSection.jsx :: url': 'url is `/api/locations/${locationId}/channels[/${igConn.id}]`, built on the lines above the fetch.',
  'src/components/settings/EmailMailboxesCard.jsx :: url': 'fetch(url) inside send(); every send() call passes `/api/locations/${locationId}/email/…`.',
}

// ACDEVLOC.1 owns these and its Task 7 deletes them. Never add to this list.
const PENDING_ACDEVLOC = [
  'src/components/settings/integrations/AcDevicesIntegrationTab.jsx :: /api/studio-management/ac/devices',
  'src/components/settings/integrations/AcDevicesIntegrationTab.jsx :: /api/studio-management/ac/devices/${deviceId}',
  'src/components/settings/integrations/AcDevicesIntegrationTab.jsx :: path',
]

function resolveImport(spec, fromFile) {
  const base = spec.startsWith('@/') ? path.join('src', spec.slice(2)) : path.join(path.dirname(fromFile), spec)
  if (!base.startsWith(path.join('src', 'components'))) return null
  for (const ext of ['', '.jsx', '.js', '/index.jsx', '/index.js']) {
    const rel = base + ext
    const abs = path.join(ROOT, rel)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel
  }
  return null
}

function reachableFiles() {
  const seen = new Set([PAGE])
  const queue = [PAGE]
  while (queue.length) {
    const file = queue.shift()
    const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    for (const m of src.matchAll(IMPORT_RE)) {
      const hit = resolveImport(m[1], file)
      if (hit && !seen.has(hit)) { seen.add(hit); queue.push(hit) }
    }
  }
  seen.delete(PAGE)
  return [...seen].sort()
}

// [{ kind: 'api', path }] for a literal /api URL that does not start with
// /api/locations/${…}; [{ kind: 'dynamic', text }] for anything not literal.
function fetchTargets(src) {
  const out = []
  for (const m of stripComments(src).matchAll(FETCH_RE)) {
    if (m[3]) { out.push({ kind: 'dynamic', text: m[3] }); continue }
    const url = m[2]
    if (/^https?:\/\//.test(url)) continue
    if (url.startsWith('/api/locations/${')) continue
    if (url.startsWith('/api/')) { out.push({ kind: 'api', path: url.split('?')[0] }); continue }
    out.push({ kind: 'dynamic', text: url })
  }
  return out
}

function findings() {
  const out = new Set()
  for (const file of reachableFiles()) {
    for (const t of fetchTargets(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      out.add(`${file} :: ${t.kind === 'api' ? t.path : t.text}`)
    }
  }
  return [...out].sort()
}

describe('the scan', () => {
  it('reads literal, multi-line and dynamic fetches; skips comments, externals and path-scoped calls', () => {
    expect(fetchTargets("fetch('/api/studio-management/ac/devices', {})")).toEqual([{ kind: 'api', path: '/api/studio-management/ac/devices' }])
    expect(fetchTargets('fetch(\n  `/api/settings/ads?locationId=${id}`\n)')).toEqual([{ kind: 'api', path: '/api/settings/ads' }])
    expect(fetchTargets('fetch(path, { cache: "no-store" })')).toEqual([{ kind: 'dynamic', text: 'path' }])
    expect(fetchTargets('fetch(`${base}/x`)')).toEqual([{ kind: 'dynamic', text: '${base}/x' }])
    expect(fetchTargets('fetch(`/api/locations/${location.id}/ac-devices?include_disabled=1`)')).toEqual([])
    expect(fetchTargets("fetch('https://nominatim.openstreetmap.org/search?q=x')")).toEqual([])
    expect(fetchTargets("// fetch('/api/studio-management/ac/devices')")).toEqual([])
  })

  it('reaches the integrations tabs through LocationIntegrations (a wrong root finds nothing)', () => {
    const files = reachableFiles()
    expect(files.length).toBeGreaterThan(30) // 43 on 28 Sep 2026
    expect(files).toContain('src/components/settings/LocationIntegrations.jsx')
    expect(files).toContain('src/components/settings/integrations/AcDevicesIntegrationTab.jsx')
  })
})

describe('/settings/locations/[id] components call only APIs that name the location', () => {
  const found = findings()
  const isReviewed = (f) => {
    const [, rest] = f.split(' :: ')
    return rest in REVIEWED || f in REVIEWED_DYNAMIC
  }

  it('no call outside the lists', () => {
    expect(found.filter((f) => !isReviewed(f) && !PENDING_ACDEVLOC.includes(f))).toEqual([])
  })

  it('every PENDING entry still matches (a fixed call leaves the list)', () => {
    expect(PENDING_ACDEVLOC.filter((p) => !found.includes(p))).toEqual([])
  })

  it('every REVIEWED entry still matches and has a reason (else delete it)', () => {
    const paths = new Set(found.map((f) => f.split(' :: ')[1]))
    expect(Object.keys(REVIEWED).filter((p) => !paths.has(p))).toEqual([])
    expect(Object.keys(REVIEWED_DYNAMIC).filter((k) => !found.includes(k))).toEqual([])
    for (const reason of [...Object.values(REVIEWED), ...Object.values(REVIEWED_DYNAMIC)]) {
      expect(reason.length).toBeGreaterThan(20)
    }
  })
})
