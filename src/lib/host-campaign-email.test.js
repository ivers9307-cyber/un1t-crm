import { describe, it, expect, vi } from 'vitest'
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

  it('keeps <style> tags, scrubbed, instead of stripping them (HOST-EMAILS.2)', () => {
    // Was "strips <style> tags WITH their content" — HOST-EMAILS.2 keeps
    // <style> so a Canva/Unlayer export stays responsive; the CSS itself is
    // still scrubbed (here the non-http(s) url() is parked to `none`).
    const out = sanitizeCampaignHtml('<style>body{background:url(evil)}</style><p>ok</p>')
    expect(out).toBe('<style>body{background:none}</style><p>ok</p>')
    expect(out).not.toContain('evil')
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
  const calls = { hostFilters: [], contactRanges: [], selects: [] }
  let contactCall = 0
  return {
    calls,
    from(table) {
      if (table === 'host_contacts') {
        return {
          select: (cols) => {
            calls.selects.push([table, cols])
            return {
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
            }
          },
        }
      }
      if (table === 'host_email_suppressions') {
        return {
          select: (cols) => {
            calls.selects.push([table, cols])
            return {
              eq: (col, val) => {
                calls.hostFilters.push([table, col, val])
                const chain = { order: () => chain, range: async () => ({ data: suppressions, error: null }) }
                return chain
              },
            }
          },
        }
      }
      throw new Error('unexpected table ' + table)
    },
  }
}

const member = (contactId, contact, marketing_consent = true) => ({ contact_id: contactId, marketing_consent, contact })
// email_marketing stays in the fixture on purpose: the host gate must IGNORE it (HOST-CONSENT.1).
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

  it('HOST-CONSENT.1 — selects host_contacts.marketing_consent and never contacts.email_marketing', async () => {
    const db = fakeRecipientsDb()
    await resolveHostRecipients(db, 'h1')
    const [, cols] = db.calls.selects.find(([t]) => t === 'host_contacts')
    expect(cols).toMatch(/marketing_consent/)
    expect(cols).toMatch(/contacts!contact_id/)
    expect(cols).not.toMatch(/email_marketing/)
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

// resolveHostRecipients — nonOpenersOf (HOST-EMAILS.2). A chainable ops-
// tracking fake (same shape as host-campaign-launch.test.js's makeDb) so the
// exact filters applied to host_campaign_sends can be asserted AND used to
// compute the fake's own canned response — the way a real .is()/.not() chain
// would narrow the rows.
describe('resolveHostRecipients — nonOpenersOf', () => {
  const HOST_ID = 'h1'
  const PARENT = 'p0000000-0000-0000-0000-0000000000p1'

  const SEND_ROWS = [
    { contact_id: 'c1', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    { contact_id: 'c2', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: '2026-09-02T00:00:00Z', clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    { contact_id: 'c3', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: '2026-09-01T01:00:00Z', complained_at: null, unsubscribed_at: null },
    // c5 — delivered/unopened/unclicked/unbounced/uncomplained/unsubscribed:
    // qualifies under the sends-history filter, so only the normal
    // emailability gate (host_contacts.marketing_consent, below) can exclude
    // it. Pins that the gate actually runs — see HOST_CONTACTS.
    { contact_id: 'c5', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    // c6 — never delivered (delivered_at null). Excluded by the resolver's
    // `.not('delivered_at', 'is', null)` — this fake only drops the row when
    // that exact op is present (see applySendsOps' 'not'/'is' branch), so a
    // resolver that forgot the filter would leak c6 through.
    { contact_id: 'c6', campaign_id: PARENT, status: 'sent', delivered_at: null, opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: null },
    // c7 — complained. Excluded by `.is('complained_at', null)`.
    { contact_id: 'c7', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: null, complained_at: '2026-09-01T02:00:00Z', unsubscribed_at: null },
    // c8 — unsubscribed. Excluded by `.is('unsubscribed_at', null)`.
    { contact_id: 'c8', campaign_id: PARENT, status: 'sent', delivered_at: '2026-09-01T00:00:00Z', opened_at: null, clicked_at: null, bounced_at: null, complained_at: null, unsubscribed_at: '2026-09-01T03:00:00Z' },
  ]

  const HOST_CONTACTS = [
    ...['c1', 'c2', 'c3', 'c4'].map((id) => ({
      contact_id: id,
      marketing_consent: true,
      contact: { id, email: `${id}@x.ie`, email_marketing: true, email_status: 'active', email_suppressed_at: null },
    })),
    // c5 passes every sends-history filter above — only a withdrawn
    // host_contacts.marketing_consent (the normal emailability gate) can
    // still keep it out. If resolveHostRecipients's isEmailable() call were
    // deleted, c5 would leak through and the "then the normal emailability
    // gate" test's `toEqual(['c1'])` assertion below would fail (c5 would
    // appear in the result).
    {
      contact_id: 'c5',
      marketing_consent: false,
      contact: { id: 'c5', email: 'c5@x.ie', email_marketing: true, email_status: 'active', email_suppressed_at: null },
    },
  ]

  function applySendsOps(rows, ops) {
    return rows.filter((row) => ops.every((o) => {
      if (o.method === 'eq') return row[o.args[0]] === o.args[1]
      if (o.method === 'is') return row[o.args[0]] === o.args[1]
      if (o.method === 'not' && o.args[1] === 'is') return row[o.args[0]] !== o.args[2]
      return true
    }))
  }

  function makeDb(route) {
    const statements = []
    const db = {
      from(table) {
        const state = { table, ops: [] }
        statements.push(state)
        const b = new Proxy({}, {
          get(_, method) {
            if (method === 'then') {
              const p = Promise.resolve(route(state) ?? {})
              return p.then.bind(p)
            }
            return (...args) => { state.ops.push({ method, args }); return b }
          },
        })
        return b
      },
    }
    return { db, statements }
  }

  const hasEq = (state, col, val) => state.ops.some((o) => o.method === 'eq' && o.args[0] === col && o.args[1] === val)

  function routeFor({ parent = { id: PARENT } } = {}) {
    return (state) => {
      if (state.table === 'host_campaigns') return { data: parent, error: null }
      if (state.table === 'host_email_suppressions') return { data: [], error: null }
      if (state.table === 'host_contacts') return { data: HOST_CONTACTS, error: null }
      if (state.table === 'host_campaign_sends') return { data: applySendsOps(SEND_ROWS, state.ops), error: null }
      return {}
    }
  }

  it('only the parent\'s delivered, unopened, unclicked, unbounced rows, then the normal emailability gate', async () => {
    const { db, statements } = makeDb(routeFor())
    const out = await resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })
    // The data assertion carries the weight: c2 (opened), c3 (bounced), c6
    // (never delivered), c7 (complained) and c8 (unsubscribed) are excluded
    // by the sends-history filter; c5 passes that filter but is excluded
    // ONLY by host_contacts.marketing_consent === false — deleting the
    // resolver's isEmailable() call would let c5 through and turn this
    // assertion red.
    expect(out.map((r) => r.contact_id)).toEqual(['c1'])

    const sendsQuery = statements.find((s) => s.table === 'host_campaign_sends')
    expect(hasEq(sendsQuery, 'campaign_id', PARENT)).toBe(true)
    expect(hasEq(sendsQuery, 'status', 'sent')).toBe(true)
    for (const col of ['opened_at', 'clicked_at', 'bounced_at', 'complained_at', 'unsubscribed_at']) {
      expect(sendsQuery.ops.some((o) => o.method === 'is' && o.args[0] === col && o.args[1] === null)).toBe(true)
    }
    // Full args, not just the column: `.not('delivered_at', 'is', null)`.
    expect(sendsQuery.ops.some((o) => o.method === 'not' && o.args[0] === 'delivered_at' && o.args[1] === 'is' && o.args[2] === null)).toBe(true)

    const parentRead = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(parentRead, 'id', PARENT)).toBe(true)
    expect(hasEq(parentRead, 'host_id', HOST_ID)).toBe(true)
  })

  it('a parent that is not this host\'s throws (no cross-host audience)', async () => {
    const { db } = makeDb(routeFor({ parent: null }))
    await expect(resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })).rejects.toThrow(/parent campaign/)
  })

  it('an empty non-openers set short-circuits — [] with no host_contacts or host_email_suppressions statements', async () => {
    const { db, statements } = makeDb((state) => {
      if (state.table === 'host_campaigns') return { data: { id: PARENT }, error: null }
      if (state.table === 'host_campaign_sends') return { data: [], error: null }
      return {}
    })
    const out = await resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })
    expect(out).toEqual([])
    expect(statements.some((s) => s.table === 'host_contacts')).toBe(false)
    expect(statements.some((s) => s.table === 'host_email_suppressions')).toBe(false)
  })

  it('paginates the non-openers read past 1000 rows', async () => {
    // 1005 qualifying rows: page one is s0..s999 (range 0-999), page two is
    // s1000..s1004 (range 1000-1999, only 5 rows). host_contacts is kept
    // deliberately tiny — only the two contacts this test cares about.
    const TOTAL = 1005
    const sendsRows = Array.from({ length: TOTAL }, (_, i) => ({ contact_id: `s${i}` }))
    const hostContacts = ['s0', 's1000'].map((id) => ({
      contact_id: id,
      marketing_consent: true,
      contact: { id, email: `${id}@x.ie`, email_marketing: true, email_status: 'active', email_suppressed_at: null },
    }))
    const { db, statements } = makeDb((state) => {
      if (state.table === 'host_campaigns') return { data: { id: PARENT }, error: null }
      if (state.table === 'host_email_suppressions') return { data: [], error: null }
      if (state.table === 'host_contacts') return { data: hostContacts, error: null }
      if (state.table === 'host_campaign_sends') {
        const [from, to] = state.ops.find((o) => o.method === 'range').args
        return { data: sendsRows.slice(from, to + 1), error: null }
      }
      return {}
    })
    const out = await resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })
    const sendsQueries = statements.filter((s) => s.table === 'host_campaign_sends')
    expect(sendsQueries.map((s) => s.ops.find((o) => o.method === 'range').args)).toEqual([[0, 999], [1000, 1999]])
    expect(out.map((r) => r.contact_id)).toContain('s1000') // from page two
  })
})

