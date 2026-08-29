import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SEARCH_DEBOUNCE_MS,
  initialSearchState,
  createMailSearchController,
  searchScopeLine,
  noMatchesCopy,
  SEARCH_ERROR_COPY,
  splitHighlight,
  createFanOutSearch,
  groupedSearchDisplay,
  groupedScopeLine,
  searchSectionHeader,
} from './mail-search'

// MOBILE-MAIL-SEARCH.1 — the search screen's whole decision surface lives in
// this module (the screen has no render harness, so every branch is here).
// Three families of rules:
//   • the debounce/lifecycle machine — when a keystroke becomes a request,
//     which response is allowed to land, and what a failure reads as;
//   • the scope line — the honest statement of what was searched;
//   • highlight splitting — which characters of a subject get the ink mark.

// ── controller ───────────────────────────────────────────────────────

/** A controller wired to a controllable fake search + a state recorder. */
function harness({ debounceMs } = {}) {
  const calls = []
  let resolvers = []
  const search = vi.fn((q) => new Promise((resolve, reject) => {
    calls.push(q)
    resolvers.push({ resolve, reject, q })
  }))
  const states = []
  const controller = createMailSearchController({
    search,
    onState: (s) => states.push(s),
    ...(debounceMs !== undefined ? { debounceMs } : {}),
  })
  return {
    search,
    calls,
    states,
    controller,
    // resolve the oldest still-pending request
    resolveNext: (value) => { resolvers.shift().resolve(value) },
    rejectNext: (err) => { resolvers.shift().reject(err) },
    last: () => states[states.length - 1],
  }
}

const ok = (rows, extra = {}) => ({ success: true, data: rows, ...extra })

// Fake timers everywhere the debounce is involved: the 300ms must be
// asserted, not slept through.
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('initialSearchState', () => {
  it('starts idle with nothing loaded', () => {
    expect(initialSearchState()).toEqual({
      query: '', phase: 'idle', rows: [], searchPartial: false, error: null,
    })
  })
})

describe('createMailSearchController — debounce', () => {
  it('does not search immediately on a keystroke', () => {
    const h = harness()
    h.controller.setQuery('freeze')
    expect(h.search).not.toHaveBeenCalled()
  })

  it('searches once, with the trimmed query, after the debounce window', () => {
    const h = harness()
    h.controller.setQuery('  freeze ')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(h.calls).toEqual(['freeze'])
  })

  it('waits the full default 300ms — not less', () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1)
    expect(h.search).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.search).toHaveBeenCalledTimes(1)
  })

  it('a keystroke inside the window restarts it — one request for the final text', () => {
    const h = harness()
    h.controller.setQuery('f')
    vi.advanceTimersByTime(200)
    h.controller.setQuery('fr')
    vi.advanceTimersByTime(200)
    expect(h.search).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(h.calls).toEqual(['fr'])
  })

  it('honours a custom debounceMs', () => {
    const h = harness({ debounceMs: 50 })
    h.controller.setQuery('x')
    vi.advanceTimersByTime(50)
    expect(h.search).toHaveBeenCalledTimes(1)
  })

  it('re-setting the same trimmed query is a no-op (no duplicate request)', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext(ok([{ id: 't1' }]))
    await Promise.resolve()
    h.controller.setQuery('freeze ') // trims identical
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(h.search).toHaveBeenCalledTimes(1)
  })

  it('clearing and retyping the same query DOES search again', () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.controller.setQuery('')
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(h.calls).toEqual(['freeze', 'freeze'])
  })
})

describe('createMailSearchController — blank queries', () => {
  it('a blank query never searches and stays idle (no emission — nothing changed)', () => {
    const h = harness()
    h.controller.setQuery('   ')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
    expect(h.search).not.toHaveBeenCalled()
    expect(h.states).toEqual([]) // whitespace on an idle screen is a no-op
    expect(h.controller.getState()).toEqual(initialSearchState())
  })

  it('clearing cancels a pending debounce', () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(100)
    h.controller.setQuery('')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
    expect(h.search).not.toHaveBeenCalled()
  })

  it('clearing while a request is in flight drops its response — no ghost results', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.controller.setQuery('')
    h.resolveNext(ok([{ id: 'ghost' }]))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.last().phase).toBe('idle')
    expect(h.last().rows).toEqual([])
  })

  it('clearing resets rows from an earlier result set', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext(ok([{ id: 't1' }]))
    await Promise.resolve()
    h.controller.setQuery('')
    expect(h.last()).toEqual(initialSearchState())
  })
})

