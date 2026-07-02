import { describe, it, expect } from 'vitest'
import { FLOW_EVENT_FIELDS, flowNotification, applyFlowEvent } from './whatsapp-flow-events.js'

describe('flowNotification', () => {
  it('THROTTLED pages with funnel-outage framing', () => {
    const n = flowNotification({ flow_id: '1343015528022374', old_status: 'PUBLISHED', new_status: 'THROTTLED' })
    expect(n.title).toBe('WhatsApp Flow THROTTLED')
    expect(n.body).toMatch(/paid-ads funnel/i)
    expect(n.body).toContain('1343015528022374')
  })
  it('BLOCKED pages', () => {
    expect(flowNotification({ new_status: 'BLOCKED', old_status: 'THROTTLED' }).body).toMatch(/no longer be sent/i)
  })
  it('recovery to PUBLISHED from a bad state notifies positively', () => {
    const n = flowNotification({ flow_name: 'Book your first visit', old_status: 'THROTTLED', new_status: 'PUBLISHED' })
    expect(n.title).toMatch(/recovered/i)
    expect(n.body).toContain('Book your first visit')
  })
  it('fresh publish (DRAFT → PUBLISHED) stays silent', () => {
    expect(flowNotification({ old_status: 'DRAFT', new_status: 'PUBLISHED' })).toBeNull()
  })
  it('deprecation warns about template buttons', () => {
    expect(flowNotification({ new_status: 'DEPRECATED' }).body).toMatch(/template buttons/i)
  })
  it('field set covers flows', () => {
    expect(FLOW_EVENT_FIELDS.has('flows')).toBe(true)
  })
})

function fakeDb({ locations = [], numbers = [] }) {
  return {
    from: (table) => ({
      select: () => Promise.resolve({ data: table === 'locations' ? locations : numbers }),
    }),
  }
}

describe('applyFlowEvent', () => {
  const STILLORGAN = { id: 'loc1', settings: { whatsapp_flow: { flow_id: '1343015528022374' } } }

  it('routes to the location whose settings carry the flow_id', async () => {
    const db = fakeDb({ locations: [STILLORGAN, { id: 'loc2', settings: {} }] })
    const res = await applyFlowEvent(db, { flow_id: '1343015528022374', old_status: 'PUBLISHED', new_status: 'THROTTLED' })
    expect(res.locations).toEqual(['loc1'])
    expect(res.notify).not.toBeNull()
  })

  it('falls back to all number locations when no settings match', async () => {
    const db = fakeDb({ locations: [{ id: 'locX', settings: {} }], numbers: [{ location_id: 'loc1' }, { location_id: 'loc1' }] })
    const res = await applyFlowEvent(db, { flow_id: 'unknown-flow', new_status: 'BLOCKED' })
    expect(res.locations).toEqual(['loc1'])
  })

  it('silent events do zero lookups and return no locations', async () => {
    let called = false
    const db = { from: () => { called = true; return { select: () => Promise.resolve({ data: [] }) } } }
    const res = await applyFlowEvent(db, { old_status: 'DRAFT', new_status: 'PUBLISHED' })
    expect(res.notify).toBeNull()
    expect(called).toBe(false)
  })
})
