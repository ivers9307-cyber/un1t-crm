// MCPEMAIL.1 — src/lib/campaign-approval.js: an approval is bound to the
// campaign's exact content, to one person, and is single-use.

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  APPROVAL_TTL_MS, APPROVALS_PER_HOUR, APPROVAL_CONTENT_FIELDS,
  campaignContentKey, audienceGrewTooMuch, agentReleaseBlocker, resendSummary,
  issueApproval, findApproval, consumeApproval, voidApprovals, pendingApproval,
} from './campaign-approval.js'

const NOW = Date.parse('2026-10-01T09:00:00.000Z')
const CAMPAIGN = 'c0000000-0000-4000-8000-000000000001'
const ME = '10000000-0000-4000-8000-000000000001'
const OTHER = '20000000-0000-4000-8000-000000000002'

// A small stateful stand-in for campaign_release_approvals: it applies the
// filters the module chains, so the tests judge behaviour, not call shapes.
function approvalsDb({ failOn = null, failError = { message: 'boom' }, countOverride } = {}) {
  const rows = []
  const calls = []
  let seq = 0
  return {
    rows, calls,
    from(table) {
      if (table !== 'campaign_release_approvals') throw new Error(`unexpected table ${table}`)
      const q = { op: 'select', cols: null, opts: null, payload: null, filters: [], limit: null, order: null }
      const run = () => {
        calls.push(q)
        if (failOn === q.op) return { data: null, error: failError }
        const match = (r) => q.filters.every(([k, c, v]) => {
          if (k === 'eq') return r[c] === v
          if (k === 'is') return r[c] === v
          if (k === 'gte') return r[c] >= v
          if (k === 'gt') return r[c] > v
          return true
        })
        if (q.op === 'insert') {
          const row = { id: `a${++seq}`, used_at: null, voided_at: null, created_at: new Date(q.nowForInsert ?? NOW).toISOString(), ...q.payload }
          rows.push(row)
          return { data: [{ id: row.id }], error: null }
        }
        if (q.op === 'update') {
          const hit = rows.filter(match)
          hit.forEach((r) => Object.assign(r, q.payload))
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        let hit = rows.filter(match)
        if (q.opts?.head) return { data: null, count: countOverride === undefined ? hit.length : countOverride, error: null }
        if (q.order) hit = [...hit].sort((a, b) => (a[q.order] < b[q.order] ? 1 : -1))
        if (q.limit != null) hit = hit.slice(0, q.limit)
        const pick = (r) => Object.fromEntries(q.cols.split(',').map((c) => c.trim()).map((c) => [c, r[c]]))
        return { data: hit.map(pick), error: null }
      }
      const b = {
        select(cols, opts) { if (q.op === 'select') { q.cols = cols; q.opts = opts ?? null } return b },
        insert(p) { q.op = 'insert'; q.payload = p; return b },
        update(p) { q.op = 'update'; q.payload = p; return b },
        eq(c, v) { q.filters.push(['eq', c, v]); return b },
        is(c, v) { q.filters.push(['is', c, v]); return b },
        gte(c, v) { q.filters.push(['gte', c, v]); return b },
        gt(c, v) { q.filters.push(['gt', c, v]); return b },
        order(c) { q.order = c; return b },
        limit(n) { q.limit = n; return b },
        maybeSingle() { const r = run(); return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null }) },
        then(res, rej) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
}

const campaign = (over = {}) => ({
  id: CAMPAIGN, location_id: 'loc', subject: 'S', preview_text: 'P', from_name: 'F', from_email: 'f@x.com', reply_to: 'r@x.com',
  html_content: '<p>Hi</p>', audience_filter: { a: 1, b: [1, 2] }, postmark_stream: 'broadcast', ab_subject_b: null,
  ab_test_pct: 10, ab_wait_hours: 4, parent_campaign_id: null, resend_enabled: false, resend_wait_hours: null,
  resend_subject: null, status: 'draft', updated_at: 'x', ...over,
})
const consumeAt = (db, id, ms = NOW) => consumeApproval(db, id, ms)
const issue = (db, over = {}) => issueApproval(db, {
  campaign: campaign(), profileId: ME, audienceEligible: 100, sendAt: null, nowMs: NOW, ...over,
})

describe('constants', () => {
  it('has the briefed values', () => {
    expect(APPROVAL_TTL_MS).toBe(86400000)
    expect(APPROVALS_PER_HOUR).toBe(5)
    expect(APPROVAL_CONTENT_FIELDS).toEqual([
      'location_id', 'subject', 'preview_text', 'from_name', 'from_email', 'reply_to', 'html_content', 'audience_filter',
      'postmark_stream', 'ab_subject_b', 'ab_test_pct', 'ab_wait_hours', 'parent_campaign_id',
      'resend_enabled', 'resend_wait_hours', 'resend_subject',
    ])
  })
})

describe('campaignContentKey', () => {
  it('changes when any of the sixteen fields changes and not when updated_at or status does', () => {
    const base = campaignContentKey(campaign())
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    const changes = {
      location_id: 'other', subject: 'S2', preview_text: 'P2', from_name: 'F2', from_email: 'g@x.com', reply_to: 'z@x.com',
      html_content: '<p>Bye</p>', audience_filter: { a: 2 },
      postmark_stream: 'outbound', ab_subject_b: 'Subject B', ab_test_pct: 20, ab_wait_hours: 8,
      parent_campaign_id: 'c0000000-0000-4000-8000-000000000009',
      resend_enabled: true, resend_wait_hours: 24, resend_subject: 'Did you miss this?',
    }
    expect(Object.keys(changes).sort()).toEqual([...APPROVAL_CONTENT_FIELDS].sort())
    for (const [f, v] of Object.entries(changes)) {
      expect(campaignContentKey(campaign({ [f]: v })), f).not.toBe(base)
    }
    expect(campaignContentKey(campaign({ updated_at: 'y', status: 'sent' }))).toBe(base)
  })

  it('the content key changes when resend_enabled, resend_wait_hours or resend_subject changes', () => {
    const on = campaign({ resend_enabled: true, resend_wait_hours: 24, resend_subject: null })
    const base = campaignContentKey(on)
    expect(campaignContentKey(campaign())).not.toBe(base)
    expect(campaignContentKey({ ...on, resend_wait_hours: 48 })).not.toBe(base)
    expect(campaignContentKey({ ...on, resend_subject: 'Second chance' })).not.toBe(base)
  })

  it('the content key throws on a row missing resend_subject', () => {
    const { resend_subject: _gone, ...without } = campaign()
    void _gone
    expect(() => campaignContentKey(without)).toThrow(/resend_subject/)
  })

  it('ignores key order inside audience_filter, but not array order', () => {
    const a = campaignContentKey(campaign({ audience_filter: { x: { p: 1, q: 2 }, y: [1, 2] } }))
    expect(campaignContentKey(campaign({ audience_filter: { y: [1, 2], x: { q: 2, p: 1 } } }))).toBe(a)
    expect(campaignContentKey(campaign({ audience_filter: { y: [2, 1], x: { q: 2, p: 1 } } }))).not.toBe(a)
  })

  it('throws naming a field absent from the row, but hashes present undefined/null alike', () => {
    for (const f of APPROVAL_CONTENT_FIELDS) {
      const { [f]: _gone, ...without } = campaign()
      void _gone
      expect(() => campaignContentKey(without), f).toThrow(new RegExp(f))
    }
    expect(campaignContentKey(campaign({ reply_to: undefined }))).toBe(campaignContentKey(campaign({ reply_to: null })))
  })
})

describe('agentReleaseBlocker', () => {
  it('passes a plain marketing campaign', () => {
    expect(agentReleaseBlocker(campaign())).toBeNull()
  })

  it('blocks a subject A/B test, a resend and anything off the marketing stream, each with a plain sentence', () => {
    expect(agentReleaseBlocker(campaign({ ab_subject_b: 'B' }))).toMatch(/subject A\/B test.*Open it in the CRM\./)
    expect(agentReleaseBlocker(campaign({ parent_campaign_id: 'c0000000-0000-4000-8000-000000000009' })))
      .toMatch(/is a resend.*Open it in the CRM\./)
    expect(agentReleaseBlocker(campaign({ postmark_stream: 'outbound' }))).toMatch(/not on the marketing stream.*Open it in the CRM\./)
    expect(agentReleaseBlocker(campaign({ postmark_stream: null }))).toMatch(/not on the marketing stream/)
  })

  it('judges the B subject the way the sender does (any truthy value is an A/B test)', () => {
    expect(agentReleaseBlocker(campaign({ ab_subject_b: '' }))).toBeNull()
    expect(agentReleaseBlocker(campaign({ ab_subject_b: '   ' }))).toMatch(/subject A\/B test/)
  })
})

describe('resendSummary', () => {
  it('resendSummary: null when off; "1 hour" singular; falls back to the subject', () => {
    expect(resendSummary(campaign())).toBeNull()
    expect(resendSummary(campaign({ resend_wait_hours: 24, resend_subject: 'X' }))).toBeNull()
    expect(resendSummary(campaign({ resend_enabled: true, resend_wait_hours: null }))).toBeNull()
    expect(resendSummary(campaign({ resend_enabled: true, resend_wait_hours: 0 }))).toBeNull()
    expect(resendSummary(campaign({ resend_enabled: true, resend_wait_hours: 1, resend_subject: 'Did you miss this?' })))
      .toBe('Then resends to people who did not open it, 1 hour after it sends, with the subject "Did you miss this?".')
    expect(resendSummary(campaign({ resend_enabled: true, resend_wait_hours: 48, resend_subject: null })))
      .toBe('Then resends to people who did not open it, 48 hours after it sends, with the subject "S".')
  })
})

describe('audienceGrewTooMuch', () => {
  it('needs more than 10% AND more than 25 extra people', () => {
    expect(audienceGrewTooMuch(100, 111)).toBe(false)
    expect(audienceGrewTooMuch(100, 130)).toBe(true)
    expect(audienceGrewTooMuch(1000, 1050)).toBe(false)
    expect(audienceGrewTooMuch(10, 40)).toBe(true)
    expect(audienceGrewTooMuch(500, 400)).toBe(false)
  })
})

describe('issueApproval', () => {
  it('stores only the hash, voids the earlier unused approval and returns the token once', async () => {
    const db = approvalsDb()
    const first = await issue(db)
    const second = await issue(db, { sendAt: '2026-10-05T09:00:00.000Z' })
    expect(second.ok).toBe(true)
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second.expiresAt).toBe(new Date(NOW + APPROVAL_TTL_MS).toISOString())
    expect(db.rows).toHaveLength(2)
    const [r1, r2] = db.rows
    expect(r1.token_hash).toBe(createHash('sha256').update(first.token).digest('hex'))
    expect(r2.token_hash).toBe(createHash('sha256').update(second.token).digest('hex'))
    expect(JSON.stringify(db.rows)).not.toContain(second.token)
    expect(r2).toMatchObject({
      campaign_id: CAMPAIGN, profile_id: ME, audience_eligible: 100, send_at: '2026-10-05T09:00:00.000Z',
      content_key: campaignContentKey(campaign()), expires_at: second.expiresAt,
    })
    expect(r1.voided_at).toBe(new Date(NOW).toISOString())
    expect(r2.voided_at).toBeNull()
  })

  it('answers too_many on the sixth request inside an hour, and counts only the last hour', async () => {
    const db = approvalsDb()
    for (let i = 0; i < 5; i++) expect((await issue(db)).ok).toBe(true)
    expect(await issue(db)).toEqual({ ok: false, code: 'too_many' })
    expect(db.rows).toHaveLength(5)
    expect((await issue(db, { nowMs: NOW + 61 * 60 * 1000 })).ok).toBe(true)
  })

  it('does not insert when voiding the earlier approvals fails, and throws', async () => {
    const db = approvalsDb({ failOn: 'update' })
    await expect(issue(db)).rejects.toThrow()
    expect(db.rows).toHaveLength(0)
  })

  it('fails closed when the one-live index rejects the insert (23505)', async () => {
    const db = approvalsDb({ failOn: 'insert', failError: { code: '23505', message: 'duplicate key' } })
    await expect(issue(db)).rejects.toThrow(/insert failed/)
  })

  it('issuing after an earlier approval has expired succeeds and voids the expired row', async () => {
    const db = approvalsDb()
    await issue(db)
    const later = NOW + APPROVAL_TTL_MS + 1000
    const r = await issue(db, { nowMs: later })
    expect(r.ok).toBe(true)
    expect(db.rows[0].voided_at).toBe(new Date(later).toISOString())
    expect(db.rows.filter((x) => !x.used_at && !x.voided_at)).toHaveLength(1)
  })

  it('throws when the rate-limit count comes back null', async () => {
    await expect(issue(approvalsDb({ countOverride: null }))).rejects.toThrow()
  })

  it('throws when the insert fails', async () => {
    await expect(issue(approvalsDb({ failOn: 'insert' }))).rejects.toThrow()
  })
})

describe('findApproval', () => {
  it('answers not_found for another person\'s token and for a random token alike', async () => {
    const db = approvalsDb()
    const { token } = await issue(db)
    const other = await findApproval(db, { token, profileId: OTHER, nowMs: NOW })
    const random = await findApproval(db, { token: 'nope', profileId: ME, nowMs: NOW })
    expect(other).toEqual({ ok: false, code: 'not_found' })
    expect(random).toEqual(other)
  })

  it('returns the approval without its hash', async () => {
    const db = approvalsDb()
    const { token } = await issue(db)
    const r = await findApproval(db, { token, profileId: ME, nowMs: NOW + 1000 })
    expect(r.ok).toBe(true)
    expect(r.approval).toMatchObject({ campaign_id: CAMPAIGN, profile_id: ME, audience_eligible: 100, content_key: campaignContentKey(campaign()) })
    expect(r.approval).not.toHaveProperty('token_hash')
    expect(db.calls.at(-1).cols).not.toMatch(/token_hash|\*/)
  })

  it('answers expired after 24 hours, used after consume, voided after a newer issue', async () => {
    const db = approvalsDb()
    const a = await issue(db)
    expect(await findApproval(db, { token: a.token, profileId: ME, nowMs: NOW + APPROVAL_TTL_MS })).toEqual({ ok: false, code: 'expired' })
    expect((await findApproval(db, { token: a.token, profileId: ME, nowMs: NOW + APPROVAL_TTL_MS - 1 })).ok).toBe(true)

    const b = await issue(db)
    expect(await findApproval(db, { token: a.token, profileId: ME, nowMs: NOW })).toEqual({ ok: false, code: 'voided' })
    const found = await findApproval(db, { token: b.token, profileId: ME, nowMs: NOW })
    expect(await consumeAt(db, found.approval.id)).toBe(true)
    expect(await findApproval(db, { token: b.token, profileId: ME, nowMs: NOW })).toEqual({ ok: false, code: 'used' })
  })

  it('throws when the read fails rather than saying not_found', async () => {
    await expect(findApproval(approvalsDb({ failOn: 'select' }), { token: 't', profileId: ME, nowMs: NOW })).rejects.toThrow()
  })
})

describe('consumeApproval', () => {
  it('refuses an approval that expired between find and consume', async () => {
    const db = approvalsDb()
    await issue(db)
    expect(await consumeAt(db, db.rows[0].id, NOW + APPROVAL_TTL_MS)).toBe(false)
    expect(db.rows[0].used_at).toBeNull()
    expect(await consumeAt(db, db.rows[0].id, NOW + 1000)).toBe(true)
  })

  it('returns true once and false the second time, and false for a voided one', async () => {
    const db = approvalsDb()
    await issue(db)
    const id = db.rows[0].id
    expect(await consumeAt(db, id)).toBe(true)
    expect(await consumeAt(db, id)).toBe(false)
    const b = await issue(db)
    void b
    const c = await issue(db)
    void c
    expect(await consumeAt(db, db.rows[1].id)).toBe(false)
  })

  it('throws on a database error', async () => {
    await expect(consumeAt(approvalsDb({ failOn: 'update' }), 'x')).rejects.toThrow()
  })
})

describe('voidApprovals / pendingApproval', () => {
  it('voids the unused rows of one campaign and leaves a used one alone', async () => {
    const db = approvalsDb()
    await issue(db)
    db.rows[0].used_at = 'earlier'
    const second = await issue(db)
    void second
    await voidApprovals(db, CAMPAIGN)
    expect(db.rows[0].voided_at).toBeNull()
    expect(db.rows[1].voided_at).not.toBeNull()
    await expect(voidApprovals(approvalsDb({ failOn: 'update' }), CAMPAIGN)).rejects.toThrow()
  })

  it('pendingApproval answers the live one, or null', async () => {
    const db = approvalsDb()
    expect(await pendingApproval(db, CAMPAIGN, NOW)).toBeNull()
    await issue(db, { sendAt: '2026-10-05T09:00:00.000Z', audienceEligible: 42 })
    expect(await pendingApproval(db, CAMPAIGN, NOW + 1000)).toEqual({
      send_at: '2026-10-05T09:00:00.000Z', expires_at: new Date(NOW + APPROVAL_TTL_MS).toISOString(), audience_eligible: 42,
    })
    expect(await pendingApproval(db, CAMPAIGN, NOW + APPROVAL_TTL_MS)).toBeNull()
    await voidApprovals(db, CAMPAIGN)
    expect(await pendingApproval(db, CAMPAIGN, NOW)).toBeNull()
  })
})