describe('createMailSearchController — lifecycle & results', () => {
  it('goes searching (with the query named) when the debounce fires', () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(h.last().phase).toBe('searching')
    expect(h.last().query).toBe('freeze')
  })

  it('keeps the previous rows on screen while a refinement is searching', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext(ok([{ id: 't1' }]))
    await Promise.resolve()
    h.controller.setQuery('freeze sept')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(h.last().phase).toBe('searching')
    expect(h.last().rows).toEqual([{ id: 't1' }])
  })

  it('a success lands as results with rows and searchPartial', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext(ok([{ id: 't1' }, { id: 't2' }], { searchPartial: true }))
    await Promise.resolve()
    expect(h.last()).toMatchObject({
      phase: 'results',
      rows: [{ id: 't1' }, { id: 't2' }],
      searchPartial: true,
      error: null,
    })
  })

  it('searchPartial is false when the response omits it', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext(ok([{ id: 't1' }]))
    await Promise.resolve()
    expect(h.last().searchPartial).toBe(false)
  })

  it('missing data on a success is an empty result list, not a crash', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext({ success: true })
    await Promise.resolve()
    expect(h.last().phase).toBe('results')
    expect(h.last().rows).toEqual([])
  })
})

describe('createMailSearchController — failure is loud, never an empty state', () => {
  it('success:false lands as an error carrying the server message', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext({ success: false, error: 'nope' })
    await Promise.resolve()
    expect(h.last().phase).toBe('error')
    expect(h.last().error).toBe('nope')
  })

  it('a thrown search is an error too, with fallback copy', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.rejectNext(new Error('network'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.last().phase).toBe('error')
    expect(typeof h.last().error).toBe('string')
    expect(h.last().error.length).toBeGreaterThan(0)
  })

  it('an error keeps the previous rows (context is not thrown away)', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext(ok([{ id: 't1' }]))
    await Promise.resolve()
    h.controller.setQuery('freeze sept')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext({ success: false, error: 'nope' })
    await Promise.resolve()
    expect(h.last().phase).toBe('error')
    expect(h.last().rows).toEqual([{ id: 't1' }])
  })

  it('retry() re-runs the current query immediately, without a debounce', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext({ success: false, error: 'nope' })
    await Promise.resolve()
    h.controller.retry()
    expect(h.calls).toEqual(['freeze', 'freeze'])
    h.resolveNext(ok([{ id: 't1' }]))
    await Promise.resolve()
    expect(h.last().phase).toBe('results')
  })

  it('retry() with no query is a no-op', () => {
    const h = harness()
    h.controller.retry()
    expect(h.search).not.toHaveBeenCalled()
  })
})

describe('createMailSearchController — stale responses', () => {
  it('an older request resolving after a newer one is dropped', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.controller.setQuery('freeze sept')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    // newer answers first…
    h.resolveNext(ok([{ id: 'old' }])) // this is actually the FIRST (older) request
    // resolvers are FIFO: shift() above resolved the OLD one — assert it's dropped
    await Promise.resolve()
    expect(h.last().phase).toBe('searching') // still waiting on the newer one
    h.resolveNext(ok([{ id: 'new' }]))
    await Promise.resolve()
    expect(h.last().rows).toEqual([{ id: 'new' }])
  })

  it('an older request FAILING after a newer one landed cannot paint an error', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.controller.setQuery('freeze sept')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    // FIFO harness: the shift() takes the OLD request — its failure must not land
    h.rejectNext(new Error('old blew up'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.last().phase).toBe('searching')
    h.resolveNext(ok([{ id: 'new' }]))
    await Promise.resolve()
    expect(h.last().phase).toBe('results')
    expect(h.last().rows).toEqual([{ id: 'new' }])
  })
})

