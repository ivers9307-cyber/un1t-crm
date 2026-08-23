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
    expect(spec.info.title).toBe('Repset CRM API')
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // REPSET-P6.S2 — canonical host leads the server list; the legacy host
  // stays listed second so existing integrations keep a documented base.
  it('lists the canonical repset host first and the legacy host second', () => {
    expect(spec.servers[0].url).toBe('https://crm.repset.ie')
    expect(spec.servers.map((s) => s.url)).toContain('https://crm.un1tdublin.com')
  })

  it('declares the pre-existing browser/integration auth schemes', () => {
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
      'LeadCapture',
    ]) {
      expect(schemas, `missing schema: ${name}`).toHaveProperty(name)
    }
  })

  // SEQGAPS.1 — the manual exit is irreversible and 409s on the second
  // call; both facts belong in the spec, not just in the route header.
  it('documents the manual enrolment exit, including its 409', () => {
    const p = '/api/sequences/{id}/enrollments/{enrollmentId}/exit'
    expect(spec.paths, `missing ${p}`).toHaveProperty(p)
    const op = spec.paths[p].post
    expect(op.tags).toContain('Automations')
    expect(op.security).toContainEqual({ CookieAuth: [] })
    expect(op.responses).toHaveProperty('409')
    expect(op.responses).toHaveProperty('404')
  })

  // FILTER-C.4 — the two audience routes an operator's whole pre-send check
  // runs on. audience-count predates the spec and audience-preview (FILTER-B.6)
  // never got registered, so /api-docs documented neither — the one place an
  // integrator would look to learn that a preview exists at all.
  it('documents the audience count and preview routes', () => {
    for (const p of ['/api/communications/audience-count', '/api/communications/audience-preview']) {
      expect(spec.paths, `missing ${p}`).toHaveProperty(p)
      const op = spec.paths[p].post
      expect(op, `${p} is not registered as POST`).toBeTruthy()
      expect(op.tags).toContain('Marketing')
      expect(op.security).toContainEqual({ CookieAuth: [] })
      expect(op.responses).toHaveProperty('200')
      expect(op.responses).toHaveProperty('400')
      expect(op.responses).toHaveProperty('401')
    }
    // The preview returns customer PII, so its tenant guard 404s rather than
    // 403s (ids must not be enumerable) — that is a documented response, not
    // an implementation detail.
    expect(spec.paths['/api/communications/audience-preview'].post.responses).toHaveProperty('404')
  })

  // SHELLY-UI.9 — the whole /api/shelly surface, and the three status codes
  // whose MEANING is not guessable from the verb: adopt's 404 (the anti-oracle
  // answer, identical for "no such device" and "another tenant's"), the
  // toggle's 429 (a SUCCESS body — the override is saved and the cron will
  // apply it; the status only tells the client to stop re-pressing) and
  // run-now's 409 vocabulary.
  it('documents all twelve Shelly routes under Automations', () => {
    const expected = {
      '/api/shelly/connection': ['get', 'put', 'delete'],
      '/api/shelly/discover': ['get'],
      '/api/shelly/devices': ['get', 'post'],
      '/api/shelly/devices/{id}': ['patch', 'delete'],
      '/api/shelly/devices/{id}/toggle': ['post'],
      '/api/shelly/devices/{id}/run-now': ['post'],
      '/api/shelly/devices/{id}/energy': ['get'],
      '/api/shelly/refresh': ['post'],
    }
    let registered = 0
    for (const [p, methods] of Object.entries(expected)) {
      expect(spec.paths, `missing ${p}`).toHaveProperty(p)
      for (const m of methods) {
        const op = spec.paths[p][m]
        expect(op, `${p} is not registered as ${m.toUpperCase()}`).toBeTruthy()
        expect(op.tags).toContain('Automations')
        expect(op.security).toContainEqual({ CookieAuth: [] })
        expect(op.responses, `${m} ${p} must document its 403`).toHaveProperty('403')
        registered += 1
      }
    }
    expect(registered).toBe(12)

    // Adopt: 404 is the ownership gate, and it is documented as such.
    const adopt = spec.paths['/api/shelly/devices'].post
    expect(adopt.responses).toHaveProperty('404')
    expect(adopt.responses['404'].description).toMatch(/not_on_account/)
    expect(adopt.responses['429'].description).toMatch(/rate_limited/)
    // The four 409 codes adopt can answer.
    for (const code of ['not_connected', 'key_rejected', 'device_cap', 'adopted_here']) {
      expect(adopt.responses['409'].description, `adopt 409 must name ${code}`).toContain(code)
    }

    // Toggle: the 429 carries success:true, which a client MUST NOT read as a
    // failed request — pinned so the sentence cannot quietly disappear.
    const toggle = spec.paths['/api/shelly/devices/{id}/toggle'].post
    expect(toggle.responses['429'].description).toMatch(/success:true/)

    // Run-now: no_schedule is checked BEFORE disabled, and the spec says so.
    const runNow = spec.paths['/api/shelly/devices/{id}/run-now'].post
    expect(runNow.responses['409'].description).toMatch(/no_schedule/)
    expect(runNow.responses['409'].description).toMatch(/disabled/)

    // Devices GET: the third connection state lives in the response schema.
    expect(spec.components.schemas.ShellyDeviceListResponse.description).toMatch(/connected: NULL/)

    // The connection view is the allowlist — no key, no fingerprint.
    const conn = spec.components.schemas.ShellyConnectionPublic
    expect(Object.keys(conn.properties).sort()).toEqual(
      ['has_auth_key', 'host', 'key_hint', 'last_error', 'last_error_at', 'last_ok_at', 'status'],
    )
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

  // HOME.3 — the needs-attention triage queue (approvals + tickets + inbox).
  it('documents the home-queue routes, including the tickets-visibility 500', () => {
    expect(spec.paths).toHaveProperty('/api/home-queue')
    expect(spec.paths).toHaveProperty('/api/home-queue/count')

    const queue = spec.paths['/api/home-queue'].get
    expect(queue.tags).toContain('Dashboard')
    expect(queue.security).toContainEqual({ CookieAuth: [] })
    expect(queue.responses).toHaveProperty('200')
    expect(queue.responses).toHaveProperty('401')

    const count = spec.paths['/api/home-queue/count'].get
    expect(count.tags).toContain('Dashboard')
    expect(count.security).toContainEqual({ CookieAuth: [] })
    expect(count.responses).toHaveProperty('200')
    // EMAIL-TICKET-CLEANUP.2 — the count endpoint 500s rather than
    // answering a confident 0 when the tickets mailbox-visibility lookup
    // itself fails; that has to be a documented response, not just an
    // implementation detail (mirrors /api/email/tickets/count's own spec).
    expect(count.responses).toHaveProperty('500')
  })

  it('includes an outbound webhooks stub', () => {
    expect(spec).toHaveProperty('webhooks')
    expect(spec.webhooks).toHaveProperty('lead.created')
    expect(spec.webhooks['lead.created'].post.description).toMatch(/planned/i)
  })

  it('declares webhook + bridge auth schemes', () => {
    const s = spec.components.securitySchemes
    expect(s).toHaveProperty('GlofoxHmac')
    expect(s).toHaveProperty('MetaSignature')
    expect(s).toHaveProperty('WebhookToken')
    expect(s).toHaveProperty('BridgeAuth')
  })
})
