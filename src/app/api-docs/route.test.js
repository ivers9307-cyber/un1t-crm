import { describe, it, expect } from 'vitest'
import { GET } from './route.js'

describe('GET /api-docs', () => {
  it('renders a Swagger UI page with a CRM + Champ App switcher', async () => {
    const res = await GET()
    const html = await res.text()
    expect(html).toContain('swagger-ui')
    expect(html).toContain("name: 'UN1T CRM'")
    expect(html).toContain("name: 'Champ App'")
    expect(html).toContain('/api/openapi.json')
    expect(html).toContain('app.champfitness.ie/api/openapi.json')
  })
})