describe('createMailSearchController — dispose', () => {
  it('cancels a pending debounce', () => {
    const h = harness()
    h.controller.setQuery('freeze')
    h.controller.dispose()
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
    expect(h.search).not.toHaveBeenCalled()
  })

  it('drops an in-flight response and emits nothing after', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    const emitted = h.states.length
    h.controller.dispose()
    h.resolveNext(ok([{ id: 't1' }]))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.states.length).toBe(emitted)
  })

  it('setQuery after dispose is dead — no search, no emission', () => {
    const h = harness()
    h.controller.dispose()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2)
    expect(h.search).not.toHaveBeenCalled()
    expect(h.states).toEqual([])
  })

  it('retry after dispose is dead too', async () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    h.resolveNext({ success: false, error: 'nope' })
    await Promise.resolve()
    h.controller.dispose()
    h.controller.retry()
    expect(h.search).toHaveBeenCalledTimes(1)
  })

  it('getState mirrors what onState last saw', () => {
    const h = harness()
    h.controller.setQuery('freeze')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(h.controller.getState()).toEqual(h.last())
  })
})

// ── scope line ───────────────────────────────────────────────────────

describe('searchScopeLine', () => {
  const results = (rows, searchPartial = false) => ({
    query: 'freeze', phase: 'results', rows, searchPartial, error: null,
  })

  it('states the count and the scope', () => {
    expect(searchScopeLine(results([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])))
      .toBe('4 conversations · all views')
  })

  it('singular for exactly one', () => {
    expect(searchScopeLine(results([{ id: 1 }]))).toBe('1 conversation · all views')
  })

  it('admits truncation instead of pretending completeness', () => {
    expect(searchScopeLine(results([{ id: 1 }, { id: 2 }], true)))
      .toBe('2 conversations · all views · showing the most recent matches')
  })

  it('says nothing before results exist (idle, searching, error)', () => {
    expect(searchScopeLine(initialSearchState())).toBeNull()
    expect(searchScopeLine({ ...results([{ id: 1 }]), phase: 'searching' })).toBeNull()
    expect(searchScopeLine({ ...results([{ id: 1 }]), phase: 'error' })).toBeNull()
  })

  it('says nothing for zero rows — the empty state carries that message', () => {
    expect(searchScopeLine(results([]))).toBeNull()
  })

  it('tolerates null', () => {
    expect(searchScopeLine(null)).toBeNull()
  })
})

// ── empty & error copy ───────────────────────────────────────────────

describe('noMatchesCopy', () => {
  it('echoes the operator’s own words back — proof the search was heard', () => {
    expect(noMatchesCopy('freeze').title).toBe('No mail matches “freeze”.')
  })
  it('falls back when the query is somehow blank', () => {
    expect(noMatchesCopy('').title).toBe('No mail matches that search.')
    expect(noMatchesCopy(null).title).toBe('No mail matches that search.')
  })
  it('the body says what search covers', () => {
    expect(noMatchesCopy('x').body).toMatch(/subjects, senders/)
  })
})

describe('SEARCH_ERROR_COPY', () => {
  it('names the failure as a failure, never an empty result', () => {
    expect(SEARCH_ERROR_COPY.title).toBe('Couldn’t search your mail')
    expect(SEARCH_ERROR_COPY.body).toMatch(/not an empty result/)
  })
  it('is frozen', () => {
    expect(Object.isFrozen(SEARCH_ERROR_COPY)).toBe(true)
  })
})

// ── highlight splitting ──────────────────────────────────────────────

