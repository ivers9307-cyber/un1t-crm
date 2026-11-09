import { describe, it, expect } from 'vitest'
import * as ui from './host-ui.js'
import { readFileSync } from 'node:fs'

const strings = []
function walk(name, v) {
  if (typeof v === 'string') strings.push([name, v])
  else for (const [k, x] of Object.entries(v)) walk(`${name}.${k}`, x)
}
for (const [k, v] of Object.entries(ui)) walk(k, v)

describe('host-ui class kit', () => {
  it('exports every constant the spec names', () => {
    for (const n of ['HOST_H1', 'HOST_SECTION', 'HOST_SECTION_DESC', 'HOST_EYEBROW', 'HOST_LABEL', 'HOST_HINT', 'HOST_META',
      'HOST_PANEL', 'HOST_WELL', 'HOST_LIST', 'HOST_ROW', 'HOST_INPUT', 'HOST_BTN', 'HOST_BTN_PRIMARY', 'HOST_BTN_DANGER',
      'HOST_LINK', 'HOST_TEXTAREA', 'HOST_CHOICE', 'HOST_CHOICE_ON', 'HOST_TAB', 'HOST_TAB_ACTIVE', 'HOST_BTN_GHOST', 'HOST_TH', 'HOST_TR', 'HOST_TD', 'HOST_BTN_SM', 'HOST_BTN_PRIMARY_SM', 'HOST_CHIP', 'HOST_CHIP_TONE', 'HOST_NOTICE', 'HOST_NOTICE_TONE']) expect(ui[n], n).toBeTruthy()
    expect(Object.keys(ui.HOST_CHIP_TONE).sort()).toEqual(['bad', 'info', 'neutral', 'ok', 'warn'])
    expect(Object.keys(ui.HOST_NOTICE_TONE).sort()).toEqual(['bad', 'info', 'neutral', 'ok', 'warn'])
  })
  it('uses no raw white, black or palette colour in any constant', () => {
    const raw = /(^|[\s:])(?:[a-z-]+:)*(?:text|bg|border|divide|ring|outline|placeholder|fill|stroke)-(?:white|black|(?:red|amber|emerald|green|sky|blue|yellow|slate|gray|zinc|neutral|stone|orange|rose|indigo|violet|purple|pink|teal|cyan|lime|fuchsia)-\d)/
    const bad = strings.filter(([, s]) => raw.test(s)).map(([n]) => n)
    expect(bad).toEqual([])
    expect(strings.length).toBeGreaterThan(20)
  })
  it('never puts an opacity modifier on a host colour', () => {
    const bad = strings.filter(([, s]) => /host-[a-z-]+\/[\d[]/.test(s)).map(([n]) => n)
    expect(bad).toEqual([])
  })
  it('the opacity guard catches an arbitrary opacity too', () => {
    const re = /host-[a-z-]+\/[\d[]/
    expect(re.test('bg-host-panel/[0.5]')).toBe(true)
    expect(re.test('bg-host-panel/50')).toBe(true)
    expect(re.test('bg-host-panel border-host-edge')).toBe(false)
  })
  it('the textarea has no fixed height and the input keeps its 44px', () => {
    expect(ui.HOST_TEXTAREA).not.toMatch(/(^|\s)h-/)
    expect(ui.HOST_TEXTAREA).toContain('min-h-[6rem]')
    expect(ui.HOST_TEXTAREA).toContain('resize-y')
    expect(ui.HOST_INPUT).toContain('h-11')
  })
  it('the table hairline is on the row, with the last-row rule in the right variant order', () => {
    // `last:[&>td]:border-0` would target the last CELL of every row; the rule
    // belongs on the <tr> itself.
    expect(ui.HOST_TR).toBe('border-b border-host-border last:border-0')
    expect(ui.HOST_TD).not.toMatch(/border/)
  })
  it('the active tab is a filled pill with an edge, not a tint', () => {
    expect(ui.HOST_TAB_ACTIVE).toContain('bg-host-panel')
    expect(ui.HOST_TAB_ACTIVE).toContain('ring-1 ring-host-edge')
    // The nav and the event tabs scroll sideways (overflow-x-auto), which clips an
    // outset ring on three sides: the ring must be drawn inside the pill.
    expect(ui.HOST_TAB_ACTIVE).toContain('ring-inset')
  })
  it('the small buttons carry the same states as the full-size ones', () => {
    for (const n of ['HOST_BTN_SM', 'HOST_BTN_PRIMARY_SM']) {
      expect(ui[n], n).toContain('text-xs')
      expect(ui[n], n).toContain('px-3 py-1.5')
      expect(ui[n], n).toContain('disabled:opacity-50 disabled:cursor-not-allowed')
    }
  })
  it('hover states use the hover token, never well', () => {
    for (const [n, s] of strings) expect(s, n).not.toMatch(/hover:bg-host-well/)
  })
  it('has no imports, so server and client code can both use it', () => {
    expect(readFileSync(new URL('./host-ui.js', import.meta.url), 'utf8')).not.toMatch(/^\s*import\s/m)
  })
  it('every host colour class names a token that exists in the Tailwind host group', () => {
    const host = Object.keys(require('../../../tailwind.config.js').theme.extend.colors.host)
    const names = new Set()
    for (const [, s] of strings) for (const m of s.matchAll(/(?:text|bg|border|divide|ring|outline|placeholder|fill|stroke)-host-([a-z-]+)/g)) names.add(m[1])
    for (const n of names) expect(host, n).toContain(n)
  })
})
