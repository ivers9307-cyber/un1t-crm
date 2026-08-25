import { describe, it, expect, afterEach, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('GET /api-docs', () => {
  it('renders a Swagger UI page with a CRM + Champ App switcher', async () => {
    const { GET } = await import('./route.js')
    const res = await GET()
    const html = await res.text()
    expect(html).toContain('swagger-ui')
    expect(html).toContain("name: 'Repset CRM'")
    expect(html).toContain("name: 'Champ App'")
    expect(html).toContain('/api/openapi.json')
    // Default champ spec host until Stage 2 flips CHAMP_OPENAPI_URL to api.repset.ie
    expect(html).toContain('https://app.champfitness.ie/api/openapi.json')
  })
  it('lets CHAMP_OPENAPI_URL override the champ spec URL (Phase 6 host flip)', async () => {
    vi.stubEnv('CHAMP_OPENAPI_URL', 'https://api.repset.ie/api/openapi.json')
    vi.resetModules()
    const { GET } = await import('./route.js')
    const html = await (await GET()).text()
    expect(html).toContain('https://api.repset.ie/api/openapi.json')
    expect(html).not.toContain('app.champfitness.ie')
  })
})
