// @vitest-environment jsdom
//
// FILTER-B.2 — the shared audience-count surface.
//
// Three of the five audience builders (WhatsApp broadcast, SMS broadcast,
// sequence settings) shipped with `audienceCount={null}`: every filter defect
// the correctness phase fixed was INVISIBLE there — a blank date, an
// unresolvable tag, a filter matching nobody, all silent. This component is
// the composer's count block extracted so all four hosts show the same number,
// asked for their OWN channel (a WhatsApp broadcast showing an email-reachable
// count would be a new lie, not a fix).
//
// The sequence host is deliberately DIFFERENT: since SEQEXIT.1 a sequence's
// audience is a CONTINUING condition — it decides who enrols and who STAYS,
// not who receives one send. It gets mode="matching" (a match count, labelled
// as such) and must never be given a will-receive number.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

import AudienceCount from './AudienceCount.jsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The component debounces its count by 400ms on REAL timers, so every
// assertion here is waiting on a scheduled callback. testing-library's
// default find timeout is 1000ms, which under a loaded CI box (or a full
// 857-file suite) is close enough to the debounce to race — this file went
// flaky roughly 1 run in 8 before these were widened. Give the waits real
// headroom rather than trusting timer scheduling luck.
vi.setConfig({ testTimeout: 20000 })
const WAIT = { timeout: 8000 }

const FILTER = { logic: 'and', filters: [{ field: 'pipeline_stage_slug', op: 'eq', value: 'member' }] }

// Captures every POST body so the channel-parity assertions can read it.
function stubCount(handler) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('/api/communications/audience-count')) {
      calls.push(JSON.parse(init.body))
      return handler()
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  }))
  return calls
}

function ok(body) { return { ok: true, status: 200, json: async () => ({ success: true, ...body }) } }
function bad(error, status = 400) { return { ok: false, status, json: async () => ({ success: false, error }) } }

describe('AudienceCount — channel parity', () => {
  it.each(['email', 'sms', 'whatsapp'])('asks the count route for its OWN channel (%s)', async (channel) => {
    const calls = stubCount(() => ok({ count: 1, matched: 1 }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel={channel} />)
    await waitFor(() => expect(calls.length).toBeGreaterThan(0), WAIT)
    expect(calls[0].channel).toBe(channel)
    expect(calls[0].location_id).toBe('loc-1')
  })

  it('strips half-built rows before counting, so an unset row never reaches the route', async () => {
    const calls = stubCount(() => ok({ count: 3, matched: 3 }))
    render(
      <AudienceCount
        locationId="loc-1"
        channel="sms"
        filter={{ logic: 'and', filters: [FILTER.filters[0], { field: '', op: '', value: '' }] }}
      />,
    )
    await waitFor(() => expect(calls.length).toBeGreaterThan(0), WAIT)
    expect(calls[0].audience_filter.filters).toEqual(FILTER.filters)
  })
})

describe('AudienceCount — states', () => {
  it('shows a loading state while the count is in flight', () => {
    stubCount(() => new Promise(() => {}))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="sms" />)
    expect(screen.getByText(/counting/i)).toBeTruthy()
  })

  it('surfaces the server error message rather than the placeholder', async () => {
    stubCount(() => bad('OR logic is not supported together with tag, event or studio-list filters.'))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="sms" />)
    await screen.findByText(/OR logic is not supported together with tag, event or studio-list filters/, undefined, WAIT)
    expect(screen.queryByText(/Add a condition to see how many contacts match/)).toBeNull()
  })
})

