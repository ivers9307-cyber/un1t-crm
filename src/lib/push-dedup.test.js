import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit-tests the claim-before-send wrapper in isolation: the send
// pipelines (sendPush / notifyUsers) and the role resolver are mocked;
// the fake db implements just the push_event_sends upsert/delete shapes
// the helper drives. What we verify is the CLAIM LOGIC — who gets sent
// to, when claims are released, and the fail-open posture.

vi.mock('./push.js', () => ({
  sendPush: vi.fn(),
  resolveRoleRecipientIds: vi.fn(),
}))
vi.mock('./notify.js', () => ({
  notifyUsers: vi.fn(),
}))
vi.mock('./log.js', () => ({
  logWarn: vi.fn(),
}))

import { sendPush, resolveRoleRecipientIds } from './push.js'
import { notifyUsers } from './notify.js'
import { logWarn } from './log.js'
import {
  sendPushOnce,
  notifyUsersOnce,
  sendPushToRolesAtLocationOnce,
  notifyUsersAtRolesOnce,
} from './push-dedup.js'

// ── fake db ──────────────────────────────────────────────────────────
let upsertError = null
let existingClaims = new Set() // "eventKey|recipientId" already in the ledger
let upsertedRows = []
let releasedCalls = []
let releaseError = null

function claimKey(row) { return `${row.event_key}|${row.recipient_id}` }

const fakeDb = {
  from(table) {
    if (table !== 'push_event_sends') throw new Error(`unexpected table ${table}`)
    return {
      upsert(rows) {
        return {
          select: () => {
            if (upsertError) return Promise.resolve({ data: null, error: upsertError })
            const fresh = rows.filter(r => !existingClaims.has(claimKey(r)))
            fresh.forEach(r => existingClaims.add(claimKey(r)))
            upsertedRows.push(...fresh)
            return Promise.resolve({ data: fresh, error: null })
          },
        }
      },
      delete() {
        return {
          eq: (_col, eventKey) => ({
            in: (_c, ids) => {
              releasedCalls.push({ eventKey, ids })
              if (!releaseError) {
                ids.forEach(id => existingClaims.delete(`${eventKey}|${id}`))
              }
              return Promise.resolve({ error: releaseError })
            },
          }),
        }
      },
    }
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  upsertError = null
  existingClaims = new Set()
  upsertedRows = []
  releasedCalls = []
  releaseError = null
  sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0 })
  notifyUsers.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 0, emailed: 0, email_failed: 0 })
})

describe('sendPushOnce — claiming', () => {
  it('sends to every recipient on first claim', async () => {
    const res = await sendPushOnce(fakeDb, 'contract_issued:c1', ['u1', 'u2'], { title: 't' })
    expect(sendPush).toHaveBeenCalledWith(['u1', 'u2'], { title: 't' })
    expect(res.deduped).toBe(0)
  })

  it('skips recipients whose claim already exists, sends the rest', async () => {
    existingClaims.add('contract_issued:c1|u1')
    const res = await sendPushOnce(fakeDb, 'contract_issued:c1', ['u1', 'u2'], { title: 't' })
    expect(sendPush).toHaveBeenCalledWith(['u2'], { title: 't' })
    expect(res.deduped).toBe(1)
  })

  it('sends nothing when every claim already exists (the replay case)', async () => {
    existingClaims.add('k|u1')
    existingClaims.add('k|u2')
    const res = await sendPushOnce(fakeDb, 'k', ['u1', 'u2'], { title: 't' })
    expect(sendPush).not.toHaveBeenCalled()
    expect(res).toMatchObject({ sent: 0, failed: 0, deduped: 2 })
  })

  it('dedupes the input id list itself', async () => {
    await sendPushOnce(fakeDb, 'k', ['u1', 'u1', null, 'u1'], { title: 't' })
    expect(sendPush).toHaveBeenCalledWith(['u1'], { title: 't' })
  })

  it('accepts a single id (non-array) like sendPush does', async () => {
    await sendPushOnce(fakeDb, 'k', 'u1', { title: 't' })
    expect(sendPush).toHaveBeenCalledWith(['u1'], { title: 't' })
  })
})

