// SEC-AUTOMATION-BUILDER-GATE.1 — /automations/[id] (the sequence flow
// builder) had auth + tenant checks (login, then assertLocationAccess on
// the sequence's location) but NO permission gate — any logged-in staffer
// at the sequence's own location could open and edit the flow, regardless
// of whether they hold any automations-related permission.
//
// The /automations index only ever links here from AutomationsFlowList,
// which the index renders behind `canFlows = hasPermission('email') ||
// hasPermission('whatsapp')` — the curated-cards section (`automations`
// perm) and the Devices link (`device_control` perm) are unrelated
// surfaces that never route through this page. So the builder is gated
// on the same OR: `email` or `whatsapp`.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccess: (user, locationId) => {
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    }
    if (!locationId) return null
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) {
      return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 })
    }
    return null
  },
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
  notFound: vi.fn(() => {
    const err = new Error('NEXT_NOT_FOUND')
    err.digest = 'NEXT_NOT_FOUND'
    throw err
  }),
}))

// SEQPAGEGATE.1 — the mocks record their props: both are 'use client', so
// whatever the page hands them is serialised into the browser.
const seen = vi.hoisted(() => ({ builder: null, performance: null }))
vi.mock('@/components/sequences/SequenceFlowBuilder', () => ({
  default: (props) => { seen.builder = props; return <div data-testid="builder">{props.sequence.name}</div> },
}))
vi.mock('@/components/automations/AutomationPerformance', () => ({
  default: (props) => { seen.performance = props; return null },
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import SequenceBuilderPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { SEQUENCE_BUILDER_PAGE_SELECT } from '@/lib/sequences/builder-shape'
import { LOC_A, LOC_B, MANAGER_A_STAFF_B, STAFF_A_MANAGER_B } from '../../../../../tests/helpers/role-sweep-callers.js'

// SEQPAGEGATE.1 — the page reads with .maybeSingle() (0 rows is "not
// found", an error is an error) and the chain records its select string.
function mockDb({ sequence = null, error = null } = {}) {
  const calls = { select: null }
  const chain = {
    select: vi.fn((cols) => { calls.select = cols; return chain }),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: sequence, error })),
  }
  return { from: vi.fn(() => chain), calls }
}

// The same staff role and permission bag at every studio the user belongs to
// (the per-location mirror is what the SEQROUTEGATE.1 gate reads).
function user({ locations = [{ id: 'loc1' }], perms = {} } = {}) {
  const assignment = {
    role: 'staff',
    permissions: { automations: false, email: false, whatsapp: false, device_control: false, ...perms },
  }
  return {
    id: 'u1',
    role: 'staff',
    locations,
    activeLocation: locations[0] || null,
    activeAssignment: assignment,
    assignmentsByLocation: Object.fromEntries(locations.map((l) => [l.id, assignment])),
  }
}

// uuid-shaped (the page 404s a non-uuid id without a read); fictional.
function props(id = '5e000000-0000-4000-8000-000000000001') {
  return { params: Promise.resolve({ id }) }
}

const mySequence = { id: 'seq1', location_id: 'loc1', name: 'Welcome flow', sequence_steps: [] }

beforeEach(() => {
  vi.clearAllMocks()
  seen.builder = null
  seen.performance = null
})

