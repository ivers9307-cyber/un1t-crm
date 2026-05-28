// CHECKLIST.1 — unit tests for the pure helpers + CRUD wrappers
// via a mocked supabase chainable.

import { describe, it, expect, vi } from 'vitest'
import {
  CHECKLIST_ROLES,
  ITEMS_PER_TEMPLATE_MAX,
  TEMPLATE_NAME_MAX,
  ITEM_LABEL_MAX,
  validateTemplateMeta,
  normaliseItems,
  newItemId,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
} from './checklists.js'

// ----------------------------------------------------------------
// validateTemplateMeta
// ----------------------------------------------------------------

describe('validateTemplateMeta', () => {
  it('rejects a role outside the enum', () => {
    const out = validateTemplateMeta({ role: 'janitor', dayOfWeek: 1, name: 'x' })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('bad_role')
  })

  it('accepts every allowed role', () => {
    for (const role of CHECKLIST_ROLES) {
      expect(validateTemplateMeta({ role, dayOfWeek: 1, name: 'x' }).ok).toBe(true)
    }
  })

  it('rejects day_of_week outside 0..6', () => {
    expect(validateTemplateMeta({ role: 'staff', dayOfWeek: -1, name: 'x' }).code).toBe('bad_day')
    expect(validateTemplateMeta({ role: 'staff', dayOfWeek: 7,  name: 'x' }).code).toBe('bad_day')
  })

  it('rejects fractional day_of_week', () => {
    expect(validateTemplateMeta({ role: 'staff', dayOfWeek: 1.5, name: 'x' }).code).toBe('bad_day')
  })

  it('rejects an empty or whitespace name', () => {
    expect(validateTemplateMeta({ role: 'staff', dayOfWeek: 1, name: '   ' }).code).toBe('name_required')
  })

  it('rejects names over the cap', () => {
    expect(validateTemplateMeta({
      role: 'staff', dayOfWeek: 1, name: 'x'.repeat(TEMPLATE_NAME_MAX + 1),
    }).code).toBe('name_too_long')
  })

  it('trims the name', () => {
    const out = validateTemplateMeta({ role: 'staff', dayOfWeek: 0, name: '  Sun closer  ' })
    expect(out.normalised.name).toBe('Sun closer')
    expect(out.normalised.dayOfWeek).toBe(0)
  })
})

// ----------------------------------------------------------------
// normaliseItems
// ----------------------------------------------------------------

describe('normaliseItems', () => {
  it('returns [] when input is null / undefined', () => {
    expect(normaliseItems(null).normalised).toEqual([])
    expect(normaliseItems(undefined).normalised).toEqual([])
  })

  it('rejects a non-array', () => {
    expect(normaliseItems({}).code).toBe('items_bad_shape')
  })

  it(`rejects more than ${ITEMS_PER_TEMPLATE_MAX} items`, () => {
    const items = Array(ITEMS_PER_TEMPLATE_MAX + 1).fill({ label: 'x' })
    expect(normaliseItems(items).code).toBe('too_many_items')
  })

  it('rejects an item with no label', () => {
    expect(normaliseItems([{ id: 'a', label: '' }]).code).toBe('item_label_required')
  })

  it('rejects an item with a label over the cap', () => {
    expect(normaliseItems([{ label: 'x'.repeat(ITEM_LABEL_MAX + 1) }]).code).toBe('item_label_too_long')
  })

  it('rejects duplicate ids across items', () => {
    expect(normaliseItems([
      { id: 'a', label: 'one' },
      { id: 'a', label: 'two' },
    ]).code).toBe('duplicate_item_id')
  })

  it('preserves caller-supplied ids (so PR 2 tick state survives label rename)', () => {
    const out = normaliseItems([
      { id: 'item-1', label: 'Wipe kettlebells' },
    ])
    expect(out.normalised[0].id).toBe('item-1')
    expect(out.normalised[0].label).toBe('Wipe kettlebells')
  })

  it("renames the label while keeping the id (PR 2 won't lose tick state)", () => {
    const first = normaliseItems([
      { id: 'item-1', label: 'Wipe kettlebells' },
    ])
    const second = normaliseItems([
      { id: 'item-1', label: 'Sanitise kettlebells' },
    ])
    expect(second.normalised[0].id).toBe(first.normalised[0].id)
    expect(second.normalised[0].label).toBe('Sanitise kettlebells')
  })

  it('mints an id when the client omits one', () => {
    const out = normaliseItems([{ label: 'New item' }])
    expect(typeof out.normalised[0].id).toBe('string')
    expect(out.normalised[0].id.length).toBeGreaterThan(0)
  })

  it('rewrites order from array index (caller-supplied order is ignored)', () => {
    const out = normaliseItems([
      { label: 'first',  order: 99 },
      { label: 'second', order: 7 },
    ])
    expect(out.normalised.map((i) => i.order)).toEqual([0, 1])
  })

  it('trims labels', () => {
    const out = normaliseItems([{ label: '  Trim me  ' }])
    expect(out.normalised[0].label).toBe('Trim me')
  })
})

// ----------------------------------------------------------------
// newItemId — just smoke-test it returns something string-y
// ----------------------------------------------------------------

