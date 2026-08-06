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
import { runZoomContactSync } from './reconcile'

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
})
