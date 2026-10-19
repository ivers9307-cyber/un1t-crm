// @vitest-environment jsdom
//
// SETTINGSWIPE.1 — the customer agent editor rendered whatever the GET said.
// The GET used to answer a failed read with the DEFAULTS (enabled:false), so
// Save switched Mia off. The GET now 500s; the editor must say "Could not
// load" with Try again and render NO Save (before this PR a 500 left it on
// "Loading…" forever).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'
import { DEFAULTS, buildCustomerAgentSettings, SettingsSchema } from '@/lib/agent/settings-contract'
import { mergeAgentSettings } from '@/lib/agent/settings-resolve'
import { initialOverridden, TRIAL_DONE_MIA_INSTRUCTION_DEFAULT } from '@/lib/agent/settings-overrides'
import CustomerAgentClient from './CustomerAgentClient.jsx'

const NOTE = 'Could not load the customer agent settings just now, so nothing is shown and nothing can be changed here until it loads.'
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const GOOD = reply(200, {
  success: true,
  settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false },
  location: { id: 'loc1', name: 'Test Studio' },
  checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
})

function mockFetch(settingsAnswers, { knowledgeFails = false } = {}) {
  let i = 0
  global.fetch = vi.fn(async (url) => {
    if (String(url).startsWith('/api/settings/customer-agent')) {
      const a = settingsAnswers[Math.min(i++, settingsAnswers.length - 1)]
      if (a instanceof Error) throw a
      return a
    }
    if (String(url).startsWith('/api/agent/knowledge')) {
      if (knowledgeFails) throw new TypeError('Failed to fetch')
      return reply(200, { success: true, entries: [] })
    }
    return reply(200, { success: true, templates: [] })
  })
}

afterEach(() => { cleanup(); delete global.fetch })

describe('CustomerAgentClient — placeholders carry the brand (W1.S3)', () => {
  it('renders the hand-off and welcome defaults and the Points label from the GET brand', async () => {
    mockFetch([reply(200, { ...(await GOOD.json()), brand: { companyName: 'Gym A', shortName: 'GA' } })])
    const { container } = render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(container.querySelector('input[placeholder="Thanks for your message! One of the Gym A team will get back to you shortly."]')).toBeTruthy()
    expect(container.querySelector('textarea[placeholder^="Hi, I\'m Mia, the studio\'s assistant at Gym A."]')).toBeTruthy()
    expect(screen.getByText('Monthly GA Points target')).toBeTruthy()
    expect(container.textContent).not.toContain('UN1T')
  })

  it('with no brand in the payload the placeholders still read naturally', async () => {
    mockFetch([GOOD])
    const { container } = render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(container.querySelector('input[placeholder="Thanks for your message! One of the team will get back to you shortly."]')).toBeTruthy()
    expect(screen.getByText('Monthly Points target')).toBeTruthy()
  })
})

describe('CustomerAgentClient — a failed read (SETTINGSWIPE.1)', () => {
  it('a 500 shows Could not load + Try again, and NO Save', async () => {
    mockFetch([reply(500, { success: false, code: 'settings_unreadable', error: 'x' })])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('a network error is the same unknown state', async () => {
    mockFetch([new TypeError('Failed to fetch')])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
  })

  it('Try again re-reads, and a good read shows the editor with Save', async () => {
    mockFetch([reply(500, { success: false }), GOOD])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('a failed KNOWLEDGE read does not hide a good settings read', async () => {
    mockFetch([GOOD], { knowledgeFails: true })
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(screen.queryByText(NOTE)).toBeNull()
  })
})

describe('CustomerAgentClient — check-in day rollup (CHECKINSTALL.1)', () => {
  it('shows the day tally and the day before, by reason', async () => {
    const day = {
      day: '2026-09-30', ticks: 8, daytime_ticks: 5, failed_ticks: 0, candidates: 8, freeform: 0, templates: 1, skipped: 7,
      reasons: { human_active: 5, too_soon: 2 },
      previous: { day: '2026-09-29', ticks: 96, daytime_ticks: 44, failed_ticks: 1, candidates: 30, freeform: 0, templates: 0, skipped: 30, reasons: { human_active: 30 }, carry_failed: true },
    }
    mockFetch([reply(200, {
      success: true,
      settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, first_class_checkin: { enabled: true, daily_cap: 20 } },
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 1, total: 12, last: null, last_run: { at: '2026-09-30T09:00:00Z', checkins: null, day } },
    })])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(/^30 Sep: 5 daytime runs/)).toBeTruthy())
    expect(screen.getByText('30 Sep: 5 daytime runs · 8 candidate checks · 1 sent · 7 skipped (human active ×5, too soon ×2)')).toBeTruthy()
    expect(screen.getByText('29 Sep: 44 daytime runs · 30 candidate checks · 0 sent · 30 skipped (human active ×30) · 1 failed run (partial: an earlier run could not be read)')).toBeTruthy()
  })
})

describe('CustomerAgentClient — check-in day line plurals (CHECKINSTALL.1)', () => {
  const dayLine = (over) => ({ ticks: 1, failed_ticks: 0, freeform: 0, templates: 0, previous: null, ...over })
  function renderDay(day) {
    mockFetch([reply(200, {
      success: true,
      settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, first_class_checkin: { enabled: true, daily_cap: 20 } },
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: { at: '2026-10-01T09:00:00Z', checkins: null, day } },
    })])
    render(<CustomerAgentClient canEdit />)
  }

  it('one run and one candidate read in the singular', async () => {
    renderDay(dayLine({ day: '2026-10-01', daytime_ticks: 1, candidates: 1, skipped: 1, reasons: { too_soon: 1 } }))
    await waitFor(() => expect(screen.getByText(/^1 Oct:/)).toBeTruthy())
    expect(screen.getByText('1 Oct: 1 daytime run · 1 candidate check · 0 sent · 1 skipped (too soon ×1)')).toBeTruthy()
  })

  it('two runs and two candidates read in the plural', async () => {
    renderDay(dayLine({ day: '2026-10-01', daytime_ticks: 2, candidates: 2, skipped: 2, reasons: { too_soon: 2 } }))
    await waitFor(() => expect(screen.getByText(/^1 Oct:/)).toBeTruthy())
    expect(screen.getByText('1 Oct: 2 daytime runs · 2 candidate checks · 0 sent · 2 skipped (too soon ×2)')).toBeTruthy()
  })
})

