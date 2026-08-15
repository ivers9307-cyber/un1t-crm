// PRUNE.1 — the config-level redirects that replaced the deleted legacy
// stub pages. Invariants: every source a deleted stub used to serve still
// redirects, to the same target the stub had (DELETED_STUB_SOURCES below
// is hand-maintained bookkeeping, not derived from git — it is only as
// complete as whoever last updated it), every destination is canonical
// (never lands on another retired tree, or the chain the stubs were
// deleted to kill comes back), and specific rules precede their prefix
// wildcard (next.config redirects are first-match-wins).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import legacyRedirects from '../../legacy-redirects.js'

const RETIRED_PREFIXES = ['/email', '/whatsapp', '/segments']

// The 27 stub routes deleted in PRUNE.1b, exactly as they existed on disk
// (dynamic segments written :id to match the redirect-rule syntax). If a
// future task deletes another redirect page, its route belongs in BOTH
// this list and legacy-redirects.js — that is the 1:1 contract.
const DELETED_STUB_SOURCES = [
  '/email',
  '/email/templates',
  '/email/sequences',
  '/email/sequences/new',
  '/email/sequences/:id',
  '/email/campaigns/new',
  '/email/campaigns/:id',
  '/whatsapp',
  '/whatsapp/templates',
  '/whatsapp/broadcasts',
  '/whatsapp/broadcasts/new',
  '/whatsapp/broadcasts/:id',
  '/whatsapp/inbox',
  '/segments',
  '/cars',
  '/cars/new',
  '/cars/pending',
  '/contacts/duplicates',
  '/communications/broadcasts',
  '/communications/campaigns',
  '/communications/instagram',
  '/communications/sequences',
  '/communications/sequences/:id',
  '/communications/sequences/templates',
  '/communications/sms/broadcasts',
  '/communications/sms/broadcasts/new',
  '/communications/sms/broadcasts/:id',
  // HUBS.2b — moved, not deleted (/admin/hyrox -> /hyrox), but listed
  // here anyway so the "never regains a page" guard below covers it
  // too, per this file's own header contract (every redirect source
  // gets a reverse-check, not just the PRUNE.1b deletions).
  '/admin/hyrox',
  // HUBS.2d — moved, not deleted (/admin/contracts -> /contracts, hub
  // member of the Team hub); listed for the same reverse-check reason.
  '/admin/contracts',
]

describe('legacy-redirects', () => {
  it('every entry is well-formed and non-permanent', () => {
    expect(legacyRedirects.length).toBeGreaterThan(0)
    for (const r of legacyRedirects) {
      expect(r.source).toMatch(/^\//)
      expect(r.destination).toMatch(/^\//)
      expect(r.permanent).toBe(false)
    }
  })

  it('every route in the recorded deletion list has a redirect rule', () => {
    const sources = new Set(legacyRedirects.map(r => r.source))
    for (const stub of DELETED_STUB_SOURCES) {
      expect(sources.has(stub), `deleted stub ${stub} has no redirect rule`).toBe(true)
    }
  })

  it('no recorded deleted stub still resolves to a real page under src/app', () => {
    // Guards the bookkeeping from the other direction: if a route in
    // DELETED_STUB_SOURCES ever gains (or regains) a page.js, either the
    // deletion never happened or the list is stale — both are bugs.
    // NOTE: this cannot catch a deleted page that was never added to the
    // list; a green run here is not proof of completeness.
    for (const stub of DELETED_STUB_SOURCES) {
      const rel = stub.replace(/:id$/, '[id]')
      const candidates = [
        path.join(process.cwd(), 'src/app', rel, 'page.js'),
        path.join(process.cwd(), 'src/app', rel, 'page.jsx'),
      ]
      for (const f of candidates) {
        expect(fs.existsSync(f), `${stub} still has a page at ${f}`).toBe(false)
      }
    }
  })

  it('never redirects into a retired tree (no chains)', () => {
    const exactSources = new Set(
      legacyRedirects.filter(r => !r.source.includes(':')).map(r => r.source)
    )
    for (const r of legacyRedirects) {
      const destPath = r.destination.split('?')[0]
      for (const prefix of RETIRED_PREFIXES) {
        expect(destPath === prefix || destPath.startsWith(`${prefix}/`),
          `${r.source} → ${r.destination} lands in retired tree ${prefix}`).toBe(false)
      }
      expect(exactSources.has(destPath),
        `${r.source} → ${r.destination} lands on another rule's source (chain)`).toBe(false)
    }
  })

  it('lists specific rules before their prefix wildcard', () => {
    for (const [i, r] of legacyRedirects.entries()) {
      if (!r.source.includes(':path*')) continue
      const prefix = r.source.replace('/:path*', '')
      for (let j = i + 1; j < legacyRedirects.length; j++) {
        expect(legacyRedirects[j].source.startsWith(`${prefix}/`),
          `${legacyRedirects[j].source} is shadowed by earlier wildcard ${r.source}`).toBe(false)
      }
    }
  })
})
