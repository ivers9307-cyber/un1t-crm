// HOSTSTATS.1 — the server keeps a host-campaign id only when it names a
// campaign of the event's host; anything else is dropped and the source
// falls back to the other signals.
import { describe, it, expect } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'
import { resolveEventAttribution } from './event-attribution-server'

const HC = '80000000-0000-4000-8000-000000000001'
const dbWith = (campaign) => fakeDb((q) => (q.table === 'host_campaigns' ? { data: campaign, error: null } : { data: null, error: null }))

describe('resolveEventAttribution', () => {
  it('keeps hc when the campaign belongs to the event host', async () => {
    const db = dbWith({ id: HC })
    const out = await resolveEventAttribution(db, { session_id: 'sess-000001', hc: HC, utm_source: 'instagram' }, { host_id: 'h1' })
    expect(out).toMatchObject({ host_campaign_id: HC, source: 'host_email' })
    const q = db.queries.find((x) => x.table === 'host_campaigns')
    expect(q.ops).toEqual(expect.arrayContaining([['eq', 'id', HC], ['eq', 'host_id', 'h1']]))
  })
  it('drops hc for another host\'s campaign, for an event with no host, and on a failed read; source falls through', async () => {
    expect(await resolveEventAttribution(dbWith(null), { hc: HC, utm_source: 'instagram' }, { host_id: 'h1' })).toMatchObject({ host_campaign_id: null, source: 'instagram' })
    const noHost = fakeDb(() => { throw new Error('must not read') })
    expect(await resolveEventAttribution(noHost, { hc: HC }, { host_id: null })).toMatchObject({ host_campaign_id: null, source: 'direct' })
    const failing = fakeDb((q) => (q.table === 'host_campaigns' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }))
    expect(await resolveEventAttribution(failing, { hc: HC }, { host_id: 'h1' })).toMatchObject({ host_campaign_id: null, source: 'direct' })
  })
  it('a referrer on the request\'s own host (the series or host page) is not a source: direct, or whatever else the tab knew', async () => {
    const db = fakeDb(() => { throw new Error('must not read') })
    const own = await resolveEventAttribution(db, { referrer: 'https://un1t.repset.ie/event/series/mob' }, { host_id: null }, { requestHost: 'un1t.repset.ie' })
    expect(own).toMatchObject({ referrer_host: null, source: 'direct' })
    const www = await resolveEventAttribution(db, { referrer: 'https://www.un1t.repset.ie/h/acme', utm_source: 'instagram' }, { host_id: null }, { requestHost: 'UN1T.repset.ie' })
    expect(www).toMatchObject({ referrer_host: null, source: 'instagram' })
    const other = await resolveEventAttribution(db, { referrer: 'https://l.instagram.com/' }, { host_id: null }, { requestHost: 'un1t.repset.ie' })
    expect(other).toMatchObject({ referrer_host: 'l.instagram.com', source: 'instagram' })
  })
  it('null in → null out, no read', async () => {
    const db = fakeDb(() => { throw new Error('must not read') })
    expect(await resolveEventAttribution(db, null, { host_id: 'h1' })).toBeNull()
    expect(await resolveEventAttribution(db, undefined, { host_id: 'h1' })).toBeNull()
  })
})
