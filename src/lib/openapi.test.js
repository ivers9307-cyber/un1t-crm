import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { getOpenApiSpec } from './openapi.js'

// RETIRE.2 — the spec documents exactly the routes that accept a
// per-organisation `unitk_` API key. This table is that surface; a route that
// gains or loses the API-key path changes it, its openapi.js entry and the
// route file together.
const API_KEY_SURFACE = {
  '/api/contacts': ['post'],
  '/api/contacts/{id}': ['get', 'put'],
  '/api/stages': ['get'],
  '/api/tasks': ['get', 'post'],
  '/api/tasks/{id}': ['delete', 'get', 'patch'],
  '/api/bookings': ['get'],
  '/api/bookings/{id}': ['put'],
  '/api/bookings/event-types': ['get', 'post'],
  '/api/bookings/event-types/{id}': ['delete', 'get', 'put'],
  '/api/campaigns': ['get', 'post'],
  '/api/campaigns/{id}': ['delete', 'get', 'put'],
  '/api/locations': ['get'],
  '/api/locations/{id}/integrations': ['get', 'put'],
}

const ROOT = process.cwd()
const routeFile = (p) => path.join(ROOT, 'src/app', p.replace(/\{(\w+)\}/g, '[$1]'), 'route.js')
const HTTP = ['get', 'post', 'put', 'patch', 'delete']

describe('getOpenApiSpec', () => {
  let spec
  beforeAll(async () => {
    spec = await getOpenApiSpec()
  })

  it('produces a 3.1 spec with the expected info block', () => {
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBe('Repset CRM API')
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // REPSET-P6.S2 — canonical host leads the server list; the legacy host
  // stays listed second so existing integrations keep a documented base.
  it('lists the canonical repset host first and the legacy host second', () => {
    expect(spec.servers[0].url).toBe('https://crm.repset.ie')
    expect(spec.servers.map((s) => s.url)).toContain('https://crm.un1tdublin.com')
  })

  it('declares the API-key and session auth schemes', () => {
    expect(spec.components.securitySchemes).toHaveProperty('BearerAuth')
    expect(spec.components.securitySchemes).toHaveProperty('CookieAuth')
  })

  it('documents exactly the API-key surface', () => {
    const documented = Object.fromEntries(
      Object.entries(spec.paths).map(([p, ops]) => [p, Object.keys(ops).filter((k) => HTTP.includes(k)).sort()]),
    )
    expect(documented).toEqual(API_KEY_SURFACE)
  })

  it('every documented operation accepts a Bearer API key', () => {
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const [verb, op] of Object.entries(ops)) {
        expect(op.security, `${verb} ${p}`).toContainEqual({ BearerAuth: [] })
      }
    }
  })

  it('every documented operation is a live handler that takes an API key', () => {
    for (const [p, verbs] of Object.entries(API_KEY_SURFACE)) {
      const file = routeFile(p)
      expect(existsSync(file), file).toBe(true)
      const src = readFileSync(file, 'utf8')
      expect(src, file).toMatch(/(authenticateApiKey|requireApiKeyOrManager)\(/)
      for (const v of verbs) {
        expect(src, `${v.toUpperCase()} in ${file}`).toMatch(new RegExp(`export async function ${v.toUpperCase()}\\b`))
      }
    }
  })

  it('no longer documents the retired Pipedrive-era routes', () => {
    for (const p of ['/api/activities', '/api/notes', '/api/deals', '/api/deals/{id}', '/api/deals/search', '/api/contacts/search']) {
      expect(spec.paths, p).not.toHaveProperty(p)
    }
    expect(spec.paths['/api/contacts']).not.toHaveProperty('get')
  })

  it('captures the component schemas the routes use', () => {
    for (const name of [
      'ErrorResponse', 'Contact', 'ContactCreate', 'ContactUpdate',
      'TaskCreate', 'TaskUpdate', 'BookingUpdate', 'EventTypeCreate', 'EventTypeUpdate',
      'CampaignCreate', 'CampaignUpdate', 'IntegrationsUpdate',
    ]) {
      expect(spec.components.schemas, `missing schema: ${name}`).toHaveProperty(name)
    }
  })

  // REVIEWNITS.1 (D5): contact create refuses a location outside the key's
  // organisation, or one a cookie caller is not a member of (403); update
  // answers 404 for an unknown id and 503 when the contact could not be read.
  it('documents the contact create 403 and the update 404/503', () => {
    expect(spec.paths['/api/contacts'].post.responses).toHaveProperty('403')
    const put = spec.paths['/api/contacts/{id}'].put.responses
    for (const code of ['401', '404', '503']) expect(put, code).toHaveProperty(code)
  })

  it('caches the spec object across calls (same reference)', async () => {
    expect(await getOpenApiSpec()).toBe(spec)
  })

  it('serialises to valid JSON without circular refs', () => {
    expect(() => JSON.stringify(spec)).not.toThrow()
  })
})
