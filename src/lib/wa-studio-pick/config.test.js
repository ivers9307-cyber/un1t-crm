// WASTUDIOPICK.1 — picker settings. Fictional ids only.
import { describe, it, expect, vi } from 'vitest'
vi.mock('../log', () => ({ logWarn: vi.fn() }))
import { readPickerConfig, pickerLabel, DEFAULT_PICKER_QUESTION } from './config.js'
import { logWarn } from '../log'

const ORG = 'd0000000-0000-4000-8000-000000000001'
const STILL = { id: 'a1', name: 'UN1T Stillorgan', organization_id: ORG, settings: { wa_studio_picker: { enabled: true, listed: true, label: 'Stillorgan', keywords: ['stillorgan'] } } }
const HATCH = { id: 'a2', name: 'UN1T Hatch Street', organization_id: ORG, settings: { wa_studio_picker: { listed: true } } }
const TEST = { id: 'a3', name: 'Test Studio', organization_id: ORG, settings: {} }
const OTHER = { id: 'a9', name: 'Elsewhere', organization_id: 'd0000000-0000-4000-8000-000000000009', settings: { wa_studio_picker: { listed: true } } }

function makeDb(rows, fault) {
  return {
    from: () => {
      const filters = []
      const run = () => (fault ? { data: null, error: fault } : { data: rows.filter((r) => filters.every((f) => f(r))), error: null })
      const b = {
        select: () => b, order: () => b,
        eq: (c, v) => { filters.push((r) => r[c] === v); return b },
        maybeSingle: async () => { const o = run(); return o.error ? o : { data: o.data[0] ?? null, error: null } },
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

describe('readPickerConfig', () => {
  it('lists opted-in studios of the receiving studio\u2019s organisation, with defaults', async () => {
    const cfg = await readPickerConfig(makeDb([STILL, HATCH, TEST, OTHER]), 'a1')
    expect(cfg.enabled).toBe(true)
    expect(cfg.question).toBe(DEFAULT_PICKER_QUESTION)
    expect(cfg.studios.map((s) => s.id).sort()).toEqual(['a1', 'a2'])
    expect(cfg.studios.find((s) => s.id === 'a2')).toMatchObject({ label: 'UN1T Hatch Street', keywords: [] })
  })
  it('disabled by default; a failed read is null and logged', async () => {
    expect((await readPickerConfig(makeDb([HATCH, TEST]), 'a2')).enabled).toBe(false)
    expect(await readPickerConfig(makeDb([], { message: 'boom' }), 'a1')).toBeNull()
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('pickerLabel', () => {
  it('label, else name, cut to 20', () => {
    expect(pickerLabel({ name: 'UN1T Hatch Street Dublin 2', settings: {} })).toBe('UN1T Hatch Street Du')
    expect(pickerLabel({ name: 'x', settings: { wa_studio_picker: { label: '  Hatch Street ' } } })).toBe('Hatch Street')
  })
})
