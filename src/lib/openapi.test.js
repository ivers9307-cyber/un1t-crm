import { describe, it, expect, beforeAll } from 'vitest'
import { getOpenApiSpec } from './openapi.js'

describe('getOpenApiSpec', () => {
  // getOpenApiSpec became async (mig of May 2026 wraps it in
  // unstable_cache so the spec survives lambda cold starts). The shape
  // of the resolved object hasn't changed.
  let spec
  beforeAll(async () => {
    spec = await getOpenApiSpec()
  })

  it('produces a 3.1 spec with the expected info block', () => {
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBe('UN1T CRM API')
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('declares both auth schemes', () => {
    expect(spec.components.securitySchemes).toHaveProperty('BearerAuth')
    expect(spec.components.securitySchemes).toHaveProperty('CookieAuth')
  })

  it('registers the high-traffic paths', () => {
    expect(spec.paths).toHaveProperty('/api/contacts')
    expect(spec.paths['/api/contacts']).toHaveProperty('get')
    expect(spec.paths['/api/contacts']).toHaveProperty('post')
    expect(spec.paths).toHaveProperty('/api/contacts/{id}')
    expect(spec.paths).toHaveProperty('/api/deals')
    expect(spec.paths).toHaveProperty('/api/staff')
    expect(spec.paths).toHaveProperty('/api/schedule/shifts')
    expect(spec.paths).toHaveProperty('/api/public/book')
  })

  it('public booking endpoint has no security requirement', () => {
    const op = spec.paths['/api/public/book'].post
    // No `security` key OR empty array means anonymous.
    expect(op.security ?? []).toHaveLength(0)
  })

  it('staff endpoints require cookie auth (browser-only)', () => {
    const op = spec.paths['/api/staff'].post
    expect(op.security).toContainEqual({ CookieAuth: [] })
  })

  it('captures every component schema we registered', () => {
    const schemas = spec.components.schemas
    for (const name of [
      'ContactCreate', 'ContactUpdate', 'Contact',
      'DealCreate', 'DealUpdate',
      'BookingCreate',
      'StaffCreate', 'StaffUpdate',
      'TimeOffRequest', 'TimeOffReview',
      'SwapCreate', 'SwapReview',
      'CampaignCreate',
      'ScheduledReport',
      'ErrorResponse',
    ]) {
      expect(schemas, `missing schema: ${name}`).toHaveProperty(name)
    }
  })

  it('caches the spec object across calls (same reference)', async () => {
    expect(await getOpenApiSpec()).toBe(spec)
  })

  it('serialises to valid JSON without circular refs', () => {
    expect(() => JSON.stringify(spec)).not.toThrow()
  })

  it('documents the public surface anonymously', () => {
    for (const p of [
      '/api/public/leads',
      '/api/public/branding',
      '/api/public/events/{slug}/register',
      '/api/public/bookings/{slug}/slots',
    ]) {
      expect(spec.paths, `missing ${p}`).toHaveProperty(p)
    }
    const op = spec.paths['/api/public/leads'].post
    expect(op.security ?? []).toHaveLength(0)
    expect(op.tags).toContain('Public')
  })

  it('documents inbound webhooks with provider auth', () => {
    for (const p of ['/api/webhooks/glofox', '/api/webhooks/whatsapp', '/api/webhooks/postmark', '/api/webhooks/twilio/status']) {
      expect(spec.paths, `missing ${p}`).toHaveProperty(p)
    }
    const glofox = spec.paths['/api/webhooks/glofox'].post
    expect(glofox.tags).toContain('Webhooks (Inbound)')
    expect(glofox.security).toContainEqual({ GlofoxHmac: [] })
    // Not gated by the browser/integration schemes:
    expect(glofox.security).not.toContainEqual({ CookieAuth: [] })
  })

  it('documents the bridge device API', () => {
    expect(spec.paths).toHaveProperty('/api/bridge/scan')
    const op = spec.paths['/api/bridge/scan'].post
    expect(op.tags).toContain('Bridge')
    expect(op.security).toContainEqual({ BridgeAuth: [] })
  })

  it('documents the staff mobile API', () => {
    expect(spec.paths).toHaveProperty('/api/mobile/today-feed')
    const op = spec.paths['/api/mobile/today-feed'].get
    expect(op.tags).toContain('Mobile')
    expect(op.security).toContainEqual({ CookieAuth: [] })
  })

  it('declares webhook + bridge auth schemes', () => {
    const s = spec.components.securitySchemes
    expect(s).toHaveProperty('GlofoxHmac')
    expect(s).toHaveProperty('MetaSignature')
    expect(s).toHaveProperty('WebhookToken')
    expect(s).toHaveProperty('BridgeAuth')
  })
})