// HOST-EMAILS.2 — <style> survives (scrubbed), the viewport meta survives
// (canonicalised), everything else on the strip list still goes. A Canva or
// Unlayer export keeps its whole responsive layer in a <style> block; before
// this it rendered as a fixed 600px table on phones.
describe('sanitizeCampaignHtml — styles and viewport (HOST-EMAILS.2)', () => {
  const CANVA = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><style>@import url("https://evil.example/x.css"); .wrap{min-width:600px} @media (max-width:600px){ .wrap{min-width:0 !important;width:100% !important} }</style></head><body><table class="wrap"><tr><td>Hi</td></tr></table></body></html>'

  it('keeps the <style> block with its media query and drops the @import', () => {
    const out = sanitizeCampaignHtml(CANVA)
    expect(out).toContain('<style>')
    expect(out).toContain('@media (max-width:600px)')
    expect(out).toContain('width:100% !important')
    expect(out).not.toContain('@import')
    expect(out).not.toContain('evil.example')
  })

  it('keeps exactly one canonical viewport meta and strips the other metas', () => {
    const out = sanitizeCampaignHtml(CANVA)
    expect(out.match(/<meta/g)).toHaveLength(1)
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).not.toContain('x-apple-disable-message-reformatting')
    expect(out).not.toContain('charset')
  })

  it('never lets an authored viewport meta carry extra attributes through', () => {
    const out = sanitizeCampaignHtml('<meta name="viewport" content="width=device-width" onload="x()" http-equiv="refresh"><p>x</p>')
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).not.toContain('refresh')
    expect(out).not.toContain('onload')
  })

  it('a <style> that tries to close itself early cannot smuggle a tag', () => {
    const out = sanitizeCampaignHtml('<style>.a{}</style ><script>alert(1)</script><style>.b{color:red}</st\\yle><img src=x onerror=alert(1)></style>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).not.toMatch(/<style>[^<]*<img/)
  })

  it('still strips script, iframe, form, link, svg and on* handlers', () => {
    const out = sanitizeCampaignHtml('<style>.a{}</style><link rel="stylesheet" href="https://x/y.css"><script>1</script><iframe src="x"></iframe><form action="x"><input></form><svg onload="1"></svg><a href="https://ok" onclick="1">ok</a>')
    expect(out).toContain('<style>.a{}</style>')
    expect(out).not.toContain('<link')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<form')
    expect(out).not.toContain('<svg')
    expect(out).not.toContain('onclick')
    // The space the removed on* handler left behind is KEPT now: the `\s+>`
    // collapse that used to tidy it also rewrote `.a > .b` inside restored
    // <style> bodies into a descendant selector (security review).
    expect(out).toMatch(/<a href="https:\/\/ok"\s*>ok<\/a>/)
  })

  it('a forged placeholder in the input cannot inject a style block', () => {
    const out = sanitizeCampaignHtml('<p>@@UN1T_STYLE_0@@ @@UN1T_VIEWPORT@@</p><style>.z{}</style>')
    expect(out).not.toContain('@@UN1T_')
    expect((out.match(/<style>/g) || []).length).toBe(1)
    expect(out).not.toContain('<meta')
  })

  it('renderHostCampaignHtml keeps a full-document export responsive', () => {
    const html = renderHostCampaignHtml({ host: { name: 'Club', sender_name: 'Club' }, subject: 's', bodyHtml: CANVA, unsubscribeUrl: 'https://x/u' })
    expect(html).toContain('@media (max-width:600px)')
    expect(html).toContain('name="viewport"')
    expect(html).toContain('https://x/u')
  })
})

