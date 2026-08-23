// @vitest-environment jsdom
//
// SHELLY-UI.1 — WindowsEditor is the window block lifted out of
// SonosScheduleClient so Shelly edits windows with the same control. These
// tests pin the contract the two callers share: the editor is CONTROLLED
// (every edit leaves through onChange, nothing is held internally), the
// extension seams (renderExtra/summaryExtra) get what they are documented
// to get, and the cap and the disabled-Add precondition both hold.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import WindowsEditor, { DAY_LABELS } from './WindowsEditor.jsx'

// A controlled harness, because that is how both real callers use it —
// testing against a bare onChange spy would pass even if the component
// secretly kept its own copy of the list.
function Harness({ initial = [], onChangeSpy, ...props }) {
  const [windows, setWindows] = useState(initial)
  return (
    <WindowsEditor
      windows={windows}
      onChange={(next) => { onChangeSpy?.(next); setWindows(next) }}
      editable
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

  it('renders all seven days, Mon..Sun', () => {
    render(<Harness initial={[{ ...WEEKDAYS }]} />)
    expect(DAY_LABELS.map((d) => d.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    for (const d of DAY_LABELS) expect(dayPill(d.label)).toBeTruthy()
  })

  it('changes the on and off times independently', () => {
    const onChange = vi.fn()
    render(<Harness initial={[{ ...WEEKDAYS }]} onChangeSpy={onChange} />)
    const [on, off] = timeInputs()

    fireEvent.change(on, { target: { value: '06:30' } })
    expect(onChange).toHaveBeenLastCalledWith([{ ...WEEKDAYS, on: '06:30' }])

    fireEvent.change(off, { target: { value: '21:30' } })
    expect(onChange).toHaveBeenLastCalledWith([{ ...WEEKDAYS, on: '06:30', off: '21:30' }])
  })

  it('edits the right row when several windows are open', () => {
    const onChange = vi.fn()
    render(<Harness initial={[{ ...WEEKDAYS }, { days: [6, 7], on: '10:00', off: '14:00' }]} onChangeSpy={onChange} />)
    const [, , secondOn] = timeInputs()

    fireEvent.change(secondOn, { target: { value: '11:00' } })
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

  it('appends the shared base merged with defaultWindow, calling it at click time', () => {
    const onChange = vi.fn()
    const defaultWindow = vi.fn(() => ({ volume: 30, favorite_id: 'fav-1' }))
    render(<Harness initial={[]} onChangeSpy={onChange} defaultWindow={defaultWindow} />)

    expect(screen.getByText(/No windows yet/)).toBeTruthy()
    expect(defaultWindow).not.toHaveBeenCalled() // not at render — only on Add

    fireEvent.click(addButton())
    expect(defaultWindow).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith([
      { days: [1, 2, 3, 4, 5], on: '09:00', off: '17:00', volume: 30, favorite_id: 'fav-1' },
    ])
  })

  it('accepts a plain object defaultWindow too, and needs none at all', () => {
    const onChange = vi.fn()
    const { unmount } = render(<Harness initial={[]} onChangeSpy={onChange} defaultWindow={{ volume: 12 }} />)
    fireEvent.click(addButton())
    expect(onChange).toHaveBeenLastCalledWith([{ days: [1, 2, 3, 4, 5], on: '09:00', off: '17:00', volume: 12 }])
    unmount()

    const onChange2 = vi.fn()
    render(<Harness initial={[]} onChangeSpy={onChange2} />)
    fireEvent.click(addButton())
    expect(onChange2).toHaveBeenLastCalledWith([{ days: [1, 2, 3, 4, 5], on: '09:00', off: '17:00' }])
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

  it('defaults the cap to 16 — the API\'s own windows.max(16)', () => {
    const rows = Array.from({ length: 16 }, (_, i) => ({ days: [1], on: '09:00', off: `${String(i).padStart(2, '0')}:30` }))
    const { unmount } = render(<Harness initial={rows} />)
    expect(addButton()).toBeNull()
    unmount()
    render(<Harness initial={rows.slice(0, 15)} />)
    expect(addButton()).toBeTruthy()
  })

  it('does not append past the cap even if Add is somehow clicked', () => {
    // Belt and braces: the guard lives in the handler, not only in the
    // render condition, so a stale click can never overrun the API's max.
    const onChange = vi.fn()
    render(
      <WindowsEditor windows={[{ ...WEEKDAYS }]} onChange={onChange} editable={false} max={1} />,
    )
    expect(addButton()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
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
  it('receives (win, i, setField) and setField writes to that window only', () => {
    const onChange = vi.fn()
    const seen = []
    render(
      <Harness
        initial={[{ ...WEEKDAYS, volume: 30 }, { days: [6], on: '10:00', off: '14:00', volume: 40 }]}
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
    expect(seen[0].win).toEqual({ ...WEEKDAYS, volume: 30 })
    expect(seen[1].win).toEqual({ days: [6], on: '10:00', off: '14:00', volume: 40 })
    expect(seen.every((s) => s.setFieldIsFn)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'volume 1' }))
    expect(onChange).toHaveBeenLastCalledWith([
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
    const { unmount } = render(<WindowsEditor windows={[]} onChange={() => {}} editable={false} />)
    expect(screen.getByText('No windows yet.')).toBeTruthy()
    unmount()
    render(<Harness initial={[]} />)
    expect(screen.getByText('No windows yet — add one below.')).toBeTruthy()
  })

  it('survives a non-array windows prop rather than throwing mid-render', () => {
    render(<WindowsEditor windows={null} onChange={() => {}} editable={false} />)
    expect(screen.getByText('No windows yet.')).toBeTruthy()
  })
})
