// WEBHOOKAUDIT.1 — the attempt row: what it keeps, what it must never keep,
// and that neither building nor writing it can throw.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from '@/lib/log'
import {
  digestGlofoxWebhookResult,
  buildGlofoxWebhookAttempt,
  recordGlofoxWebhookAttempt,
  GLOFOX_ATTEMPTS_TABLE,
  MAX_DIGEST_BYTES,
  MAX_ERROR_CHARS,
} from './glofox-webhook-attempts.js'

// Synthetic personal data — the digest must carry none of these strings.
const PII = {
  email: 'person@example.test',
  phone: '+10000000001',
  first_name: 'Firstname',
  last_name: 'Lastname',
  dob: '1990-01-01',
  emergency_contact: 'Contactname +10000000002',
}
const PII_VALUES = [...Object.values(PII), 'other@example.test', '+10000000003', 'Firstname Lastname']

const appliedResult = () => ({
  contact_id: 'contact-uuid-1',
  tags: ['glofox_booking_updated'],
  ltv: null,
  service: null,
  membership_pause: null,
  dunning: null,
  member_sync: {
    action: 'update',
    existing_id: 'contact-uuid-1',
    existing: { ...PII, glofox_membership_status: 'credit_member', trial_credits_remaining: 4 },
    mapped: { ...PII, name: 'Firstname Lastname', glofox_membership_status: 'member', trial_credits_remaining: null },
    changes: {
      glofox_membership_status: { from: 'credit_member', to: 'member' },
      trial_credits_remaining: { from: 4, to: null },
      phone: { from: PII.phone, to: '+10000000003' },
      email: { from: PII.email, to: 'other@example.test' },
    },
    deal_action: { action: 'leave', reason: 'classifier output unchanged' },
    // The REAL shape applyMemberSync returns: writeContactTags()'s result
    // (src/lib/contact-tags.js), not an array.
    transition_tags: { written: ['status_credit_member_to_member'], alreadyPresent: ['glofox_member'] },
  },
})

beforeEach(() => vi.clearAllMocks())