describe('splitHighlight', () => {
  it('marks a case-insensitive substring match', () => {
    expect(splitHighlight('Membership freeze — September', 'freeze')).toEqual([
      { text: 'Membership ', match: false },
      { text: 'freeze', match: true },
      { text: ' — September', match: false },
    ])
  })

  it('preserves the ORIGINAL casing of the matched slice', () => {
    expect(splitHighlight('Freeze over Christmas', 'freeze')).toEqual([
      { text: 'Freeze', match: true },
      { text: ' over Christmas', match: false },
    ])
  })

  it('marks every occurrence, not just the first', () => {
    expect(splitHighlight('freeze then freeze', 'freeze')).toEqual([
      { text: 'freeze', match: true },
      { text: ' then ', match: false },
      { text: 'freeze', match: true },
    ])
  })

  it('a match at the very start and very end produces no empty segments', () => {
    expect(splitHighlight('freeze', 'freeze')).toEqual([{ text: 'freeze', match: true }])
  })

  it('splits a multi-word query into terms, any of which marks', () => {
    expect(splitHighlight('Holiday freeze question', 'freeze holiday')).toEqual([
      { text: 'Holiday', match: true },
      { text: ' ', match: false },
      { text: 'freeze', match: true },
      { text: ' question', match: false },
    ])
  })

  it('the longer of two overlapping terms wins the whole word', () => {
    // 'free freeze': naive first-term-first would mark 'free' inside 'Freeze'
    // and orphan the 'ze'.
    expect(splitHighlight('Freeze question', 'free freeze')).toEqual([
      { text: 'Freeze', match: true },
      { text: ' question', match: false },
    ])
  })

  it('regex metacharacters in the query are literal text, not syntax', () => {
    expect(splitHighlight('cost (approx.)', '(approx.)')).toEqual([
      { text: 'cost ', match: false },
      { text: '(approx.)', match: true },
    ])
    // an unescaped '.' would also match 'x' — prove it doesn't
    expect(splitHighlight('max', 'a.')).toEqual([{ text: 'max', match: false }])
  })

  it('duplicate terms are collapsed', () => {
    expect(splitHighlight('freeze', 'freeze FREEZE')).toEqual([
      { text: 'freeze', match: true },
    ])
  })

  it('a blank query marks nothing', () => {
    expect(splitHighlight('Membership freeze', '')).toEqual([
      { text: 'Membership freeze', match: false },
    ])
    expect(splitHighlight('Membership freeze', '   ')).toEqual([
      { text: 'Membership freeze', match: false },
    ])
    expect(splitHighlight('Membership freeze', null)).toEqual([
      { text: 'Membership freeze', match: false },
    ])
  })

  it('no text → no segments', () => {
    expect(splitHighlight('', 'freeze')).toEqual([])
    expect(splitHighlight(null, 'freeze')).toEqual([])
    expect(splitHighlight(undefined, 'freeze')).toEqual([])
  })

  it('the segments always reassemble the exact input text', () => {
    const text = 'Re: Freeze — freeze my (freeze) plan?'
    const joined = splitHighlight(text, 'freeze (fr plan?').map(s => s.text).join('')
    expect(joined).toBe(text)
  })

  it('non-matching query returns the whole text unmarked', () => {
    expect(splitHighlight('Invoice for August', 'freeze')).toEqual([
      { text: 'Invoice for August', match: false },
    ])
  })
})

// ═══ MAIL-ALLLOC.1 — the All-mode fan-out ════════════════════════════
//
// When the Mail tab's scope is All, search fans out one listMail({ q }) per
// readable studio CLIENT-SIDE and renders results grouped by studio. The
// grouping, the partial-failure posture (a failed studio shows an error
// section, the others still render) and the honest counts live here; the
// screen renders verdicts.