describe('sendPushOnce — fail-open + release semantics', () => {
  it('fails open when the claim insert errors: sends WITHOUT dedup', async () => {
    upsertError = { message: 'relation does not exist' }
    const res = await sendPushOnce(fakeDb, 'k', ['u1', 'u2'], { title: 't' })
    expect(sendPush).toHaveBeenCalledWith(['u1', 'u2'], { title: 't' })
    expect(res.deduped).toBe(0)
    expect(logWarn).toHaveBeenCalled()
    // ...and a subsequent pipeline failure must NOT try to release
    // rows it never claimed (claimTracked=false).
    expect(releasedCalls).toEqual([])
  })

  it('releases claims when the pipeline fails outright (failed>0, sent=0)', async () => {
    sendPush.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 2 })
    await sendPushOnce(fakeDb, 'k', ['u1', 'u2'], { title: 't' })
    expect(releasedCalls).toEqual([{ eventKey: 'k', ids: ['u1', 'u2'] }])
    // the retry can now claim again
    const retry = await sendPushOnce(fakeDb, 'k', ['u1', 'u2'], { title: 't' })
    expect(retry.deduped).toBe(0)
  })

  it('releases claims when the send throws', async () => {
    sendPush.mockRejectedValue(new Error('boom'))
    const res = await sendPushOnce(fakeDb, 'k', ['u1'], { title: 't' })
    expect(releasedCalls).toEqual([{ eventKey: 'k', ids: ['u1'] }])
    expect(res.deduped).toBe(0)
    expect(res.sent).toBe(0)
  })

  it('keeps claims on partial delivery (re-send would double-notify)', async () => {
    sendPush.mockResolvedValue({ sent: 1, skipped: 0, invalidated: 0, failed: 1 })
    await sendPushOnce(fakeDb, 'k', ['u1', 'u2'], { title: 't' })
    expect(releasedCalls).toEqual([])
  })

  it('keeps claims on a quiet no-op (sent=0, failed=0 — no tokens)', async () => {
    sendPush.mockResolvedValue({ sent: 0, skipped: 2, invalidated: 0, failed: 0 })
    await sendPushOnce(fakeDb, 'k', ['u1', 'u2'], { title: 't' })
    expect(releasedCalls).toEqual([])
  })

  it('sends WITHOUT dedup when no event key is available', async () => {
    await sendPushOnce(fakeDb, null, ['u1'], { title: 't' })
    expect(sendPush).toHaveBeenCalledWith(['u1'], { title: 't' })
    expect(upsertedRows).toEqual([])
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('notifyUsersOnce — email fallback counts as delivered', () => {
  it('keeps claims when push failed but the email fallback landed', async () => {
    notifyUsers.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 1, emailed: 1, email_failed: 0 })
    await notifyUsersOnce(fakeDb, 'k', ['u1'], { title: 't' })
    expect(releasedCalls).toEqual([])
  })

  it('releases claims when push AND email both failed', async () => {
    notifyUsers.mockResolvedValue({ sent: 0, skipped: 0, invalidated: 0, failed: 1, emailed: 0, email_failed: 1 })
    await notifyUsersOnce(fakeDb, 'k', ['u1'], { title: 't' })
    expect(releasedCalls).toEqual([{ eventKey: 'k', ids: ['u1'] }])
  })
})

describe('role fan-out variants — ids resolved BEFORE claiming', () => {
  it('sendPushToRolesAtLocationOnce claims per resolved recipient', async () => {
    resolveRoleRecipientIds.mockResolvedValue(['m1', 'm2'])
    existingClaims.add('k|m1')
    const res = await sendPushToRolesAtLocationOnce(fakeDb, 'k', 'loc1', ['owner'], { title: 't' })
    expect(resolveRoleRecipientIds).toHaveBeenCalledWith(fakeDb, 'loc1', ['owner'])
    expect(sendPush).toHaveBeenCalledWith(['m2'], { title: 't' })
    expect(res.deduped).toBe(1)
  })

  it('notifyUsersAtRolesOnce resolves then claims the same way', async () => {
    resolveRoleRecipientIds.mockResolvedValue(['m1'])
    await notifyUsersAtRolesOnce(fakeDb, 'k', 'loc1', ['owner', 'manager'], { title: 't' })
    expect(notifyUsers).toHaveBeenCalledWith(['m1'], { title: 't' })
  })

  it('no recipients resolved → no claim, no send', async () => {
    resolveRoleRecipientIds.mockResolvedValue([])
    const res = await sendPushToRolesAtLocationOnce(fakeDb, 'k', 'loc1', ['owner'], { title: 't' })
    expect(sendPush).not.toHaveBeenCalled()
    expect(res.sent).toBe(0)
  })
})
