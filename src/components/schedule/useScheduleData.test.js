// @vitest-environment jsdom
//
// ROSTER-FIX.6a — the schedule calendar's fetchData had no try/catch and no
// request ordering. Two live defects fell out of that:
//   1. Any failed fetch rejected the Promise.all, so setLoading(false) never
//      ran and the screen sat on "Loading roster..." forever with nothing
//      telling the operator why. (memory: discarded-error defect class)
//   2. Clicking the week arrow faster than the API answers let an OLDER
//      response land last and paint a week the operator had already left.
// These pin both.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act, cleanup } from '@testing-library/react'

import { useScheduleData, readJson, SESSION_ENDED_MESSAGE, NO_ACCESS_MESSAGE } from './useScheduleData'

const ARGS = {
  locationId: 'loc1',
  startDate: '2026-05-04',
  endDate: '2026-05-10',
  spendReferenceDate: '2026-05-01',
  // ROSTERLOAD.1 (B1) — the spend route is manager-only; the default suite
  // runs as a manager so the six-read fan-out stays under test.
  canReadSpend: true,
}

// Every endpoint the hook fans out to, keyed by the path fragment that
// identifies it, so a test can answer one route differently from the rest.
function okResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

function defaultBody(url) {
  if (url.includes('/schedule/blocks')) return { data: [{ id: 'b1', block_date: '2026-05-04' }] }
  if (url.includes('/schedule/templates')) return { data: [{ id: 't1', active: true }, { id: 't2', active: false }] }
  if (url.includes('/api/staff')) return { data: [{ id: 's1' }] }
  if (url.includes('/schedule/time-off')) return { data: [{ id: 'to1' }] }
  if (url.includes('/holidays')) return { data: [{ date: '2026-05-04' }] }
  if (url.includes('contractor-spend')) return { success: true, data: { spend: 100 } }
  return { data: [] }
}

