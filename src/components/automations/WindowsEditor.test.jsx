// @vitest-environment jsdom
//
// SHELLY-UI.1 — WindowsEditor is the window block lifted out of
// SonosScheduleClient so Shelly edits windows with the same control. These
// tests pin the contract the two callers share: the editor is CONTROLLED
// (every edit leaves through onChange, nothing is held internally), the
// extension seams (renderExtra/summaryExtra) get what they are documented
// to get, and the cap and the disabled-Add precondition both hold.
//
// SHELLY-UI.1b — plus REFERENTIAL identity, not just deep equality. React
// bails out of a re-render on Object.is, so a mutate-in-place edit
// (`list[i].on = value; onChange(list)`) deep-equals the correct result and
// would pass every value assertion here while leaving Sonos looking frozen
// — the operator types a new time and the field snaps back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { DAY_LABELS, BASE_WINDOW } from '@/lib/schedule/windows'
import WindowsEditor from './WindowsEditor.jsx'

const MAX = 16 // what Sonos passes; `max` is required, there is no default

// A controlled harness, because that is how both real callers use it —
// testing against a bare onChange spy would pass even if the component
// secretly kept its own copy of the list.
function Harness({ initial = [], onChangeSpy, max = MAX, ...props }) {
  const [windows, setWindows] = useState(initial)
  return (
    <WindowsEditor
      windows={windows}
      onChange={(next) => { onChangeSpy?.(next); setWindows(next) }}
      editable
      max={max}
      {...props}
    />
  )
}

const WEEKDAYS = { days: [1, 2, 3, 4, 5], on: '09:00', off: '17:00' }

