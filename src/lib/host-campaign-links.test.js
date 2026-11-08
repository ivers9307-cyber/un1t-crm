// HOSTSTATS.1 — a host campaign's event links carry hc=<campaign id>, so a
// booking made from the email is attributable. Only links on the tenant host
// to /event/… or /h/… are touched; everything else is byte-for-byte as sent.
import { describe, it, expect } from 'vitest'
import { tagHostCampaignLinks } from './host-campaign-links'

const HC = '80000000-0000-4000-8000-000000000001'
const opts = { campaignId: HC, tenantHost: 'un1t.repset.ie' }
const tag = (html, o = opts) => tagHostCampaignLinks(html, o)

describe('tagHostCampaignLinks', () => {
  it('tags event and host-page links on the tenant host', () => {
    expect(tag('<a href="https://un1t.repset.ie/event/mob">Book</a>')).toBe(`<a href="https://un1t.repset.ie/event/mob?hc=${HC}">Book</a>`)
    // The host is matched case-insensitively; the written URL is normalised (lower-case host).
    expect(tag('<a href="https://UN1T.repset.ie/h/other-host">See</a>')).toBe(`<a href="https://un1t.repset.ie/h/other-host?hc=${HC}">See</a>`)
  })
  it('joins an existing query with &amp; and replaces an existing hc', () => {
    expect(tag('<a href="https://un1t.repset.ie/event/mob?utm_source=ig">x</a>')).toBe(`<a href="https://un1t.repset.ie/event/mob?utm_source=ig&amp;hc=${HC}">x</a>`)
    expect(tag('<a href="https://un1t.repset.ie/event/mob?hc=old&amp;utm_source=ig">x</a>')).toBe(`<a href="https://un1t.repset.ie/event/mob?hc=${HC}&amp;utm_source=ig">x</a>`)
  })
  it('leaves other hosts, other paths, mailto and non-anchor URL attributes alone', () => {
    for (const html of [
      '<a href="https://other.example/event/x">x</a>',
      '<a href="https://un1t.repset.ie/unsubscribe/host/t">x</a>',
      '<a href="https://un1t.repset.ie/">x</a>',
      '<a href="mailto:hi@x.ie">x</a>',
      '<img src="https://un1t.repset.ie/event/mob">',
      '<a>no href</a>',
    ]) expect(tag(html)).toBe(html)
  })
  it('handles single-quoted and bare attribute values, and several links in one document', () => {
    expect(tag("<a href='https://un1t.repset.ie/event/mob'>x</a>")).toBe(`<a href="https://un1t.repset.ie/event/mob?hc=${HC}">x</a>`)
    expect(tag('<a href=https://un1t.repset.ie/event/mob>x</a>')).toBe(`<a href="https://un1t.repset.ie/event/mob?hc=${HC}">x</a>`)
    const two = '<p><a href="https://un1t.repset.ie/event/a">a</a> and <a href="https://un1t.repset.ie/event/b">b</a></p>'
    expect(tag(two)).toBe(`<p><a href="https://un1t.repset.ie/event/a?hc=${HC}">a</a> and <a href="https://un1t.repset.ie/event/b?hc=${HC}">b</a></p>`)
  })
  it('is a no-op without a campaign id or tenant host, and on a malformed URL', () => {
    const html = '<a href="https://un1t.repset.ie/event/mob">x</a>'
    expect(tag(html, { campaignId: null, tenantHost: 'un1t.repset.ie' })).toBe(html)
    expect(tag(html, { campaignId: HC, tenantHost: '' })).toBe(html)
    const bad = '<a href="https://un1t.repset.ie:notaport/event/x">x</a>'
    expect(tag(bad)).toBe(bad)
  })
})