beforeEach(() => {
  global.fetch = vi.fn(async (url) => okResponse(defaultBody(url)))
})
// cleanup unmounts each hook's host tree before jsdom is torn down
// (see tests/rtl-cleanup-after-each.test.js).
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useScheduleData', () => {
  it('loads every slice and clears loading', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeNull()
    expect(result.current.blocks).toHaveLength(1)
    // Inactive templates are filtered out here, as the calendar always did.
    expect(result.current.templates.map(t => t.id)).toEqual(['t1'])
    expect(result.current.staff).toHaveLength(1)
    expect(result.current.timeOff).toHaveLength(1)
    expect(result.current.holidays).toHaveLength(1)
    expect(result.current.contractorSpend).toEqual({ spend: 100 })
  })

  // ROSTER-FIX.6c — the calendar's headline claim. Without the query param the
  // route hands a master/owner/manager caller `*`, so hourly_rate,
  // annual_salary and overtime_rate land in the tab on every roster load.
  it('asks /api/staff for the pay-free picker shape', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const staffUrls = global.fetch.mock.calls
      .map(([url]) => url)
      .filter(url => url.includes('/api/staff'))
    expect(staffUrls).toHaveLength(1)
    expect(staffUrls[0]).toContain('fields=picker')
  })

  it('does not fetch without a location', async () => {
    const { result } = renderHook(() => useScheduleData({ ...ARGS, locationId: null }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('clears loading and sets error when a fetch rejects', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeTruthy()
  })

  it('clears loading and sets error when a route answers non-OK', async () => {
    global.fetch = vi.fn(async (url) =>
      url.includes('/schedule/blocks')
        ? { ok: false, status: 500, json: async () => ({ error: 'Could not read the roster' }) }
        : okResponse(defaultBody(url))
    )
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Could not read the roster')
  })

  it('surfaces an error even when the body is not JSON', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json') } }))
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toMatch(/502/)
  })

  it('keeps the previously loaded week on screen when a refresh fails', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.blocks).toHaveLength(1))
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await act(async () => { await result.current.refresh() })
    expect(result.current.error).toBeTruthy()
    expect(result.current.blocks).toHaveLength(1)
  })

  it('clears a stale error on the next successful load', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.error).toBeTruthy())
    global.fetch = vi.fn(async (url) => okResponse(defaultBody(url)))
    await act(async () => { await result.current.refresh() })
    expect(result.current.error).toBeNull()
  })

  it('ignores an older response that resolves after a newer one', async () => {
    // Week A is slow, week B is fast. The operator clicks the arrow before A
    // answers; B paints, then A finally lands. A must be dropped.
    // Week A's requests are ALL held (three of the six carry the date) and
    // released together, or Promise.all never settles and the assertion is
    // vacuous - it passed with the guard deleted until this was fixed.
    const heldA = []
    global.fetch = vi.fn((url) => {
      if (!url.includes('2026-05-04')) return Promise.resolve(okResponse(defaultBody(url)))
      return new Promise((resolve) => {
        heldA.push(() => resolve(okResponse(
          url.includes('/schedule/blocks') ? { data: [{ id: 'STALE' }] } : defaultBody(url)
        )))
      })
    })

    const { result, rerender } = renderHook((props) => useScheduleData(props), { initialProps: ARGS })
    // Navigate to week B before A has answered.
    rerender({ ...ARGS, startDate: '2026-05-11', endDate: '2026-05-17' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.blocks.map(b => b.id)).toEqual(['b1'])

    await act(async () => { heldA.forEach(r => r()); await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.blocks.map(b => b.id)).toEqual(['b1'])
    expect(result.current.loading).toBe(false)
  })

  it('does not let a stale FAILED request wipe the current week', async () => {
    const gate = {}
    global.fetch = vi.fn((url) => {
      if (url.includes('2026-05-04')) {
        return new Promise((_resolve, reject) => { gate.failA = () => reject(new TypeError('Failed to fetch')) })
      }
      return Promise.resolve(okResponse(defaultBody(url)))
    })
    const { result, rerender } = renderHook((props) => useScheduleData(props), { initialProps: ARGS })
    rerender({ ...ARGS, startDate: '2026-05-11', endDate: '2026-05-17' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { gate.failA(); await new Promise(r => setTimeout(r, 0)) })
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })
})

// ROSTER-FIX.6a-8 — an expired cookie answers 401 on every schedule endpoint
// at once. As "Request failed (401)" that reads like an outage and sends the
// operator hunting for a server problem, so the one thing they can actually do
// about it is named instead. No redirect: unpublished roster edits may be on
// screen. A 403 is a DIFFERENT state (a live session that may not read this
// location) and must not tell them to sign in again.
describe('readJson session handling (ROSTER-FIX.6a-8)', () => {
  it('names a signed-out session on 401', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('keeps the server\'s own words on a 403, and never says signed out', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden - location not in your assignments' }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow('Forbidden - location not in your assignments')
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden - location not in your assignments' }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.not.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('falls back to a permission sentence when a 403 carries no message', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(NO_ACCESS_MESSAGE)
  })

  it('says so even when the 401 body is not JSON', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => { throw new Error('not json') } }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('leaves other statuses to the server\'s own words', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'Database is unavailable' }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow('Database is unavailable')
  })

  it('surfaces the signed-out message through the hook', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe(SESSION_ENDED_MESSAGE)
  })

  // ROSTER-FIX.6a-8 (finding 7) — every other failure fixture omits
  // `success`, so `!res.ok` could be deleted from the check and the suite
  // would still pass. This one is non-OK AND claims success.
  it('fails a non-OK response even when the body claims success', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: true }) }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(/500/)
  })
})

// CHANGELOG.1 — in production a signed-out request never reaches a route to be
// answered 401: src/proxy.js redirects it to /login, fetch FOLLOWS the redirect,
// and what comes back is 200 + an HTML page. That read as "Request failed
// (200)", or worse as an empty success.
describe('readJson — a signed-out request that was redirected to /login', () => {
  const html = async () => { throw new Error("Unexpected token '<'") }

  it('a followed redirect is a signed-out session', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, redirected: true, json: html }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('so is a 200 whose body is not JSON, on a read', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, redirected: false, json: html }))
    await expect(readJson('/api/schedule/blocks')).rejects.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('a redirected MUTATION is signed out too', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, redirected: true, json: html }))
    await expect(readJson('/api/schedule/reports/scheduled/x', { method: 'DELETE' })).rejects.toThrow(SESSION_ENDED_MESSAGE)
  })

  it('but a mutation that answers 200 with an empty body is still a success (unchanged)', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, redirected: false, json: html }))
    await expect(readJson('/api/schedule/reports/scheduled/x', { method: 'DELETE' })).resolves.toEqual({})
  })
})

