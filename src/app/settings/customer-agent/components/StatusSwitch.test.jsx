// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import StatusSwitch from './StatusSwitch'

afterEach(() => cleanup())

const setup = (settings, extra = {}) => {
  const onChoose = vi.fn()
  const onTestPhones = vi.fn()
  render(<StatusSwitch settings={settings} onChoose={onChoose} onTestPhones={onTestPhones} {...extra} />)
  return { onChoose, onTestPhones }
}

describe('StatusSwitch', () => {
  it('is a radiogroup "Mia is" with Off, Test, Live', () => {
    setup({ enabled: false, test_mode: false })
    const group = screen.getByRole('radiogroup', { name: 'Mia is' })
    expect(group).toBeTruthy()
    expect(screen.getAllByRole('radio').map(r => r.value)).toEqual(['off', 'test', 'live'])
    expect(screen.getByRole('radio', { name: 'Off' }).checked).toBe(true)
    expect(screen.getByText('Mia does not reply to anyone.')).toBeTruthy()
  })

  it('shows the test numbers only in Test', () => {
    const { rerender } = render(<StatusSwitch settings={{ enabled: false, test_mode: true, test_phones: ['+353871'] }} onChoose={() => {}} onTestPhones={() => {}} />)
    expect(screen.getByText('Test numbers (comma-separated, e.g. +353871234567)')).toBeTruthy()
    expect(screen.getByText('Mia replies only to the test numbers below.')).toBeTruthy()
    rerender(<StatusSwitch settings={{ enabled: true, test_mode: false }} onChoose={() => {}} onTestPhones={() => {}} />)
    expect(screen.queryByText(/Test numbers/)).toBeNull()
    expect(screen.getByText('Mia replies to every customer.')).toBeTruthy()
  })

  it('parses test numbers on comma, trimmed, empties dropped', () => {
    const { onTestPhones } = setup({ enabled: false, test_mode: true, test_phones: [] })
    fireEvent.change(screen.getByPlaceholderText('+353871234567, +353879999999'), { target: { value: ' +1 , ,+2 ' } })
    expect(onTestPhones).toHaveBeenCalledWith(['+1', '+2'])
  })

  it('live_and_test shows Live selected and the warning', () => {
    setup({ enabled: true, test_mode: true })
    expect(screen.getByRole('radio', { name: 'Live' }).checked).toBe(true)
    expect(screen.getByText(/Click Live to tidy this up\.$/)).toBeTruthy()
  })

  it('reports the choice, and disables every radio when disabled', () => {
    const { onChoose } = setup({ enabled: false, test_mode: false })
    fireEvent.click(screen.getByRole('radio', { name: 'Test' }))
    expect(onChoose).toHaveBeenCalledWith('test')
  })

  it('is disabled when told to', () => {
    setup({ enabled: false, test_mode: false }, { disabled: true })
    screen.getAllByRole('radio').forEach(r => expect(r.disabled).toBe(true))
  })
})
