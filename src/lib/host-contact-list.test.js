import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  hostTagFor,
  isEmailable,
  emailabilityReason,
  addEventAttendeesToHostList,
  fetchHostContactRows,
  eventTagFor,
} from './host-contact-list'
import { writeContactTag } from '@/lib/contact-tags'

// HOST-MASTER.5 — writeContactTag is mocked per the estate's idiom
// (glofox-push.test.js): the real contact_tags dual-write/sequence-fire
// behaviour is covered by contact-tags.test.js; here we only assert
// addEventAttendeesToHostList calls it with the right args and swallows
// its failures.
vi.mock('@/lib/contact-tags', () => ({
  writeContactTag: vi.fn(async () => ({ written: true, tag: 'mocked', alreadyPresent: false })),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

describe('hostTagFor', () => {
  it('prefers the slug when set', () => {
    expect(hostTagFor({ slug: 'acme-events', name: 'Something Else' })).toBe('host:acme-events')
  })
  it('derives from the name when there is no slug: lowercased, non-alnum → -', () => {
    expect(hostTagFor({ slug: null, name: 'Acme Events & Co.' })).toBe('host:acme-events-co')
  })
  it('trims leading/trailing dashes', () => {
    expect(hostTagFor({ name: '  !!Acme!!  ' })).toBe('host:acme')
  })
  it('falls back to a non-empty tag for degenerate input', () => {
    expect(hostTagFor({ name: '###' })).toBe('host:host')
    expect(hostTagFor({})).toBe('host:host')
    expect(hostTagFor(null)).toBe('host:host')
  })
})

describe('eventTagFor', () => {
  it('builds event:<slug>', () => expect(eventTagFor({ slug: 'pride-sep20' })).toBe('event:pride-sep20'))
  it('falls back to normalised name then event', () => {
    expect(eventTagFor({ slug: null, name: 'Pride Run 5K' })).toBe('event:pride-run-5k')
    expect(eventTagFor({})).toBe('event:event')
  })
})

describe('isEmailable', () => {
  // HOST-CONSENT.1 — the marketing gate is host_contacts.marketing_consent
  // (opts.hostConsent), passed in by the caller, not contacts.email_marketing:
  //   no host_email_suppressions row, hostConsent === true,
  //   email_status NOT IN ('bounced','complained'), email_suppressed_at IS NULL
  // email_marketing stays on the fixture (later tasks drop it from selects)
  // but no longer participates in the predicate — see the nested describe
  // below for the tests proving that.
  const good = { email: 'a@b.ie', email_marketing: true, email_status: 'active', email_suppressed_at: null }

  it('is true for a consented contact with an email and clean flags', () => {
    expect(isEmailable(good, false, { hostConsent: true })).toBe(true)
  })
  it('is false without an email address', () => {
    expect(isEmailable({ ...good, email: null }, false, { hostConsent: true })).toBe(false)
    expect(isEmailable({ ...good, email: '' }, false, { hostConsent: true })).toBe(false)
  })
  it('is false when bounced / complained', () => {
    expect(isEmailable({ ...good, email_status: 'bounced' }, false, { hostConsent: true })).toBe(false)
    expect(isEmailable({ ...good, email_status: 'complained' }, false, { hostConsent: true })).toBe(false)
  })
  it('tolerates a missing/other email_status — incl. retired unsubscribed (mig 492)', () => {
    expect(isEmailable({ ...good, email_status: null }, false, { hostConsent: true })).toBe(true)
    expect(isEmailable({ ...good, email_status: undefined }, false, { hostConsent: true })).toBe(true)
    expect(isEmailable({ ...good, email_status: 'unsubscribed' }, false, { hostConsent: true })).toBe(true)
  })
  it('is false when inactivity-suppressed (email_suppressed_at set, mig 395)', () => {
    expect(isEmailable({ ...good, email_suppressed_at: '2026-01-01T00:00:00Z' }, false, { hostConsent: true })).toBe(false)
  })
  it('is false when per-host suppressed', () => {
    expect(isEmailable(good, true, { hostConsent: true })).toBe(false)
  })
  it('is false for a missing contact (defensive)', () => {
    expect(isEmailable(null, false, { hostConsent: true })).toBe(false)
    expect(isEmailable(undefined, false, { hostConsent: true })).toBe(false)
  })

  describe('HOST-CONSENT.1 — host consent replaces the UN1T flag for marketing', () => {
    const optedOutOfUn1t = { ...good, email_marketing: false }

    it('is TRUE for a contact opted out of UN1T marketing but consented to the host', () => {
      expect(isEmailable(optedOutOfUn1t, false, { hostConsent: true })).toBe(true)
    })
    it('is FALSE when host consent is false, even with UN1T consent true', () => {
      expect(isEmailable(good, false, { hostConsent: false })).toBe(false)
      expect(isEmailable(good, false, { hostConsent: null })).toBe(false)
    })
    it('fails CLOSED when hostConsent is omitted', () => {
      expect(isEmailable(good, false)).toBe(false)
      expect(isEmailable(good, false, {})).toBe(false)
    })
    it('still blocks a per-host suppression with host consent true', () => {
      expect(isEmailable(good, true, { hostConsent: true })).toBe(false)
    })
    it('still blocks mailbox facts with host consent true', () => {
      expect(isEmailable({ ...good, email_status: 'bounced' }, false, { hostConsent: true })).toBe(false)
      expect(isEmailable({ ...good, email_status: 'complained' }, false, { hostConsent: true })).toBe(false)
      expect(isEmailable({ ...good, email_suppressed_at: '2026-08-11T05:45:14Z' }, false, { hostConsent: true })).toBe(false)
    })
    it('utility ignores hostConsent entirely (administrative consent + mailbox facts only)', () => {
      const admin = { ...good, email_administrative: true, email_marketing: false }
      expect(isEmailable(admin, true, { emailType: 'utility', hostConsent: false })).toBe(true)
    })
  })
})

describe('emailabilityReason (HOST-METRICS.1)', () => {
  const good = { email: 'a@b.ie', email_status: 'active', email_suppressed_at: null }
  it('null when mailable', () => expect(emailabilityReason(good, false, { hostConsent: true })).toBeNull())
  it('no_email', () => expect(emailabilityReason({ ...good, email: null }, false, { hostConsent: true })).toBe('no_email'))
  it('null contact → no_email', () => expect(emailabilityReason(null, false, { hostConsent: true })).toBe('no_email'))
  it('mailbox_blocked for the repeat-bounce stamp, bounced and complained', () => {
    expect(emailabilityReason({ ...good, email_suppressed_at: '2026-08-11T05:45:14Z' }, false, { hostConsent: true })).toBe('mailbox_blocked')
    expect(emailabilityReason({ ...good, email_status: 'bounced' }, false, { hostConsent: true })).toBe('mailbox_blocked')
    expect(emailabilityReason({ ...good, email_status: 'complained' }, false, { hostConsent: true })).toBe('mailbox_blocked')
  })
  it('host_unsubscribed beats no_host_consent (a revoke sets both)', () => {
    expect(emailabilityReason(good, true, { hostConsent: false })).toBe('host_unsubscribed')
  })
  it('no_host_consent', () => expect(emailabilityReason(good, false, { hostConsent: false })).toBe('no_host_consent'))
  it('utility: no_administrative_consent, and hostConsent/suppressed ignored', () => {
    expect(emailabilityReason({ ...good, email_administrative: false }, true, { emailType: 'utility' })).toBe('no_administrative_consent')
    expect(emailabilityReason({ ...good, email_administrative: true }, true, { emailType: 'utility', hostConsent: false })).toBeNull()
  })
  it('isEmailable is exactly reason === null', () => {
    expect(isEmailable(good, false, { hostConsent: true })).toBe(true)
    expect(isEmailable(good, true, { hostConsent: true })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// addEventAttendeesToHostList — fakeDb mirrors the host-events.test.js pattern.
// regPages: array of pages served to successive .range() calls.
// ---------------------------------------------------------------------------
function fakeListDb({
  race, regPages = [], upsertError = null,
  host = null, hostError = null, contactsById = {}, contactsLoadError = null,
  existingTaggedPairs = [], precheckError = null,
} = {}) {
  const calls = {
    upserts: [], regQueries: [], contactsSelects: [], contactsUpdates: [], precheckQueries: [],
  }
  let regCall = 0
  return {
    calls,
    from(table) {
      if (table === 'race_events') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: race, error: null }) }) }),
        }
      }
      if (table === 'race_registrations') {
        return {
          select: (cols) => {
            const filters = []
            const builder = {
              eq: (col, val) => { filters.push([col, val]); return builder },
              order: () => builder,
              range: async (from, to) => {
                calls.regQueries.push({ cols, filters: [...filters], from, to })
                const page = regPages[regCall] || []
                regCall++
                return { data: page, error: null }
              },
            }
            return builder
          },
        }
      }
      if (table === 'host_contacts') {
        return {
          upsert: async (rows, opts) => {
            calls.upserts.push({ rows, opts })
            return { error: upsertError }
          },
        }
      }
      if (table === 'event_hosts') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: host, error: hostError }) }) }),
        }
      }
      if (table === 'contacts') {
        return {
          select: (cols) => ({
            in: async (col, ids) => {
              calls.contactsSelects.push({ cols, col, ids: [...ids] })
              if (contactsLoadError) return { data: null, error: contactsLoadError }
              const data = ids.map((id) => contactsById[id]).filter(Boolean)
              return { data, error: null }
            },
          }),
          update: (patch) => ({
            eq: async (col, val) => {
              calls.contactsUpdates.push({ patch, id: val })
              return { error: null }
            },
          }),
        }
      }
      if (table === 'contact_tags') {
        return {
          select: (cols) => {
            const filters = {}
            const builder = {
              in: (col, vals) => { filters[col] = [...vals]; return builder },
              is: async (col, val) => {
                calls.precheckQueries.push({ cols, filters, isCol: col, isVal: val })
                if (precheckError) return { data: null, error: precheckError }
                return { data: existingTaggedPairs, error: null }
              },
            }
            return builder
          },
        }
      }
      throw new Error('unexpected table ' + table)
    },
  }
}

