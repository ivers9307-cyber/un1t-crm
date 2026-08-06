import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./external-contacts', () => ({ listOwnedContacts: vi.fn() }))
vi.mock('./desired-contacts', () => ({ buildDesiredContacts: vi.fn() }))
vi.mock('./client', () => ({ zoomConfigured: vi.fn(() => true) }))
vi.mock('@/lib/qstash', () => ({
  publishQueuePush: vi.fn(async () => ({ ok: true, messageId: 'm1' })),
  ensureQueue: vi.fn(async () => ({ ok: true })),
  ZOOM_CONTACTS_WORKER_PATH: '/api/webhooks/qstash/zoom-contacts',
  ZOOM_CONTACTS_QUEUE_NAME: 'zoom-contacts',
  ZOOM_CONTACTS_QUEUE_PARALLELISM: 2,
}))

import { listOwnedContacts } from './external-contacts'
import { buildDesiredContacts } from './desired-contacts'
import { zoomConfigured } from './client'
import { publishQueuePush } from '@/lib/qstash'
import { runZoomContactSync, PUBLISH_CONCURRENCY } from './reconcile'

const desiredMap = (n, prefix = 'Name') => new Map(
  Array.from({ length: n }, (_, i) => [`+35387${String(i).padStart(7, '0')}`, { name: `${prefix} ${i}`, contactId: `u${i}` }])
)

beforeEach(() => {
  vi.mocked(zoomConfigured).mockReturnValue(true)
  vi.mocked(publishQueuePush).mockClear()
  vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(3), stats: {} })
  vi.mocked(listOwnedContacts).mockResolvedValue({ ok: true, contacts: new Map(), scanned: 0 })
})