// ---------------------------------------------------------------------------
// Security review fixes — pins the two real defects found in the
// just-landed HOST-EMAILS.2 sanitizer:
//   1. dropOnAttrBoundary dropped a WHITESPACE boundary, which is
//      structural when the removed on* attribute abuts the next token
//      (no space between them) — merging attribute names/values together
//      and, worst case, hiding a `href` from the URL scheme check.
//   2. the placeholder scheme was forgeable via a nested prefix
//      (`@@UN1T@@UN1T__STYLE_0@@` reconstitutes after ONE `.split().join()`
//      pass), letting a host duplicate/relocate style content or the
//      viewport meta, or inject `<style>` text inside an open tag.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — on* boundary + placeholder-forgery regressions (security review)', () => {
  it('an on* attribute directly abutting the NEXT attribute (no whitespace) does not eat it', () => {
    // Was: dropOnAttrBoundary swallowed the whitespace boundary, merging
    // `<a onclick="1"href="...">` into `<ahref="...">` — the href attribute
    // vanished as such, so URL_ATTR's scheme check never saw it and the
    // javascript: URL survived verbatim.
    const out = sanitizeCampaignHtml('<a onclick="1"href="javascript:alert(1)">click</a>')
    expect(out).not.toMatch(/onclick/i)
    expect(out).not.toMatch(/javascript:/i)
    expect(out).toContain('<a href="#">click</a>')
  })

  it('an on* attribute directly abutting a following src (no whitespace) keeps the image', () => {
    // Was: <imgsrc=…> — the image silently lost its src attribute entirely.
    const out = sanitizeCampaignHtml('<img onclick="track()"src="https://cdn/hero.png" alt="Hero">')
    expect(out).not.toMatch(/onclick/i)
    expect(out).toContain('src="https://cdn/hero.png"')
    expect(out).toContain('alt="Hero"')
  })

  it('two adjacent on* attributes (quoted then bare, no space between) both go cleanly', () => {
    // Was: <img src=xonerror=alert(1)> — dropOnAttrBoundary ate the space
    // ahead of the bare attribute too, splicing "x" and "onerror" together.
    const out = sanitizeCampaignHtml('<img src=x onclick="1"onerror=alert(1)>')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('onclick')
    expect(out).toContain('<img src=x')
  })

  it('a nested-prefix forgery around a style placeholder token cannot duplicate the style block', () => {
    // @@UN1T@@UN1T__STYLE_0@@ reconstitutes into a live "@@UN1T_STYLE_0@@"
    // token after exactly one split/join pass — the fixed-point strip (and
    // the per-call nonce) must reduce it to inert text instead.
    const out = sanitizeCampaignHtml('<style>.real{color:red}</style><p>@@UN1T@@UN1T__STYLE_0@@</p>')
    expect((out.match(/<style>/g) || []).length).toBe(1)
    expect(out).not.toContain('@@UN1T_')
  })

  it('a nested-prefix forgery around a viewport placeholder token cannot relocate the viewport meta into the body', () => {
    const out = sanitizeCampaignHtml('<p>@@UN1T@@UN1T__VIEWPORT@@</p><meta name="viewport" content="x">')
    expect(out).not.toContain('@@UN1T_')
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    // the canonical meta must land OUTSIDE the <p>, not be spliced into it
    expect(out).not.toMatch(/<p>[^]*?<meta[^]*?<\/p>/)
    expect(out.indexOf('<meta')).toBeGreaterThan(out.indexOf('</p>'))
  })

  it('a triple-nested prefix forgery is still reduced to a fixed point with no live token left', () => {
    const out = sanitizeCampaignHtml('@@UN1T@@UN1T@@UN1T___STYLE_0@@')
    expect(out).not.toContain('@@UN1T_')
  })

  it('a forged placeholder token sitting inside an open tag cannot resurrect a <style> tag there', () => {
    const out = sanitizeCampaignHtml('<a href="https://ok" @@UN1T@@UN1T__STYLE_0@@>hi</a><style>.a{}</style>')
    expect(out).not.toContain('@@UN1T_')
    expect(out).not.toMatch(/<a[^>]*<style/)
  })

  it('two separate sanitizeCampaignHtml calls use independent (non-colliding) placeholder nonces', () => {
    // Not a shared/global token — two renders can run concurrently without
    // one call's forged input ever matching another call's live placeholder.
    const a = sanitizeCampaignHtml('<style>.a{color:red}</style><p>hi</p>')
    const b = sanitizeCampaignHtml('<style>.b{color:blue}</style><p>bye</p>')
    expect(a).toContain('<style>.a{color:red}</style>')
    expect(b).toContain('<style>.b{color:blue}</style>')
  })
})

