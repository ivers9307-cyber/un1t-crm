// SHIFTTYPE.1 — what kind of shift a template or block is.
import { describe, it, expect } from 'vitest'
import { SHIFT_KINDS, DEFAULT_SHIFT_KIND, SHIFT_KIND_LABELS, shiftKindOf, isAdminShift } from './shift-kind.js'

describe('shift kinds', () => {
  it('are class and admin, class by default, each with a label', () => {
    expect(SHIFT_KINDS).toEqual(['class', 'admin'])
    expect(DEFAULT_SHIFT_KIND).toBe('class')
    expect(SHIFT_KIND_LABELS).toEqual({ class: 'Class', admin: 'Admin' })
  })
})

describe('shiftKindOf / isAdminShift', () => {
  it('reads a template row directly', () => {
    expect(shiftKindOf({ kind: 'admin' })).toBe('admin')
    expect(shiftKindOf({ kind: 'class' })).toBe('class')
  })

  it('reads a block through its embedded template', () => {
    expect(shiftKindOf({ block_date: '2026-10-01', shift_templates: { name: 'Stock take', kind: 'admin' } })).toBe('admin')
    expect(isAdminShift({ shift_templates: { kind: 'admin' } })).toBe(true)
    expect(isAdminShift({ shift_templates: { kind: 'class' } })).toBe(false)
  })

  it('anything it cannot read is class: the pre-SHIFTTYPE behaviour, which over-reports and never hides a gap', () => {
    for (const row of [null, undefined, {}, { shift_templates: null }, { shift_templates: {} }, { kind: 'desk' }, { shift_templates: { kind: 'ADMIN' } }]) {
      expect(shiftKindOf(row)).toBe('class')
      expect(isAdminShift(row)).toBe(false)
    }
  })
})
