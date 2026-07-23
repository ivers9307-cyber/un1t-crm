import { describe, it, expect } from 'vitest'
import { toMemberStatus, buildStatusView, DEFAULT_COPY } from './status-page.js'

describe('toMemberStatus', () => {
  it('maps internal → member vocabulary, and never alarms on unknown', () => {
    expect(toMemberStatus('down')).toBe('down')
    expect(toMemberStatus('warn')).toBe('degraded')
    expect(toMemberStatus('ok')).toBe('operational')
    expect(toMemberStatus('unknown')).toBe('operational') // not-configured ≠ broken
    expect(toMemberStatus(undefined)).toBe('operational')
  })
})

describe('buildStatusView', () => {
  const allOk = [
    { key: 'crons', status: 'ok' }, { key: 'webhooks', status: 'ok' },
    { key: 'glofox', status: 'ok' }, { key: 'wa:main', status: 'ok' },
    { key: 'payments', status: 'ok' }, { key: 'email', status: 'ok' },
  ]

  it('all green → operational everywhere', () => {
    const v = buildStatusView(allOk)
    expect(v.overall).toBe('operational')
    expect(v.services.map((s) => s.status)).toEqual(['operational', 'operational', 'operational', 'operational'])
    expect(v.verdict.tag).toBe(DEFAULT_COPY.verdict.operational.tag)
  })

  it('a WhatsApp outage degrades only Messaging, and drives the overall verdict', () => {
    const v = buildStatusView(allOk.map((r) => r.key === 'wa:main' ? { ...r, status: 'down' } : r))
    const messaging = v.services.find((s) => s.key === 'messaging')
    expect(messaging.status).toBe('down')
    expect(messaging.desc).toBe(DEFAULT_COPY.services.messaging.bad)
    expect(v.overall).toBe('down')
    expect(v.services.find((s) => s.key === 'booking').status).toBe('operational')
  })

  it('booking rolls up crons/webhooks/glofox — worst wins', () => {
    const v = buildStatusView([{ key: 'crons', status: 'ok' }, { key: 'webhooks', status: 'warn' }, { key: 'glofox', status: 'ok' }])
    expect(v.services.find((s) => s.key === 'booking').status).toBe('degraded')
    expect(v.overall).toBe('degraded')
  })

  it('a not-configured (unknown) integration does not alarm customers', () => {
    const v = buildStatusView([{ key: 'glofox', status: 'unknown' }])
    expect(v.services.find((s) => s.key === 'booking').status).toBe('operational')
    expect(v.overall).toBe('operational')
  })

  it('missing rows default a service to operational (nothing says it is broken)', () => {
    const v = buildStatusView([])
    expect(v.overall).toBe('operational')
    expect(v.services).toHaveLength(4)
  })

  it('never leaks internal detail — only status is read', () => {
    const v = buildStatusView([{ key: 'email', status: 'down', detail: '80% bounced — sk_live_xxx', remedy: 'internal note' }])
    const json = JSON.stringify(v)
    expect(json).not.toContain('bounced')
    expect(json).not.toContain('internal note')
  })

  it('applies operator copy overrides, keeping other defaults', () => {
    const v = buildStatusView(allOk, { brand: 'CHAMP', services: { payments: { label: 'Billing' } } })
    expect(v.brand).toBe('CHAMP')
    expect(v.services.find((s) => s.key === 'payments').label).toBe('Billing')
    // untouched service keeps its default label
    expect(v.services.find((s) => s.key === 'email').label).toBe(DEFAULT_COPY.services.email.label)
  })
})
