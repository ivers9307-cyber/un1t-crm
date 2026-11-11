// @vitest-environment jsdom
// HOSTTHEME.1 — the host login fields carry a visible label, not only a placeholder.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn() }))

const { default: HostLoginForm } = await import('./HostLoginForm.jsx')

afterEach(cleanup)

describe('HostLoginForm labels', () => {
  it('each field has a visible label and keeps its placeholder, type and autocomplete', () => {
    render(<HostLoginForm brand={{ name: 'Test Org', shortName: 'TEST' }} />)
    const email = screen.getByLabelText('Email')
    expect(email.tagName).toBe('INPUT')
    expect(email.getAttribute('type')).toBe('email')
    expect(email.getAttribute('placeholder')).toBe('Email')
    expect(email.getAttribute('autocomplete')).toBe('email')
    const password = screen.getByLabelText('Password')
    expect(password.getAttribute('type')).toBe('password')
    expect(password.getAttribute('placeholder')).toBe('Password')
    expect(password.getAttribute('autocomplete')).toBe('current-password')
    for (const text of ['Email', 'Password']) {
      const label = screen.getByText(text, { selector: 'label' })
      expect(label.className).not.toMatch(/sr-only/)
    }
  })
})
