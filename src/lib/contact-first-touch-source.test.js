import { describe, it, expect, vi, beforeEach } from 'vitest'

const logWarn = vi.hoisted(() => vi.fn())
vi.mock('./log', () => ({ logWarn }))

import { firstTouchSourcePatch, stampFirstTouchSource } from './contact-first-touch-source'

/** A contacts update chain that records the patch and every filter, then resolves `result`. */
function fakeDb(result = { error: null }) {
  const calls = []
  const db = {
    calls,
    from(table) {
      const call = { table, patch: null, filters: [] }
      calls.push(call)
      const chain = {
        update(patch) { call.patch = patch; return chain },
        eq(col, v) { call.filters.push(['eq', col, v]); return chain },
        is(col, v) { call.filters.push(['is', col, v]); return chain },
        then(resolve, reject) {
          if (result instanceof Error) return Promise.reject(result).then(resolve, reject)
          return Promise.resolve(result).then(resolve, reject)
        },
      }
      return chain
    },
  }
  return db
}

beforeEach(() => logWarn.mockClear())

describe('firstTouchSourcePatch', () => {
  it('takes source and medium, and nothing else', () => {
    expect(firstTouchSourcePatch({ utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'c', ad_external_id: '9', fbp: 'x' }))
      .toEqual({ utm_source: 'instagram', utm_medium: 'bio' })
  })

  it('one without the other is still a value', () => {
    expect(firstTouchSourcePatch({ utm_source: 'crm' })).toEqual({ utm_source: 'crm' })
    expect(firstTouchSourcePatch({ utm_medium: 'email' })).toEqual({ utm_medium: 'email' })
  })

  it('an unfilled Meta macro is no value, plain or URL-encoded', () => {
    expect(firstTouchSourcePatch({ utm_source: '{{site_source_name}}', utm_medium: 'paid' })).toEqual({ utm_medium: 'paid' })
    expect(firstTouchSourcePatch({ utm_source: '%7B%7Bsite_source_name%7D%7D' })).toBeNull()
  })

  it('caps at 200 characters and trims', () => {
    expect(firstTouchSourcePatch({ utm_source: `  ${'a'.repeat(300)}  ` }).utm_source).toHaveLength(200)
    expect(firstTouchSourcePatch({ utm_source: '  ig  ' })).toEqual({ utm_source: 'ig' })
  })

  it('nothing to say is null: absent, empty, blank, non-string, no object', () => {
    for (const a of [undefined, null, 'x', {}, { utm_source: '' }, { utm_source: '   ' }, { utm_source: 5, utm_medium: { a: 1 } }, { utm_campaign: 'c' }]) {
      expect(firstTouchSourcePatch(a), JSON.stringify(a)).toBeNull()
    }
  })
})

describe('stampFirstTouchSource', () => {
  it('writes only the two columns, first-touch: while source, medium and attributed_at are all NULL', async () => {
    const db = fakeDb()
    const r = await stampFirstTouchSource(db, 'c-1', { utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'x', ad_provider: 'meta' })
    expect(r).toEqual({ stamped: true })
    expect(db.calls).toHaveLength(1)
    expect(db.calls[0].table).toBe('contacts')
    expect(db.calls[0].patch).toEqual({ utm_source: 'instagram', utm_medium: 'bio' })
    expect(db.calls[0].filters).toEqual([
      ['eq', 'id', 'c-1'], ['is', 'utm_source', null], ['is', 'utm_medium', null], ['is', 'attributed_at', null],
    ])
  })

  it('never marks anyone an ad lead: no ad_provider, no attributed_at in the patch', async () => {
    const db = fakeDb()
    await stampFirstTouchSource(db, 'c-1', { utm_source: 'facebook', utm_medium: 'paid', ad_provider: 'meta', ad_external_id: '1' })
    expect(Object.keys(db.calls[0].patch).sort()).toEqual(['utm_medium', 'utm_source'])
  })

  it('sends no write when there is nothing to stamp, or no contact', async () => {
    const db = fakeDb()
    expect(await stampFirstTouchSource(db, 'c-1', { utm_campaign: 'c' })).toEqual({ stamped: false })
    expect(await stampFirstTouchSource(db, 'c-1', { utm_source: '{{x}}' })).toEqual({ stamped: false })
    expect(await stampFirstTouchSource(db, null, { utm_source: 'ig' })).toEqual({ stamped: false })
    expect(db.calls).toHaveLength(0)
  })

  it('a failed write is read off the resolved error, logged without the value, and never thrown', async () => {
    const db = fakeDb({ error: { code: '42703', message: 'column contacts.utm_source does not exist' } })
    await expect(stampFirstTouchSource(db, 'c-1', { utm_source: 'ig' }, { module: 'trialbuy' })).resolves.toEqual({ stamped: false, error: true })
    expect(logWarn).toHaveBeenCalledWith('trialbuy', 'utm source/medium persist failed', { code: '42703' })
  })

  it('a thrown write is swallowed too', async () => {
    const db = fakeDb(new TypeError('fetch failed'))
    await expect(stampFirstTouchSource(db, 'c-1', { utm_source: 'ig' })).resolves.toEqual({ stamped: false, error: true })
    expect(logWarn).toHaveBeenCalledWith('attribution', 'utm source/medium persist threw', { errClass: 'TypeError' })
  })
})