describe('digestGlofoxWebhookResult', () => {
  it('keeps what C13 needed: the label and balance before and after, and which columns changed', () => {
    const d = digestGlofoxWebhookResult(appliedResult())
    expect(d.contact_id).toBe('contact-uuid-1')
    expect(d.tags).toEqual(['glofox_booking_updated'])
    expect(d.member_sync.action).toBe('update')
    expect(d.member_sync.changed).toEqual(['email', 'glofox_membership_status', 'phone', 'trial_credits_remaining'])
    expect(d.member_sync.tracked).toEqual({
      glofox_membership_status: { from: 'credit_member', to: 'member' },
      trial_credits_remaining: { from: 4, to: null },
    })
    expect(d.member_sync.seen).toEqual({
      existing_status: 'credit_member', mapped_status: 'member', existing_credits: 4, mapped_credits: null,
    })
    expect(d.member_sync.deal_action).toBe('leave')
    expect(d.member_sync.credits_unread).toBe(false)
  })

  it("keeps the transition tags applyMemberSync wrote (writeContactTags' { written, alreadyPresent })", () => {
    const d = digestGlofoxWebhookResult(appliedResult())
    expect(d.member_sync.transition_tags).toEqual(['status_credit_member_to_member'])
    expect(d.member_sync.transition_tags_present).toEqual(['glofox_member'])
    expect(d.member_sync.transition_tags_failed).toBe(false)
  })

  it('a failed transition-tag write is a flag, never its error text', () => {
    for (const tt of [
      { error: 'insert into contact_tags failed: abc123secret' },
      { written: [], alreadyPresent: ['glofox_member'], error: 'abc123secret bulk insert refused' },
    ]) {
      const r = appliedResult()
      r.member_sync.transition_tags = tt
      const d = digestGlofoxWebhookResult(r)
      expect(d.member_sync.transition_tags_failed).toBe(true)
      expect(d.member_sync.transition_tags).toEqual([])
      expect(JSON.stringify(d)).not.toContain('abc123secret')
    }
  })

  it('no transition-tag write (null) is empty lists and no failure', () => {
    const r = appliedResult()
    r.member_sync.transition_tags = null
    expect(digestGlofoxWebhookResult(r).member_sync).toMatchObject({
      transition_tags: [], transition_tags_present: [], transition_tags_failed: false,
    })
  })

  it('carries no personal data at all', () => {
    const text = JSON.stringify(digestGlofoxWebhookResult(appliedResult()))
    for (const v of PII_VALUES) expect(text).not.toContain(v)
  })

  it('keeps credits_unread (C13) when the sync could not read credits', () => {
    const r = appliedResult()
    r.member_sync.credits_unread = true
    expect(digestGlofoxWebhookResult(r).member_sync.credits_unread).toBe(true)
  })

  it("keeps a failed member fetch's reason and HTTP status, never its error text", () => {
    const d = digestGlofoxWebhookResult({
      contact_id: 'contact-uuid-1', tags: [],
      member_sync: { ok: false, reason: 'threw', status: 503, error: 'GET /2.0/members/abc123secret failed' },
    })
    expect(d.member_sync).toMatchObject({ ok: false, reason: 'threw', http_status: 503 })
    expect(JSON.stringify(d)).not.toContain('abc123secret')
  })

  it('keeps the side-effects as codes only (invoice, dunning, service, pause)', () => {
    const d = digestGlofoxWebhookResult({
      contact_id: 'c', tags: [],
      ltv: { ok: true, invoice_status: 'PAST_DUE', is_membership: true, amount_cents: 5000, invoice_id: 'inv-1', glofox_user_id: 'u-1', aggregates: { ltv: 1 } },
      dunning: { kind: 'membership', enrolled: true, exited: false, reason: null, sequence_id: 's-1' },
      service: { ok: true, state_change: { from: 'active', to: 'paused' } },
      membership_pause: { ok: true, paused: true, cleared: false, resume_at: '2026-10-01' },
    })
    expect(d.ltv).toEqual({ ok: true, reason: null, invoice_status: 'PAST_DUE', is_membership: true })
    expect(d.dunning).toEqual({ kind: 'membership', enrolled: true, exited: false, reason: null })
    expect(d.service).toEqual({ ok: true, reason: null, state_change: { from: 'active', to: 'paused' } })
    expect(d.membership_pause).toEqual({ ok: true, paused: true, cleared: false })
  })

  it('answers null for no result', () => {
    expect(digestGlofoxWebhookResult(null)).toBeNull()
    expect(digestGlofoxWebhookResult(undefined)).toBeNull()
    expect(digestGlofoxWebhookResult('applied')).toBeNull()
    expect(digestGlofoxWebhookResult([1, 2])).toBeNull()
  })

  it('never exceeds the table CHECK: an oversize digest collapses to a small marker', () => {
    const changes = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`c${String(i).padStart(3, '0')}_${'x'.repeat(70)}`, { from: 1, to: 2 }]))
    const tags = Array.from({ length: 50 }, (_, i) => `t${i}_${'y'.repeat(80)}`)
    const d = digestGlofoxWebhookResult({ contact_id: 'c', tags, member_sync: { action: 'update', changes } })
    expect(new TextEncoder().encode(JSON.stringify(d)).length).toBeLessThanOrEqual(MAX_DIGEST_BYTES)
    expect(d).toEqual({ oversize: true, contact_id: 'c', member_sync_action: 'update' })
  })
})

