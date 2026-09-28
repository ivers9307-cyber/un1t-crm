// HUBREAD.1 — the hub page's own locations read. A failure used to hand []
// to the assembler: no locations, every card empty with Connect buttons,
// and "All connections healthy".

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getOwnerOrganizationIds: vi.fn(() => ['org-1']),
}))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/integrations-hub', () => ({ assembleIntegrationsHub: vi.fn(async () => ({ stub: true })) }))
vi.mock('@/components/settings/IntegrationsHub', () => ({ default: () => 'HUB_RENDERED' }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import IntegrationsHubPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { assembleIntegrationsHub } from '@/lib/integrations-hub'
import { logError } from '@/lib/log'

function locationsDb(result) {
  const b = {
    select: () => b, eq: () => b, order: () => b, in: () => b,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  }
  return { from: () => b }
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue({ id: 'u1', isMaster: true })
})

describe('/settings/integrations-hub — the locations read (HUBREAD.1)', () => {
  it('a failed read says it could not load, and never renders an empty hub', async () => {
    createServerClient.mockReturnValue(locationsDb({ data: null, error: { message: 'db exploded' } }))
    const html = renderToStaticMarkup(await IntegrationsHubPage())
    expect(html).toContain('Could not load your locations just now')
    expect(html).not.toContain('HUB_RENDERED')
    expect(html).not.toContain('db exploded')
    expect(assembleIntegrationsHub).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('a good read still renders the hub (pin)', async () => {
    createServerClient.mockReturnValue(locationsDb({ data: [{ id: 'loc-a', name: 'Stillorgan' }], error: null }))
    const html = renderToStaticMarkup(await IntegrationsHubPage())
    expect(html).toContain('HUB_RENDERED')
    expect(assembleIntegrationsHub).toHaveBeenCalledTimes(1)
  })
})