// MIAROLE.1 (C80) — only an owner at the studio (or a master) may change Mia's
// settings. Everyone else who can open the page still reads them, with every
// settings control disabled and no Save. The knowledge editor is not part of
// this rule and stays as it was. `:disabled` (not `.disabled`, which reads only
// the element's own attribute) is what sees the disabled <fieldset> around it.
describe('CustomerAgentClient — read-only for a non-owner (MIAROLE.1)', () => {
  it('a non-owner sees the settings with no Save, every control disabled, and says why', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit={false} />)
    await waitFor(() => expect(screen.getByText(/Live — reply to all customers/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
    expect(screen.getByRole('checkbox', { name: /Live — reply to all customers/ }).matches(':disabled')).toBe(true)
    expect(screen.getByText('Only an owner can change these settings.')).toBeTruthy()
  })

  it('omitting canEdit fails closed (read-only)', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient />)
    await waitFor(() => expect(screen.getByText(/Live — reply to all customers/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /Save settings/ })).toBeNull()
  })

  it('an owner gets the working editor', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    expect(screen.getByRole('checkbox', { name: /Live — reply to all customers/ }).matches(':disabled')).toBe(false)
    expect(screen.queryByText('Only an owner can change these settings.')).toBeNull()
  })
})

// CHECKINRISKS.1 (C106 c) — the counts are SENDS; a failed read (null) says
// so and is never shown as 0.
describe('CustomerAgentClient — check-in counts (CHECKINRISKS.1)', () => {
  const withStats = (checkin_stats) => reply(200, {
    success: true,
    settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, first_class_checkin: { enabled: true, daily_cap: 20 } },
    location: { id: 'loc1', name: 'Test Studio' },
    checkin_stats,
  })

  it('shows the sends', async () => {
    mockFetch([withStats({ sent_today: 2, total: 7, last: null, last_run: null })])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('Sent today 2/20')).toBeTruthy())
    expect(screen.getByText(/Sent all time 7/)).toBeTruthy()
  })

  it('an unreadable count reads "could not be read", never 0', async () => {
    mockFetch([withStats({ sent_today: null, total: null, last: null, last_unreadable: true, last_run: null })])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('Sent today: could not be read')).toBeTruthy())
    expect(screen.getByText(/Sent all time could not be read/)).toBeTruthy()
    expect(screen.queryByText(/none yet/)).toBeNull()
  })
})

// TZ.5 — quiet hours with no stored zone are the studio's own clock: the
// editor names the studio's zone and never writes 'Europe/Dublin' itself.
describe('CustomerAgentClient — quiet hours follow the studio zone (TZ.5)', () => {
  const withQuiet = async (timezone, tz) => reply(200, {
    ...(await GOOD.json()),
    settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, quiet_hours: { start: '21:00', end: '08:00', ...(tz !== undefined ? { tz } : {}) } },
    location: { id: 'loc1', name: 'Test Studio', timezone },
  })
  const savedQuietHours = () => {
    const put = global.fetch.mock.calls.find(([url, init]) => String(url).startsWith('/api/settings/customer-agent') && init?.method === 'PUT')
    return JSON.parse(put[1].body).quiet_hours
  }

  it('a Dublin studio reads exactly as before', async () => {
    mockFetch([await withQuiet('Europe/Dublin')])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('Europe/Dublin — agent stays quiet, a human replies.')).toBeTruthy())
  })

  it('a New York studio names its own zone, and Save writes no zone of its own', async () => {
    mockFetch([await withQuiet('America/New_York')])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('America/New_York — agent stays quiet, a human replies.')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /Save settings/ })[0])
    await waitFor(() => expect(savedQuietHours()).toEqual({ start: '21:00', end: '08:00', tz: null }))
  })

  it('a stored zone is shown and kept on save', async () => {
    mockFetch([await withQuiet('America/New_York', 'Europe/Dublin')])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('Europe/Dublin — agent stays quiet, a human replies.')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /Save settings/ })[0])
    await waitFor(() => expect(savedQuietHours()).toEqual({ start: '21:00', end: '08:00', tz: 'Europe/Dublin' }))
  })
})