describe('/automations/[id] builder page', () => {
  it('redirects to /login without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/login$/)
  })

  it('redirects to / when the user holds none of email/whatsapp', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: false, whatsapp: false } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('redirects to / for a device_control-only user (devices is a separate surface)', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { device_control: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('redirects to / for an automations-only user (curated cards never link here)', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { automations: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })

  it('renders the builder for an email holder at the sequence location', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    const html = renderToStaticMarkup(await SequenceBuilderPage(props()))
    expect(html).toContain('Welcome flow')
  })

  it('renders the builder for a whatsapp holder at the sequence location', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { whatsapp: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: mySequence }))
    const html = renderToStaticMarkup(await SequenceBuilderPage(props()))
    expect(html).toContain('Welcome flow')
  })

  it('404s a missing sequence before the permission check can leak its existence either way', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: null }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('404s a foreign-location sequence even when the user holds email', async () => {
    getCurrentUser.mockResolvedValue(user({ locations: [{ id: 'loc1' }], perms: { email: true } }))
    createServerClient.mockReturnValue(
      mockDb({ sequence: { ...mySequence, location_id: 'loc9', name: 'Foreign flow' } })
    )
    await expect(SequenceBuilderPage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })

  // SEQROUTEGATE.1 — the rule is judged at the SEQUENCE's studio, the same
  // place every /api/sequences route judges it, so the page never opens a
  // builder whose every save would then be refused.
  it('404s a sequence at a studio where the user may not build, even when the active studio allows it', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B) // manager at A (active), staff at B
    createServerClient.mockReturnValue(mockDb({ sequence: { ...mySequence, location_id: LOC_B, name: 'Studio B flow' } }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('renders a sequence at the studio where the user may build (same studio as active)', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A_STAFF_B)
    createServerClient.mockReturnValue(mockDb({ sequence: { ...mySequence, location_id: LOC_A, name: 'Studio A flow' } }))
    const html = renderToStaticMarkup(await SequenceBuilderPage(props()))
    expect(html).toContain('Studio A flow')
  })

  it('renders a sequence at a non-active studio where the user may build', async () => {
    getCurrentUser.mockResolvedValue(STAFF_A_MANAGER_B) // staff at A (active), manager at B
    createServerClient.mockReturnValue(mockDb({ sequence: { ...mySequence, location_id: LOC_B, name: 'Studio B flow' } }))
    const html = renderToStaticMarkup(await SequenceBuilderPage(props()))
    expect(html).toContain('Studio B flow')
  })
})

// SEQPAGEGATE.1 — SequenceFlowBuilder and AutomationPerformance are client
// components; whatever the page passes them is in the browser.
describe('/automations/[id] — what crosses into the browser (SEQPAGEGATE.1)', () => {
  const FULL = {
    ...mySequence, description: null, status: 'draft', trigger_type: 'webhook', trigger_config: {},
    audience_filter: null, goal_config: null, send_window: null, re_enrolment_cooldown_days: 0,
    webhook_token: 'd'.repeat(32), webhook_secret: 'SYNTH-SECRET', graph: null, draft_graph: null,
    sequence_steps: [{ id: 'st1', step_order: 0, step_type: 'email', config: {}, subject: 'Hi', html_content: '<p>SYNTH-HTML</p>', delay_days: 0, delay_hours: 0, delay_minutes: 0 }],
  }

  it('reads named columns (no star on email_sequences)', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: true } }))
    const db = mockDb({ sequence: FULL })
    createServerClient.mockReturnValue(db)
    renderToStaticMarkup(await SequenceBuilderPage(props()))
    // The only star is the server-only steps embed (see builder-shape.js).
    expect(db.calls.select).toBe(SEQUENCE_BUILDER_PAGE_SELECT)
    expect(db.calls.select.replace('sequence_steps(*)', '')).not.toContain('*')
  })

  it('the builder gets has_webhook_secret, never the secret; the performance panel gets id/step_type/config only', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: FULL }))
    renderToStaticMarkup(await SequenceBuilderPage(props()))
    expect(seen.builder.sequence).not.toHaveProperty('webhook_secret')
    expect(seen.builder.sequence.has_webhook_secret).toBe(true)
    expect(seen.builder.sequence).not.toHaveProperty('sequence_steps')
    expect(seen.performance.steps).toEqual([{ id: 'st1', step_type: 'email', config: {} }])
    const payload = JSON.stringify({ b: seen.builder.sequence, p: seen.performance })
    expect(payload).not.toContain('SYNTH-')
  })

  it('a failed read is logged and thrown (an error page), never "not found"', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: true } }))
    createServerClient.mockReturnValue(mockDb({ sequence: null, error: { code: '57014', message: 'timeout' } }))
    await expect(SequenceBuilderPage(props())).rejects.toThrow(/Could not load the sequence/)
    expect(logError).toHaveBeenCalledWith('sequences', expect.stringMatching(/builder page/), expect.objectContaining({ code: '57014' }))
  })

  it('a non-uuid id is not found, without a read', async () => {
    getCurrentUser.mockResolvedValue(user({ perms: { email: true } }))
    const db = mockDb({ sequence: FULL })
    createServerClient.mockReturnValue(db)
    await expect(SequenceBuilderPage(props('not-a-uuid'))).rejects.toThrow('NEXT_NOT_FOUND')
    expect(db.from).not.toHaveBeenCalled()
  })
})
