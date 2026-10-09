import { describe, it, expect, vi, afterEach } from 'vitest'
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
  afterEach(() => vi.restoreAllMocks())
  const STILLORGAN = { id: 'loc1', settings: { whatsapp_flow: { flow_id: '1343015528022374' } } }

  it('routes to the location whose settings carry the flow_id', async () => {
    const db = fakeDb({ locations: [STILLORGAN, { id: 'loc2', settings: {} }] })
    const res = await applyFlowEvent(db, { flow_id: '1343015528022374', old_status: 'PUBLISHED', new_status: 'THROTTLED' })
    expect(res.locations).toEqual(['loc1'])
    expect(res.notify).not.toBeNull()
  })

  // W0.13 — an unmatched flow_id used to fan out to every location that owns
  // a WhatsApp number (a cross-tenant alert). Now: notify nobody, log for
  // platform ops, keep `notify` built so an ops channel can still use it.
  it('an unmatched flow_id notifies NO location, logs at error level, and flags unmatched', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = fakeDb({ locations: [{ id: 'locX', settings: {} }], numbers: [{ location_id: 'loc1' }, { location_id: 'loc2' }] })
    const res = await applyFlowEvent(db, { flow_id: 'unknown-flow', new_status: 'BLOCKED' })
    expect(res.locations).toEqual([])
    expect(res.unmatched).toBe(true)
    expect(res.notify).not.toBeNull()
    expect(res.notify.title).toBe('WhatsApp Flow BLOCKED')
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0][0]).toMatch(/unmatched flow_id unknown-flow/)
  })

  it('a flow event with no flow_id at all is unmatched too (never pages every tenant)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = fakeDb({ locations: [STILLORGAN], numbers: [{ location_id: 'loc1' }] })
    const res = await applyFlowEvent(db, { new_status: 'THROTTLED', old_status: 'PUBLISHED' })
    expect(res.locations).toEqual([])
    expect(res.unmatched).toBe(true)
    expect(errSpy).toHaveBeenCalledTimes(1)
  })

  it('a matched flow is not flagged unmatched and logs nothing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = fakeDb({ locations: [STILLORGAN] })
    const res = await applyFlowEvent(db, { flow_id: '1343015528022374', new_status: 'BLOCKED' })
    expect(res.locations).toEqual(['loc1'])
    expect(res.unmatched).toBe(false)
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('silent events do zero lookups and return no locations', async () => {
    let called = false
    const db = { from: () => { called = true; return { select: () => Promise.resolve({ data: [] }) } } }
    const res = await applyFlowEvent(db, { old_status: 'DRAFT', new_status: 'PUBLISHED' })
    expect(res.notify).toBeNull()
    expect(called).toBe(false)
  })
})
