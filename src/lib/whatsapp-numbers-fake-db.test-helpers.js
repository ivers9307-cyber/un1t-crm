// WAORGNUMBER.1 — a small filtering fake of the supabase client for the
// WhatsApp number resolvers (whatsapp-config.js). It models just enough
// PostgREST for those reads:
//
//   from('location_whatsapp_numbers').select('…, whatsapp_numbers!inner(*)')
//     → each link row with its number embedded as `whatsapp_numbers`; a link
//       whose number is missing is dropped (the !inner join)
//   .eq(col, v) / .neq(col, v) / .in(col, vals)  — a dotted column ('whatsapp_numbers.is_active')
//       filters on the embedded row, as PostgREST does for an !inner embed
//   .order(col, { ascending }) / .limit(n) / .maybeSingle() / await
//
// state = { numbers, links, conversations, locations, faults: { [table]: error } }
// `links` omitted (undefined/null) = each number switched on at its home studio.
// Every read is pushed onto state.reads (the table name) when that array exists,
// and its select string onto state.selects ([table, columns]) when that exists.
// Fictional ids only: the repo is public.

function valueAt(row, col) {
  if (!col.includes('.')) return row[col]
  const [embed, field] = col.split('.')
  return row[embed]?.[field]
}

function rowsFor(state, table) {
  if (table === 'location_whatsapp_numbers') {
    // No `links` given: every number is switched on at its home studio, as the
    // mig 736 backfill (and its AFTER INSERT trigger) leaves it.
    const links = state.links ?? (state.numbers || []).map((n) => link(n.location_id, n.id, { is_default: Boolean(n.is_default) }))
    return links
      .map((l) => ({ ...l, whatsapp_numbers: (state.numbers || []).find((n) => n.id === l.whatsapp_number_id) || null }))
      .filter((r) => r.whatsapp_numbers)
  }
  if (table === 'whatsapp_numbers') return state.numbers || []
  if (table === 'whatsapp_conversations') return state.conversations || []
  if (table === 'locations') return state.locations || []
  return state[table] || []
}

export function fakeWhatsAppDb(state) {
  return {
    from: (table) => {
      const filters = []
      const orders = []
      let cap = Infinity
      const run = () => {
        if (Array.isArray(state.reads)) state.reads.push(table)
        if (state.faults?.[table]) return { data: null, error: state.faults[table] }
        let rows = rowsFor(state, table).filter((r) => filters.every((f) => f(r)))
        for (const [col, asc] of orders.slice().reverse()) {
          rows = rows.slice().sort((a, b) => {
            const x = valueAt(a, col)
            const y = valueAt(b, col)
            if (x === y) return 0
            return (x > y ? 1 : -1) * (asc ? 1 : -1)
          })
        }
        return { data: rows.slice(0, cap), error: null }
      }
      const b = {
        select: (cols) => { if (Array.isArray(state.selects)) state.selects.push([table, cols]); return b },
        eq: (c, v) => { filters.push((r) => valueAt(r, c) === v); return b },
        neq: (c, v) => { filters.push((r) => valueAt(r, c) !== v); return b },
        in: (c, vals) => { filters.push((r) => vals.includes(valueAt(r, c))); return b },
        order: (c, o) => { orders.push([c, o?.ascending !== false]); return b },
        limit: (n) => { cap = n; return b },
        maybeSingle: async () => {
          const out = run()
          if (out.error) return out
          if (out.data.length > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } }
          return { data: out.data[0] ?? null, error: null }
        },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

// A link row: number `numberId` switched on at `locationId`.
export function link(locationId, numberId, extra = {}) {
  return { location_id: locationId, whatsapp_number_id: numberId, is_default: false, created_at: '2026-09-01T00:00:00Z', ...extra }
}
