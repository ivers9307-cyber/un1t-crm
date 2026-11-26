// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import EmailTypoHint from './EmailTypoHint'

afterEach(cleanup)

describe('EmailTypoHint (TYPOHINT.1)', () => {
  it('offers the corrected address and fills it on tap', () => {
    const onAccept = vi.fn()
    const u = render(<EmailTypoHint email="anne@gmial.com" onAccept={onAccept} />)
    fireEvent.click(u.getByRole('button', { name: 'anne@gmail.com' }))
    expect(onAccept).toHaveBeenCalledWith('anne@gmail.com')
  })

  it('renders nothing for a good address', () => {
    const u = render(<EmailTypoHint email="anne@gmail.com" onAccept={() => {}} />)
    expect(u.container.textContent).toBe('')
  })
})