// MIAORG.1 Task 3 — inherited fields show their source, editing one makes it
// the studio's own, "Use organisation default" hands it back, and Save sends
// `overridden` so only the studio's own fields are stored (Review Focus 1).
describe('CustomerAgentClient — overrides and source tags (MIAORG.1 Task 3)', () => {
  const ORG = { tone: 'Org tone', extra_rules: 'Org rule', followups: { daily_cap: 80 } }
  const STUDIO = { enabled: true, tone: 'Studio tone' }
  function answer({ studio = STUDIO, org = ORG } = {}) {
    const { settings, sources } = mergeAgentSettings({ org, studio })
    return reply(200, {
      success: true,
      settings: { ...settings, social_enabled: false, glofox_auto_cancel: false },
      studio, org, sources,
      inherited: mergeAgentSettings({ org, studio: null }).settings,
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
    })
  }
  const labelRow = (text) => screen.getByText(text).parentElement
  const putBody = () => {
    const put = global.fetch.mock.calls.find(([url, init]) => String(url).startsWith('/api/settings/customer-agent') && init?.method === 'PUT')
    return put && JSON.parse(put[1].body)
  }
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
  const save = () => fireEvent.click(screen.getAllByRole('button', { name: /Save settings/ })[0])

  it('tags each inherited field with its source; the studio\'s own field offers the way back', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(labelRow('Extra rules (optional)')).getByText('Organisation default')).toBeTruthy()
    expect(within(labelRow('Hand-off message')).getByText('Default')).toBeTruthy()
    expect(within(labelRow('Tone & voice')).getByRole('button', { name: 'Use organisation default' })).toBeTruthy()
    // an org value fills the inherited field
    expect(screen.getByPlaceholderText('e.g. Never discuss competitor pricing.').value).toBe('Org rule')
  })

  it('studio-only fields carry no tag', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const signup = screen.getByText('Membership sign-up link').parentElement
    expect(within(signup).queryByText('Default')).toBeNull()
    expect(within(signup).queryByText('Organisation default')).toBeNull()
    expect(within(signup).queryByRole('button', { name: /Use/ })).toBeNull()
    // the on/off switch sits straight in the section, with no tag beside it
    const live = screen.getByRole('checkbox', { name: /Live — reply to all customers/ }).closest('label')
    expect(live.parentElement.tagName).toBe('SECTION')
    expect(live.nextElementSibling?.textContent).not.toMatch(/^(Default|Organisation default|Use (organisation )?default)$/)
  })

  it('saving without touching inherited fields sends only the studio\'s own', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toEqual(['tone'])
  })

  it('editing an inherited field marks just it as the studio\'s own', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    fireEvent.change(screen.getByPlaceholderText('e.g. Never discuss competitor pricing.'), { target: { value: 'Studio rule' } })
    expect(within(labelRow('Extra rules (optional)')).getByRole('button', { name: 'Use organisation default' })).toBeTruthy()
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toEqual(['extra_rules', 'tone'])
    expect(putBody().extra_rules).toBe('Studio rule')
  })

  it('an object field is overridden per field', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(screen.getByText('Enable proactive follow-ups').closest('label').parentElement).getByText('Default')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable proactive follow-ups' }))
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toEqual(['followups.enabled', 'tone'])
    // the inherited cap is sent for display parity but not overridden
    expect(putBody().followups.daily_cap).toBe(80)
  })

  it('"Use organisation default" removes the override and shows the inherited value', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const tone = screen.getByPlaceholderText('e.g. Warm, upbeat, brief. Use first names. No emojis.')
    expect(tone.value).toBe('Studio tone')
    fireEvent.click(within(labelRow('Tone & voice')).getByRole('button', { name: 'Use organisation default' }))
    expect(tone.value).toBe('Org tone')
    expect(within(labelRow('Tone & voice')).getByText('Organisation default')).toBeTruthy()
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toEqual([])
    // the studio-only switches still go in the body (the PUT always saves them)
    expect(putBody()).toMatchObject({ enabled: true, test_mode: false })
  })

  it('a studio value with no org value behind it offers "Use default"', async () => {
    mockFetch([answer({ org: null })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(labelRow('Tone & voice')).getByRole('button', { name: 'Use default' })).toBeTruthy()
    expect(within(labelRow('Extra rules (optional)')).getByText('Default')).toBeTruthy()
  })

  it('T3-D: a legacy full blob marks every value it stores, so the first Save keeps all of it', async () => {
    const legacy = buildCustomerAgentSettings(SettingsSchema.parse({
      enabled: true, tone: 'Warm', handoff_cooldown_hours: 0, monthly_points_target: 600,
      followups: { enabled: true, nudge_after_hours: 4, template_name: 'nudge_v2', daily_cap: 40 },
      quiet_hours: { start: '21:00', end: '07:00' },
    }))
    mockFetch([answer({ studio: legacy, org: null })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toEqual(initialOverridden(legacy))
    expect(putBody().overridden).toEqual(expect.arrayContaining([
      'tone', 'agent_name', 'handoff_cooldown_hours',
      'followups.enabled', 'followups.nudge_after_hours', 'followups.template_name', 'followups.daily_cap',
      'quiet_hours.start', 'quiet_hours.end', 'inline_suggestion.enabled',
    ]))
    // studio-only since the final review: always in the body, never an override path
    expect(putBody().overridden).not.toContain('monthly_points_target')
    expect(putBody().monthly_points_target).toBe(600)
  })

  it('a studio with no blob (Hatch) overrides nothing until someone edits', async () => {
    mockFetch([answer({ studio: null })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toEqual([])
  })

  it('after a save the settings are re-read, so the tags show what was stored', async () => {
    // GET (studio tone) -> PUT ok -> GET again (the studio dropped its tone)
    mockFetch([answer(), reply(200, { success: true, settings: { enabled: true } }), answer({ studio: { enabled: true } })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(labelRow('Tone & voice')).getByRole('button', { name: 'Use organisation default' })).toBeTruthy()
    save()
    await waitFor(() => expect(within(labelRow('Tone & voice')).getByText('Organisation default')).toBeTruthy())
    expect(screen.getByPlaceholderText('e.g. Warm, upbeat, brief. Use first names. No emojis.').value).toBe('Org tone')
  })

  it('"Use organisation default" on quiet hours clears start, end and tz together', async () => {
    const studio = { enabled: true, quiet_hours: { start: '21:00', end: '07:00', tz: 'America/New_York' } }
    mockFetch([answer({ studio, org: null })])
    const { container } = render(<CustomerAgentClient canEdit />)
    await ready()
    const [start, end] = container.querySelectorAll('input[type="time"]')
    expect(start.value).toBe('21:00')
    expect(screen.getByText('America/New_York — agent stays quiet, a human replies.')).toBeTruthy()
    fireEvent.click(within(labelRow('Quiet hours (optional)')).getByRole('button', { name: 'Use default' }))
    expect(start.value).toBe('')
    expect(end.value).toBe('')
    expect(within(labelRow('Quiet hours (optional)')).getByText('Default')).toBeTruthy()
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toEqual([])
    expect(putBody().quiet_hours).toBe(null)
  })

  it('quiet hours revert to the org\'s pair, and the tag needs a set org FIELD, not just the key', async () => {
    const studio = { enabled: true, quiet_hours: { start: '21:00', end: '07:00', tz: 'America/New_York' } }
    mockFetch([answer({ studio, org: { quiet_hours: { start: '22:00', end: '06:00', tz: null } } })])
    const { container } = render(<CustomerAgentClient canEdit />)
    await ready()
    fireEvent.click(within(labelRow('Quiet hours (optional)')).getByRole('button', { name: 'Use organisation default' }))
    const [start, end] = container.querySelectorAll('input[type="time"]')
    expect([start.value, end.value]).toEqual(['22:00', '06:00'])
    expect(within(labelRow('Quiet hours (optional)')).getByText('Organisation default')).toBeTruthy()
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden.filter(p => p.startsWith('quiet_hours'))).toEqual([])
  })

  it('an org quiet_hours object with no field set does not count as an org value', async () => {
    const studio = { enabled: true, quiet_hours: { start: '21:00', end: '07:00' } }
    mockFetch([answer({ studio, org: { quiet_hours: { start: null, end: null, tz: null } } })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(labelRow('Quiet hours (optional)')).getByRole('button', { name: 'Use default' })).toBeTruthy()
  })

  it('a cleared follow-up cap shows the inherited value as its placeholder and is left out of the PUT', async () => {
    mockFetch([answer()])
    const { container } = render(<CustomerAgentClient canEdit />)
    await ready()
    const caps = [...container.querySelectorAll('input[type="number"][max="500"]')]
    expect(caps).toHaveLength(1)
    fireEvent.change(caps[0], { target: { value: '' } })
    expect(caps[0].value).toBe('')
    expect(caps[0].placeholder).toBe('80')
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().followups).not.toHaveProperty('daily_cap')
  })

  it('a read-only viewer sees the tags but no way back', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit={false} />)
    await waitFor(() => expect(screen.getByText(/Live — reply to all customers/)).toBeTruthy())
    expect(within(labelRow('Extra rules (optional)')).getByText('Organisation default')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use organisation default' })).toBeNull()
  })
})

// MIAORG.1 Task 4 (T4-A) — "No quiet hours (ignore the organisation's)": null
// cannot say "none" once the org sets quiet hours, so the studio stores
// quiet_hours.off. And the organisation defaults section, for org admins.
describe('CustomerAgentClient — quiet hours opt-out and org defaults (MIAORG.1 Task 4)', () => {
  const ORG_QUIET = { quiet_hours: { start: '22:00', end: '07:00' } }
  function answer({ studio = { enabled: true }, org = ORG_QUIET } = {}) {
    const { settings, sources } = mergeAgentSettings({ org, studio })
    return reply(200, {
      success: true,
      settings: { ...settings, social_enabled: false, glofox_auto_cancel: false },
      studio, org, sources,
      inherited: mergeAgentSettings({ org, studio: null }).settings,
      location: { id: 'loc1', name: 'Test Studio', timezone: 'Europe/Dublin' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
    })
  }
  const putBody = () => {
    const put = global.fetch.mock.calls.find(([url, init]) => String(url) === '/api/settings/customer-agent' && init?.method === 'PUT')
    return put && JSON.parse(put[1].body)
  }
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
  const save = () => fireEvent.click(screen.getAllByRole('button', { name: /Save settings/ })[0])
  const optOut = () => screen.getByRole('checkbox', { name: "No quiet hours (ignore the organisation's)" })

  it('ticking it clears the window and saves quiet_hours.off alone', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const start = screen.getByLabelText('Quiet hours start')
    expect(start.value).toBe('22:00')
    fireEvent.click(optOut())
    expect(start.value).toBe('')
    expect(start.disabled).toBe(true)
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().quiet_hours).toEqual({ off: true })
    expect(putBody().overridden).toEqual(['quiet_hours.off'])
  })

  it('a studio that stored the opt-out shows it ticked and keeps it on the next save', async () => {
    mockFetch([answer({ studio: { enabled: true, quiet_hours: { off: true } } })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(optOut().checked).toBe(true)
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().quiet_hours).toEqual({ off: true })
    expect(putBody().overridden).toEqual(['quiet_hours.off'])
  })

  it('"Use organisation default" clears the opt-out too', async () => {
    mockFetch([answer({ studio: { enabled: true, quiet_hours: { off: true } } })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    fireEvent.click(within(screen.getByText('Quiet hours (optional)').parentElement).getByRole('button', { name: 'Use organisation default' }))
    expect(optOut().checked).toBe(false)
    expect(screen.getByLabelText('Quiet hours start').value).toBe('22:00')
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden.filter((p) => p.startsWith('quiet_hours'))).toEqual([])
  })

  it('unticking it hands the window back to the organisation', async () => {
    mockFetch([answer({ studio: { enabled: true, quiet_hours: { off: true } } })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    fireEvent.click(optOut())
    expect(screen.getByLabelText('Quiet hours end').value).toBe('07:00')
    save()
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toEqual([])
  })

  it('no org defaults section without orgDefaults (everyone but masters and org admins)', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.queryByText('Organisation defaults (all studios)')).toBeNull()
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/customer-agent/org'))).toBe(false)
  })

  it('with orgDefaults the section renders, and an org save re-reads what the studio inherits', async () => {
    const ORG_ID = 'a0000000-0000-0000-0000-00000000a0a1'
    let studioReads = 0
    global.fetch = vi.fn(async (url, init) => {
      const u = String(url)
      if (u.startsWith('/api/settings/customer-agent/org')) {
        const raw = init?.method === 'PUT' ? { tone: 'New org tone' } : null
        return reply(200, { success: true, data: { organization: { id: ORG_ID, name: 'Org A' }, settings: { ...mergeAgentSettings({ org: raw }).settings }, raw, defaults: DEFAULTS, studios: [] } })
      }
      if (u.startsWith('/api/settings/customer-agent')) {
        studioReads += 1
        return studioReads === 1 ? answer({ org: null }) : answer({ org: { tone: 'New org tone' } })
      }
      if (u.startsWith('/api/agent/knowledge')) return reply(200, { success: true, entries: [] })
      return reply(200, { success: true, templates: [] })
    })
    const { container } = render(<CustomerAgentClient canEdit orgDefaults={{ organizationId: ORG_ID, organizationName: 'Org A' }} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save organisation defaults' })).toBeTruthy())
    expect(screen.getByRole('heading', { name: 'Organisation defaults (all studios)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save organisation defaults' }))
    await waitFor(() => expect(studioReads).toBe(2))
    // the studio's own tone field (not the org one) now shows the new org value
    const toneInputs = [...container.querySelectorAll('textarea[placeholder="e.g. Warm, upbeat, brief. Use first names. No emojis."]')]
    await waitFor(() => expect(toneInputs.at(-1).value).toBe('New org tone'))
  })
})

// MIAORG.1 Task 4 fix round — a studio edit made while an ORG save is in
// flight survives the re-read that follows it; a half quiet-hours window
// holds Save.
describe('CustomerAgentClient — fix round (MIAORG.1 Task 4)', () => {
  const ORG_ID = 'a0000000-0000-0000-0000-00000000a0a1'
  const TONE_PH = 'e.g. Warm, upbeat, brief. Use first names. No emojis.'
  function studioAnswer(org) {
    const studio = { enabled: true }
    const { settings, sources } = mergeAgentSettings({ org, studio })
    return reply(200, {
      success: true,
      settings: { ...settings, social_enabled: false, glofox_auto_cancel: false },
      studio, org, sources,
      inherited: mergeAgentSettings({ org, studio: null }).settings,
      location: { id: 'loc1', name: 'Test Studio', timezone: 'Europe/Dublin' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
    })
  }
  const orgState = (raw) => reply(200, { success: true, data: { organization: { id: ORG_ID, name: 'Org A' }, settings: mergeAgentSettings({ org: raw }).settings, raw, defaults: DEFAULTS, studios: [] } })

  it('a studio field edited while the org save is pending keeps the edit and stays overridden', async () => {
    let studioReads = 0
    let releasePut
    const putGate = new Promise((resolve) => { releasePut = resolve })
    global.fetch = vi.fn(async (url, init) => {
      const u = String(url)
      if (u.startsWith('/api/settings/customer-agent/org')) {
        if (init?.method === 'PUT') { await putGate; return orgState({ tone: 'New org tone' }) }
        return orgState(null)
      }
      if (u === '/api/settings/customer-agent' && init?.method === 'PUT') return reply(200, { success: true, settings: {} })
      if (u.startsWith('/api/settings/customer-agent')) {
        studioReads += 1
        return studioAnswer(studioReads === 1 ? null : { tone: 'New org tone' })
      }
      if (u.startsWith('/api/agent/knowledge')) return reply(200, { success: true, entries: [] })
      return reply(200, { success: true, templates: [] })
    })
    const { container } = render(<CustomerAgentClient canEdit orgDefaults={{ organizationId: ORG_ID, organizationName: 'Org A' }} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save organisation defaults' })).toBeTruthy())
    const tones = () => [...container.querySelectorAll(`textarea[placeholder="${TONE_PH}"]`)]
    // org tone first (the section sits above), the studio's last
    fireEvent.change(tones()[0], { target: { value: 'New org tone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save organisation defaults' }))
    // while the org PUT is in flight, the operator edits the STUDIO's tone
    fireEvent.change(tones().at(-1), { target: { value: 'My studio tone' } })
    await act(async () => { releasePut() })
    await waitFor(() => expect(studioReads).toBe(2))
    await waitFor(() => expect(within(screen.getByText('Tone & voice').parentElement).getByRole('button', { name: 'Use organisation default' })).toBeTruthy())
    expect(tones().at(-1).value).toBe('My studio tone')
    fireEvent.click(screen.getAllByRole('button', { name: /Save settings/ })[0])
    await waitFor(() => expect(global.fetch.mock.calls.some(([u, i]) => String(u) === '/api/settings/customer-agent' && i?.method === 'PUT')).toBe(true))
    const [, init] = global.fetch.mock.calls.find(([u, i]) => String(u) === '/api/settings/customer-agent' && i?.method === 'PUT')
    const body = JSON.parse(init.body)
    expect(body.tone).toBe('My studio tone')
    expect(body.overridden).toContain('tone')
  })

  it('a half-entered quiet-hours window says "Set both times" and holds Save', async () => {
    mockFetch([studioAnswer(null)])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:00' } })
    expect(screen.getByText('Set both times')).toBeTruthy()
    for (const b of screen.getAllByRole('button', { name: /Save settings/ })) expect(b.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '07:00' } })
    expect(screen.queryByText('Set both times')).toBeNull()
    for (const b of screen.getAllByRole('button', { name: /Save settings/ })) expect(b.disabled).toBe(false)
  })
})

describe('CustomerAgentClient — booking link fields (MIAORG.1 final review)', () => {
  function answer({ bookings, studio = { enabled: true } } = {}) {
    const { settings, sources } = mergeAgentSettings({ org: null, studio })
    return reply(200, {
      success: true,
      settings: { ...settings, social_enabled: false, glofox_auto_cancel: false },
      studio, org: null, sources,
      inherited: mergeAgentSettings({ org: null, studio: null }).settings,
      ...(bookings === undefined ? {} : { bookings }),
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
    })
  }
  const puts = () => global.fetch.mock.calls.filter(([url, init]) => String(url).startsWith('/api/settings/customer-agent') && init?.method === 'PUT')
  const putBody = () => { const p = puts()[0]; return p && JSON.parse(p[1].body) }
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
  const saveButton = () => screen.getAllByRole('button', { name: /Save settings/ })[0]

  it('a studio that takes no bookings shows the fields; an edit goes into the PUT body', async () => {
    mockFetch([answer({ bookings: false }), reply(200, { success: true, settings: {} }), answer({ bookings: false })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByText('Mia sends this link when a customer wants to book.', { exact: false })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Booking link'), { target: { value: ' https://book.example.test/hatch ' } })
    fireEvent.change(screen.getByLabelText('Booking button label'), { target: { value: 'Book now' } })
    expect(screen.getByLabelText('Booking button label').getAttribute('placeholder')).toBe('Book a class')
    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody()).toMatchObject({ booking_url: 'https://book.example.test/hatch', booking_cta_label: 'Book now' })
    // studio-only: never an override path, always saved
    expect(putBody().overridden).not.toContain('booking_url')
  })

  it('a blank link saves null', async () => {
    mockFetch([answer({ bookings: false, studio: { enabled: true, booking_url: 'https://old.example.test' } }), reply(200, { success: true, settings: {} })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByLabelText('Booking link').value).toBe('https://old.example.test')
    fireEvent.change(screen.getByLabelText('Booking link'), { target: { value: '   ' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().booking_url).toBe(null)
    expect(putBody().booking_cta_label).toBe(null)
  })

  it('an invalid link shows inline and holds Save', async () => {
    mockFetch([answer({ bookings: false })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    fireEvent.change(screen.getByLabelText('Booking link'), { target: { value: 'javascript:alert(1)' } })
    expect(screen.getByText('Enter a full link starting with https:// (or http://).')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Booking link'), { target: { value: 'https://ok.example.test' } })
    expect(screen.queryByText('Enter a full link starting with https:// (or http://).')).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })

  it("the PUT's 400 on a booking field shows beside it", async () => {
    mockFetch([answer({ bookings: false }), reply(400, { success: false, error: 'Invalid request body', issues: [{ path: 'booking_cta_label', message: 'Too long' }] })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    fireEvent.click(saveButton())
    await waitFor(() => expect(screen.getByText('Too long')).toBeTruthy())
  })

  it('a studio that takes bookings (Glofox) does not show them; a stored link is still echoed on Save', async () => {
    mockFetch([answer({ bookings: true, studio: { enabled: true, booking_url: 'https://kept.example.test' } }), reply(200, { success: true, settings: {} })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.queryByLabelText('Booking link')).toBeNull()
    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().booking_url).toBe('https://kept.example.test')
  })

  it('an older GET without `bookings` shows the fields (never hides a link)', async () => {
    mockFetch([answer({})])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByLabelText('Booking link')).toBeTruthy()
  })

  it('the monthly points target is the studio\'s own: no source tag, edited and saved as typed', async () => {
    mockFetch([answer({ bookings: true, studio: { enabled: true, monthly_points_target: 3000 } }), reply(200, { success: true, settings: {} })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const row = screen.getByText('Monthly Points target').parentElement
    expect(within(row).queryByRole('button')).toBeNull()
    const input = row.querySelector('input[type="number"]')
    expect(input.value).toBe('3000')
    fireEvent.change(input, { target: { value: '3500' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().monthly_points_target).toBe(3500)
  })
})

describe('CustomerAgentClient — Hatch payments and booking copy (MIAHATCH.4)', () => {
  function answer({ membership_source_key, studio = { enabled: true }, org = null } = {}) {
    const { settings, sources } = mergeAgentSettings({ org, studio })
    return reply(200, {
      success: true,
      settings: { ...settings, social_enabled: false, glofox_auto_cancel: false },
      studio, org, sources,
      inherited: mergeAgentSettings({ org, studio: null }).settings,
      ...(membership_source_key === undefined ? {} : { membership_source_key }),
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
    })
  }
  const puts = () => global.fetch.mock.calls.filter(([url, init]) => String(url).startsWith('/api/settings/customer-agent') && init?.method === 'PUT')
  const putBody = () => { const p = puts()[0]; return p && JSON.parse(p[1].body) }
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
  const GROUP = 'Hatch payments and booking'

  it('a un1t.online studio shows the group with every field and the code defaults as placeholders', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByText(GROUP)).toBeTruthy()
    const group = screen.getByTestId('hatch-copy-group')
    expect(group.querySelectorAll('input:not([type="checkbox"])').length).toBe(12)
    expect(within(group).getByPlaceholderText('Thanks! You can go back to WhatsApp now.')).toBeTruthy()
    expect(within(group).getByPlaceholderText("Here's your secure payment link for {product}. Once it goes through I'll book you into {class}.")).toBeTruthy()
  })

  it('no dash (em or en) in the group\'s labels, help or placeholders', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const group = screen.getByTestId('hatch-copy-group')
    expect(group.textContent).not.toMatch(/[—–]/)
    for (const input of group.querySelectorAll('input:not([type="checkbox"])')) expect(input.getAttribute('placeholder')).not.toMatch(/[—–]/)
  })

  it('a Glofox studio, no source, or an older GET shows no group', async () => {
    for (const key of ['glofox', 'none', undefined]) {
      mockFetch([answer({ membership_source_key: key })])
      const { unmount } = render(<CustomerAgentClient canEdit />)
      await ready()
      expect(screen.queryByText(GROUP), String(key)).toBeNull()
      expect(screen.queryByTestId('hatch-copy-group'), String(key)).toBeNull()
      unmount()
    }
  })

  it('an edit is the studio\'s own and goes into the PUT body; a blank is null', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' }), reply(200, { success: true, settings: {} }), answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    fireEvent.change(screen.getByPlaceholderText('Thanks! You can go back to WhatsApp now.'), { target: { value: '  All done, back to WhatsApp.  ' } })
    fireEvent.click(screen.getAllByRole('button', { name: /Save settings/ })[0])
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().overridden).toContain('pay_done_page_text')
    expect(putBody().pay_done_page_text).toBe('All done, back to WhatsApp.')
    expect(putBody().pay_cancel_page_text).toBe(null)
  })

  it('an organisation value is shown as inherited', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online', org: { refund_request_text: 'Org refund text.' } })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const group = screen.getByTestId('hatch-copy-group')
    expect(within(group).getByDisplayValue('Org refund text.')).toBeTruthy()
    expect(within(screen.getByText('Refund request message').parentElement).getByText('Organisation default')).toBeTruthy()
  })

  // MIAHATCH.4 (Task 14) — "What Mia can sell" mounts in the same gate, and the
  // booking link fields stay for a un1t.online studio even though its source
  // takes bookings (Mia books there, but a link remains the fallback).
  function withOffers() {
    const real = global.fetch
    global.fetch = vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/locations/loc1/mia-offers')) {
        return reply(200, { success: true, data: { offers: [], products: [{ id: 'p1', title: '1 Class Credit', price_cents: 1500, interval: null, private: false }] } })
      }
      return real(url, init)
    })
  }

  it('a un1t.online studio shows What Mia can sell, reading its own location\'s offers', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    withOffers()
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByText('What Mia can sell')).toBeTruthy()
    await screen.findByTestId('offer-picker')
    expect(global.fetch.mock.calls.some(([u]) => String(u) === '/api/locations/loc1/mia-offers')).toBe(true)
  })

  it('a non-owner sees the offer list without controls', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    withOffers()
    render(<CustomerAgentClient canEdit={false} />)
    await waitFor(() => expect(screen.getByText('What Mia can sell')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('No offers yet. Mia will not offer to sell anything.')).toBeTruthy())
    expect(screen.queryByTestId('offer-picker')).toBeNull()
  })

  it('a Glofox studio, no source, or an older GET shows no offers section and never fetches it', async () => {
    for (const key of ['glofox', 'none', undefined]) {
      mockFetch([answer({ membership_source_key: key })])
      withOffers()
      const { unmount } = render(<CustomerAgentClient canEdit />)
      await ready()
      expect(screen.queryByText('What Mia can sell'), String(key)).toBeNull()
      expect(global.fetch.mock.calls.some(([u]) => String(u).includes('mia-offers')), String(key)).toBe(false)
      unmount()
    }
  })

  it('the booking link fields stay visible at a un1t.online studio even when bookings is true', async () => {
    mockFetch([reply(200, {
      ...(await answer({ membership_source_key: 'un1t_online' }).json()),
      bookings: true,
    })])
    withOffers()
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByLabelText('Booking link')).toBeTruthy()
    expect(screen.getByLabelText('Booking button label')).toBeTruthy()
  })

  // MIAHATCH.5 (Ruling 25) — Mia's switch for booking, cancelling and taking
  // payments in chat at this studio. Off unless ticked; saved with the studio.
  const SWITCH = 'Mia can book and cancel classes, send payment links and pass refund requests to the team in chat at this studio'

  it('the Hatch group carries the chat actions switch, unticked by default, no dash in its words', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const group = screen.getByTestId('hatch-copy-group')
    const box = within(group).getByLabelText(SWITCH)
    expect(box.type).toBe('checkbox')
    expect(box.checked).toBe(false)
    expect(group.textContent).not.toMatch(/[—–]/)
    // MIAHATCH.6 — the help under it says payment links too.
    expect(group.textContent).toMatch(/sends payment links for the offers listed under What Mia can sell/)
  })

  it('a stored true shows ticked; ticking it puts true in the PUT body, unticking false', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' }), reply(200, { success: true, settings: {} }), answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    fireEvent.click(screen.getByLabelText(SWITCH))
    fireEvent.click(screen.getAllByRole('button', { name: /Save settings/ })[0])
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().un1t_chat_actions_enabled).toBe(true)
  })

  it('a stored true is shown ticked and saved false when unticked', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online', studio: { enabled: true, un1t_chat_actions_enabled: true } }), reply(200, { success: true, settings: {} }), answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const box = screen.getByLabelText(SWITCH)
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    fireEvent.click(screen.getAllByRole('button', { name: /Save settings/ })[0])
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().un1t_chat_actions_enabled).toBe(false)
  })

  it('a Glofox studio never shows the switch', async () => {
    mockFetch([answer({ membership_source_key: 'glofox' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.queryByLabelText(SWITCH)).toBeNull()
  })

  it('every button in the editor\'s form-like surface is typed', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    const { container } = render(<CustomerAgentClient canEdit />)
    await ready()
    for (const b of container.querySelectorAll('[data-testid="hatch-copy-group"] button')) expect(b.getAttribute('type')).toBe('button')
  })
})