function dayPill(label) {
  return screen.getByRole('button', { name: label })
}
function timeInputs() {
  return document.querySelectorAll('input[type="time"]')
}
function addButton() {
  return screen.queryByRole('button', { name: /Add window/ })
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(cleanup)

describe('WindowsEditor — editing', () => {
  it('toggles a day off and back on, keeping days sorted ascending', () => {
    const onChange = vi.fn()
    render(<Harness initial={[{ ...WEEKDAYS }]} onChangeSpy={onChange} />)

    fireEvent.click(dayPill('Wed'))
    expect(onChange).toHaveBeenLastCalledWith([{ ...WEEKDAYS, days: [1, 2, 4, 5] }])

    // Back on — re-inserted in order, not appended, so the stored array
    // never depends on the order the operator clicked in.
    fireEvent.click(dayPill('Wed'))
    expect(onChange).toHaveBeenLastCalledWith([{ ...WEEKDAYS, days: [1, 2, 3, 4, 5] }])
  })

  it('reports each day pill\'s state through aria-pressed', () => {
    render(<Harness initial={[{ days: [1], on: '09:00', off: '17:00' }]} />)
    expect(dayPill('Mon').getAttribute('aria-pressed')).toBe('true')
    expect(dayPill('Tue').getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(dayPill('Tue'))
    expect(dayPill('Tue').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(dayPill('Mon'))
    expect(dayPill('Mon').getAttribute('aria-pressed')).toBe('false')
  })

  it('renders all seven days, Mon..Sun', () => {
    render(<Harness initial={[{ ...WEEKDAYS }]} />)
    expect(DAY_LABELS.map((d) => d.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    for (const d of DAY_LABELS) expect(dayPill(d.label)).toBeTruthy()
  })

  it('changes the on and off times independently, and replaces rather than mutates', () => {
    const onChange = vi.fn()
    const before = [{ ...WEEKDAYS }, { days: [6], on: '10:00', off: '14:00' }]
    const snapshot = structuredClone(before)
    render(<Harness initial={before} onChangeSpy={onChange} />)

    fireEvent.change(timeInputs()[0], { target: { value: '06:30' } })
    const next = onChange.mock.lastCall[0]

    expect(next).not.toBe(before)          // a new array…
    expect(next[0]).not.toBe(before[0])    // …a new object for the edited row…
    expect(next[1]).toBe(before[1])        // …and the untouched row shared, not cloned
    expect(before).toEqual(snapshot)       // nothing written in place
    expect(next[0]).toEqual({ ...WEEKDAYS, on: '06:30' })

    fireEvent.change(timeInputs()[1], { target: { value: '21:30' } })
    expect(onChange).toHaveBeenLastCalledWith([
      { ...WEEKDAYS, on: '06:30', off: '21:30' },
      { days: [6], on: '10:00', off: '14:00' },
    ])
  })

  it('edits the right row when several windows are open', () => {
    const onChange = vi.fn()
    render(<Harness initial={[{ ...WEEKDAYS }, { days: [6, 7], on: '10:00', off: '14:00' }]} onChangeSpy={onChange} />)

    fireEvent.change(timeInputs()[2], { target: { value: '11:00' } })
    expect(onChange).toHaveBeenLastCalledWith([
      { ...WEEKDAYS },
      { days: [6, 7], on: '11:00', off: '14:00' },
    ])
  })

  it('removes the window whose Remove was clicked, not the first one', () => {
    const onChange = vi.fn()
    render(<Harness initial={[{ ...WEEKDAYS }, { days: [6], on: '10:00', off: '14:00' }]} onChangeSpy={onChange} />)

    const removes = screen.getAllByRole('button', { name: /Remove/ })
    expect(removes).toHaveLength(2)
    fireEvent.click(removes[1])
    expect(onChange).toHaveBeenLastCalledWith([{ ...WEEKDAYS }])
    expect(timeInputs()).toHaveLength(2) // one window left
  })

  it('appends BASE_WINDOW merged with defaultWindowExtra, calling it at click time', () => {
    const onChange = vi.fn()
    const defaultWindowExtra = vi.fn(() => ({ volume: 30, favorite_id: 'fav-1' }))
    render(<Harness initial={[]} onChangeSpy={onChange} defaultWindowExtra={defaultWindowExtra} />)

    expect(screen.getByText(/No windows yet/)).toBeTruthy()
    expect(defaultWindowExtra).not.toHaveBeenCalled() // not at render — only on Add

    fireEvent.click(addButton())
    expect(defaultWindowExtra).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith([
      { days: [1, 2, 3, 4, 5], on: '09:00', off: '17:00', volume: 30, favorite_id: 'fav-1' },
    ])
    // A copy, never the frozen shared constant itself.
    expect(onChange.mock.lastCall[0][0]).not.toBe(BASE_WINDOW)
  })

  it('accepts a plain object defaultWindowExtra too, and needs none at all', () => {
    const onChange = vi.fn()
    const { unmount } = render(<Harness initial={[]} onChangeSpy={onChange} defaultWindowExtra={{ volume: 12 }} />)
    fireEvent.click(addButton())
    expect(onChange).toHaveBeenLastCalledWith([{ ...BASE_WINDOW, volume: 12 }])
    unmount()

    const onChange2 = vi.fn()
    render(<Harness initial={[]} onChangeSpy={onChange2} />)
    fireEvent.click(addButton())
    expect(onChange2).toHaveBeenLastCalledWith([{ ...BASE_WINDOW }])
  })
})

describe('WindowsEditor — the cap', () => {
  it('hides Add once `max` windows exist and shows it again after a removal', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ days: [1], on: `0${i}:00`, off: `0${i}:30` }))
    render(<Harness initial={rows} max={3} />)
    expect(addButton()).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[0])
    expect(addButton()).toBeTruthy()
  })

  it('takes the cap from the caller\'s `max`, with no built-in default', () => {
    // `max` is required precisely so a caller states the number its own API
    // enforces — the same six windows are under one caller's cap and at
    // another's.
    const rows = Array.from({ length: 6 }, (_, i) => ({ days: [1], on: '09:00', off: `0${i}:30` }))
    const { unmount } = render(<Harness initial={rows} max={MAX} />)
    expect(addButton()).toBeTruthy()
    unmount()
    render(<Harness initial={rows} max={6} />)
    expect(addButton()).toBeNull()
  })
})

