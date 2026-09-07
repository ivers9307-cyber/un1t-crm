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
  ]

  const HOST_CONTACTS = ['c1', 'c2', 'c3', 'c4'].map((id) => ({
    contact_id: id,
    marketing_consent: true,
    contact: { id, email: `${id}@x.ie`, email_marketing: true, email_status: 'active', email_suppressed_at: null },
  }))

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
    expect(out.map((r) => r.contact_id)).toEqual(['c1'])

    const sendsQuery = statements.find((s) => s.table === 'host_campaign_sends')
    expect(hasEq(sendsQuery, 'campaign_id', PARENT)).toBe(true)
    expect(hasEq(sendsQuery, 'status', 'sent')).toBe(true)
    for (const col of ['opened_at', 'clicked_at', 'bounced_at', 'complained_at', 'unsubscribed_at']) {
      expect(sendsQuery.ops.some((o) => o.method === 'is' && o.args[0] === col && o.args[1] === null)).toBe(true)
    }
    expect(sendsQuery.ops.some((o) => o.method === 'not' && o.args[0] === 'delivered_at')).toBe(true)

    const parentRead = statements.find((s) => s.table === 'host_campaigns')
    expect(hasEq(parentRead, 'id', PARENT)).toBe(true)
    expect(hasEq(parentRead, 'host_id', HOST_ID)).toBe(true)
  })

  it('a parent that is not this host\'s throws (no cross-host audience)', async () => {
    const { db } = makeDb(routeFor({ parent: null }))
    await expect(resolveHostRecipients(db, HOST_ID, { nonOpenersOf: PARENT })).rejects.toThrow(/parent campaign/)
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
    expect(out).toContain('<a href="https://ok">ok</a>')
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
