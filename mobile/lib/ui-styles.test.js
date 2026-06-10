import { describe, it, expect } from 'vitest'
import {
  buttonClasses, buttonTextClasses, cardClasses,
  BUTTON_VARIANTS, BUTTON_SIZES, CARD_PADDING,
  modalOverlayClasses, modalContainerClasses, modalPanelClasses,
  dataTableMode, tableHeaderClasses, tableRowClasses, tableHeaderTextClasses, tableCellTextClasses, dataCardClasses, dataCardLabelClasses, dataCardValueClasses,
  tabItemClasses, tabTextClasses,
} from './ui-styles.js'

describe('buttonClasses', () => {
  it('defaults to primary + md', () => {
    const c = buttonClasses()
    expect(c).toContain(BUTTON_VARIANTS.primary)
    expect(c).toContain(BUTTON_SIZES.md)
  })
  it('applies requested variant + size', () => {
    const c = buttonClasses({ variant: 'danger', size: 'lg' })
    expect(c).toContain(BUTTON_VARIANTS.danger)
    expect(c).toContain(BUTTON_SIZES.lg)
  })
  it('square icon size for icon-only buttons', () => {
    expect(buttonClasses({ size: 'icon' })).toContain(BUTTON_SIZES.icon)
  })
  it('adds opacity when disabled', () => {
    expect(buttonClasses({ disabled: true })).toContain('opacity-50')
    expect(buttonClasses({ disabled: false })).not.toContain('opacity-50')
  })
  it('falls back to defaults for unknown variant/size (no undefined)', () => {
    const c = buttonClasses({ variant: 'nope', size: 'huge' })
    expect(c).toContain(BUTTON_VARIANTS.primary)
    expect(c).toContain(BUTTON_SIZES.md)
    expect(c).not.toContain('undefined')
  })
  it('uses renamed tokens (MOB-UI.1 regression guard)', () => {
    expect(buttonClasses({ variant: 'secondary' })).toContain('border-un1t-border')
  })
})

describe('buttonTextClasses', () => {
  it('white text on primary/danger, dark on secondary', () => {
    expect(buttonTextClasses({ variant: 'primary' })).toContain('text-white')
    expect(buttonTextClasses({ variant: 'danger' })).toContain('text-white')
    expect(buttonTextClasses({ variant: 'secondary' })).toContain('text-un1t-text')
    expect(buttonTextClasses({ variant: 'ghost' })).toContain('text-un1t-subtle')
  })
})

describe('cardClasses', () => {
  it('defaults to md padding', () => {
    expect(cardClasses()).toContain(CARD_PADDING.md)
  })
  it('none padding emits no p- class', () => {
    expect(cardClasses({ padding: 'none' })).not.toMatch(/\bp-\d/)
  })
  it('appends caller className', () => {
    expect(cardClasses({ className: 'mt-4' })).toContain('mt-4')
  })
})

describe('data table classes', () => {
  it('mode is table on tablet, cards on phone', () => {
    expect(dataTableMode(true)).toBe('table')
    expect(dataTableMode(false)).toBe('cards')
  })
  it('header + rows use un1t tokens and a bottom border', () => {
    expect(tableHeaderClasses()).toContain('border-b')
    expect(tableHeaderClasses()).toContain('border-un1t-border')
    expect(tableRowClasses()).toContain('border-un1t-border')
  })
  it('pressable rows get an active background; non-pressable do not', () => {
    expect(tableRowClasses({ pressable: true })).toContain('active:bg-un1t-surface')
    expect(tableRowClasses({ pressable: false })).not.toContain('active:bg-un1t-surface')
  })
  it('header text is uppercase muted; cell text is normal', () => {
    expect(tableHeaderTextClasses()).toContain('uppercase')
    expect(tableHeaderTextClasses()).toContain('un1t-subtle')
    expect(tableCellTextClasses()).toContain('un1t-text')
  })
  it('phone card has label + value styles and no undefined', () => {
    expect(dataCardClasses()).toContain('rounded-2xl')
    expect(dataCardLabelClasses()).toContain('un1t-subtle')
    expect(dataCardValueClasses()).toContain('un1t-text')
    expect(tableRowClasses({ pressable: true })).not.toContain('undefined')
  })
})

describe('tabs classes', () => {
  it('active tab is filled with the accent; inactive is bordered surface', () => {
    expect(tabItemClasses({ active: true })).toContain('bg-un1t-accent')
    expect(tabItemClasses({ active: false })).toContain('border-un1t-border')
  })
  it('active text is white; inactive text is muted', () => {
    expect(tabTextClasses({ active: true })).toContain('text-white')
    expect(tabTextClasses({ active: false })).toContain('un1t-subtle')
  })
  it('never emits undefined for default args', () => {
    expect(tabItemClasses()).not.toContain('undefined')
    expect(tabTextClasses()).not.toContain('undefined')
  })
})

describe('modal classes', () => {
  it('overlay dims the full screen', () => {
    expect(modalOverlayClasses()).toContain('bg-black/50')
    expect(modalOverlayClasses()).toContain('flex-1')
  })
  it('tablet centers the panel; phone anchors it to the bottom', () => {
    expect(modalContainerClasses({ isTablet: true })).toContain('justify-center')
    expect(modalContainerClasses({ isTablet: false })).toContain('justify-end')
  })
  it('tablet panel is a rounded card with a max width; phone panel is a top-rounded sheet', () => {
    const tablet = modalPanelClasses({ isTablet: true })
    const phone = modalPanelClasses({ isTablet: false })
    expect(tablet).toContain('rounded-2xl')
    expect(tablet).toContain('max-w-lg')
    expect(phone).toContain('rounded-t-2xl')
    expect(phone).not.toContain('max-w-lg')
  })
  it('uses un1t tokens and never emits undefined', () => {
    expect(modalPanelClasses({ isTablet: false })).not.toContain('undefined')
    expect(modalPanelClasses()).toContain('bg-white')
  })
})
