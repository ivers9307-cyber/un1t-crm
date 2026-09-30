// src/lib/agent/followups-checkin-claim.test.js
// CHECKINRISKS.1 (C106 a) — the first-class check-in was stamped AFTER the
// send, with a bare update whose { error } nobody read. A failed stamp left the
// contact a candidate, so every 15-minute tick sent the check-in again for up
// to 24 h.
//
// Now (CLAUDE.md, "Removing a silent failure", case c): the contact is CLAIMED
// before the send, by a conditional stamp (first_class_checkin_at IS NULL), and
// the claim carries a LEASE: a claim older than CHECKIN_CLAIM_LEASE_MS with no
// recorded outcome (no agent_checkin activity, no agent message since the
// claim) is re-opened by a later tick, so a process killed between claim and
// send costs a delay, not the check-in. A claim that cannot be written sends
// nothing this tick (the next tick retries); a duplicate is possible only when
// both outcome records are lost, and that is logged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))
const events = []
const sendTemplateMessage = vi.fn(async () => { events.push('send'); return { messageId: 'wamid.test' } })
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.test' })),
  headerComponentFor: () => null,
  getOrCreateConversation: vi.fn(async () => 'conv1'),
}))
vi.mock('@/lib/radar-outreach', () => ({ extractTemplateBody: () => ({ varCount: 0 }) }))

import { runFirstClassCheckins, CHECKIN_CLAIM_LEASE_MS } from './followups'

const H = 3600_000
const NOW = Date.UTC(2026, 8, 25, 13, 0, 0) // 14:00 Dublin
const LOCATION = {
  id: 'loc1', name: 'Stillorgan',
  settings: { customer_agent: { enabled: true, first_class_checkin: { enabled: true, delay_hours: 2, template_name: 'agent_first_class_checkin_v1' } } },
}
const CONTACT = {
  id: 'c1', first_name: 'Alex', name: 'Alex Example', wa_phone: '353870000000', phone: '353870000000',
  pipeline_stage_slug: 'first_class', last_attended_at: new Date(NOW - 3 * H).toISOString(),
  first_class_checkin_at: null, recent_bookings: [], wa_status: 'active',
}
const APPROVED = [{ name: 'agent_first_class_checkin_v1', language: 'en', status: 'APPROVED', components: [], header_media_url: null }]
const BOOM = { message: 'canceling statement due to statement timeout', code: '57014' }

// A stub that records every chain (table, op, patch, filters) and answers
// through `answer(q)`, so a test can tell the claim, the release, the
// re-open and the reads apart by their filters.
function stubDb(answer = () => undefined) {
  const log = []
  return {
    log,
    from(table) {
      const q = { table, op: 'select', patch: null, filters: [], opts: null }
      const def = () => {
        if (table === 'locations') return { data: [LOCATION], error: null }
        if (table === 'contacts' && q.op === 'select') {
          if (q.opts?.head) return { count: 0, error: null }
          if (q.filters.some((f) => f[0] === 'is' && f[1] === 'first_class_checkin_at')) return { data: [CONTACT], error: null }
          return { data: [], error: null } // stale-claim scan: none by default
        }
        if (table === 'contacts' && q.op === 'update') return { data: [{ id: 'c1' }], error: null }
        if (table === 'whatsapp_conversations') return { data: [], error: null } // no thread → Case B (template)
        if (table === 'contact_preferences') return { data: { whatsapp_marketing: true }, error: null }
        if (table === 'whatsapp_templates') return { data: APPROVED, error: null }
        return { data: [], error: null }
      }
      const finish = () => {
        log.push(q)
        if (q.op === 'update' && table === 'contacts') events.push('stamp')
        return answer(q) ?? def()
      }
      const f = (name) => (...args) => { q.filters.push([name, ...args]); return b }
      const b = {
        select: (_c, o) => { if (o) q.opts = o; return b },
        update: (patch) => { q.op = 'update'; q.patch = patch; return b },
        insert: (row) => { q.op = 'insert'; q.patch = row; return Promise.resolve(finish()) },
        eq: f('eq'), in: f('in'), gte: f('gte'), lt: f('lt'), lte: f('lte'), is: f('is'), not: f('not'), or: f('or'),
        order: () => b, limit: () => b, maybeSingle: () => b, single: () => b,
        then: (ok, bad) => Promise.resolve(finish()).then(ok, bad),
      }
      return b
    },
  }
}
const contactUpdates = (db) => db.log.filter((q) => q.table === 'contacts' && q.op === 'update')
const hasFilter = (q, ...f) => q.filters.some((x) => JSON.stringify(x) === JSON.stringify(f))

