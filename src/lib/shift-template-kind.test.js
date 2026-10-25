// SHIFTTYPE.1 — the kind + min_coaches half of a template write.
import { describe, it, expect } from 'vitest'
import { resolveTemplateKindWrite, adminMinimumRefusal, ADMIN_MINIMUM_ERROR } from './shift-template-kind'

describe('adminMinimumRefusal', () => {
  it('refuses a non-zero minimum on an admin shift, with a sentence the editor can show', () => {
    expect(adminMinimumRefusal('admin', 2)).toEqual({
      status: 400,
      body: { success: false, error: ADMIN_MINIMUM_ERROR, message: expect.stringMatching(/admin shift has no minimum/i) },
    })
    expect(ADMIN_MINIMUM_ERROR).toBe('admin_has_no_minimum')
  })

  it('allows 0 or no minimum on admin, and anything on class', () => {
    for (const m of [undefined, null, 0]) expect(adminMinimumRefusal('admin', m)).toBeNull()
    for (const m of [undefined, 0, 1, 5]) expect(adminMinimumRefusal('class', m)).toBeNull()
  })
})

describe('resolveTemplateKindWrite — create (prior null)', () => {
  it('defaults to class with the SHIFTMIN.1 minimum of 1', () => {
    expect(resolveTemplateKindWrite({ body: {} })).toEqual({ ok: true, patch: { kind: 'class', min_coaches: 1 } })
  })

  it('keeps an explicit class minimum, 0 included', () => {
    expect(resolveTemplateKindWrite({ body: { kind: 'class', min_coaches: 0 } }).patch).toEqual({ kind: 'class', min_coaches: 0 })
    expect(resolveTemplateKindWrite({ body: { min_coaches: 3 } }).patch).toEqual({ kind: 'class', min_coaches: 3 })
  })

  it('an admin template has minimum 0, stated or not', () => {
    expect(resolveTemplateKindWrite({ body: { kind: 'admin' } }).patch).toEqual({ kind: 'admin', min_coaches: 0 })
    expect(resolveTemplateKindWrite({ body: { kind: 'admin', min_coaches: 0 } }).patch).toEqual({ kind: 'admin', min_coaches: 0 })
  })

  it('refuses admin with a minimum rather than quietly dropping it', () => {
    expect(resolveTemplateKindWrite({ body: { kind: 'admin', min_coaches: 2 } }))
      .toMatchObject({ ok: false, status: 400, body: { error: 'admin_has_no_minimum' } })
  })
})

describe('resolveTemplateKindWrite — edit', () => {
  const classT = { kind: 'class', min_coaches: 2 }
  const adminT = { kind: 'admin', min_coaches: 0 }

  it('an edit that touches neither kind nor minimum writes neither', () => {
    expect(resolveTemplateKindWrite({ prior: classT, body: { name: 'x' } }).patch).toEqual({})
    expect(resolveTemplateKindWrite({ prior: adminT, body: { name: 'x' } }).patch).toEqual({})
    expect(resolveTemplateKindWrite({ prior: classT, body: { display_order: 3 } }).patch).toEqual({})
  })

  it('class -> admin sets the minimum to 0 in the same write (the DB CHECK needs both at once)', () => {
    expect(resolveTemplateKindWrite({ prior: classT, body: { kind: 'admin' } }).patch).toEqual({ kind: 'admin', min_coaches: 0 })
  })

  it('admin -> class restores the create default of 1 unless a minimum is given', () => {
    expect(resolveTemplateKindWrite({ prior: adminT, body: { kind: 'class' } }).patch).toEqual({ kind: 'class', min_coaches: 1 })
    expect(resolveTemplateKindWrite({ prior: adminT, body: { kind: 'class', min_coaches: 0 } }).patch).toEqual({ kind: 'class', min_coaches: 0 })
  })

  it('refuses a minimum on a template that stays admin', () => {
    expect(resolveTemplateKindWrite({ prior: adminT, body: { min_coaches: 1 } })).toMatchObject({ ok: false, status: 400 })
    expect(resolveTemplateKindWrite({ prior: adminT, body: { min_coaches: 0 } }).patch).toEqual({ min_coaches: 0 })
  })

  it('a class minimum edit passes straight through; a stored row with no kind is class', () => {
    expect(resolveTemplateKindWrite({ prior: classT, body: { min_coaches: 3 } }).patch).toEqual({ min_coaches: 3 })
    expect(resolveTemplateKindWrite({ prior: { min_coaches: 1 }, body: { min_coaches: 2 } }).patch).toEqual({ min_coaches: 2 })
  })
})