// ROSTER-FIX.6a-9 (finding 4) — keeping the last-good data under the banner is
// right for a flaky refresh of the SAME week and wrong the moment the header
// has moved on: the previous week's blocks then render under the new week's
// dates, and a sparse week reads as "nobody is rostered" with nothing on
// screen saying otherwise.
describe('stale data on a failed load (ROSTER-FIX.6a-9)', () => {
  it('keeps the week on screen when a refresh of THAT week fails, and flags it', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.blocks).toHaveLength(1))

    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await act(async () => { await result.current.refresh() })

    expect(result.current.error).toBeTruthy()
    expect(result.current.blocks).toHaveLength(1)
    expect(result.current.showingStaleData).toBe(true)
  })

  it('clears the range-scoped slices when the load for a DIFFERENT range fails', async () => {
    const { result, rerender } = renderHook((props) => useScheduleData(props), { initialProps: ARGS })
    await waitFor(() => expect(result.current.blocks).toHaveLength(1))
    expect(result.current.contractorSpend).toEqual({ spend: 100 })

    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    rerender({ ...ARGS, startDate: '2026-05-11', endDate: '2026-05-17' })

    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.blocks).toEqual([])
    expect(result.current.contractorSpend).toBeNull()
    // Nothing is being shown, so the banner must not claim otherwise.
    expect(result.current.showingStaleData).toBe(false)
  })

  it('does not flag stale data when the very first load fails', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.showingStaleData).toBe(false)
    expect(result.current.blocks).toEqual([])
  })

  it('drops the stale flag once a load succeeds again', async () => {
    const { result } = renderHook(() => useScheduleData(ARGS))
    await waitFor(() => expect(result.current.blocks).toHaveLength(1))
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await act(async () => { await result.current.refresh() })
    expect(result.current.showingStaleData).toBe(true)

    global.fetch = vi.fn(async (url) => okResponse(defaultBody(url)))
    await act(async () => { await result.current.refresh() })
    expect(result.current.showingStaleData).toBe(false)
    expect(result.current.error).toBeNull()
  })
})