describe('AudienceCount — send mode reports match vs will-receive', () => {
  it('email: N match · M will receive it, plus the excluded breakdown', async () => {
    stubCount(() => ok({
      count: 2300, matched: 4900,
      excluded: { not_opted_in: 1200, bounced_or_complained: 24, suppressed: 300 },
    }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="email" />)
    await screen.findByText(/will receive it/, undefined, WAIT)
    expect(screen.getByText('4,900')).toBeTruthy()
    expect(screen.getByText('2,300')).toBeTruthy()
    await screen.findByText(/1,200 no marketing opt-in/, undefined, WAIT)
    screen.getByText(/24 bounced or complained/)
    screen.getByText(/300 suppressed for repeat bounces/)
  })

  it('sms: renders the excluded breakdown the composer never showed', async () => {
    stubCount(() => ok({ count: 5, matched: 9, excluded: { no_phone: 2, not_opted_in: 1, opted_out: 1 } }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="sms" />)
    await screen.findByText(/will receive it/, undefined, WAIT)
    await screen.findByText(/2 no phone number/, undefined, WAIT)
    screen.getByText(/1 no marketing opt-in/)
    screen.getByText(/1 opted out/)
  })

  it('whatsapp: N match · M reachable on WhatsApp (never an email-reachable number)', async () => {
    stubCount(() => ok({
      count: 10, reachable: 6,
      excluded: { no_number: 3, no_consent: 2, opted_out: 1, undeliverable: 0 },
    }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="whatsapp" />)
    await screen.findByText(/reachable on WhatsApp/, undefined, WAIT)
    expect(screen.getByText('10')).toBeTruthy()
    expect(screen.getByText('6')).toBeTruthy()
    await screen.findByText(/3 no WhatsApp number/, undefined, WAIT)
  })
})

describe('AudienceCount — matching mode is NOT a recipient count (SEQEXIT.1)', () => {
  it('asks channel-agnostically and labels the number as a match, not a send', async () => {
    const calls = stubCount(() => ok({ count: 812 }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} mode="matching" />)
    await screen.findByText('812', undefined, WAIT)
    expect(calls[0].channel).toBeUndefined()
    expect(screen.getByText(/currently match/i)).toBeTruthy()
    // The words that would make it a recipient count must NOT appear.
    expect(screen.queryByText(/will receive/i)).toBeNull()
    expect(screen.queryByText(/reachable/i)).toBeNull()
  })

  it('says the condition is re-checked, so the number is not a one-off send list', async () => {
    stubCount(() => ok({ count: 812 }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} mode="matching" />)
    await screen.findByText('812', undefined, WAIT)
    expect(screen.getByText(/re-checked before every step/i)).toBeTruthy()
  })
})

describe('AudienceCount — half-built rows are called out, not silently ignored', () => {
  it('warns that an unfinished row is being ignored (the widening failure mode)', async () => {
    stubCount(() => ok({ count: 3360, matched: 3360 }))
    render(
      <AudienceCount
        locationId="loc-1"
        channel="email"
        filter={{ logic: 'and', filters: [{ field: '', op: '', value: '' }] }}
      />,
    )
    await screen.findByText(/1 unfinished filter row is being ignored/i, undefined, WAIT)
  })

  it('stays quiet when every row is complete', async () => {
    stubCount(() => ok({ count: 10, matched: 10 }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="email" />)
    await screen.findByText(/will receive it/, undefined, WAIT)
    expect(screen.queryByText(/unfinished filter row/i)).toBeNull()
  })
})

describe('AudienceCount — onResult lets a host gate Send on the same number', () => {
  it('reports the ready result, including the sendable number for the channel', async () => {
    stubCount(() => ok({ count: 10, reachable: 6, excluded: {} }))
    const seen = []
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="whatsapp" onResult={r => seen.push(r)} />)
    await waitFor(() => expect(seen.some(r => r.status === 'ready')).toBe(true), WAIT)
    const ready = seen.find(r => r.status === 'ready')
    expect(ready.matched).toBe(10)
    expect(ready.reachable).toBe(6)
    expect(ready.sendable).toBe(6)
    expect(ready.error).toBeNull()
  })

  it('reports an error result so Send can stay disabled', async () => {
    stubCount(() => bad('tag filter requires a non-empty string value'))
    const seen = []
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="sms" onResult={r => seen.push(r)} />)
    await waitFor(() => expect(seen.some(r => r.status === 'error')).toBe(true), WAIT)
    const err = seen.find(r => r.status === 'error')
    expect(err.sendable).toBeNull()
    expect(err.error).toMatch(/tag filter requires/)
  })
})

// ── FILTER-B.9 — the preview rides with the count, in every host ──────
describe('AudienceCount — mounts the preview behind the number', () => {
  it('offers "who matches" once a count has arrived', async () => {
    stubCount(() => ok({ count: 10, matched: 10 }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="email" />)
    await screen.findByText(/will receive it/, undefined, WAIT)
    expect(screen.getByRole('button', { name: /who matches/i })).toBeTruthy()
  })

  it('does not offer it while the count is failing — there is no audience to show', async () => {
    stubCount(() => bad('Unknown audience field: nope'))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="email" />)
    await screen.findByText(/Unknown audience field/, undefined, WAIT)
    expect(screen.getByRole('button', { name: /who matches/i }).disabled).toBe(true)
  })

  it('can be suppressed by a host that does not want it', async () => {
    stubCount(() => ok({ count: 10, matched: 10 }))
    render(<AudienceCount locationId="loc-1" filter={FILTER} channel="email" showPreview={false} />)
    await screen.findByText(/will receive it/, undefined, WAIT)
    expect(screen.queryByRole('button', { name: /who matches/i })).toBeNull()
  })
})
