// Tests for src/lib/external-export.js (P1-10).
//
// Key behaviours covered:
//
//   1. enqueueExportsForSession — idempotency via upsert + ignoreDuplicates;
//      only queues for integrations with auto_export_enabled=true.
//
//   2. runExportWorker — claims jobs and processes them. The critical money/data
//      regression here is the 1000-row cap: if selectAll is broken or not used,
//      a 45-min class (~2700 HR samples) would be silently truncated to 1000
//      samples and Strava would receive a chopped graph. We verify that a
//      paginated >1000-sample dataset arrives at buildTcx in full.
//
//   3. Worker skips integration if it has been disconnected.
//
//   4. Worker skips if fewer than 10 samples (too thin to be useful).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/tcx-builder', () => ({ buildTcx: vi.fn(() => '<tcx/>') }))
vi.mock('@/lib/strava', () => ({
  refreshAccessToken: vi.fn(),
  uploadTcx: vi.fn(),
  pollUpload: vi.fn(),
}))

import { enqueueExportsForSession, runExportWorker } from './external-export.js'
import { buildTcx } from '@/lib/tcx-builder'
import { uploadTcx } from '@/lib/strava'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSamples(n) {
  return Array.from({ length: n }, (_, i) => ({
    recorded_at: new Date(Date.now() + i * 1000).toISOString(),
    bpm: 140 + (i % 20),
  }))
}

/**
 * Build a DB mock where hr_samples returns `allSamples` via a paginated
 * selectAll-compatible interface: each call to .range(from, to) returns
 * the slice [from..to] from allSamples.
 *
 * This simulates the 1000-row-per-page PostgREST ceiling. The mock
 * honours the slice contract so selectAll can page through and reassemble
 * the full dataset.
 *
 * The contact_external_integrations chain is:
 *   .select('*').eq(contact_id).eq(provider).is(disconnected_at).maybeSingle()
 */
function makeWorkerDb({
  jobs = [],
  integration = null,
  service = null,
  session = null,
  allSamples = [],
  upsertError = null,
} = {}) {
  const updates = []
  const upserts = []

  // Fluent chain helper — returns an object where every method returns
  // itself, except `maybeSingle` and `range` which return the real data.
  // This handles arbitrary-depth .eq().eq().is()... chains.
  function chain(terminal) {
    const proxy = new Proxy({}, {
      get(_, prop) {
        if (prop === 'maybeSingle') return () => terminal
        if (prop === 'single') return () => terminal
        if (prop === 'range') return (from, to) => {
          // Used by hr_samples — terminal is a function here
          if (typeof terminal === 'function') return terminal(from, to)
          return terminal
        }
        // Return something thenable for await compatibility
        if (prop === 'then') return undefined
        return () => proxy
      },
    })
    return proxy
  }

  const shims = {
    external_export_jobs: {
      select: (..._args) => ({
        in: () => ({
          lte: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: jobs, error: null }),
            }),
          }),
        }),
      }),
      update: (patch) => {
        const entry = { patch }
        updates.push(entry)
        return {
          eq: (col, val) => {
            entry.col = col; entry.val = val
            return Promise.resolve({ data: null, error: null })
          },
        }
      },
      upsert: (rows, opts) => {
        upserts.push({ rows, opts })
        return Promise.resolve({ error: upsertError })
      },
    },
    contact_external_integrations: {
      // processOneJob calls: .select('*').eq().eq().is().maybeSingle()
      select: () => chain(Promise.resolve({ data: integration, error: null })),
      update: (patch) => {
        const entry = { patch, table: 'contact_external_integrations' }
        updates.push(entry)
        return chain(Promise.resolve({ data: null, error: null }))
      },
    },
    service_integrations: {
      select: () => chain(Promise.resolve({ data: service, error: null })),
    },
    heart_rate_sessions: {
      select: () => chain(Promise.resolve({ data: session, error: null })),
    },
    hr_samples: {
      // selectAll calls: .select().eq().order().range(from, to)
      // The terminal function receives (from, to) and slices allSamples.
      select: () => chain((from, to) => {
        const slice = allSamples.slice(from, to + 1)
        return Promise.resolve({ data: slice, error: null })
      }),
    },
  }

  return {
    from: (table) => shims[table] || {
      select: () => chain(Promise.resolve({ data: null, error: null })),
      update: () => chain(Promise.resolve({ data: null, error: null })),
      upsert: () => Promise.resolve({ error: null }),
    },
    _updates: updates,
    _upserts: upserts,
  }
}

// ─── enqueueExportsForSession ─────────────────────────────────────────────────