// ROSTERLOAD.1 — the fan-out was all-or-nothing: ONE Promise.all over six
// reads, so a 500 from the approved-leave read, the bank-holiday read or the
// contractor-spend read failed the whole roster (same week: stale banner; new
// week: blocks cleared, an empty week on screen). Only the blocks read decides
// whether the roster loaded now. Every other slice settles on its own, keeps
// its last value only while that value still belongs to what is on screen,
// and says it failed in `partialErrors` instead of reading as "none".
describe('each slice settles on its own (ROSTERLOAD.1)', () => {
  const WEEK_B = { ...ARGS, startDate: '2026-05-11', endDate: '2026-05-17' }

  // Fails every read whose URL contains `fragment`; answers the rest normally.
  function failing(fragment, response = { ok: false, status: 500, json: async () => ({ error: `${fragment} broke` }) }) {
    return vi.fn(async (url) => (url.includes(fragment) ? response : okResponse(defaultBody(url))))
  }

  async function loaded(props = ARGS) {
    const hook = renderHook((p) => useScheduleData(p), { initialProps: props })
    await waitFor(() => expect(hook.result.current.successCount).toBe(1))
    return hook
  }

  it('a clean load reports no partial errors', async () => {
    const { result } = await loaded()
    expect(result.current.partialErrors).toBeNull()
  })

  describe('the blocks read still decides the roster, exactly as before', () => {
    it('same week: keeps the roster, flags it stale, and the other slices are not partial', async () => {
      const { result } = await loaded()
      global.fetch = failing('/schedule/blocks')
      await act(async () => { await result.current.refresh() })
      expect(result.current.error).toBe('/schedule/blocks broke')
      expect(result.current.showingStaleData).toBe(true)
      expect(result.current.blocks).toHaveLength(1)
      expect(result.current.successCount).toBe(1)
      expect(result.current.partialErrors).toBeNull()
      expect(result.current.loading).toBe(false)
    })

    it('new week: clears the roster and does not claim stale data', async () => {
      const { result, rerender } = await loaded()
      global.fetch = failing('/schedule/blocks')
      rerender(WEEK_B)
      await waitFor(() => expect(result.current.error).toBe('/schedule/blocks broke'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.blocks).toEqual([])
      expect(result.current.showingStaleData).toBe(false)
      expect(result.current.successCount).toBe(1)
    })
  })

  describe('approved leave fails alone', () => {
    it('the roster still loads, the error is not top-level, and leave is marked missing', async () => {
      global.fetch = failing('/schedule/time-off')
      const { result } = await loaded()
      expect(result.current.error).toBeNull()
      expect(result.current.showingStaleData).toBe(false)
      expect(result.current.blocks).toHaveLength(1)
      expect(result.current.timeOff).toEqual([])
      expect(result.current.partialErrors).toEqual({
        timeOff: { message: '/schedule/time-off broke', kept: false },
      })
    })

    it('a same-week refresh keeps the leave it already had, and says so', async () => {
      const { result } = await loaded()
      global.fetch = failing('/schedule/time-off')
      await act(async () => { await result.current.refresh() })
      expect(result.current.error).toBeNull()
      expect(result.current.timeOff).toHaveLength(1)
      expect(result.current.partialErrors.timeOff).toEqual({ message: '/schedule/time-off broke', kept: true })
    })

    it('a new week clears the previous week\'s leave rather than painting it under new dates', async () => {
      const { result, rerender } = await loaded()
      global.fetch = failing('/schedule/time-off')
      rerender(WEEK_B)
      await waitFor(() => expect(result.current.successCount).toBe(2))
      expect(result.current.error).toBeNull()
      expect(result.current.timeOff).toEqual([])
      expect(result.current.partialErrors.timeOff.kept).toBe(false)
    })
  })

  it('bank holidays: kept on a same-week refresh, cleared on a new week', async () => {
    const { result, rerender } = await loaded()
    global.fetch = failing('/holidays')
    await act(async () => { await result.current.refresh() })
    expect(result.current.error).toBeNull()
    expect(result.current.holidays).toHaveLength(1)
    expect(result.current.partialErrors).toEqual({ holidays: { message: '/holidays broke', kept: true } })

    rerender(WEEK_B)
    await waitFor(() => expect(result.current.successCount).toBe(3))
    expect(result.current.holidays).toEqual([])
    expect(result.current.partialErrors).toEqual({ holidays: { message: '/holidays broke', kept: false } })
  })

  it('contractor spend: kept on a same-range refresh, cleared on a new week', async () => {
    const { result, rerender } = await loaded()
    global.fetch = failing('contractor-spend')
    await act(async () => { await result.current.refresh() })
    expect(result.current.error).toBeNull()
    expect(result.current.contractorSpend).toEqual({ spend: 100 })
    expect(result.current.partialErrors).toEqual({ contractorSpend: { message: 'contractor-spend broke', kept: true } })

    rerender(WEEK_B)
    await waitFor(() => expect(result.current.successCount).toBe(3))
    expect(result.current.contractorSpend).toBeNull()
    expect(result.current.partialErrors.contractorSpend.kept).toBe(false)
  })

  it('contractor spend failing on the very first load leaves it null and says so', async () => {
    global.fetch = failing('contractor-spend')
    const { result } = await loaded()
    expect(result.current.contractorSpend).toBeNull()
    expect(result.current.partialErrors).toEqual({ contractorSpend: { message: 'contractor-spend broke', kept: false } })
  })

  // Templates and the coach list do not depend on the dates, so a new week
  // can keep them. They DO belong to a location, so a new location cannot.
  for (const [slice, fragment, expected] of [
    ['templates', '/schedule/templates', ['t1']],
    ['staff', '/api/staff', ['s1']],
  ]) {
    describe(`${slice} fails alone`, () => {
      it('the first load leaves it empty and marks it missing', async () => {
        global.fetch = failing(fragment)
        const { result } = await loaded()
        expect(result.current.error).toBeNull()
        expect(result.current[slice]).toEqual([])
        expect(result.current.partialErrors).toEqual({ [slice]: { message: `${fragment} broke`, kept: false } })
      })

      it('a new week at the same location keeps the list it had', async () => {
        const { result, rerender } = await loaded()
        global.fetch = failing(fragment)
        rerender(WEEK_B)
        await waitFor(() => expect(result.current.successCount).toBe(2))
        expect(result.current[slice].map(x => x.id)).toEqual(expected)
        expect(result.current.partialErrors[slice].kept).toBe(true)
      })

      it('a different location clears it', async () => {
        const { result, rerender } = await loaded()
        global.fetch = failing(fragment)
        rerender({ ...ARGS, locationId: 'loc2' })
        await waitFor(() => expect(result.current.successCount).toBe(2))
        expect(result.current[slice]).toEqual([])
        expect(result.current.partialErrors[slice].kept).toBe(false)
      })
    })
  }

  // A 401/403 on ANY read means the session or the access is gone, and the
  // next action will fail the same way. That is not a degraded slice, it is
  // the roster not loading.
  describe('a signed-out answer on a non-blocks read is top-level', () => {
    it('401 on holidays: top-level error, no success, no partials', async () => {
      global.fetch = failing('/holidays', { ok: false, status: 401, json: async () => ({}) })
      const { result } = renderHook(() => useScheduleData(ARGS))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.error).toBe(SESSION_ENDED_MESSAGE)
      expect(result.current.successCount).toBe(0)
      expect(result.current.partialErrors).toBeNull()
      expect(result.current.blocks).toEqual([])
    })

    it('a signed-out redirect on the leave read during a same-week refresh keeps the week and flags it stale', async () => {
      const { result } = await loaded()
      global.fetch = failing('/schedule/time-off', { ok: true, status: 200, redirected: true, json: async () => { throw new Error('html') } })
      await act(async () => { await result.current.refresh() })
      expect(result.current.error).toBe(SESSION_ENDED_MESSAGE)
      expect(result.current.showingStaleData).toBe(true)
      expect(result.current.blocks).toHaveLength(1)
      expect(result.current.successCount).toBe(1)
    })
  })

  // ROSTERLOAD.1 (B1) — on a SIDE read only 401 is fatal. A 403 there is a
  // permission difference, not lost access: blocks, templates, time-off and
  // holidays all run assertLocationAccess for the same location, so lost
  // access shows up as a 403 on BLOCKS. The live case was contractor spend,
  // which is manager-only and answered every coach's calendar 403, killing
  // the roster for every coach and reception user.
  describe('a 403 on a side read is a permission difference, not a dead roster', () => {
    const forbidden = { ok: false, status: 403, json: async () => ({ success: false, error: 'Unauthorized' }) }

    it('403 on contractor spend (the real body): roster loads, spend is a partial error', async () => {
      global.fetch = failing('contractor-spend', forbidden)
      const { result } = await loaded()
      expect(result.current.error).toBeNull()
      expect(result.current.blocks).toHaveLength(1)
      expect(result.current.contractorSpend).toBeNull()
      expect(result.current.partialErrors).toEqual({ contractorSpend: { message: 'Unauthorized', kept: false } })
    })

    it('403 on the coach list: roster loads, staff is a partial error', async () => {
      global.fetch = failing('/api/staff', forbidden)
      const { result } = await loaded()
      expect(result.current.error).toBeNull()
      expect(result.current.partialErrors).toEqual({ staff: { message: 'Unauthorized', kept: false } })
    })

    it('403 on BLOCKS stays fatal, in the server\'s words, and a new week is cleared', async () => {
      const { result, rerender } = await loaded()
      global.fetch = failing('/schedule/blocks', { ok: false, status: 403, json: async () => ({ error: 'Forbidden - location not in your assignments' }) })
      rerender(WEEK_B)
      await waitFor(() => expect(result.current.error).toBe('Forbidden - location not in your assignments'))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.blocks).toEqual([])
      expect(result.current.showingStaleData).toBe(false)
    })
  })

  describe('contractor spend is not asked for when it cannot succeed (B1)', () => {
    it('without canReadSpend: no spend request, spend null, and nothing partial', async () => {
      const { result } = await loaded({ ...ARGS, canReadSpend: false })
      expect(global.fetch.mock.calls.some(([url]) => url.includes('contractor-spend'))).toBe(false)
      expect(result.current.contractorSpend).toBeNull()
      expect(result.current.partialErrors).toBeNull()
      expect(result.current.error).toBeNull()
      expect(result.current.blocks).toHaveLength(1)
    })

    it('losing canReadSpend drops a spend figure loaded earlier', async () => {
      const { result, rerender } = await loaded()
      expect(result.current.contractorSpend).toEqual({ spend: 100 })
      rerender({ ...ARGS, canReadSpend: false })
      await waitFor(() => expect(result.current.successCount).toBe(2))
      expect(result.current.contractorSpend).toBeNull()
    })
  })

  // ROSTERLOAD.1 (S1) — the blocks key was the date range alone, so a failed
  // blocks read after a studio switch in the same week kept studio A's
  // blocks under studio B, while staff and templates moved to B.
  it('a failed blocks read after a location switch in the same week clears the blocks', async () => {
    const { result, rerender } = await loaded()
    global.fetch = failing('/schedule/blocks')
    rerender({ ...ARGS, locationId: 'loc2' })
    await waitFor(() => expect(result.current.error).toBe('/schedule/blocks broke'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.blocks).toEqual([])
    expect(result.current.showingStaleData).toBe(false)
  })

  // ROSTERLOAD.1 (S3) — a body of the wrong shape must fail THAT slice, not
  // throw out of the state writes half-applied.
  describe('a malformed body fails its own slice', () => {
    const malformed = okResponse({ data: 'not a list' })

    it('malformed templates: roster loads, templates is a partial error', async () => {
      global.fetch = failing('/schedule/templates', malformed)
      const { result } = await loaded()
      expect(result.current.error).toBeNull()
      expect(result.current.templates).toEqual([])
      expect(result.current.partialErrors.templates.kept).toBe(false)
      expect(result.current.timeOff).toHaveLength(1)
    })

    it('malformed blocks on a new week: the full roster failure, blocks cleared, not stale', async () => {
      const { result, rerender } = await loaded()
      global.fetch = failing('/schedule/blocks', malformed)
      rerender(WEEK_B)
      await waitFor(() => expect(result.current.error).toBeTruthy())
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.blocks).toEqual([])
      expect(result.current.showingStaleData).toBe(false)
      expect(result.current.successCount).toBe(1)
    })

    it('malformed blocks on a same-week refresh: keeps the week and flags it stale', async () => {
      const { result } = await loaded()
      global.fetch = failing('/schedule/blocks', malformed)
      await act(async () => { await result.current.refresh() })
      expect(result.current.error).toBeTruthy()
      expect(result.current.blocks).toHaveLength(1)
      expect(result.current.showingStaleData).toBe(true)
    })
  })

  it('a later full success clears partialErrors', async () => {
    global.fetch = failing('/schedule/time-off')
    const { result } = await loaded()
    expect(result.current.partialErrors).not.toBeNull()
    global.fetch = vi.fn(async (url) => okResponse(defaultBody(url)))
    await act(async () => { await result.current.refresh() })
    expect(result.current.partialErrors).toBeNull()
    expect(result.current.timeOff).toHaveLength(1)
  })

  // The generation guard must hold for EVERY slice now that they settle
  // separately: a late loser for week A may neither write its data nor its
  // failure over week B.
  for (const fragment of ['/schedule/blocks', '/schedule/templates', '/api/staff', '/schedule/time-off', '/holidays', 'contractor-spend']) {
    for (const outcome of ['resolves', 'rejects']) {
    it(`a late loser cannot write ${fragment} over the current week when it ${outcome}`, async () => {
      const held = []
      let firstRound = true
      global.fetch = vi.fn((url) => {
        if (firstRound && url.includes(fragment)) {
          return new Promise((resolve, reject) => { held.push({ resolve, reject }) })
        }
        return Promise.resolve(okResponse(defaultBody(url)))
      })
      const { result, rerender } = renderHook((p) => useScheduleData(p), { initialProps: ARGS })
      firstRound = false
      rerender(WEEK_B)
      await waitFor(() => expect(result.current.successCount).toBe(1))
      const before = { ...result.current }

      await act(async () => {
        held.forEach(h => (outcome === 'rejects'
          ? h.reject(new TypeError('Failed to fetch'))
          : h.resolve(okResponse({ success: true, data: [{ id: 'STALE', active: true }] }))))
        await new Promise(r => setTimeout(r, 0))
      })
      expect(result.current.error).toBeNull()
      expect(result.current.partialErrors).toBeNull()
      for (const k of ['blocks', 'templates', 'staff', 'timeOff', 'holidays', 'contractorSpend']) {
        expect(result.current[k]).toEqual(before[k])
      }
      expect(result.current.loading).toBe(false)
    })
    }
  }
})
