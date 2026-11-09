// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

const jar = { value: undefined }
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => 'crm.example.com' }),
  cookies: async () => ({ get: (name) => (name === 'host_theme' && jar.value !== undefined ? { name, value: jar.value } : undefined) }),
}))
vi.mock('@/lib/default-site-name', () => ({ customerFacingMetadata: async () => ({}) }))

const { default: HostLayout } = await import('./layout.js')

afterEach(cleanup)

describe('HostLayout theme wrapper', () => {
  it.each([['light', 'light'], ['dark', 'dark'], [undefined, 'system'], ['nonsense', 'system']])(
    'cookie %s renders data-host-theme=%s', async (cookie, attr) => {
      jar.value = cookie
      const { container } = render(await HostLayout({ children: <p>child</p> }))
      const el = container.querySelector('[data-host-theme]')
      expect(el.getAttribute('data-host-theme')).toBe(attr)
      expect(el.className).toContain('min-h-screen')
      expect(el.className).toContain('bg-host-bg')
      expect(el.className).toContain('text-host-text')
      expect(el.textContent).toBe('child')
    })
})