let errSpy
beforeEach(() => {
  events.length = 0
  sendTemplateMessage.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('runFirstClassCheckins — the send is claimed first (CHECKINRISKS.1)', () => {
  it('claims the contact (a conditional stamp) BEFORE the send', async () => {
    const db = stubDb()
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.templates).toBe(1)
    expect(events).toEqual(['stamp', 'send'])
    const [claim] = contactUpdates(db)
    expect(claim.patch.first_class_checkin_at).toEqual(expect.any(String))
    expect(hasFilter(claim, 'is', 'first_class_checkin_at', null)).toBe(true)
  })

  it('a claim that cannot be written sends NOTHING (the old repro: send, then a lost stamp)', async () => {
    const db = stubDb((q) => (q.table === 'contacts' && q.op === 'update' ? { data: null, error: BOOM } : undefined))
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ claim_failed: 1 })
    expect(errSpy).toHaveBeenCalled()
  })

  it('two ticks with a failing stamp never send twice (the 24 h re-send loop)', async () => {
    const failing = (q) => (q.table === 'contacts' && q.op === 'update' ? { data: null, error: BOOM } : undefined)
    await runFirstClassCheckins(stubDb(failing), { nowMs: NOW })
    await runFirstClassCheckins(stubDb(failing), { nowMs: NOW + 15 * 60_000 })
    expect(sendTemplateMessage.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('a claim another tick already took (0 rows) sends nothing', async () => {
    const db = stubDb((q) => (q.table === 'contacts' && q.op === 'update' ? { data: [], error: null } : undefined))
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(res.reasons).toEqual({ claim_taken: 1 })
  })

  it('a send Meta did not accept releases the claim (only that claim), so the next tick retries', async () => {
    sendTemplateMessage.mockImplementationOnce(async () => { events.push('send'); return { messageId: null } })
    const db = stubDb()
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.reasons).toEqual({ send_failed: 1 })
    const [claim, release] = contactUpdates(db)
    expect(release.patch).toEqual({ first_class_checkin_at: null })
    expect(hasFilter(release, 'eq', 'id', 'c1')).toBe(true)
    expect(hasFilter(release, 'eq', 'first_class_checkin_at', claim.patch.first_class_checkin_at)).toBe(true)
  })

  it('a lost outcome record after a real send is logged, and the claim stands (no release)', async () => {
    const db = stubDb((q) => (q.table === 'activities' && q.op === 'insert' ? { error: BOOM } : undefined))
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(res.templates).toBe(1)
    expect(contactUpdates(db)).toHaveLength(1)
    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toMatch(/outcome record failed/)
  })
})

describe('runFirstClassCheckins — a stale claim is re-opened by a later tick (the lease)', () => {
  const claimedAt = (msAgo) => new Date(NOW - msAgo).toISOString()
  const staleScan = (claimIso, extra = {}) => (q) => {
    if (q.table === 'contacts' && q.op === 'select' && !q.opts?.head &&
        q.filters.some((f) => f[0] === 'gte' && f[1] === 'first_class_checkin_at')) {
      return { data: [{ id: 'c9', first_class_checkin_at: claimIso }], error: null }
    }
    return extra[q.table]?.(q)
  }
  const reopens = (db) => contactUpdates(db).filter((q) => q.patch.first_class_checkin_at === null && hasFilter(q, 'eq', 'id', 'c9'))

  it('re-opens a claim older than the lease with no recorded outcome', async () => {
    const claimIso = claimedAt(CHECKIN_CLAIM_LEASE_MS + 10 * 60_000)
    const db = stubDb(staleScan(claimIso))
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(reopens(db)).toHaveLength(1)
    expect(hasFilter(reopens(db)[0], 'eq', 'first_class_checkin_at', claimIso)).toBe(true)
    expect(res.reasons.claim_reopened).toBe(1)
  })

  it('leaves a claim inside the lease alone', async () => {
    const db = stubDb(staleScan(claimedAt(CHECKIN_CLAIM_LEASE_MS - 10 * 60_000)))
    await runFirstClassCheckins(db, { nowMs: NOW })
    expect(reopens(db)).toHaveLength(0)
  })

  it('leaves a claim whose outcome was recorded (an agent_checkin activity)', async () => {
    const db = stubDb(staleScan(claimedAt(2 * H), { activities: (q) => (q.op === 'select' && hasFilter(q, 'in', 'contact_id', ['c9']) ? { data: [{ contact_id: 'c9' }], error: null } : undefined) }))
    await runFirstClassCheckins(db, { nowMs: NOW })
    expect(reopens(db)).toHaveLength(0)
  })

  it('leaves a claim followed by an agent message (the send landed, its activity did not)', async () => {
    const claimIso = claimedAt(2 * H)
    const db = stubDb(staleScan(claimIso, {
      whatsapp_messages: (q) => (hasFilter(q, 'in', 'contact_id', ['c9'])
        ? { data: [{ contact_id: 'c9', created_at: new Date(NOW - 2 * H + 5000).toISOString() }], error: null }
        : undefined),
    }))
    await runFirstClassCheckins(db, { nowMs: NOW })
    expect(reopens(db)).toHaveLength(0)
  })

  it('a failed outcome read re-opens nothing (unknown is not "unsent")', async () => {
    const db = stubDb(staleScan(claimedAt(2 * H), { activities: (q) => (q.op === 'select' && hasFilter(q, 'in', 'contact_id', ['c9']) ? { data: null, error: BOOM } : undefined) }))
    const res = await runFirstClassCheckins(db, { nowMs: NOW })
    expect(reopens(db)).toHaveLength(0)
    expect(res.reasons.claim_reopen_read_failed).toBe(1)
  })
})
