import { describe, it, expect } from 'vitest'
import {
  buttonClasses, BUTTON_VARIANTS, BUTTON_SIZES,
  cardClasses, CARD_PADDING,
  modalPanelClasses, MODAL_SIZES,
  fieldIds, fieldDescribedBy,
  tableState, cellValue,
} from './styles.js'

describe('buttonClasses', () => {
  it('defaults to primary + md', () => {
    const c = buttonClasses()
    expect(c).toContain(BUTTON_VARIANTS.primary)
    expect(c).toContain(BUTTON_SIZES.md)
  })
  it('applies the requested variant and size', () => {
    const c = buttonClasses({ variant: 'danger', size: 'lg' })
    expect(c).toContain(BUTTON_VARIANTS.danger)
    expect(c).toContain(BUTTON_SIZES.lg)
  })
  it('falls back to defaults for unknown variant/size (no undefined in output)', () => {
    const c = buttonClasses({ variant: 'nope', size: 'huge' })
    expect(c).toContain(BUTTON_VARIANTS.primary)
    expect(c).toContain(BUTTON_SIZES.md)
    expect(c).not.toContain('undefined')
  })
  it('appends caller className', () => {
    expect(buttonClasses({ className: 'w-full' })).toContain('w-full')
  })
  it('always includes the accessible focus ring', () => {
    expect(buttonClasses()).toContain('focus-visible:ring-un1t-accent')
  })
  it('supports the square icon size for icon-only buttons', () => {
    expect(buttonClasses({ size: 'icon' })).toContain(BUTTON_SIZES.icon)
  })
})

describe('cardClasses', () => {
  it('defaults to md padding', () => {
    expect(cardClasses()).toContain(CARD_PADDING.md)
  })
  it('supports none padding (no padding class)', () => {
    const c = cardClasses({ padding: 'none' })
    expect(c).not.toMatch(/\bp-\d/)
  })
  it('uses renamed border token (regression guard for UI-FOUND.1)', () => {
    expect(cardClasses()).toContain('border-un1t-border')
  })
})

describe('modalPanelClasses', () => {
  it('defaults to md width', () => {
    expect(modalPanelClasses()).toContain(MODAL_SIZES.md)
  })
  it('honours xl', () => {
    expect(modalPanelClasses({ size: 'xl' })).toContain(MODAL_SIZES.xl)
  })
  it('falls back for unknown size', () => {
    expect(modalPanelClasses({ size: 'mega' })).toContain(MODAL_SIZES.md)
  })
})

describe('fieldIds / fieldDescribedBy', () => {
  it('derives stable child ids', () => {
    expect(fieldIds('email')).toEqual({ control: 'email', error: 'email-error', hint: 'email-hint' })
  })
  it('describedBy is undefined when no hint/error', () => {
    expect(fieldDescribedBy({ baseId: 'email', hasError: false, hasHint: false })).toBeUndefined()
  })
  it('describedBy lists hint then error when both present', () => {
    expect(fieldDescribedBy({ baseId: 'email', hasError: true, hasHint: true }))
      .toBe('email-hint email-error')
  })
  it('describedBy with only error', () => {
    expect(fieldDescribedBy({ baseId: 'pw', hasError: true, hasHint: false })).toBe('pw-error')
  })
})

describe('tableState', () => {
  it('loading wins over rows', () => {
    expect(tableState({ rows: [1, 2], loading: true })).toBe('loading')
  })
  it('empty for missing or empty rows', () => {
    expect(tableState({ rows: [] })).toBe('empty')
    expect(tableState({})).toBe('empty')
    expect(tableState({ rows: null })).toBe('empty')
  })
  it('rows when populated and not loading', () => {
    expect(tableState({ rows: [{ id: 1 }] })).toBe('rows')
  })
})

describe('cellValue', () => {
  it('reads by string accessor', () => {
    expect(cellValue({ name: 'Ada' }, { accessor: 'name' })).toBe('Ada')
  })
  it('prefers a render function over accessor', () => {
    expect(cellValue({ first: 'Ada', last: 'L' }, { render: (r) => `${r.first} ${r.last}` }))
      .toBe('Ada L')
  })
  it('is defensive against null rows', () => {
    expect(cellValue(null, { accessor: 'name' })).toBeUndefined()
  })
  it('returns undefined for a column with neither accessor nor render', () => {
    expect(cellValue({ a: 1 }, {})).toBeUndefined()
  })
})