describe('newItemId', () => {
  it('returns a non-empty string', () => {
    const id = newItemId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(8)
  })

  it('returns distinct values across calls', () => {
    expect(newItemId()).not.toBe(newItemId())
  })
})

// ----------------------------------------------------------------
// CRUD wrappers — mocked supabase chainable
// ----------------------------------------------------------------

function makeDb({
  selectListResult = { data: [], error: null },
  selectSingleResult = { data: null, error: null },
  insertResult = { data: { id: 't1' }, error: null },
  updateResult = { data: { id: 't1' }, error: null },
} = {}) {
  const trackers = { tables: [], updates: [], inserts: [] }
  const db = {}
  db.from = vi.fn((t) => {
    trackers.tables.push(t)
    const chain = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.order = vi.fn(() => {
      // Return-this-then-await terminal — supabase's .order(...).order(...) finally awaits.
      return new Proxy(chain, {
        get(target, prop) {
          if (prop === 'then') return (resolve) => resolve(selectListResult)
          return Reflect.get(target, prop)
        },
      })
    })
    chain.maybeSingle = vi.fn(() => Promise.resolve(selectSingleResult))
    chain.insert = vi.fn((row) => {
      trackers.inserts.push({ table: t, row })
      return {
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve(insertResult)),
        })),
      }
    })
    chain.update = vi.fn((row) => {
      trackers.updates.push({ table: t, row })
      return {
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve(updateResult)),
          })),
        })),
      }
    })
    return chain
  })
  return { db, trackers }
}

describe('listTemplates', () => {
  it('returns [] when no locationId', async () => {
    const { db } = makeDb()
    expect(await listTemplates(db, null)).toEqual([])
  })

  it('returns the rows from the chainable', async () => {
    const rows = [{ id: 't1' }, { id: 't2' }]
    const { db } = makeDb({ selectListResult: { data: rows, error: null } })
    expect(await listTemplates(db, 'loc-1')).toEqual(rows)
  })

  it('returns [] on a query error rather than throwing', async () => {
    const { db } = makeDb({ selectListResult: { data: null, error: { message: 'boom' } } })
    expect(await listTemplates(db, 'loc-1')).toEqual([])
  })
})

describe('getTemplate', () => {
  it('returns null on missing id', async () => {
    const { db } = makeDb()
    expect(await getTemplate(db, null)).toBeNull()
  })

  it('returns the row when present', async () => {
    const row = { id: 't1' }
    const { db } = makeDb({ selectSingleResult: { data: row, error: null } })
    expect(await getTemplate(db, 't1')).toEqual(row)
  })
})

describe('createTemplate', () => {
  it('rejects bad meta upfront', async () => {
    const { db } = makeDb()
    const out = await createTemplate(db, {
      locationId: 'loc', role: 'wat', dayOfWeek: 1, name: 'x', items: [],
    })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('bad_role')
  })

  it('surfaces a 409 on unique-constraint violation', async () => {
    const { db } = makeDb({
      insertResult: { data: null, error: { code: '23505', message: 'unique violation' } },
    })
    const out = await createTemplate(db, {
      locationId: 'loc', role: 'staff', dayOfWeek: 1, name: 'Closer', items: [],
    })
    expect(out.ok).toBe(false)
    expect(out.status).toBe(409)
    expect(out.code).toBe('duplicate_template')
  })

  it('inserts normalised meta + items on success', async () => {
    const { db, trackers } = makeDb({
      insertResult: { data: { id: 't1', name: 'Closer' }, error: null },
    })
    const out = await createTemplate(db, {
      locationId: 'loc-1', role: 'staff', dayOfWeek: 5, name: '  Closer  ',
      items: [{ label: 'one' }, { label: 'two' }],
    })
    expect(out.ok).toBe(true)
    expect(trackers.inserts[0].row.name).toBe('Closer')
    expect(trackers.inserts[0].row.items).toHaveLength(2)
    expect(trackers.inserts[0].row.items[0].order).toBe(0)
  })
})

describe('updateTemplate', () => {
  it('rejects when no editable fields are supplied', async () => {
    const { db } = makeDb()
    const out = await updateTemplate(db, 't1', {})
    expect(out.ok).toBe(false)
    expect(out.code).toBe('no_fields')
  })

  it('rejects an empty name', async () => {
    const { db } = makeDb()
    const out = await updateTemplate(db, 't1', { name: '  ' })
    expect(out.code).toBe('name_required')
  })

  it('lets you flip enabled to false on its own', async () => {
    const { db, trackers } = makeDb({
      updateResult: { data: { id: 't1', enabled: false }, error: null },
    })
    const out = await updateTemplate(db, 't1', { enabled: false })
    expect(out.ok).toBe(true)
    expect(trackers.updates[0].row).toEqual({ enabled: false })
  })

  it('normalises items on the patch path too', async () => {
    const { db, trackers } = makeDb({
      updateResult: { data: { id: 't1' }, error: null },
    })
    await updateTemplate(db, 't1', { items: [{ label: 'one' }, { label: 'two' }] })
    expect(trackers.updates[0].row.items).toHaveLength(2)
    expect(trackers.updates[0].row.items[0]).toMatchObject({ label: 'one', order: 0 })
  })
})
