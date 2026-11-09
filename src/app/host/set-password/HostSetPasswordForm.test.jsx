// @vitest-environment jsdom
// HOSTTHEME.1 — the set-password fields carry a visible label, not only a placeholder.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn(() => ({})) }))
vi.mock('@/lib/recovery-link', () => ({
  parseRecoveryLink: vi.fn(() => ({ flowType: 'invite' })),
  // Never settles: the form stays on "Verifying your invite…", which is all this test needs.
  establishRecoverySession: vi.fn(() => new Promise(() => {})),
}))

const { default: HostSetPasswordForm } = await import('./HostSetPasswordForm.jsx')

afterEach(cleanup)

describe('HostSetPasswordForm labels', () => {
  it('each field has a visible label and keeps its placeholder, type and autocomplete', () => {
    render(<HostSetPasswordForm brand={{ name: 'Test Org', shortName: 'TEST' }} />)
    for (const text of ['New password', 'Confirm password']) {
      const field = screen.getByLabelText(text)
      expect(field.tagName).toBe('INPUT')
      expect(field.getAttribute('type')).toBe('password')
      expect(field.getAttribute('placeholder')).toBe(text)
      expect(field.getAttribute('autocomplete')).toBe('new-password')
      expect(screen.getByText(text, { selector: 'label' }).className).not.toMatch(/sr-only/)
    }
  })
})
