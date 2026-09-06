import { describe, it, expect } from 'vitest'
import {
  sanitizeCampaignHtml,
  renderHostCampaignHtml,
  resolveHostRecipients,
} from './host-campaign-email'

// ---------------------------------------------------------------------------
// sanitizeCampaignHtml — host-authored body HTML is the ONLY unescaped input
// in a host campaign email; every dangerous construct must be stripped.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml', () => {
  it('strips <script> tags WITH their content', () => {
    const out = sanitizeCampaignHtml('<p>hi</p><script>alert("x")</script><p>bye</p>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toBe('<p>hi</p><p>bye</p>')
  })

  it('strips <style> tags WITH their content', () => {
    const out = sanitizeCampaignHtml('<style>body{background:url(evil)}</style><p>ok</p>')
    expect(out).not.toContain('style')
    expect(out).not.toContain('evil')
    expect(out).toBe('<p>ok</p>')
  })

  it('strips script tags case-insensitively and with attributes', () => {
    const out = sanitizeCampaignHtml('<SCRIPT src="https://x.ie/e.js"></SCRIPT><p>ok</p>')
    expect(out).toBe('<p>ok</p>')
  })

  it('strips a stray unclosed <script> open tag', () => {
    const out = sanitizeCampaignHtml('<p>a</p><script src="x.js">')
    expect(out).not.toContain('<script')
  })

  it('strips iframe / object / embed / form / link / meta tags', () => {
    const out = sanitizeCampaignHtml(
      '<iframe src="https://x.ie"></iframe><object data="x"></object>' +
      '<embed src="x"><form action="/steal"><input></form>' +
      '<link rel="stylesheet" href="x.css"><meta http-equiv="refresh" content="0">' +
      '<p>keep</p>'
    )
    expect(out).not.toMatch(/<\/?(iframe|object|embed|form|link|meta)\b/i)
    expect(out).toContain('<p>keep</p>')
  })

  it('strips on* event-handler attributes (double-quoted, single-quoted, bare)', () => {
    expect(sanitizeCampaignHtml('<img src="https://x.ie/a.png" onerror="alert(1)">')).not.toMatch(/onerror/i)
    expect(sanitizeCampaignHtml("<div onclick='alert(1)'>x</div>")).not.toMatch(/onclick/i)
    expect(sanitizeCampaignHtml('<div onmouseover=alert(1)>x</div>')).not.toMatch(/onmouseover/i)
    // case-insensitive
    expect(sanitizeCampaignHtml('<div ONCLICK="alert(1)">x</div>')).not.toMatch(/onclick/i)
  })

  it('keeps non-handler attributes intact while stripping handlers', () => {
    const out = sanitizeCampaignHtml('<img src="https://x.ie/a.png" alt="pic" onerror="alert(1)" width="100">')
    expect(out).toContain('src="https://x.ie/a.png"')
    expect(out).toContain('alt="pic"')
    expect(out).toContain('width="100"')
    expect(out).not.toMatch(/onerror/i)
  })

  it('neutralizes javascript: hrefs (any case / leading whitespace)', () => {
    expect(sanitizeCampaignHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<a href=" javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<a href=javascript:alert(1)>x</a>')).not.toMatch(/javascript:/i)
  })

  it('neutralizes data: hrefs and srcs', () => {
    expect(sanitizeCampaignHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).not.toMatch(/data:/i)
    expect(sanitizeCampaignHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">')).not.toMatch(/data:/i)
  })

  it('strips on* handlers separated by / or a quote instead of whitespace', () => {
    expect(sanitizeCampaignHtml('<img/onerror=alert(1) src="https://x.ie/a.png">')).not.toMatch(/onerror/i)
    expect(sanitizeCampaignHtml('<svg/onload=alert(1)>')).not.toMatch(/onload/i)
    expect(sanitizeCampaignHtml('<img src="https://x.ie/a.png"onerror="alert(1)">')).not.toMatch(/onerror/i)
  })

  it('strips svg and math tags', () => {
    const out = sanitizeCampaignHtml(
      '<svg><circle r="1"></circle></svg><math><mi>x</mi></math><p>keep</p>'
    )
    expect(out).not.toMatch(/<\/?(svg|math)\b/i)
    expect(out).toContain('<p>keep</p>')
  })

  it('neutralizes entity-encoded / control-obfuscated / unknown schemes (allowlist)', () => {
    // decimal + hex numeric entities
    expect(sanitizeCampaignHtml('<a href="&#106;avascript:alert(1)">x</a>')).toContain('href="#"')
    expect(sanitizeCampaignHtml('<a href="&#x6A;avascript:alert(1)">x</a>')).toContain('href="#"')
    // named entity colon
    expect(sanitizeCampaignHtml('<a href="javascript&colon;alert(1)">x</a>')).toContain('href="#"')
    // control chars inside the scheme
    expect(sanitizeCampaignHtml('<a href="jav\tascript:alert(1)">x</a>')).toContain('href="#"')
    // any scheme outside http/https/mailto/tel is neutralized — allowlist, not deny-list
    expect(sanitizeCampaignHtml('<a href="vbscript:msgbox(1)">x</a>')).toContain('href="#"')
    // benign absolute URLs with entities, mailto/tel, and relative/fragment URLs survive untouched
    const ok = '<a href="https://x.ie/?a=1&#38;b=2">x</a><a href="mailto:hi@x.ie">m</a><a href="tel:+3531234">t</a><a href="#section">s</a>'
    expect(sanitizeCampaignHtml(ok)).toBe(ok)
  })

  it('neutralizes dangerous xlink:href and slash-separated URL attributes', () => {
    expect(sanitizeCampaignHtml('<use xlink:href="javascript:alert(1)">')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<img/src="javascript:alert(1)">')).not.toMatch(/javascript:/i)
  })

  it('keeps benign marketing markup untouched', () => {
    const html = '<h1>Sale!</h1><p>Hi <strong>there</strong>,<br>see <a href="https://acme.ie/offer">our offer</a>.</p><img src="https://acme.ie/hero.png" alt="hero">'
    expect(sanitizeCampaignHtml(html)).toBe(html)
  })

  it('returns an empty string for empty / non-string input', () => {
    expect(sanitizeCampaignHtml('')).toBe('')
    expect(sanitizeCampaignHtml(null)).toBe('')
    expect(sanitizeCampaignHtml(undefined)).toBe('')
    expect(sanitizeCampaignHtml(42)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// renderHostCampaignHtml — the server-owned shell. Footer + unsubscribe link
// are injected HERE, after sanitization, so a host can never omit or strip
// them (they never touch host-authored input).
// ---------------------------------------------------------------------------
describe('renderHostCampaignHtml', () => {
  const host = { name: 'Acme Events', sender_name: 'Acme Team' }
  const unsub = 'https://crm.un1tdublin.com/unsubscribe/host/tok.sig'
  const render = (overrides = {}) =>
    renderHostCampaignHtml({
      host,
      subject: 'July offers',
      bodyHtml: '<p>Hello!</p>',
      unsubscribeUrl: unsub,
      ...overrides,
    })

  it('always contains the unsubscribe link and the mandatory footer copy', () => {
    const html = render()
    expect(html).toContain(`href="${unsub}"`)
    expect(html).toContain('Unsubscribe')
    expect(html).toContain('Acme Events')
    expect(html).toContain('attended an event or joined the mailing list')
  })

  it('keeps the footer + unsubscribe link even when the body tries to close the document', () => {
    const html = render({ bodyHtml: '<p>bye</p></td></table></body></html>' })
    const bodyIdx = html.indexOf('<p>bye</p>')
    const unsubIdx = html.indexOf(`href="${unsub}"`)
    expect(bodyIdx).toBeGreaterThan(-1)
    expect(unsubIdx).toBeGreaterThan(bodyIdx) // footer renders AFTER the body slot
    expect(html).toContain('attended an event or joined the mailing list')
  })

  it('shows the sender_name header, falling back to the host name', () => {
    expect(render()).toContain('Acme Team')
    const noSender = render({ host: { name: 'Acme Events', sender_name: null } })
    expect(noSender).toContain('Acme Events')
  })

  it('escapes host-controlled strings (sender_name, name, subject)', () => {
    const html = render({
      host: { name: 'A & B <Events>', sender_name: '<script>alert(1)</script>' },
      subject: '<img src=x>',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('A &amp; B &lt;Events&gt;')
    expect(html).not.toContain('<img src=x>')
  })

  it('sanitizes the host-authored body (script stripped, handlers stripped)', () => {
    const html = render({ bodyHtml: '<p onclick="p()">Hi</p><script>steal()</script>' })
    expect(html).not.toContain('steal()')
    expect(html).not.toMatch(/onclick/i)
    expect(html).toContain('Hi')
  })

  it('tolerates a null-ish host and empty body', () => {
    const html = renderHostCampaignHtml({ host: null, subject: 's', bodyHtml: '', unsubscribeUrl: unsub })
    expect(html).toContain(`href="${unsub}"`)
    expect(html).toContain('Unsubscribe')
  })
})

// ---------------------------------------------------------------------------
// resolveHostRecipients — fakeDb mirrors host-contact-list.test.js: pages of
// host_contacts (joined contact) + host_email_suppressions rows.
// ---------------------------------------------------------------------------
function fakeRecipientsDb({ contactPages = [[]], suppressions = [] } = {}) {
  const calls = { hostFilters: [], contactRanges: [] }
  let contactCall = 0
  return {
    calls,
    from(table) {
      if (table === 'host_contacts') {
        return {
          select: () => ({
            eq: (col, val) => {
              calls.hostFilters.push([table, col, val])
              let sourceFilter = col === 'source' ? val : null
              const chain = {
                eq: (col2, val2) => {
                  calls.hostFilters.push([table, col2, val2])
                  if (col2 === 'source') sourceFilter = val2
                  return chain
                },
                order: () => chain,
                range: async (from, to) => {
                  calls.contactRanges.push({ from, to })
                  let page = contactPages[contactCall] || []
                  contactCall++
                  if (sourceFilter) page = page.filter((r) => r.source === sourceFilter)
                  return { data: page, error: null }
                },
              }
              return chain
            },
          }),
        }
      }
      if (table === 'host_email_suppressions') {
        return {
          select: () => ({
            eq: (col, val) => {
              calls.hostFilters.push([table, col, val])
              const chain = { order: () => chain, range: async () => ({ data: suppressions, error: null }) }
              return chain
            },
          }),
        }
      }
      throw new Error('unexpected table ' + table)
    },
  }
}

const member = (contactId, contact, marketing_consent = true) => ({ contact_id: contactId, marketing_consent, contact })
const goodContact = (id, email) => ({
  id, email, email_marketing: true, email_status: 'active', email_suppressed_at: null,
})

describe('resolveHostRecipients', () => {
  it('scopes BOTH queries to the host_id (tenancy)', async () => {
    const db = fakeRecipientsDb()
    await resolveHostRecipients(db, 'h1')
    expect(db.calls.hostFilters).toEqual([
      ['host_email_suppressions', 'host_id', 'h1'],
      ['host_contacts', 'host_id', 'h1'],
    ])
  })

  it('returns {contact_id, email} for emailable contacts only', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        member('c1', goodContact('c1', 'a@x.ie')),
        member('c2', goodContact('c2', 'b@x.ie'), false),
        member('c3', { ...goodContact('c3', 'c@x.ie'), email_status: 'bounced' }),
        member('c4', null), // broken join — tolerated, skipped
      ]],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([{ contact_id: 'c1', email: 'a@x.ie' }])
  })

  it('HOST-CONSENT.1 — includes a UN1T-opted-out contact who consented to the host, excludes one who did not', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        member('c1', { ...goodContact('c1', 'a@x.ie'), email_marketing: false }, true),
        member('c2', goodContact('c2', 'b@x.ie'), false),
      ]],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([{ contact_id: 'c1', email: 'a@x.ie' }])
  })

  it('excludes per-host suppressed contacts', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[member('c1', goodContact('c1', 'a@x.ie')), member('c2', goodContact('c2', 'b@x.ie'))]],
      suppressions: [{ contact_id: 'c1' }],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([{ contact_id: 'c2', email: 'b@x.ie' }])
  })

  it('dedupes by lowercased email — first (newest membership) wins', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        member('c1', goodContact('c1', 'Pat@X.ie')),
        member('c2', goodContact('c2', 'pat@x.ie')),
        member('c3', goodContact('c3', 'other@x.ie')),
      ]],
    })
    expect(await resolveHostRecipients(db, 'h1')).toEqual([
      { contact_id: 'c1', email: 'Pat@X.ie' },
      { contact_id: 'c3', email: 'other@x.ie' },
    ])
  })

  it('paginates past the 1000-row select cap', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => member(`c${i}`, goodContact(`c${i}`, `u${i}@x.ie`)))
    const page2 = [member('last', goodContact('last', 'last@x.ie'))]
    const db = fakeRecipientsDb({ contactPages: [page1, page2] })
    const rows = await resolveHostRecipients(db, 'h1')
    expect(rows).toHaveLength(1001)
    expect(db.calls.contactRanges).toEqual([{ from: 0, to: 999 }, { from: 1000, to: 1999 }])
  })

  it('mailingListOnly restricts the query to source=mailing_list', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        { ...member('c1', goodContact('c1', 'a@x.ie')), source: 'event' },
        { ...member('c2', goodContact('c2', 'b@x.ie')), source: 'mailing_list' },
      ]],
    })
    const out = await resolveHostRecipients(db, 'h1', { mailingListOnly: true })
    expect(db.calls.hostFilters).toContainEqual(['host_contacts', 'source', 'mailing_list'])
    expect(out).toEqual([{ contact_id: 'c2', email: 'b@x.ie' }])
  })

  it('default leaves the source unfiltered', async () => {
    const db = fakeRecipientsDb({
      contactPages: [[
        { ...member('c1', goodContact('c1', 'a@x.ie')), source: 'event' },
        { ...member('c2', goodContact('c2', 'b@x.ie')), source: 'mailing_list' },
      ]],
    })
    const out = await resolveHostRecipients(db, 'h1')
    expect(db.calls.hostFilters.some(([t, c]) => t === 'host_contacts' && c === 'source')).toBe(false)
    expect(out.map((r) => r.contact_id).sort()).toEqual(['c1', 'c2'])
  })
})