// ---------------------------------------------------------------------------
// Security re-review — the COMPLETE SANITIZER BYPASS in the just-landed
// HOST-EMAILS.2 sanitizer, plus the three smaller holes found beside it.
//
// Root cause of the bypass: step 2 replaced EVERY `<meta name=viewport>` with
// a placeholder, and the restore step then deleted every placeholder but the
// first — a DELETION PERFORMED AFTER the fixed-point strip loop. It spliced
// the surrounding text together and nothing ever re-scanned the result, so a
// host could saw any dangerous construct in half with `<meta name=viewport>`
// and have the sanitizer weld it back together on the way out. Every one of
// the four payloads below shipped LIVE active content.
//
// The fix is structural: only the FIRST viewport meta becomes a placeholder;
// every other one is left exactly as authored so TAG_STRIP removes it INSIDE
// the loop, where the splice is re-scanned. Nothing is ever deleted after the
// loop — the two restorations only insert a scrubbed <style> body or the
// fixed canonical meta tag.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — viewport-meta splice bypass (security re-review)', () => {
  const oneMeta = (out) => expect(out.match(/<meta/g) || []).toHaveLength(1)

  it('cannot weld a live <script> back together through split viewport metas', () => {
    const out = sanitizeCampaignHtml(
      '<meta name=viewport><scr<meta name=viewport>ipt>window.__pwned=1</scr<meta name=viewport>ipt>'
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('__pwned')
    oneMeta(out)
  })

  it('cannot weld a live onerror= handler back together through a split viewport meta', () => {
    const out = sanitizeCampaignHtml('<meta name=viewport><img src=x on<meta name=viewport>error=alert(1)>')
    expect(out).not.toMatch(/onerror/i)
    expect(out).not.toContain('alert(1)')
    oneMeta(out)
  })

  it('cannot weld a javascript: href back together through a split viewport meta', () => {
    const out = sanitizeCampaignHtml('<meta name=viewport><a href="java<meta name=viewport>script:alert(1)">x</a>')
    expect(out).not.toMatch(/javascript:/i)
    expect(out).toContain('href="#"')
    oneMeta(out)
  })

  it('cannot weld an <iframe> back together through split viewport metas', () => {
    const out = sanitizeCampaignHtml(
      '<meta name=viewport><ifra<meta name=viewport>me src="https://evil"></ifra<meta name=viewport>me>'
    )
    expect(out).not.toMatch(/<\/?iframe/i)
    expect(out).not.toContain('evil')
    oneMeta(out)
  })

  it('still keeps exactly one canonical viewport meta when several are authored', () => {
    const out = sanitizeCampaignHtml(
      '<meta name="viewport" content="a"><p>x</p><meta name="viewport" content="b">'
    )
    oneMeta(out)
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(out).not.toContain('content="a"')
    expect(out).not.toContain('content="b"')
  })

  it('a GENUINE <style> block inside an open tag is dropped, not restored there', () => {
    // The forged-placeholder version of this is covered above; a real <style>
    // element is lifted to a placeholder, so the restore has to refuse to put
    // it back inside another tag's attribute list.
    const out = sanitizeCampaignHtml('<a href="https://ok" <style>onerror=alert(1)</style>>hi</a>')
    expect(out).not.toMatch(/<a[^>]*<style/)
    expect(out).not.toMatch(/<a[^>]*onerror\s*=/i)
    expect(out).toContain('hi')
  })

  it('strips <base>, which would re-point every relative URL in the message', () => {
    const out = sanitizeCampaignHtml('<base href="//evil/"><a href="/offer">o</a>')
    expect(out).not.toMatch(/<base\b/i)
    expect(out).not.toContain('evil')
    expect(out).toContain('href="/offer"')
  })

  it('scheme-checks poster / formaction / background like href and src', () => {
    expect(sanitizeCampaignHtml('<video poster="javascript:alert(1)"></video>')).not.toMatch(/javascript:/i)
    expect(sanitizeCampaignHtml('<video poster="javascript:alert(1)"></video>')).toContain('poster="#"')
    expect(sanitizeCampaignHtml('<button formaction="javascript:alert(1)">go</button>')).toContain('formaction="#"')
    expect(sanitizeCampaignHtml('<td background="data:text/html,x">c</td>')).toContain('background="#"')
    // a legitimate http(s) value is untouched
    expect(sanitizeCampaignHtml('<video poster="https://cdn/p.png"></video>')).toContain('poster="https://cdn/p.png"')
  })

  it('scrubs the inline style attribute (a remote url() is a tracking pixel)', () => {
    const out = sanitizeCampaignHtml('<td style="background:url(https://tracker/x.gif)">hi</td>')
    expect(out).not.toMatch(/url\(\s*['"]?https:\/\/tracker/i)
    expect(out).toContain('hi')
    // parked behind the CRM's unresolvable scheme (or dropped) — never live
    if (/tracker/.test(out)) expect(out).toContain('x-un1t-blocked:https://tracker/x.gif')
  })

  it('scrubs a single-quoted inline style and cannot break out of the attribute', () => {
    const out = sanitizeCampaignHtml("<p style='background:url(\"https://tracker/y.gif\")'>hi</p>")
    expect(out).not.toMatch(/url\(\s*['"]?https:\/\/tracker/i)
    expect(out).not.toMatch(/<p[^>]*>[^<]*"/)
    expect(out).toContain('hi')
  })

  it('keeps a harmless inline style', () => {
    expect(sanitizeCampaignHtml('<p style="color:red">hi</p>')).toContain('style="color:red"')
  })

  it('the `\\s+>` collapse is gone: text nodes and attribute values keep their spacing', () => {
    // It ran over the WHOLE finished document, so every ` >` in ordinary copy
    // or in an attribute was rewritten. `5 > 3` became `5> 3`.
    expect(sanitizeCampaignHtml('<p>book if 5 > 3</p>')).toBe('<p>book if 5 > 3</p>')
    expect(sanitizeCampaignHtml('<a href="https://ok" title="a > b">x</a>'))
      .toBe('<a href="https://ok" title="a > b">x</a>')
  })

  it('a CSS child combinator loses its `>` to scrubCss, NOT to this sanitizer', () => {
    // Pinned so the loss is not re-attributed to the deleted `\s+>` collapse:
    // scrubCss (email-html.js) ends with `.replace(/[<>]/g, '')`, which is the
    // guarantee that a <style> body can never reconstitute a tag. `.a > .b`
    // therefore arrives as a DESCENDANT selector — a real (pre-existing,
    // out-of-scope) fidelity loss for Canva/Unlayer exports, not a security
    // one. Whitespace either side is preserved now, which is all this change
    // can do about it.
    expect(sanitizeCampaignHtml('<style>.a > .b{color:red}</style><p>x</p>'))
      .toBe('<style>.a  .b{color:red}</style><p>x</p>')
  })
})

// ---------------------------------------------------------------------------
// THIRD security review — the same defect class, third instance.
//
// The stranded-placeholder drop was written as
// `insideOpenTag(whole, offset) ? '' : <restore>` INSIDE the restore step,
// i.e. a DELETION PERFORMED AFTER the last strip pass, whose splice nothing
// ever re-scanned. That is exactly the shape of the viewport-meta bypass the
// previous review fixed, and it shipped the same live payloads — this time
// with no decoy meta needed, because the host's own `<style>` element is the
// saw:
//
//   <img src=x on<style>a{color:red}</style>error=alert(1)>  → live onerror
//   <scr<style>…</style>ipt>alert(1)                          → live <script>
//   <a href="javascri<style>…</style>pt:alert(1)">            → javascript:
//   <ifra<style>…</style>me src="https://evil.example/">      → live <iframe>
//   <ba<style>…</style>se href="//evil.example/">             → live <base>
//   <p>Sale!</p><sty<style>…</style>le>                       → unclosed
//     <style> that swallows the server-injected footer
//
// The earlier splice tests all missed it because every one of them opened
// with a decoy `<meta name=viewport>`, which absorbed the single viewport
// placeholder and left the injected device to be stripped normally. THE
// PAYLOADS BELOW CARRY NO DECOY.
//
// The fix is structural, and the invariant is now stated on
// sanitizeCampaignHtml: every deletion (the strip passes AND the stranded-
// placeholder drop) happens inside ONE outer fixed point that re-scans, and
// restoration only ever INSERTS, at positions the final round proved lie
// outside any open tag.
// ---------------------------------------------------------------------------
describe('sanitizeCampaignHtml — stranded-placeholder splice bypass (third security review)', () => {
  // Two devices, one payload table. Either element gets lifted out of the
  // document before the strip passes run, so either can saw a construct in
  // half; the <style> one needs no meta at all.
  const DEVICES = {
    style: '<style>a{color:red}</style>',
    viewport: '<meta name="viewport" content="w">',
  }

  const styleTagsBalanced = (out) => {
    const open = (out.match(/<style\b/gi) || []).length
    const close = (out.match(/<\/style\b/gi) || []).length
    expect(open).toBe(close)
  }

  const PAYLOADS = [
    {
      name: 'an on* handler sawn in half',
      html: (d) => `<img src=x on${d}error=alert(1)>`,
      check: (out) => {
        expect(out).not.toMatch(/onerror/i)
        expect(out).not.toContain('alert(1)')
      },
    },
    {
      name: 'a <script> open tag sawn in half',
      html: (d) => `<scr${d}ipt>alert(1)`,
      check: (out) => {
        expect(out).not.toContain('<script')
        expect(out).not.toMatch(/<scr/i)
      },
    },
    {
      name: 'a javascript: href sawn in half',
      html: (d) => `<a href="javascri${d}pt:alert(1)">x</a>`,
      check: (out) => {
        expect(out).not.toMatch(/javascript:/i)
        expect(out).toContain('href="#"')
      },
    },
    {
      name: 'an <iframe> sawn in half',
      html: (d) => `<ifra${d}me src="https://evil.example/">`,
      check: (out) => {
        expect(out).not.toMatch(/<\/?iframe/i)
        expect(out).not.toContain('evil.example')
      },
    },
    {
      name: 'a <base> sawn in half',
      html: (d) => `<ba${d}se href="//evil.example/">`,
      check: (out) => {
        expect(out).not.toMatch(/<base\b/i)
        expect(out).not.toContain('evil.example')
      },
    },
    {
      name: 'an unclosed <style> sawn in half (would swallow the injected footer)',
      html: (d) => `<p>Sale!</p><sty${d}le>`,
      check: (out) => {
        expect(out).toContain('<p>Sale!</p>')
        // The footer is appended AFTER this sanitizer runs, so an unclosed
        // <style> here eats it. Balance is the assertion that matters.
        styleTagsBalanced(out)
        expect(out).not.toMatch(/<style/i)
      },
    },
  ]

  for (const [deviceName, device] of Object.entries(DEVICES)) {
    for (const payload of PAYLOADS) {
      it(`${payload.name} — spliced with a ${deviceName} placeholder, NO decoy meta`, () => {
        payload.check(sanitizeCampaignHtml(payload.html(device)))
      })
    }
  }

  it('the same payloads never reassemble when the footer is appended after them', () => {
    // renderHostCampaignHtml injects the footer AFTER sanitization; the
    // unclosed-<style> payload is the one that could hide it.
    const html = renderHostCampaignHtml({
      host: { name: 'Acme', sender_name: 'Acme' },
      subject: 's',
      bodyHtml: '<p>Sale!</p><sty<style>a{color:red}</style>le>',
      unsubscribeUrl: 'https://x/u/t',
    })
    expect(html).toContain('Unsubscribe')
    expect(html).toContain('attended an event or joined the mailing list')
    styleTagsBalanced(html)
  })
})

describe('sanitizeCampaignHtml — quote-aware open-tag scan (third security review)', () => {
  it('a bare `<` in ordinary copy does NOT strand a legitimate <style> block', () => {
    // FALSE POSITIVE in the old `lastIndexOf('<') > lastIndexOf('>')` test:
    // `5 < 6` looked like an unclosed tag, so the placeholder after it read as
    // stranded and the whole (perfectly legitimate) style block was silently
    // deleted from the email. HTML opens a tag only on `<` + letter/`/`/`!`/`?`.
    const out = sanitizeCampaignHtml('5 < 6 and <style>a{color:red}</style> here')
    expect(out).toBe('5 < 6 and <style>a{color:red}</style> here')
  })

  it('a `>` inside a quoted attribute value does NOT close the tag — no <style> is restored inside it', () => {
    // FALSE NEGATIVE in the old test: the `>` in title="a>b" moved
    // lastIndexOf('>') past the `<`, so a placeholder genuinely inside the tag
    // read as outside it and a real <style> element was restored into the
    // attribute list.
    const out = sanitizeCampaignHtml('<img title="a>b" style="<style>a{color:red}</style>">')
    expect(out).not.toContain('<style')
    expect(out).not.toContain('color:red')
    expect(out).not.toMatch(/<img[^>]*<style/)
    expect(out).toContain('title="a>b"')
  })

  it('a <style> block inside an HTML comment is dropped, not restored', () => {
    const out = sanitizeCampaignHtml('<!-- draft <style>a{color:red}</style> --><p>x</p>')
    expect(out).not.toContain('<style')
    expect(out).toContain('<p>x</p>')
  })
})

describe('sanitizeCampaignHtml — footer-swallowing tags (third security review)', () => {
  it('strips <plaintext>, which can never be closed and would eat the footer', () => {
    const out = sanitizeCampaignHtml('<p>x</p><plaintext>hidden footer')
    expect(out).not.toMatch(/<plaintext/i)
    expect(out).toContain('<p>x</p>')
    expect(out).toContain('hidden footer') // the TAG goes, its text stays
  })

  it('strips <textarea>, <noscript>, <noembed>, <xmp> and <template> the same way', () => {
    const out = sanitizeCampaignHtml(
      '<textarea>a</textarea><noscript>b</noscript><noembed>c</noembed><xmp>d</xmp><template>e</template>'
    )
    expect(out).not.toMatch(/<\/?(textarea|noscript|noembed|xmp|template)\b/i)
    expect(out).toBe('abcde')
  })
})

describe('sanitizeCampaignHtml — inline-style CSS budget is per pass, not per document', () => {
  it('a 2,000-cell table keeps every inline style', () => {
    // REGRESSION for counter amplification. The budget (CSS_TOTAL_MAX_CHARS,
    // 250,000) used to be a single per-document counter shared by every
    // fixed-point pass, so the passes multiplied against it: this document
    // spends 88,000 characters per scan, and three scans would exhaust the
    // budget and make scrubCss start returning '' — silently wiping every
    // inline style in an entirely legitimate marketing email. It is now reset
    // at the top of each pass, because the bound is meant to size ONE linear
    // scan of the document.
    const CELL = 'color:#ff0000;padding:4px 8px;font-size:14px'
    const html = `<table>${Array.from({ length: 2000 }, (_, i) => `<tr><td style="${CELL}">c${i}</td></tr>`).join('')}</table>`
    const out = sanitizeCampaignHtml(html)
    expect((out.match(/style="color:#ff0000;padding:4px 8px;font-size:14px"/g) || [])).toHaveLength(2000)
    expect(out).toContain('c1999')
  })
})

describe('sanitizeCampaignHtml — the outer fixed point fails CLOSED', () => {
  // A drop→strip→drop chain that costs one outer round per link. Each link is
  //   `<lin` + <inner> + <style>…</style> + `k>`
  // The inner construct collapses to nothing, splicing `<lin` onto `k>` to
  // make a fresh `<link>` — which the NEXT round strips, stranding the next
  // placeholder, and so on. Depth n needs n+2 rounds, so anything past
  // MAX_OUTER_PASSES - 2 exhausts the bound.
  const S = '<style>a{}</style>'
  const chain = (n) => {
    let s = `<lin${S}k>`
    for (let i = 2; i <= n; i++) s = `<lin${s}${S}k>`
    return s
  }

  it('a chain that converges inside the bound sanitizes normally and keeps the rest of the body', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = sanitizeCampaignHtml(`${chain(5)}<p>keep me</p>`)
      expect(out).toBe('<p>keep me</p>')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('a chain that does NOT converge returns the empty string and warns', () => {
    // Fail closed, loudly: an unconverged document is by definition one whose
    // last deletion was never re-scanned, which is precisely the state all
    // three bypasses shipped from. The legitimate `<p>keep me</p>` is dropped
    // too — that is the trade, and an empty campaign body is something an
    // operator sees and reports.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = sanitizeCampaignHtml(`${chain(25)}<p>keep me</p>`)
      expect(out).toBe('')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/failed closed/)
    } finally {
      warn.mockRestore()
    }
  })
})