describe('WindowsEditor — addDisabled', () => {
  it('disables Add with the caller\'s reason as its title, and refuses the click', () => {
    const onChange = vi.fn()
    render(
      <Harness
        initial={[]}
        onChangeSpy={onChange}
        addDisabled
        addDisabledTitle="Save a favourite in the Sonos app first"
      />,
    )
    const btn = addButton()
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toBe('Save a favourite in the Sonos app first')

    fireEvent.click(btn)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('carries no title when Add is enabled', () => {
    render(<Harness initial={[]} addDisabledTitle="not shown" />)
    expect(addButton().disabled).toBe(false)
    expect(addButton().getAttribute('title')).toBeNull()
  })
})

describe('WindowsEditor — renderExtra', () => {
  it('receives (win, i, setField) and setField replaces that window only', () => {
    const onChange = vi.fn()
    const seen = []
    const before = [{ ...WEEKDAYS, volume: 30 }, { days: [6], on: '10:00', off: '14:00', volume: 40 }]
    const snapshot = structuredClone(before)
    render(
      <Harness
        initial={before}
        onChangeSpy={onChange}
        renderExtra={(win, i, setField) => {
          seen.push({ win, i, setFieldIsFn: typeof setField === 'function' })
          return (
            <button type="button" onClick={() => setField(i, 'volume', 99)}>
              volume {i}
            </button>
          )
        }}
      />,
    )

    expect(seen.map((s) => s.i)).toEqual([0, 1])
    expect(seen[0].win).toBe(before[0]) // the row object itself, not a copy
    expect(seen[1].win).toBe(before[1])
    expect(seen.every((s) => s.setFieldIsFn)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'volume 1' }))
    const next = onChange.mock.lastCall[0]

    expect(next).not.toBe(before)
    expect(next[1]).not.toBe(before[1])
    expect(next[0]).toBe(before[0])
    expect(before).toEqual(snapshot)
    expect(next).toEqual([
      { ...WEEKDAYS, volume: 30 },
      { days: [6], on: '10:00', off: '14:00', volume: 99 },
    ])
  })

  it('renders the extra controls in the same row as On/Off, before Remove', () => {
    // Layout matters here: Sonos's Remove sits at `ml-auto` on the end of
    // that flex row, so extras landing after it would push it off.
    render(
      <Harness
        initial={[{ ...WEEKDAYS }]}
        renderExtra={() => <span data-testid="extra">extra</span>}
      />,
    )
    const row = screen.getByTestId('extra').parentElement
    expect(within(row).getByRole('button', { name: /Remove/ })).toBeTruthy()
    expect(row.querySelectorAll('input[type="time"]')).toHaveLength(2)
    const kids = Array.from(row.children)
    expect(kids.indexOf(screen.getByTestId('extra'))).toBeLessThan(
      kids.indexOf(within(row).getByRole('button', { name: /Remove/ })),
    )
  })

  it('renders nothing extra when no renderExtra is given', () => {
    render(<Harness initial={[{ ...WEEKDAYS }]} />)
    // On, Off and Remove only — no orphan control from a missing prop.
    expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(1)
    expect(timeInputs()).toHaveLength(2)
  })
})

describe('WindowsEditor — read-only', () => {
  it('summarises days and times and appends summaryExtra', () => {
    render(
      <WindowsEditor
        windows={[{ days: [1, 3, 5], on: '06:00', off: '21:30', volume: 30, favorite_id: 'fav-1' }]}
        onChange={() => {}}
        editable={false}
        max={MAX}
        summaryExtra={(win) => <> · volume {win.volume} · favourite {win.favorite_id || '(none)'}</>}
      />,
    )
    expect(screen.getByText('Mon, Wed, Fri · 06:00–21:30 · volume 30 · favourite fav-1')).toBeTruthy()
  })

  it('says "No days" when a window targets none, and (none) via summaryExtra', () => {
    render(
      <WindowsEditor
        windows={[{ days: [], on: '06:00', off: '21:30', volume: 0, favorite_id: '' }]}
        onChange={() => {}}
        editable={false}
        max={MAX}
        summaryExtra={(win) => <> · volume {win.volume} · favourite {win.favorite_id || '(none)'}</>}
      />,
    )
    expect(screen.getByText('No days · 06:00–21:30 · volume 0 · favourite (none)')).toBeTruthy()
  })

  it('renders no controls at all read-only — no Add, no Remove, no inputs', () => {
    render(
      <WindowsEditor
        windows={[{ ...WEEKDAYS }]}
        onChange={() => {}}
        editable={false}
        max={MAX}
        renderExtra={() => <span data-testid="extra">extra</span>}
      />,
    )
    expect(addButton()).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
    expect(timeInputs()).toHaveLength(0)
    // renderExtra belongs to the editable row, so it must not leak here.
    expect(screen.queryByTestId('extra')).toBeNull()
  })

  it('drops the "add one below" half of the empty state when not editable', () => {
    const { unmount } = render(<WindowsEditor windows={[]} onChange={() => {}} editable={false} max={MAX} />)
    expect(screen.getByText('No windows yet.')).toBeTruthy()
    unmount()
    render(<Harness initial={[]} />)
    expect(screen.getByText('No windows yet — add one below.')).toBeTruthy()
  })

  it('survives a non-array windows prop rather than throwing mid-render', () => {
    render(<WindowsEditor windows={null} onChange={() => {}} editable={false} max={MAX} />)
    expect(screen.getByText('No windows yet.')).toBeTruthy()
  })

  it('survives a window with no days array in either branch', () => {
    // A hand-written or partially-migrated row: days missing entirely.
    const { unmount } = render(
      <WindowsEditor windows={[{ on: '06:00', off: '07:00' }]} onChange={() => {}} editable={false} max={MAX} />,
    )
    expect(screen.getByText('No days · 06:00–07:00')).toBeTruthy()
    unmount()

    const onChange = vi.fn()
    render(<Harness initial={[{ on: '06:00', off: '07:00' }]} onChangeSpy={onChange} />)
    expect(dayPill('Mon').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(dayPill('Mon'))
    expect(onChange).toHaveBeenLastCalledWith([{ on: '06:00', off: '07:00', days: [1] }])
  })
})