describe('enqueueExportsForSession', () => {
  function makeEnqueueDb({ integrations = [], upsertError = null } = {}) {
    const upserts = []
    return {
      from: (table) => {
        if (table === 'contact_external_integrations') {
          return {
            select: () => ({
              eq: () => ({
                is: () => ({
                  eq: () => Promise.resolve({ data: integrations, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'external_export_jobs') {
          return {
            upsert: (rows, opts) => {
              upserts.push({ rows, opts })
              return Promise.resolve({ error: upsertError })
            },
          }
        }
        return {}
      },
      _upserts: upserts,
    }
  }

  it('returns queued=0 and never upserts when session has no ended_at', async () => {
    const db = makeEnqueueDb()
    const result = await enqueueExportsForSession(db, {
      id: 'sess-1',
      contact_id: 'c-1',
      ended_at: null,
    })
    expect(result.queued).toBe(0)
    expect(db._upserts).toHaveLength(0)
  })

  it('returns queued=0 when the contact has no active integrations', async () => {
    const db = makeEnqueueDb({ integrations: [] })
    const result = await enqueueExportsForSession(db, {
      id: 'sess-1',
      contact_id: 'c-1',
      ended_at: '2026-01-15T11:00:00Z',
    })
    expect(result.queued).toBe(0)
    expect(db._upserts).toHaveLength(0)
  })

  it('upserts with ignoreDuplicates=true — re-enqueuing the same session is idempotent', async () => {
    const db = makeEnqueueDb({
      integrations: [{ contact_id: 'c-1', provider: 'strava', auto_export_enabled: true }],
    })
    const result = await enqueueExportsForSession(db, {
      id: 'sess-1',
      contact_id: 'c-1',
      ended_at: '2026-01-15T11:00:00Z',
    })
    expect(result.queued).toBe(1)
    expect(db._upserts).toHaveLength(1)
    const { rows, opts } = db._upserts[0]
    expect(opts.ignoreDuplicates).toBe(true)
    expect(opts.onConflict).toMatch(/session_id/)
    expect(rows[0]).toMatchObject({
      session_id: 'sess-1',
      contact_id: 'c-1',
      provider: 'strava',
    })
  })
})

// ─── runExportWorker — pagination (the 1000-row truncation regression) ────────

describe('runExportWorker — HR samples pagination', () => {
  const baseJob = {
    id: 'job-1',
    session_id: 'sess-1',
    contact_id: 'c-1',
    provider: 'strava',
    attempts: 0,
  }
  const baseIntegration = {
    id: 'int-1',
    contact_id: 'c-1',
    provider: 'strava',
    auto_export_enabled: true,
    disconnected_at: null,
    access_token: 'tok-valid',
    refresh_token: 'ref-tok',
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), // not expired
  }
  const baseService = {
    provider: 'strava',
    is_enabled: true,
    client_id: 'cid',
    client_secret: 'csec',
  }
  const baseSession = {
    id: 'sess-1',
    contact_id: 'c-1',
    started_at: new Date(Date.now() - 45 * 60_000).toISOString(),
    ended_at: new Date().toISOString(),
    avg_hr_bpm: 155,
    peak_hr_bpm: 185,
    effort_points: 450,
    zones_seconds: {},
  }

  beforeEach(() => {
    vi.clearAllMocks()
    uploadTcx.mockResolvedValue({ activityId: 'strava-act-123', uploadId: null })
  })

  it('passes ALL samples to buildTcx when >1000 rows (pagination regression)', async () => {
    // A 45-min class at 1 sample/sec = 2700 samples. Without pagination
    // via selectAll, the PostgREST 1000-row cap would silently truncate to
    // 1000. This test verifies the full set reaches buildTcx.
    const TOTAL = 2700
    const allSamples = makeSamples(TOTAL, 'sess-1')

    const db = makeWorkerDb({
      jobs: [baseJob],
      integration: baseIntegration,
      service: baseService,
      session: baseSession,
      allSamples,
    })

    await runExportWorker(db)

    expect(buildTcx).toHaveBeenCalledOnce()
    const callArgs = buildTcx.mock.calls[0][0]
    expect(callArgs.samples).toHaveLength(TOTAL)
    // Spot-check that the last sample is present, not truncated at 1000
    expect(callArgs.samples[TOTAL - 1]).toEqual(allSamples[TOTAL - 1])
  })

  it('skips (does not upload) when sample count < 10', async () => {
    const db = makeWorkerDb({
      jobs: [baseJob],
      integration: baseIntegration,
      service: baseService,
      session: baseSession,
      allSamples: makeSamples(8),
    })

    await runExportWorker(db)
    expect(buildTcx).not.toHaveBeenCalled()
    expect(uploadTcx).not.toHaveBeenCalled()
  })

  it('skips when the integration has been disconnected', async () => {
    const db = makeWorkerDb({
      jobs: [baseJob],
      integration: { ...baseIntegration, auto_export_enabled: false },
      service: baseService,
      session: baseSession,
      allSamples: makeSamples(500),
    })

    await runExportWorker(db)
    expect(buildTcx).not.toHaveBeenCalled()
    expect(uploadTcx).not.toHaveBeenCalled()
  })

  it('returns processed count matching the claimed batch', async () => {
    const allSamples = makeSamples(50)
    const db = makeWorkerDb({
      jobs: [baseJob],
      integration: baseIntegration,
      service: baseService,
      session: baseSession,
      allSamples,
    })

    const result = await runExportWorker(db)
    expect(result.processed).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('returns processed=0 when no jobs are due', async () => {
    const db = makeWorkerDb({ jobs: [] })
    const result = await runExportWorker(db)
    expect(result.processed).toBe(0)
  })
})