describe('buildGlofoxWebhookAttempt', () => {
  const payload = {
    Type: 'BOOKING_UPDATED',
    Metadata: { location_id: 'branch-1', trace_id: 'trace-1', version: 'v1' },
    Payload: { id: 'entity-1' },
    Timestamp: '2026-09-28T09:00:00.000Z',
  }
  const base = {
    eventRowId: 'row-1', locationId: 'loc-1', parsed: { eventType: 'BOOKING_UPDATED' }, payload,
    deliveredAt: '2026-09-28T09:00:01.000Z', processedAt: '2026-09-28T09:00:02.000Z',
  }

  it('builds the row: which emission, when, what happened', () => {
    const row = buildGlofoxWebhookAttempt({ ...base, status: 'applied', result: appliedResult(), errorMessage: null })
    expect(row).toMatchObject({
      event_row_id: 'row-1', location_id: 'loc-1', trace_id: 'trace-1', event_type: 'BOOKING_UPDATED',
      emitted_at: '2026-09-28T09:00:00.000Z', delivered_at: '2026-09-28T09:00:01.000Z',
      processed_at: '2026-09-28T09:00:02.000Z', status: 'applied', error_message: null,
    })
    expect(row.digest.member_sync.tracked.glofox_membership_status).toEqual({ from: 'credit_member', to: 'member' })
    expect(Object.keys(row).sort()).toEqual([
      'delivered_at', 'digest', 'emitted_at', 'error_message', 'event_row_id', 'event_type',
      'location_id', 'processed_at', 'status', 'trace_id',
    ])
  })

  it('reads the lowercase SERVICE_* metadata too', () => {
    const row = buildGlofoxWebhookAttempt({ ...base, payload: { metadata: { trace_id: 'trace-lc' }, timestamp: '2026-09-28T08:00:00Z' }, status: 'applied' })
    expect(row.trace_id).toBe('trace-lc')
    expect(row.emitted_at).toBe('2026-09-28T08:00:00.000Z')
  })

  it('an unreadable timestamp or trace is null, never a throw', () => {
    const row = buildGlofoxWebhookAttempt({ ...base, payload: { Metadata: { trace_id: 42 }, Timestamp: 'not a date' }, status: 'failed' })
    expect(row.trace_id).toBeNull()
    expect(row.emitted_at).toBeNull()
    expect(buildGlofoxWebhookAttempt({ ...base, payload: null, parsed: null, status: 'failed' }).event_type).toBeNull()
  })

  it('caps the error text at the table CHECK', () => {
    const row = buildGlofoxWebhookAttempt({ ...base, status: 'failed', errorMessage: 'e'.repeat(2000) })
    expect(row.error_message.length).toBe(MAX_ERROR_CHARS)
  })

  it('a result that throws while being read still builds a row', () => {
    const hostile = { contact_id: 'c' }
    Object.defineProperty(hostile, 'member_sync', { enumerable: true, get() { throw new Error('boom') } })
    const row = buildGlofoxWebhookAttempt({ ...base, status: 'applied', result: hostile })
    expect(row.digest).toEqual({ digest_failed: true })
    expect(row.status).toBe('applied')
  })

  it('falls back to the processing time when no delivery time was passed', () => {
    const row = buildGlofoxWebhookAttempt({ ...base, deliveredAt: undefined, status: 'applied' })
    expect(row.delivered_at).toBe('2026-09-28T09:00:02.000Z')
  })
})

describe('recordGlofoxWebhookAttempt', () => {
  const fakeDb = (outcome) => {
    const inserts = []
    return {
      inserts,
      from: (table) => ({
        insert: async (row) => {
          inserts.push({ table, row })
          if (outcome === 'throw') throw new Error('socket hang up')
          return { data: null, error: outcome === 'error' ? { code: '42P01', message: 'relation does not exist' } : null }
        },
      }),
    }
  }
  const row = { event_row_id: 'row-1', status: 'applied' }

  it('inserts into glofox_webhook_attempts', async () => {
    const db = fakeDb('ok')
    await expect(recordGlofoxWebhookAttempt(db, row)).resolves.toEqual({ ok: true, error: null })
    expect(db.inserts).toEqual([{ table: GLOFOX_ATTEMPTS_TABLE, row }])
    expect(GLOFOX_ATTEMPTS_TABLE).toBe('glofox_webhook_attempts')
  })

  it('a refused insert is one warning and { ok: false }, never a throw', async () => {
    const r = await recordGlofoxWebhookAttempt(fakeDb('error'), row)
    expect(r.ok).toBe(false)
    expect(logWarn).toHaveBeenCalledWith('glofox-webhook', 'attempt row insert failed', expect.objectContaining({ status: 'applied', code: '42P01' }))
  })

  it('a thrown insert is one warning and { ok: false }, never a throw', async () => {
    const r = await recordGlofoxWebhookAttempt(fakeDb('throw'), row)
    expect(r.ok).toBe(false)
    expect(logWarn).toHaveBeenCalledWith('glofox-webhook', 'attempt row insert threw', expect.objectContaining({ status: 'applied' }))
  })
})