// HOST-EMAIL.4 — visual composer + per-event audience.
describe('renderHostCampaignHtml — full-document (Unlayer) campaigns', () => {
  const host = { name: 'Pride Training Club', sender_name: 'Pride Training Club' }
  it('injects the footer before </body> instead of shell-wrapping', () => {
    const doc = '<!DOCTYPE html><html><head><title>x</title></head><body><table><tr><td>Hi</td></tr></table></body></html>'
    const out = renderHostCampaignHtml({ host, subject: 'S', bodyHtml: doc, unsubscribeUrl: 'https://x/u/t' })
    expect(out.match(/<!DOCTYPE html>/gi)).toHaveLength(1)
    expect(out).toContain('Unsubscribe')
    expect(out.indexOf('Unsubscribe')).toBeLessThan(out.indexOf('</body>'))
  })
  it('still sanitizes active content inside a full document', () => {
    const doc = '<html><body><script>alert(1)</script><p onclick="x()">Hi</p></body></html>'
    const out = renderHostCampaignHtml({ host, subject: 'S', bodyHtml: doc, unsubscribeUrl: 'https://x/u/t' })
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onclick')
    expect(out).toContain('Unsubscribe')
  })
  it('plain fragments keep the branded shell', () => {
    const out = renderHostCampaignHtml({ host, subject: 'S', bodyHtml: '<p>Hi</p>', unsubscribeUrl: 'https://x/u/t' })
    expect(out).toContain('border-radius:12px')
    expect(out).toContain('Unsubscribe')
  })
})