describe('runZoomContactSync', () => {
  it('skips cleanly when unconfigured', async () => {
    vi.mocked(zoomConfigured).mockReturnValue(false)
    const out = await runZoomContactSync({})
    expect(out.skipped).toBe('unconfigured')
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('enqueues one job per create', async () => {
    const out = await runZoomContactSync({})
    expect(out.ok).toBe(true)
    expect(out.enqueued).toBe(3)
    expect(publishQueuePush).toHaveBeenCalledTimes(3)
  })

  it('uses a dash-only dedup id (QStash 400s on colons)', async () => {
    await runZoomContactSync({})
    const { deduplicationId } = vi.mocked(publishQueuePush).mock.calls[0][0]
    expect(deduplicationId).not.toContain(':')
    expect(deduplicationId).toBe('zoom-contact-create-353870000000')
  })

  it('dry mode reports the diff and enqueues nothing', async () => {
    const out = await runZoomContactSync({ dry: true })
    expect(out.dry).toBe(true)
    expect(out.counts.creates).toBe(3)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('limit caps the number of jobs enqueued', async () => {
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(10), stats: {} })
    const out = await runZoomContactSync({ limit: 4 })
    expect(out.enqueued).toBe(4)
    expect(out.limited).toBe(true)
  })

  it('reports failure and enqueues nothing when the Zoom list fails', async () => {
    vi.mocked(listOwnedContacts).mockResolvedValue({ ok: false, error: 'zoom down' })
    const out = await runZoomContactSync({})
    expect(out.ok).toBe(false)
    expect(publishQueuePush).not.toHaveBeenCalled()
  })

  it('fails the run when the guard trips, but still enqueues creates', async () => {
    const owned = new Map(Array.from({ length: 100 }, (_, i) =>
      [`+35389${String(i).padStart(7, '0')}`, { name: `Old ${i}`, zoomId: `z${i}` }]))
    vi.mocked(listOwnedContacts).mockResolvedValue({ ok: true, contacts: owned, scanned: 100 })
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(2), stats: {} })

    const out = await runZoomContactSync({})
    expect(out.ok).toBe(false)
    expect(out.guardTripped).toBe(true)
    expect(out.counts.deletes).toBe(0)
    expect(out.enqueued).toBe(2) // the two creates still went
  })

  it('force bypasses the guard so a legitimate mass cleanup can proceed', async () => {
    const owned = new Map(Array.from({ length: 100 }, (_, i) =>
      [`+35389${String(i).padStart(7, '0')}`, { name: `Old ${i}`, zoomId: `z${i}` }]))
    vi.mocked(listOwnedContacts).mockResolvedValue({ ok: true, contacts: owned, scanned: 100 })
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(2), stats: {} })

    const out = await runZoomContactSync({ force: true })
    expect(out.guardTripped).toBe(false)
    expect(out.counts.deletes).toBe(100)
    expect(out.forced).toBe(true)
    expect(out.ok).toBe(true)
  })

  // Bounded-concurrency publish loop (PUBLISH_CONCURRENCY batches) — added
  // when the fully-sequential loop was found to blow the cron's 300s
  // maxDuration on a ~6,330-job cold start.
  it('batches large publish sets without dropping any (60 creates spans 3 batches at concurrency 25)', async () => {
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(60), stats: {} })

    const out = await runZoomContactSync({})

    expect(out.enqueued).toBe(60)
    expect(publishQueuePush).toHaveBeenCalledTimes(60)
  })

  it('publishes within a batch concurrently, honouring PUBLISH_CONCURRENCY as the ceiling', async () => {
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(60), stats: {} })
    let inFlight = 0
    let maxInFlight = 0
    vi.mocked(publishQueuePush).mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve() // yield a microtask so batch-mates overlap before any resolves
      inFlight--
      return { ok: true, messageId: 'm1' }
    })

    const out = await runZoomContactSync({})

    expect(out.enqueued).toBe(60)
    // The whole first batch is dispatched synchronously (Array#map calls each
    // async callback in order, each running up to its first await before the
    // next starts) before any of it can resolve — proves batching, not a
    // sequential loop that would never exceed 1 in flight.
    expect(maxInFlight).toBe(PUBLISH_CONCURRENCY)
  })

  it('one rejected publish inside a batch does not discard its siblings', async () => {
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired: desiredMap(10), stats: {} })
    const failing = '+353870000005' // the middle of a single 10-job batch (< PUBLISH_CONCURRENCY)
    vi.mocked(publishQueuePush).mockImplementation(async ({ body }) => {
      if (body.e164 === failing) throw new Error('boom') // publishQueuePush itself never rejects, but the
      return { ok: true, messageId: 'm1' }                // wrapper must survive a caller that does
    })

    const out = await runZoomContactSync({})

    expect(publishQueuePush).toHaveBeenCalledTimes(10) // every job in the batch was still attempted
    expect(out.enqueued).toBe(9)
    expect(out.ok).toBe(false)
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]).toContain(failing)
    expect(out.failures[0]).toContain('boom')
  })

  it('preserves creates-before-updates ordering through capping and batching when limit spans the boundary', async () => {
    const owned = new Map([
      ['+353870000000', { name: 'Old A', zoomId: 'z-a' }],
      ['+353870000001', { name: 'Old B', zoomId: 'z-b' }],
    ])
    vi.mocked(listOwnedContacts).mockResolvedValue({ ok: true, contacts: owned, scanned: 2 })
    const desired = new Map([
      ['+353870000000', { name: 'New A', contactId: 'u0' }], // → update
      ['+353870000001', { name: 'New B', contactId: 'u1' }], // → update
      ['+353870000002', { name: 'New C', contactId: 'u2' }], // → create
      ['+353870000003', { name: 'New D', contactId: 'u3' }], // → create
      ['+353870000004', { name: 'New E', contactId: 'u4' }], // → create
    ])
    vi.mocked(buildDesiredContacts).mockResolvedValue({ ok: true, desired, stats: {} })

    const out = await runZoomContactSync({ limit: 4 })

    expect(out.enqueued).toBe(4)
    expect(out.limited).toBe(true)
    const ops = vi.mocked(publishQueuePush).mock.calls.map((c) => c[0].body.op)
    expect(ops).toEqual(['create', 'create', 'create', 'update']) // limit spends itself on creates first
  })
})