const reg = (contactIds) => ({
  id: 'r-' + contactIds.join('-'),
  teams: { team_members: contactIds.map((c) => ({ contact_id: c })) },
})

// ---------------------------------------------------------------------------
// HOST-CONSENT.1 — fakeListDb only models select/upsert on host_contacts, not
// the `update` grantHostConsentBulk issues. makeRecorder is a generic
// chainable statement recorder (used ONLY by the two HOST-CONSENT.1 tests
// below) so the real host-consent.js module can run unmocked against it and
// the update statement it issues is visible for assertions.
// ---------------------------------------------------------------------------
function makeRecorder(route) {
  const statements = []
  const db = {
    from(table) {
      const state = { table, ops: [] }
      statements.push(state)
      const b = new Proxy({}, {
        get(_, method) {
          if (method === 'then') {
            const p = Promise.resolve(route(state) ?? { data: null, error: null })
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
const opOf = (s, m) => s.ops.find((o) => o.method === m)

function fakeSyncDb(cfg) {
  return makeRecorder((state) => {
    const { table, ops } = state
    if (table === 'race_events') return { data: cfg.race, error: null }
    if (table === 'race_registrations') return { data: cfg.registrations, error: null }
    if (table === 'event_hosts') return { data: { id: 'h1', slug: 'run', name: 'Run' }, error: null }
    if (table === 'contacts') {
      const hasSelect = ops.some((o) => o.method === 'select')
      return hasSelect ? { data: [], error: null } : { data: null, error: null }
    }
    if (table === 'host_contacts') {
      const updateOp = ops.find((o) => o.method === 'update')
      if (updateOp) {
        if (cfg.throwOnHostContactsUpdate && ops[0]?.method === 'update') {
          throw new Error('host_contacts update boom')
        }
        const inOp = ops.find((o) => o.method === 'in')
        const ids = inOp ? inOp.args[1] : []
        return { data: ids.map((id) => ({ contact_id: id })), error: null }
      }
      return { data: [], error: null }
    }
    if (table === 'host_email_suppressions') return { data: cfg.suppressions ?? [], error: null }
    return { data: [], error: null }
  })
}

describe('addEventAttendeesToHostList', () => {
  it('returns 0 and never upserts when the race does not exist', async () => {
    const db = fakeListDb({ race: null })
    expect(await addEventAttendeesToHostList(db, 'ev1')).toBe(0)
    expect(db.calls.upserts).toEqual([])
  })

  it('returns 0 and never upserts for an internal (no host_id) event', async () => {
    const db = fakeListDb({ race: { id: 'ev1', host_id: null } })
    expect(await addEventAttendeesToHostList(db, 'ev1')).toBe(0)
    expect(db.calls.upserts).toEqual([])
  })

  it('only queries CONFIRMED registrations for this race', async () => {
    const db = fakeListDb({ race: { id: 'ev1', host_id: 'h1' }, regPages: [[reg(['c1'])]] })
    await addEventAttendeesToHostList(db, 'ev1')
    expect(db.calls.regQueries[0].filters).toEqual([
      ['race_event_id', 'ev1'],
      ['status', 'confirmed'],
    ])
  })

  it('dedupes contact ids, skips members without a contact_id, upserts the right shape', async () => {
    const db = fakeListDb({
      race: { id: 'ev1', host_id: 'h1' },
      regPages: [[
        reg(['c1', 'c2']),
        { id: 'r3', teams: { team_members: [{ contact_id: 'c2' }, { contact_id: null }, {}] } },
        { id: 'r4', teams: null }, // registration with no team — tolerated
      ]],
    })
    const count = await addEventAttendeesToHostList(db, 'ev1')
    expect(count).toBe(2)
    expect(db.calls.upserts).toHaveLength(1)
    expect(db.calls.upserts[0].opts).toEqual({ onConflict: 'host_id,contact_id', ignoreDuplicates: true })
    expect(db.calls.upserts[0].rows).toEqual([
      { host_id: 'h1', contact_id: 'c1', source: 'event', source_event_id: 'ev1' },
      { host_id: 'h1', contact_id: 'c2', source: 'event', source_event_id: 'ev1' },
    ])
  })

  it('returns 0 without upserting when no confirmed member has a contact_id', async () => {
    const db = fakeListDb({
      race: { id: 'ev1', host_id: 'h1' },
      regPages: [[{ id: 'r1', teams: { team_members: [{ contact_id: null }] } }]],
    })
    expect(await addEventAttendeesToHostList(db, 'ev1')).toBe(0)
    expect(db.calls.upserts).toEqual([])
  })

  it('paginates past the 1000-row select cap and chunks upserts at 500', async () => {
    // Page 1: exactly 1000 regs (forces a second range call), page 2: 5 more.
    const page1 = Array.from({ length: 1000 }, (_, i) => reg([`c${i}`]))
    const page2 = Array.from({ length: 5 }, (_, i) => reg([`d${i}`]))
    const db = fakeListDb({ race: { id: 'ev1', host_id: 'h1' }, regPages: [page1, page2] })

    const count = await addEventAttendeesToHostList(db, 'ev1')
    expect(count).toBe(1005)
    expect(db.calls.regQueries).toHaveLength(2)
    expect(db.calls.regQueries[0]).toMatchObject({ from: 0, to: 999 })
    expect(db.calls.regQueries[1]).toMatchObject({ from: 1000, to: 1999 })
    expect(db.calls.upserts.map((u) => u.rows.length)).toEqual([500, 500, 5])
  })

  it('throws on an upsert error (callers are fire-and-forget with their own catch)', async () => {
    const db = fakeListDb({
      race: { id: 'ev1', host_id: 'h1' },
      regPages: [[reg(['c1'])]],
      upsertError: { message: 'boom' },
    })
    await expect(addEventAttendeesToHostList(db, 'ev1')).rejects.toThrow(/boom/)
  })

  // HOST-MASTER.5 — each confirmed attendee ALSO gets the host tag + the
  // per-event tag, in BOTH tag systems (subscribe-route pattern).
  describe('tagging attendees (HOST-MASTER.5)', () => {
    beforeEach(() => {
      writeContactTag.mockClear()
      writeContactTag.mockResolvedValue({ written: true, tag: 'mocked', alreadyPresent: false })
    })

    const race = { id: 'ev1', host_id: 'h1', slug: 'pride-run', name: 'Pride Run' }
    const host = { id: 'h1', slug: 'acme', name: 'Acme Events' }

    it('tags each confirmed attendee with the host and event tags', async () => {
      const contactsById = {
        c1: { id: 'c1', location_id: 'loc1', tags: ['other'] },                       // missing both
        c2: { id: 'c2', location_id: 'loc2', tags: ['host:acme'] },                    // missing event tag only
        c3: { id: 'c3', location_id: 'loc3', tags: ['host:acme', 'event:pride-run'] }, // already has both
      }
      const db = fakeListDb({
        race, host, contactsById,
        regPages: [[reg(['c1', 'c2', 'c3'])]],
      })

      const count = await addEventAttendeesToHostList(db, 'ev1')
      expect(count).toBe(3)

      // contact_tags dual-write — both tags, per contact, using the CONTACT's
      // own location_id (host-event contacts live at the org master location;
      // tags must follow the contact).
      expect(writeContactTag).toHaveBeenCalledTimes(6)
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c1', locationId: 'loc1', tag: 'host:acme' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c1', locationId: 'loc1', tag: 'event:pride-run' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c2', locationId: 'loc2', tag: 'host:acme' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c2', locationId: 'loc2', tag: 'event:pride-run' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c3', locationId: 'loc3', tag: 'host:acme' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c3', locationId: 'loc3', tag: 'event:pride-run' })

      // contacts.tags append-if-missing: one union update per contact that's
      // missing anything; a contact with both tags already present gets NO
      // update call at all.
      expect(db.calls.contactsUpdates).toHaveLength(2)
      const c1Update = db.calls.contactsUpdates.find((u) => u.id === 'c1')
      expect(new Set(c1Update.patch.tags)).toEqual(new Set(['other', 'host:acme', 'event:pride-run']))
      const c2Update = db.calls.contactsUpdates.find((u) => u.id === 'c2')
      expect(new Set(c2Update.patch.tags)).toEqual(new Set(['host:acme', 'event:pride-run']))
      expect(db.calls.contactsUpdates.some((u) => u.id === 'c3')).toBe(false)
    })

    it('tag failures do not throw past the sync', async () => {
      writeContactTag.mockRejectedValue(new Error('tag write boom'))
      const contactsById = { c1: { id: 'c1', location_id: 'loc1', tags: [] } }
      const db = fakeListDb({ race, host, contactsById, regPages: [[reg(['c1'])]] })

      await expect(addEventAttendeesToHostList(db, 'ev1')).resolves.toBe(1)
      expect(writeContactTag).toHaveBeenCalledTimes(2) // still attempted both tags
    })

    // HOST-MASTER.5b — a failed/TOCTOU-missing host load must never fall
    // back to hostTagFor(null)'s degenerate 'host:host' tag.
    it('skips all attendee tagging when the host load errors', async () => {
      const contactsById = { c1: { id: 'c1', location_id: 'loc1', tags: [] } }
      const db = fakeListDb({
        race, host: null, hostError: { message: 'boom' }, contactsById,
        regPages: [[reg(['c1'])]],
      })

      const count = await addEventAttendeesToHostList(db, 'ev1')
      expect(count).toBe(1) // host_contacts upsert count is unaffected
      expect(writeContactTag).not.toHaveBeenCalled()
      expect(db.calls.contactsSelects).toEqual([]) // never even loads attendee contacts
      expect(db.calls.contactsUpdates).toEqual([])
    })

    it('skips all attendee tagging when the host row is missing (deleted host, no query error)', async () => {
      const contactsById = { c1: { id: 'c1', location_id: 'loc1', tags: [] } }
      const db = fakeListDb({ race, host: null, contactsById, regPages: [[reg(['c1'])]] })

      const count = await addEventAttendeesToHostList(db, 'ev1')
      expect(count).toBe(1)
      expect(writeContactTag).not.toHaveBeenCalled()
    })

    // HOST-MASTER.5b — batched contact_tags delta pre-check per chunk:
    // pairs already active are skipped, only the gaps go through
    // writeContactTag (steady-state re-confirmations cost ~1 query, not
    // ~2 per attendee).
    it('skips writeContactTag for pairs the batched pre-check finds already active', async () => {
      const contactsById = {
        c1: { id: 'c1', location_id: 'loc1', tags: [] },
        c2: { id: 'c2', location_id: 'loc2', tags: [] },
      }
      const db = fakeListDb({
        race, host, contactsById,
        regPages: [[reg(['c1', 'c2'])]],
        existingTaggedPairs: [{ contact_id: 'c1', tag: 'host:acme' }],
      })

      await addEventAttendeesToHostList(db, 'ev1')

      expect(db.calls.precheckQueries).toHaveLength(1)
      expect(db.calls.precheckQueries[0].filters).toEqual({
        contact_id: ['c1', 'c2'],
        tag: ['host:acme', 'event:pride-run'],
      })
      // c1:host:acme is the only pre-tagged pair — skipped. The other 3 go through.
      expect(writeContactTag).toHaveBeenCalledTimes(3)
      expect(writeContactTag).not.toHaveBeenCalledWith(db, { contactId: 'c1', locationId: 'loc1', tag: 'host:acme' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c1', locationId: 'loc1', tag: 'event:pride-run' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c2', locationId: 'loc2', tag: 'host:acme' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c2', locationId: 'loc2', tag: 'event:pride-run' })
    })

    it('falls back to calling writeContactTag for every pair when the pre-check errors (fail-open — writeContactTag is idempotent on its own)', async () => {
      const contactsById = { c1: { id: 'c1', location_id: 'loc1', tags: [] } }
      const db = fakeListDb({
        race, host, contactsById,
        regPages: [[reg(['c1'])]],
        precheckError: { message: 'precheck boom' },
      })

      await addEventAttendeesToHostList(db, 'ev1')
      expect(writeContactTag).toHaveBeenCalledTimes(2)
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c1', locationId: 'loc1', tag: 'host:acme' })
      expect(writeContactTag).toHaveBeenCalledWith(db, { contactId: 'c1', locationId: 'loc1', tag: 'event:pride-run' })
    })
  })

  it('HOST-CONSENT.1 — grants host consent to registrants who ticked the box, not to their team-mates', async () => {
    const { db, statements } = fakeSyncDb({
      race: { id: 'r1', host_id: 'h1', slug: 'run', name: 'Run' },
      registrations: [
        { id: 'reg-1', contact_id: 'cap-1', marketing_consent: true,  teams: { team_members: [{ contact_id: 'cap-1' }, { contact_id: 'mate-1' }] } },
        { id: 'reg-2', contact_id: 'cap-2', marketing_consent: false, teams: { team_members: [{ contact_id: 'cap-2' }] } },
        { id: 'reg-3', contact_id: 'cap-3', marketing_consent: null,  teams: { team_members: [{ contact_id: 'cap-3' }] } },
      ],
    })
    await addEventAttendeesToHostList(db, 'r1')
    // membership for all four
    const upsert = statements.find((s) => s.table === 'host_contacts' && opOf(s, 'upsert'))
    expect(opOf(upsert, 'upsert').args[0].map((r) => r.contact_id).sort()).toEqual(['cap-1', 'cap-2', 'cap-3', 'mate-1'])
    // consent for cap-1 only (pre-588 NULL rows and unticked boxes grant nothing)
    const grant = statements.find((s) => s.table === 'host_contacts' && opOf(s, 'update'))
    expect(opOf(grant, 'in').args).toEqual(['contact_id', ['cap-1']])
    expect(opOf(grant, 'update').args[0]).toMatchObject({ marketing_consent: true, marketing_consent_source: 'event_form' })
  })

  it('HOST-CONSENT.1 — a ticked box does not re-open a prior host unsubscribe (no opt_in for a suppressed contact)', async () => {
    const { db, statements } = fakeSyncDb({
      race: { id: 'r1', host_id: 'h1', slug: 'run', name: 'Run' },
      registrations: [
        { id: 'reg-1', contact_id: 'cap-1', marketing_consent: true, teams: { team_members: [{ contact_id: 'cap-1' }] } },
        { id: 'reg-2', contact_id: 'cap-2', marketing_consent: true, teams: { team_members: [{ contact_id: 'cap-2' }] } },
      ],
      suppressions: [{ contact_id: 'cap-1' }],
    })
    await addEventAttendeesToHostList(db, 'r1')
    const grant = statements.find((s) => s.table === 'host_contacts' && opOf(s, 'update'))
    expect(opOf(grant, 'in').args).toEqual(['contact_id', ['cap-2']])
    const supQ = statements.find((s) => s.table === 'host_email_suppressions')
    expect(supQ.ops.some((o) => o.method === 'eq' && o.args[0] === 'host_id' && o.args[1] === 'h1')).toBe(true)
  })

  it('HOST-CONSENT.1 — a throwing grant does not abort the sync (tagging still runs)', async () => {
    const { db, statements } = fakeSyncDb({
      race: { id: 'r1', host_id: 'h1', slug: 'run', name: 'Run' },
      registrations: [{ id: 'reg-1', contact_id: 'cap-1', marketing_consent: true, teams: { team_members: [{ contact_id: 'cap-1' }] } }],
      throwOnHostContactsUpdate: true,
    })
    const n = await addEventAttendeesToHostList(db, 'r1')
    expect(n).toBe(1)
    expect(statements.some((s) => s.table === 'contacts')).toBe(true) // tagging block ran
  })

  it('HOST-CONSENT.1 — the registrations select carries contact_id and marketing_consent', async () => {
    const { db, statements } = fakeSyncDb({ race: { id: 'r1', host_id: 'h1', slug: 'run', name: 'Run' }, registrations: [] })
    await addEventAttendeesToHostList(db, 'r1')
    const regs = statements.find((s) => s.table === 'race_registrations')
    expect(opOf(regs, 'select').args[0]).toMatch(/contact_id, marketing_consent/)
  })
})

// ---------------------------------------------------------------------------
// fetchHostContactRows — membership join + suppression set → emailable rows.
// ---------------------------------------------------------------------------
function fakeRowsDb({ memberships = [], suppressions = [] } = {}) {
  const calls = { hostFilters: [], selects: [] }
  const pageBuilder = (table, rows) => ({
    select: (cols) => {
      calls.selects.push([table, cols])
      return {
        eq: (col, val) => {
          calls.hostFilters.push([table, col, val])
          // Chainable order — the real query adds a unique-id tiebreaker
          // after created_at (stable pagination across ties).
          const chain = { order: () => chain, range: async () => ({ data: rows, error: null }) }
          return chain
        },
      }
    },
  })
  return {
    calls,
    from(table) {
      if (table === 'host_contacts') return pageBuilder(table, memberships)
      if (table === 'host_email_suppressions') return pageBuilder(table, suppressions)
      throw new Error('unexpected table ' + table)
    },
  }
}

describe('fetchHostContactRows', () => {
  const membership = (contactId, contact, source = 'event', marketing_consent = true) => ({
    contact_id: contactId,
    source,
    created_at: '2026-07-01T10:00:00Z',
    marketing_consent,
    contact,
  })
  // email_marketing stays in the fixture on purpose: the host gate must IGNORE it (HOST-CONSENT.1).
  const goodContact = (id) => ({
    id, name: 'Pat', email: `${id}@x.ie`, email_marketing: true, email_status: 'active', email_suppressed_at: null,
  })

  it('scopes BOTH queries to the host_id (tenancy)', async () => {
    const db = fakeRowsDb()
    await fetchHostContactRows(db, 'h1')
    expect(db.calls.hostFilters).toEqual([
      ['host_contacts', 'host_id', 'h1'],
      ['host_email_suppressions', 'host_id', 'h1'],
    ])
  })

  it('HOST-CONSENT.1 — selects host_contacts.marketing_consent and the disambiguated contact join', async () => {
    const db = fakeRowsDb()
    await fetchHostContactRows(db, 'h1')
    const [, cols] = db.calls.selects.find(([t]) => t === 'host_contacts')
    expect(cols).toMatch(/marketing_consent/)
    expect(cols).toMatch(/contacts!contact_id/)
    expect(cols).not.toMatch(/email_marketing/)
  })

  it('returns rows with emailable computed via isEmailable', async () => {
    const db = fakeRowsDb({
      memberships: [
        membership('c1', goodContact('c1')),
        membership('c2', { ...goodContact('c2'), email_marketing: false }, 'mailing_list'),
      ],
    })
    const rows = await fetchHostContactRows(db, 'h1')
    expect(rows).toEqual([
      { contact_id: 'c1', name: 'Pat', email: 'c1@x.ie', source: 'event', created_at: '2026-07-01T10:00:00Z', marketing_consent: true, emailable: true },
      { contact_id: 'c2', name: 'Pat', email: 'c2@x.ie', source: 'mailing_list', created_at: '2026-07-01T10:00:00Z', marketing_consent: true, emailable: true },
    ])
  })

  it('HOST-CONSENT.1 — emailable follows host consent, not contacts.email_marketing', async () => {
    const db = fakeRowsDb({
      memberships: [
        membership('c1', { ...goodContact('c1'), email_marketing: false }, 'event', true),
        membership('c2', goodContact('c2'), 'event', false),
      ],
    })
    const rows = await fetchHostContactRows(db, 'h1')
    expect(rows.map((r) => [r.contact_id, r.emailable, r.marketing_consent])).toEqual([
      ['c1', true, true],
      ['c2', false, false],
    ])
  })

  it('marks per-host-suppressed contacts not emailable', async () => {
    const db = fakeRowsDb({
      memberships: [membership('c1', goodContact('c1'))],
      suppressions: [{ contact_id: 'c1' }],
    })
    const rows = await fetchHostContactRows(db, 'h1')
    expect(rows[0].emailable).toBe(false)
  })

  it('tolerates a membership row whose contact join is missing', async () => {
    const db = fakeRowsDb({ memberships: [membership('c1', null)] })
    const rows = await fetchHostContactRows(db, 'h1')
    expect(rows[0]).toMatchObject({ contact_id: 'c1', name: '', email: '', emailable: false })
  })
})

// HOST-EMAIL.6 — utility vs marketing consent families.
describe('isEmailable — utility emails', () => {
  const base = { email: 'a@x.com', email_marketing: false, email_administrative: true, email_status: 'active', email_suppressed_at: null }
  it('reaches admin-consented contacts regardless of marketing opt-out or host unsubscribe', () => {
    expect(isEmailable(base, false, { emailType: 'utility' })).toBe(true)
    expect(isEmailable(base, true, { emailType: 'utility' })).toBe(true)
    expect(isEmailable({ ...base, email_status: 'unsubscribed' }, false, { emailType: 'utility' })).toBe(true)
  })
  it('still blocks on missing admin consent and deliverability', () => {
    expect(isEmailable({ ...base, email_administrative: false }, false, { emailType: 'utility' })).toBe(false)
    expect(isEmailable({ ...base, email_status: 'bounced' }, false, { emailType: 'utility' })).toBe(false)
    expect(isEmailable({ ...base, email_status: 'complained' }, false, { emailType: 'utility' })).toBe(false)
    expect(isEmailable({ ...base, email_suppressed_at: '2026-01-01' }, false, { emailType: 'utility' })).toBe(false)
  })
  it('HOST-CONSENT.1 — marketing gate now runs on hostConsent, independent of email_marketing', () => {
    expect(isEmailable(base, false)).toBe(false) // no hostConsent → fails closed
    expect(isEmailable(base, false, { hostConsent: true })).toBe(true) // host consent, despite email_marketing:false
    expect(isEmailable(base, true, { hostConsent: true })).toBe(false) // per-host suppression still blocks
  })
})