describe('createFanOutSearch', () => {
  const locations = [
    { id: 'loc-a', name: 'Hatch Street' },
    { id: 'loc-b', name: 'Stillorgan' },
  ]
  const row = (id) => ({ id, subject: `S-${id}` })

  it('searches every location and answers sections in the given (name) order', async () => {
    const searchOne = vi.fn(async (id, _q) => ({
      success: true,
      data: id === 'loc-a' ? [row('t1'), row('t2')] : [row('t3')],
      searchPartial: false,
    }))
    const search = createFanOutSearch({ locations, searchOne })
    const res = await search('freeze')
    expect(searchOne).toHaveBeenCalledWith('loc-a', 'freeze')
    expect(searchOne).toHaveBeenCalledWith('loc-b', 'freeze')
    expect(res.success).toBe(true)
    expect(res.data.map(s => s.location_id)).toEqual(['loc-a', 'loc-b'])
    expect(res.data[0]).toMatchObject({ name: 'Hatch Street', failed: false })
    expect(res.data[0].rows.map(r => r.id)).toEqual(['t1', 't2'])
    expect(res.data[1].rows.map(r => r.id)).toEqual(['t3'])
  })

  it('one failed studio is an error SECTION, not a failed search — the others still render', async () => {
    const searchOne = vi.fn(async (id) => (
      id === 'loc-a' ? { success: false, error: 'blip' } : { success: true, data: [row('t3')] }
    ))
    const res = await createFanOutSearch({ locations, searchOne })('x')
    expect(res.success).toBe(true)
    expect(res.data[0]).toMatchObject({ failed: true, rows: [] })
    expect(res.data[1]).toMatchObject({ failed: false })
  })

  it('a rejecting search counts as that studio failing, never as an unhandled throw', async () => {
    const searchOne = vi.fn(async (id) => {
      if (id === 'loc-b') throw new Error('boom')
      return { success: true, data: [row('t1')] }
    })
    const res = await createFanOutSearch({ locations, searchOne })('x')
    expect(res.success).toBe(true)
    expect(res.data[1].failed).toBe(true)
  })

  it('EVERY studio failing is a failed search — the house rule, estate-wide', async () => {
    const searchOne = vi.fn(async () => ({ success: false }))
    const res = await createFanOutSearch({ locations, searchOne })('x')
    expect(res.success).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('ORs searchPartial — one truncated scan makes the whole answer admit it', async () => {
    const searchOne = vi.fn(async (id) => ({
      success: true, data: [], searchPartial: id === 'loc-b',
    }))
    const res = await createFanOutSearch({ locations, searchOne })('x')
    expect(res.searchPartial).toBe(true)
  })
})

describe('groupedSearchDisplay', () => {
  const section = (id, name, rows, failed = false) => ({ location_id: id, name, rows, failed })

  it('totals only what actually rendered and hides empty healthy sections', () => {
    const state = {
      phase: 'results',
      rows: [
        section('loc-a', 'A', [{ id: 't1' }, { id: 't2' }]),
        section('loc-b', 'B', []),
        section('loc-c', 'C', [], true),
      ],
    }
    const d = groupedSearchDisplay(state)
    expect(d.total).toBe(2)
    expect(d.anyFailed).toBe(true)
    expect(d.allEmpty).toBe(false)
    // The failed section stays visible (its error state IS the content);
    // a healthy studio with no matches is noise and drops out.
    expect(d.sections.map(s => s.location_id)).toEqual(['loc-a', 'loc-c'])
  })

  it('allEmpty only when every HEALTHY section found nothing', () => {
    const clean = groupedSearchDisplay({
      phase: 'results',
      rows: [section('loc-a', 'A', []), section('loc-b', 'B', [])],
    })
    expect(clean.allEmpty).toBe(true)
    expect(clean.anyFailed).toBe(false)
    expect(clean.sections).toEqual([])
  })

  it('is inert outside grouped results', () => {
    const d = groupedSearchDisplay({ phase: 'idle', rows: [] })
    expect(d).toEqual({ sections: [], total: 0, allEmpty: false, anyFailed: false })
  })
})

describe('groupedScopeLine', () => {
  const rows = [
    { location_id: 'loc-a', name: 'A', rows: [{ id: 't1' }, { id: 't2' }], failed: false },
    { location_id: 'loc-b', name: 'B', rows: [{ id: 't3' }], failed: false },
  ]

  it('states the estate-wide count and scope', () => {
    expect(groupedScopeLine({ phase: 'results', rows, searchPartial: false }))
      .toBe('3 conversations · all locations · all views')
    expect(groupedScopeLine({ phase: 'results', rows: [rows[1]], searchPartial: false }))
      .toBe('1 conversation · all locations · all views')
  })

  it('admits a truncated scan', () => {
    expect(groupedScopeLine({ phase: 'results', rows, searchPartial: true }))
      .toBe('3 conversations · all locations · all views · showing the most recent matches')
  })

  it('is null before results and at zero — the empty state carries that message', () => {
    expect(groupedScopeLine({ phase: 'searching', rows })).toBe(null)
    expect(groupedScopeLine({ phase: 'results', rows: [], searchPartial: false })).toBe(null)
    expect(groupedScopeLine({
      phase: 'results',
      rows: [{ location_id: 'loc-a', name: 'A', rows: [], failed: false }],
    })).toBe(null)
  })
})

describe('searchSectionHeader', () => {
  it('names the studio with its match count', () => {
    expect(searchSectionHeader({ name: 'Hatch Street', rows: [{ id: 't1' }, { id: 't2' }], failed: false }))
      .toEqual({ title: 'Hatch Street', detail: '2' })
  })
  it('makes no count claim for a failed studio', () => {
    expect(searchSectionHeader({ name: 'Hatch Street', rows: [], failed: true }))
      .toEqual({ title: 'Hatch Street', detail: null })
  })
  it('survives a nameless location', () => {
    expect(searchSectionHeader({ rows: [], failed: false }).title).toBe('Studio')
  })
})