// TRIALDONE.3 — the trial-finisher card: studio-only, a un1t.online studio only.
describe('CustomerAgentClient — trial finisher card (TRIALDONE.3)', () => {
  function answer({ membership_source_key, studio = { enabled: true }, org = null } = {}) {
    const { settings, sources } = mergeAgentSettings({ org, studio })
    return reply(200, {
      success: true,
      settings: { ...settings, social_enabled: false, glofox_auto_cancel: false },
      studio, org, sources,
      inherited: mergeAgentSettings({ org, studio: null }).settings,
      ...(membership_source_key === undefined ? {} : { membership_source_key }),
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
    })
  }
  const puts = () => global.fetch.mock.calls.filter(([url, init]) => String(url).startsWith('/api/settings/customer-agent') && init?.method === 'PUT')
  const putBody = () => { const p = puts()[0]; return p && JSON.parse(p[1].body) }
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /Save settings/ }).length).toBeGreaterThan(0))
  const saveButton = () => screen.getAllByRole('button', { name: /Save settings/ })[0]
  const TITLE = 'Trial finisher follow-up'
  const ID_A = '11111111-1111-4111-8111-111111111111'

  it('shows at a un1t.online studio, off, with both template names, the delay and the default instruction as placeholder', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByText(TITLE)).toBeTruthy()
    const card = screen.getByTestId('trial-done-card')
    expect(within(card).getByLabelText('Enable trial finisher follow-up').checked).toBe(false)
    expect(within(card).getByLabelText('Opener template').value).toBe('hatch_trial_done_checkin')
    expect(within(card).getByLabelText('Follow-up template').value).toBe('hatch_trial_done_followup')
    expect(within(card).getByLabelText('Send after (hours)').value).toBe('2')
    expect(within(card).getByLabelText("Mia's instruction").getAttribute('placeholder')).toBe(TRIAL_DONE_MIA_INSTRUCTION_DEFAULT)
    expect(card.textContent).not.toMatch(/[\u2014\u2013]/)
  })

  // TRIALDONE.7 — the card says who gets it, and what the delay counts from.
  it('describes the trigger as 3 trial classes, or 2 and an expired trial, timed from the trial ending', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const card = screen.getByTestId('trial-done-card')
    expect(card.textContent).toContain('has done 3 trial classes, or 2 classes and the trial has expired')
    expect(card.textContent).toContain('Hours after the trial ends')
    expect(card.textContent).not.toContain('attends their second class')
    expect(card.textContent).not.toContain('Hours after their last class')
  })

  it('a Glofox studio, no source, or an older GET shows no card', async () => {
    for (const key of ['glofox', 'none', undefined]) {
      mockFetch([answer({ membership_source_key: key })])
      const { unmount } = render(<CustomerAgentClient canEdit />)
      await ready()
      expect(screen.queryByText(TITLE), String(key)).toBeNull()
      expect(screen.queryByTestId('trial-done-card'), String(key)).toBeNull()
      unmount()
    }
  })

  it('an edit goes into the PUT body as the studio\'s own block', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' }), reply(200, { success: true, settings: {} }), answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const card = screen.getByTestId('trial-done-card')
    fireEvent.click(within(card).getByLabelText('Enable trial finisher follow-up'))
    fireEvent.change(within(card).getByLabelText('Opener template'), { target: { value: 'my_opener' } })
    fireEvent.change(within(card).getByLabelText('Send after (hours)'), { target: { value: '6' } })
    fireEvent.change(within(card).getByLabelText("Mia's instruction"), { target: { value: 'Help them carry on.' } })
    fireEvent.change(within(card).getByLabelText('Test contact ids'), { target: { value: ID_A } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().trial_done).toMatchObject({
      enabled: true, opener_template: 'my_opener', delay_hours: 6, mia_instruction: 'Help them carry on.', only_contact_ids: [ID_A],
      followup_template: 'hatch_trial_done_followup',
    })
  })

  it('a stored block is shown, and a test list is flagged as a test', async () => {
    const studio = { enabled: true, trial_done: { ...DEFAULTS.trial_done, enabled: true, opener_template: 'stored_opener', only_contact_ids: [ID_A] } }
    mockFetch([answer({ membership_source_key: 'un1t_online', studio })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const card = screen.getByTestId('trial-done-card')
    expect(within(card).getByLabelText('Enable trial finisher follow-up').checked).toBe(true)
    expect(within(card).getByLabelText('Opener template').value).toBe('stored_opener')
    expect(within(card).getByLabelText('Test contact ids').value).toBe(ID_A)
    expect(within(card).getByText('Test: 1 contact only')).toBeTruthy()
  })

  it('an organisation value never reaches the card', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online', org: { trial_done: { enabled: true, daily_cap: 99 } } })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(screen.getByTestId('trial-done-card')).getByLabelText('Enable trial finisher follow-up').checked).toBe(false)
  })

  it('an invalid value is named beside its field and holds Save; an em-dash is refused', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const card = screen.getByTestId('trial-done-card')
    expect(saveButton().disabled).toBe(false)
    fireEvent.change(within(card).getByLabelText('Opener template'), { target: { value: 'Has Caps' } })
    expect(within(card).getByText(/lowercase letters, numbers and underscores/)).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(within(card).getByLabelText('Opener template'), { target: { value: 'ok_name' } })
    expect(saveButton().disabled).toBe(false)
    fireEvent.change(within(card).getByLabelText("Mia's instruction"), { target: { value: 'Hi \u2014 there' } })
    expect(within(card).getByText(/No em-dashes/)).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
  })

  it('is read-only without edit rights, and every button in it is typed', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    const { container } = render(<CustomerAgentClient canEdit={false} />)
    await waitFor(() => expect(screen.getByTestId('trial-done-card')).toBeTruthy())
    expect(screen.getByTestId('trial-done-card').closest('fieldset').disabled).toBe(true)
    for (const b of container.querySelectorAll('[data-testid="trial-done-card"] button')) expect(b.getAttribute('type')).toBe('button')
  })
})
