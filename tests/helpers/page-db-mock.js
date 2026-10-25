// PAGEGATES.1 — a service-role client stand-in for server-PAGE tests
// (TEST-ONLY; not collected: vitest collects *.test.js only).
//
// `rows[table]` is what any read of that table answers: `.single()` and
// `.maybeSingle()` resolve to it (an array's first row), and awaiting the bare
// chain resolves to it as a list. Every filter/order method returns the chain,
// so a page's exact query shape does not matter here: these tests are about
// who the page lets in and which controls it hands out, not the query.
export function pageDb(rows = {}) {
  const chain = (table) => {
    const value = rows[table] ?? null
    const one = Array.isArray(value) ? (value[0] ?? null) : value
    const list = value == null ? [] : (Array.isArray(value) ? value : [value])
    const c = {}
    const self = () => c
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'range', 'gte', 'lte', 'gt', 'lt', 'ilike', 'filter', 'match', 'contains']) c[m] = self
    c.single = async () => ({ data: one, error: one ? null : { message: 'not found' } })
    c.maybeSingle = async () => ({ data: one, error: null })
    c.then = (resolve, reject) => Promise.resolve({ data: list, error: null, count: list.length }).then(resolve, reject)
    return c
  }
  return {
    from: (table) => chain(table),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  }
}

// next/navigation's redirect/notFound throw; these name the throw so a test
// can tell which one fired.
export const navigationMock = () => ({
  redirect: (url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  },
  notFound: () => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  },
})
