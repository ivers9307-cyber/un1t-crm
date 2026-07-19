// QSTASH.4 — enqueue-hook contract for POST /api/contacts/import/commit.
//
// The async path (> SYNC_LIMIT rows) inserts the contact_imports row
// with status='pending' and then fire-and-forget publishes { id } to
// QStash so the worker picks the job up in ~seconds instead of waiting
// for the next cron tick. The publish must NEVER affect the commit
// response: env-gated inside publishQueuePush, dedup id DASH-ONLY
// (QStash 400s on colons — the QSTASH.2 lesson), no delay, own
// try/catch. The sync path never publishes — its row is born
// 'completed'.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

vi.mock('@/lib/contact-import-runner', () => ({
  runImportCommit: vi.fn(),
}))

vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn().mockResolvedValue({ ok: true, messageId: 'msg-test' }),
  CONTACT_IMPORTS_WORKER_PATH: '/api/webhooks/qstash/contact-imports',
}))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { runImportCommit } from '@/lib/contact-import-runner'
import { publishQueuePush, CONTACT_IMPORTS_WORKER_PATH } from '@/lib/qstash'

// ─── fixtures ────────────────────────────────────────────────────────────────

const LOC_ID = 'c0000000-0000-0000-0000-000000000003'
const IMPORT_ID = 'a0000000-0000-0000-0000-000000000042'
const MASTER = { id: 'u-1', role: 'master', isMaster: true, activeLocation: { id: LOC_ID } }

/** rows > SYNC_LIMIT (1000) trigger the async/queued path. */
function makeRows(n) {
  return Array.from({ length: n }, (_, i) => ({ Email: `person${i}@example.ie` }))
}

function makeRequest(rows) {
  return new Request('http://localhost/api/contacts/import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapping: { Email: 'email' }, rows }),
  })
}

// ─── db mock ─────────────────────────────────────────────────────────────────

function makeDb({ insertedId = IMPORT_ID } = {}) {
  const calls = { inserts: [], updates: [] }
  const db = {
    from: vi.fn((table) => {
      if (table === 'locations') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: { id: LOC_ID }, error: null })),
            })),
          })),
        }
      }
      if (table === 'contact_imports') {
        return {
          insert: vi.fn((payload) => {
            calls.inserts.push(payload)
            return {
              select: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({ data: { id: insertedId, ...payload }, error: null })),
              })),
            }
          }),
          update: vi.fn((payload) => {
            const record = { payload, filters: [] }
            const builder = {
              eq: vi.fn((col, val) => {
                record.filters.push(['eq', col, val])
                return builder
              }),
              then(resolve, reject) {
                calls.updates.push(record)
                return Promise.resolve({ data: null, error: null }).then(resolve, reject)
              },
            }
            return builder
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
    _calls: calls,
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  publishQueuePush.mockResolvedValue({ ok: true, messageId: 'msg-test' })
  getCurrentUser.mockResolvedValue(MASTER)
})

// ─── async path — publishes ──────────────────────────────────────────────────

describe('async path (rows > SYNC_LIMIT)', () => {
  it('inserts the pending row and publishes { id } to the contact-imports worker', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)

    const res = await POST(makeRequest(makeRows(1001)))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.async).toBe(true)
    expect(json.data.import_id).toBe(IMPORT_ID)
    expect(db._calls.inserts[0].status).toBe('pending')

    expect(publishQueuePush).toHaveBeenCalledTimes(1)
    expect(publishQueuePush).toHaveBeenCalledWith({
      path: CONTACT_IMPORTS_WORKER_PATH,
      body: { id: IMPORT_ID },
      deduplicationId: `contact-import-${IMPORT_ID}`,
    })
    // No delaySeconds — the import should start as soon as QStash delivers.
    expect(publishQueuePush.mock.calls[0][0]).not.toHaveProperty('delaySeconds')
  })

  it('uses a DASH-ONLY dedup id (QStash 400s on colons)', async () => {
    createServerClient.mockReturnValue(makeDb())

    await POST(makeRequest(makeRows(1001)))

    const [{ deduplicationId }] = publishQueuePush.mock.calls[0]
    expect(deduplicationId).not.toContain(':')
    expect(deduplicationId).toBe(`contact-import-${IMPORT_ID}`)
  })

  it('still returns the async success response when the publish rejects', async () => {
    createServerClient.mockReturnValue(makeDb())
    publishQueuePush.mockRejectedValue(new Error('qstash exploded'))

    const res = await POST(makeRequest(makeRows(1001)))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.async).toBe(true)
  })
})

// ─── sync path — never publishes ─────────────────────────────────────────────

describe('sync path (rows ≤ SYNC_LIMIT)', () => {
  it('runs inline and never publishes to QStash', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    runImportCommit.mockResolvedValue({ counts: { created: 1, updated: 0, skipped: 0, errored: 0 } })

    const res = await POST(makeRequest(makeRows(3)))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.async).toBe(false)
    expect(db._calls.inserts[0].status).toBe('completed')
    expect(publishQueuePush).not.toHaveBeenCalled()
  })
})