describe('resolveHostRecipients — per-event audience', () => {
  function eventDb({ attendees, hostContacts }) {
    return {
      from(table) {
        let filters = {}
        const b = {
          select: () => b,
          eq: (col, val) => { filters[col] = val; return b },
          order: () => b,
          range: async () => {
            if (table === 'race_registrations') {
              return { data: attendees.map((id) => ({ id: `r-${id}`, teams: { team_members: [{ contact_id: id }] } })), error: null }
            }
            if (table === 'host_email_suppressions') return { data: [], error: null }
            if (table === 'host_contacts') {
              return {
                data: hostContacts.map((id) => ({
                  contact_id: id,
                  marketing_consent: true,
                  contact: { id, email: `${id}@x.com`, email_marketing: true, email_status: 'active', email_suppressed_at: null },
                })),
                error: null,
              }
            }
            return { data: [], error: null }
          },
        }
        return b
      },
    }
  }

  it('restricts to the event attendees when audienceEventId is set', async () => {
    const db = eventDb({ attendees: ['a', 'b'], hostContacts: ['a', 'b', 'c'] })
    const out = await resolveHostRecipients(db, 'h1', { audienceEventId: 'ev1' })
    expect(out.map((r) => r.contact_id).sort()).toEqual(['a', 'b'])
  })

  it('no audience → every host contact (unchanged)', async () => {
    const db = eventDb({ attendees: [], hostContacts: ['a', 'b', 'c'] })
    const out = await resolveHostRecipients(db, 'h1')
    expect(out).toHaveLength(3)
  })

  it('event with zero attendees → empty, no contact scan', async () => {
    const db = eventDb({ attendees: [], hostContacts: ['a'] })
    const out = await resolveHostRecipients(db, 'h1', { audienceEventId: 'ev1' })
    expect(out).toEqual([])
  })
})
