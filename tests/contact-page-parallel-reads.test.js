// PROFILEFAST.1 — the contact profile page starts its independent reads
// together instead of one after another. Source scan of the server page (a
// floor, not a proof): after the acting studio is decided, the only reads
// still awaited in place are the ones that depend on an earlier answer
// (un1t_clients → its studios, inside the started un1t read; the per-studio
// consent read, which needs the memberships).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from './helpers/js-code.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const raw = stripComments(readFileSync(path.join(ROOT, 'src/app/(sales)/contacts/[id]/page.js'), 'utf8'))
const src = raw.replace(/\s+/g, ' ')
const afterActing = src.slice(src.indexOf('const actingId = pickActingStudio('))

describe('contact profile page reads (PROFILEFAST.1)', () => {
  it('the person group joins the first batch', () => {
    expect(src).toContain('const personP = (async () => {')
    expect(src.indexOf('const personP')).toBeLessThan(src.indexOf('await Promise.all(['))
    expect(src).toContain('const person = await personP')
  })

  it('single builders are started with Promise.resolve (a builder sends nothing until awaited)', () => {
    for (const t of ['event_types', 'glofox_memberships', 'contact_tags', 'whatsapp_templates']) {
      expect(afterActing).toContain(`Promise.resolve(db.from('${t}')`)
    }
  })

  it('no other read is awaited in place after the acting studio is known', () => {
    const inPlace = [...afterActing.matchAll(/await db\.from\('([a-z0-9_]+)'\)/g)].map((m) => m[1])
    expect(inPlace.sort()).toEqual(['contact_location_preferences', 'locations', 'un1t_clients'])
  })

  it('each started read is awaited where it is used', () => {
    for (const p of ['eventTypesP', 'catalogP', 'un1tP', 'tagRowsP', 'journeyP', 'seqEmailP', 'templatesP', 'consultReadsP', 'consultZoneP', 'bookingZonesP']) {
      expect(afterActing).toContain(`await ${p}`)
    }
  })
})
