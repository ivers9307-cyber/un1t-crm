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
import { fieldsFor } from './fields'

// MIASETTINGS.3b — a follow-up card folded while its switch is off keeps its
// details behind "Show settings"; open every folded card (in `scope`).
function showAllSettings(scope = screen) {
  for (const b of scope.queryAllByRole('button', { name: 'Show settings', hidden: true })) fireEvent.click(b)
}

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

// MIASETTINGS.2c — the page shows one section at a time; every section stays
// mounted and the others are `hidden`, which role queries skip. A test that
// reaches a field by role opens its section first, by its menu item.
const openSection = (name) => fireEvent.click(screen.getByRole('button', { name }))

// The section link lives in the URL; put it back so one test's section does
// not open the next test's page somewhere else.
afterEach(() => { cleanup(); delete global.fetch; window.history.replaceState(null, '', '/') })

// MIASETTINGS.3a — Messages rows start folded: open one by its label.
const openRow = (label) => fireEvent.click(screen.getAllByRole('button', { expanded: false, hidden: true }).find((b) => (b.textContent || '').startsWith(label)))

describe('CustomerAgentClient — placeholders carry the brand (W1.S3)', () => {
  it('renders the hand-off and welcome defaults and the Points label from the GET brand', async () => {
    mockFetch([reply(200, { ...(await GOOD.json()), brand: { companyName: 'Gym A', shortName: 'GA' } })])
    const { container } = render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
    // MIASETTINGS.3a — a folded row previews its default.
    const previews = [...container.querySelectorAll('[data-testid="message-preview"]')].map((n) => n.textContent)
    expect(container.querySelector('input[placeholder="Thanks for your message! One of the Gym A team will get back to you shortly."]')).toBeTruthy()
    expect(previews.some((t) => t.startsWith("Hi, I'm Mia, the studio's assistant at Gym A."))).toBe(true)
    expect(screen.getByText('Monthly GA Points target')).toBeTruthy()
    expect(container.textContent).not.toContain('UN1T')
  })

  it('with no brand in the payload the placeholders still read naturally', async () => {
    mockFetch([GOOD])
    const { container } = render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
    expect(container.querySelector('input[placeholder="Thanks for your message! One of the team will get back to you shortly."]')).toBeTruthy()
    expect(screen.getByText('Monthly Points target')).toBeTruthy()
  })
})

describe('CustomerAgentClient — a failed read (SETTINGSWIPE.1)', () => {
  it('a 500 shows Could not load + Try again, and NO Save', async () => {
    mockFetch([reply(500, { success: false, code: 'settings_unreadable', error: 'x' })])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Save( settings)?$/ })).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('a network error is the same unknown state', async () => {
    mockFetch([new TypeError('Failed to fetch')])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Save( settings)?$/ })).toBeNull()
  })

  it('Try again re-reads, and a good read shows the editor with Save', async () => {
    mockFetch([reply(500, { success: false }), GOOD])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText(NOTE)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('a failed KNOWLEDGE read does not hide a good settings read', async () => {
    mockFetch([GOOD], { knowledgeFails: true })
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
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
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Mia is' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Save( settings)?$/ })).toBeNull()
    expect(screen.getByRole('radio', { name: 'Live' }).matches(':disabled')).toBe(true)
    expect(screen.getByText("Only an owner can change Mia's settings here.")).toBeTruthy()
  })

  it('omitting canEdit fails closed (read-only)', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient />)
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Mia is' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Save( settings)?$/ })).toBeNull()
  })

  it('an owner gets the working editor', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
    expect(screen.getByRole('radio', { name: 'Live' }).matches(':disabled')).toBe(false)
    expect(screen.queryByText("Only an owner can change Mia's settings here.")).toBeNull()
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
    await waitFor(() => expect(screen.getByText('Europe/Dublin. The agent stays quiet and a human replies.')).toBeTruthy())
  })

  it('a New York studio names its own zone, and Save writes no zone of its own', async () => {
    mockFetch([await withQuiet('America/New_York')])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('America/New_York. The agent stays quiet and a human replies.')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])
    await waitFor(() => expect(savedQuietHours()).toEqual({ start: '21:00', end: '08:00', tz: null }))
  })

  it('a stored zone is shown and kept on save', async () => {
    mockFetch([await withQuiet('America/New_York', 'Europe/Dublin')])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getByText('Europe/Dublin. The agent stays quiet and a human replies.')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])
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
  // A field's label row. Labels only: Mia's voices (Personality and voice)
  // name a voice kind "Hand-off message" too.
  const labelRow = (text) => screen.getByText(text, { selector: 'label' }).parentElement
  const putBody = () => {
    const put = global.fetch.mock.calls.find(([url, init]) => String(url).startsWith('/api/settings/customer-agent') && init?.method === 'PUT')
    return put && JSON.parse(put[1].body)
  }
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
  const save = () => fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])

  it('tags each inherited field with its source; the studio\'s own field offers the way back', async () => {
    mockFetch([answer()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    openSection('Personality and voice')
    expect(within(labelRow('Extra rules (optional)')).getByText('Organisation default')).toBeTruthy()
    expect(within(labelRow('Hand-off message')).getByText('Default')).toBeTruthy()
    expect(within(labelRow('Tone and voice')).getByRole('button', { name: 'Use organisation default' })).toBeTruthy()
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
    const live = screen.getByRole('radiogroup', { name: 'Mia is' }).parentElement
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
    openSection('Personality and voice')
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
    openSection('Follow-ups')
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
    openSection('Personality and voice')
    const tone = screen.getByPlaceholderText('e.g. Warm, upbeat, brief. Use first names. No emojis.')
    expect(tone.value).toBe('Studio tone')
    fireEvent.click(within(labelRow('Tone and voice')).getByRole('button', { name: 'Use organisation default' }))
    expect(tone.value).toBe('Org tone')
    expect(within(labelRow('Tone and voice')).getByText('Organisation default')).toBeTruthy()
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
    openSection('Personality and voice')
    expect(within(labelRow('Tone and voice')).getByRole('button', { name: 'Use default' })).toBeTruthy()
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
    openSection('Personality and voice')
    expect(within(labelRow('Tone and voice')).getByRole('button', { name: 'Use organisation default' })).toBeTruthy()
    save()
    await waitFor(() => expect(within(labelRow('Tone and voice')).getByText('Organisation default')).toBeTruthy())
    expect(screen.getByPlaceholderText('e.g. Warm, upbeat, brief. Use first names. No emojis.').value).toBe('Org tone')
  })

  it('"Use organisation default" on quiet hours clears start, end and tz together', async () => {
    const studio = { enabled: true, quiet_hours: { start: '21:00', end: '07:00', tz: 'America/New_York' } }
    mockFetch([answer({ studio, org: null })])
    const { container } = render(<CustomerAgentClient canEdit />)
    await ready()
    const [start, end] = container.querySelectorAll('input[type="time"]')
    expect(start.value).toBe('21:00')
    expect(screen.getByText('America/New_York. The agent stays quiet and a human replies.')).toBeTruthy()
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
    showAllSettings()
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
    await waitFor(() => expect(screen.getByRole('radiogroup', { name: 'Mia is' })).toBeTruthy())
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
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
  const save = () => fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])
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
    await waitFor(() => expect(screen.getByRole('radio', { name: 'All studios (organisation)' })).toBeTruthy())
    // MIASETTINGS.4 — the organisation defaults sit behind the scope switch.
    expect(screen.queryByRole('heading', { name: 'Organisation defaults (all studios)' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'All studios (organisation)' }))
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
    await waitFor(() => expect(screen.getByRole('radio', { name: 'All studios (organisation)' })).toBeTruthy())
    // MIASETTINGS.4 — the org's tone, behind the scope switch.
    fireEvent.click(screen.getByRole('radio', { name: 'All studios (organisation)' }))
    openSection('Personality and voice')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save organisation defaults' })).toBeTruthy())
    const orgTone = () => container.querySelector('[data-org-field="tone"] textarea')
    const studioTone = () => screen.getByTestId('section-personality').querySelector(`textarea[placeholder="${TONE_PH}"]`)
    fireEvent.change(orgTone(), { target: { value: 'New org tone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save organisation defaults' }))
    // while the org PUT is in flight, the STUDIO's tone changes (its section
    // stays mounted, hidden, in the organisation scope)
    fireEvent.change(studioTone(), { target: { value: 'My studio tone' } })
    await act(async () => { releasePut() })
    await waitFor(() => expect(studioReads).toBe(2))
    // the org save is done, so going back to the studio asks nothing
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save organisation defaults' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('radio', { name: 'This studio' }))
    expect(screen.getByRole('radio', { name: 'This studio' }).getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(within(screen.getByTestId('section-personality')).getByRole('button', { name: 'Use organisation default' })).toBeTruthy())
    expect(studioTone().value).toBe('My studio tone')
    fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])
    await waitFor(() => expect(global.fetch.mock.calls.some(([u, i]) => String(u) === '/api/settings/customer-agent' && i?.method === 'PUT')).toBe(true))
    const [, init] = global.fetch.mock.calls.find(([u, i]) => String(u) === '/api/settings/customer-agent' && i?.method === 'PUT')
    const body = JSON.parse(init.body)
    expect(body.tone).toBe('My studio tone')
    expect(body.overridden).toContain('tone')
  })

  it('a half-entered quiet-hours window says "Set both times" and holds Save', async () => {
    mockFetch([studioAnswer(null)])
    render(<CustomerAgentClient canEdit />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:00' } })
    expect(screen.getByText('Set both times')).toBeTruthy()
    for (const b of screen.getAllByRole('button', { name: /^Save( settings)?$/ })) expect(b.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '07:00' } })
    expect(screen.queryByText('Set both times')).toBeNull()
    for (const b of screen.getAllByRole('button', { name: /^Save( settings)?$/ })) expect(b.disabled).toBe(false)
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
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
  const saveButton = () => screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0]

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
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
  // MIASETTINGS.2c — the group's heading is its Messages group title.
  const GROUP = /^Payments at Hatch/

  it('a un1t.online studio shows the group with every field and the code defaults as placeholders', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByText(GROUP)).toBeTruthy()
    const group = screen.getByTestId('hatch-copy-group')
    // MIASETTINGS.1c — the 12 Hatch copy fields plus the booking form message
    // (booking_flow_text), new at the studio and Hatch only. MIASETTINGS.2c:
    // the booking form message sits in Messages' WhatsApp booking form group.
    expect(group.querySelectorAll('[data-testid^="message-row-"]').length).toBe(12)
    expect(within(screen.getByTestId('message-group-booking-form')).getByRole('button', { name: /^Booking form message \(WhatsApp\)/, hidden: true })).toBeTruthy()
    expect(within(group).getByText('Thanks! You can go back to WhatsApp now.')).toBeTruthy()
    expect(within(group).getByText("Here's your secure payment link for {product}. Once it goes through I'll book you into {class}.")).toBeTruthy()
  })

  it('no dash (em or en) in the group\'s labels, help or placeholders', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const group = screen.getByTestId('hatch-copy-group')
    expect(group.textContent).not.toMatch(/[—–]/)
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
    openRow('Payment done page text')
    fireEvent.change(screen.getByPlaceholderText('Thanks! You can go back to WhatsApp now.'), { target: { value: '  All done, back to WhatsApp.  ' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])
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
    expect(within(group).getByText('Org refund text.')).toBeTruthy()
    const row = within(group).getByText('Refund request message').closest('[data-testid^="message-row-"]')
    expect(within(row).getByText('Organisation default')).toBeTruthy()
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

  // MIASETTINGS.2c — the switch moved to Bookings and sales.
  it('Bookings and sales carries the chat actions switch, unticked by default, no dash in its words', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    openSection('Bookings and sales')
    const group = screen.getByTestId('section-bookings').querySelector('fieldset')
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
    fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])
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
    fireEvent.click(screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0])
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
  const ready = () => waitFor(() => expect(screen.getAllByRole('button', { name: /^Save( settings)?$/ }).length).toBeGreaterThan(0))
  const saveButton = () => screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0]
  const TITLE = 'Trial finisher follow-up'
  const ID_A = '11111111-1111-4111-8111-111111111111'

  it('shows at a un1t.online studio, off, with both template names, the delay and the default instruction as placeholder', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByText(TITLE)).toBeTruthy()
    const card = screen.getByTestId('trial-done-card')
    expect(within(card).getByLabelText('Enable trial finisher follow-up').checked).toBe(false)
    expect(within(card).queryByLabelText('Opener template')).toBeNull()
    showAllSettings(within(card))
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
    showAllSettings(within(card))
    expect(card.textContent).toContain('has done 3 trial classes, or 2 classes and the trial has expired')
    expect(card.textContent).toContain('Hours after the trial ends')
    expect(card.textContent).not.toContain('attends their second class')
    expect(card.textContent).not.toContain('Hours after their last class')
  })

  it('MIASETTINGS.3b: the trial finisher shows only at Hatch, and folds its details while off', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const card = screen.getByTestId('trial-done-card')
    expect(within(card).getByRole('button', { name: 'Show settings', hidden: true }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(within(card).getByLabelText('Enable trial finisher follow-up'))
    expect(within(card).queryByRole('button', { name: 'Show settings', hidden: true })).toBeNull()
    expect(within(card).getByLabelText('Opener template')).toBeTruthy()
    fireEvent.click(within(card).getByLabelText('Enable trial finisher follow-up'))
    expect(within(card).queryByLabelText('Opener template')).toBeNull()
  })

  it('MIASETTINGS.3b: the test tag stays in the header while the details are folded', async () => {
    const studio = { enabled: true, trial_done: { ...DEFAULTS.trial_done, enabled: false, only_contact_ids: [ID_A] } }
    mockFetch([answer({ membership_source_key: 'un1t_online', studio })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const card = screen.getByTestId('trial-done-card')
    expect(within(card).getByText('Test: 1 contact only')).toBeTruthy()
    expect(within(card).queryByLabelText('Test contact ids')).toBeNull()
  })

  it('MIASETTINGS.3b: a stored value in a folded detail is still in the PUT body', async () => {
    const studio = { enabled: true, followups: { enabled: false, nudge_after_hours: 5, template_name: 'nudge_v2', daily_cap: 33 } }
    mockFetch([answer({ studio }), reply(200, { success: true, settings: {} }), answer({ studio })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.queryByLabelText('Nudge after (hours)')).toBeNull()
    fireEvent.click(screen.getByLabelText('Enable inline suggestions'))
    fireEvent.click(saveButton())
    await waitFor(() => expect(putBody()).toBeTruthy())
    expect(putBody().followups).toMatchObject({ nudge_after_hours: 5, template_name: 'nudge_v2', daily_cap: 33 })
  })

  it('MIASETTINGS.3b fix: a read-only viewer can open a folded card and sees its fields disabled', async () => {
    mockFetch([answer({ membership_source_key: 'un1t_online' })])
    render(<CustomerAgentClient canEdit={false} />)
    await waitFor(() => expect(screen.getByTestId('trial-done-card')).toBeTruthy())
    const card = screen.getByTestId('trial-done-card')
    const toggle = within(card).getByRole('button', { name: 'Show settings', hidden: true })
    expect(toggle.matches(':disabled')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(within(card).getByLabelText('Opener template').matches(':disabled')).toBe(true)
    const hide = within(card).getByRole('button', { name: 'Hide settings', hidden: true })
    expect(hide.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(hide)
    expect(within(card).queryByLabelText('Opener template')).toBeNull()
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
    showAllSettings(within(card))
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
    expect(screen.getByTestId('trial-done-card').querySelector('fieldset').disabled).toBe(true)
    for (const b of container.querySelectorAll('[data-testid="trial-done-card"] button')) expect(b.getAttribute('type')).toBe('button')
  })
})

// MIASETTINGS.2c — the shell: a section menu showing one section at a time,
// the section in the URL, drafts kept across a switch, and a read-only viewer
// who can still move around (Review Focus 1).
describe('CustomerAgentClient — sections, menu and shell (MIASETTINGS.2c)', () => {
  const MENU = ['Overview', 'Personality and voice', 'Handoffs', 'Bookings and sales', 'Messages', 'Follow-ups', 'Cancellation form', 'Knowledge', 'Member app']
  const ready = () => waitFor(() => expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy())
  const current = () => screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.textContent)

  it('opens on Overview, with every section in the menu', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    for (const name of MENU) expect(screen.getByRole('button', { name })).toBeTruthy()
    expect(current()).toEqual(['Overview'])
    expect(screen.getByRole('radiogroup', { name: 'Mia is' })).toBeTruthy()
    // another section's field is in the page but hidden
    expect(screen.queryByRole('textbox', { name: 'Agent name' })).toBeNull()
    expect(screen.getByLabelText('Agent name')).toBeTruthy()
  })

  it('?section=messages opens Messages', async () => {
    window.history.replaceState(null, '', '/?section=messages')
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(current()).toEqual(['Messages'])
    expect(screen.getByRole('button', { name: /^No-credits escalation message/ })).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Mia is' })).toBeNull()
  })

  it('an unknown section opens Overview', async () => {
    window.history.replaceState(null, '', '/?section=nonsense')
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(current()).toEqual(['Overview'])
  })

  it('clicking a menu item shows its section and puts it in the URL', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    openSection('Follow-ups')
    expect(current()).toEqual(['Follow-ups'])
    expect(window.location.search).toBe('?section=followups')
    expect(screen.getByRole('checkbox', { name: 'Enable proactive follow-ups' })).toBeTruthy()
    openSection('Overview')
    expect(window.location.search).toBe('')
  })

  it('the mobile select drives the same section', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const select = screen.getByRole('combobox', { name: 'Section' })
    expect(select.value).toBe('overview')
    fireEvent.change(select, { target: { value: 'member-app' } })
    expect(current()).toEqual(['Member app'])
    expect(window.location.search).toBe('?section=member-app')
    openSection('Handoffs')
    expect(select.value).toBe('handoffs')
  })

  it('an edit in Personality survives a switch to Messages and back, and is saved', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    openSection('Personality and voice')
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya' } })
    openSection('Messages')
    expect(screen.queryByRole('textbox', { name: 'Agent name' })).toBeNull()
    openSection('Personality and voice')
    expect(screen.getByRole('textbox', { name: 'Agent name' }).value).toBe('Maya')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(global.fetch.mock.calls.some(([u, i]) => String(u) === '/api/settings/customer-agent' && i?.method === 'PUT')).toBe(true))
    const [, init] = global.fetch.mock.calls.find(([u, i]) => String(u) === '/api/settings/customer-agent' && i?.method === 'PUT')
    expect(JSON.parse(init.body).agent_name).toBe('Maya')
  })

  it('one Save, on every section but Knowledge', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    for (const name of MENU) {
      openSection(name)
      expect(screen.queryAllByRole('button', { name: 'Save' }), name).toHaveLength(name === 'Knowledge' ? 0 : 1)
    }
  })

  it('Review Focus 1: a non-owner can move around, with every setting input disabled', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit={false} />)
    await ready()
    for (const name of MENU) expect(screen.getByRole('button', { name }).matches(':disabled'), name).toBe(false)
    expect(screen.getByRole('combobox', { name: 'Section' }).matches(':disabled')).toBe(false)
    openSection('Personality and voice')
    expect(current()).toEqual(['Personality and voice'])
    expect(screen.getByRole('textbox', { name: 'Agent name' }).matches(':disabled')).toBe(true)
    expect(screen.getByText("Only an owner can change Mia's settings here.")).toBeTruthy()
    openSection('Cancellation form')
    const controls = screen.getByTestId('section-cancellation').querySelectorAll('input, textarea, select')
    expect(controls.length).toBeGreaterThan(20)
    for (const c of controls) expect(c.matches(':disabled')).toBe(true)
    openSection('Member app')
    expect(screen.getByRole('checkbox', { name: 'Member social (friends, feed and kudos)' }).matches(':disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('the menu foot links to Activity, Requests and the channel connections', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByRole('link', { name: 'Activity' }).getAttribute('href')).toBe('/settings/customer-agent/analytics')
    expect(screen.getByRole('link', { name: 'Requests' }).getAttribute('href')).toBe('/settings/customer-agent/requests')
    expect(screen.getByRole('link', { name: 'Channel connections' }).getAttribute('href')).toBe('/settings/integrations-hub?manage=instagram&location=loc1')
    // the two old link cards are gone
    expect(screen.queryByText('View agent activity')).toBeNull()
  })

  it('the header names the studio and shows the SAVED status, not an unsaved switch', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const header = screen.getByRole('banner')
    expect(within(header).getByRole('heading', { level: 1, name: 'Customer Agent' })).toBeTruthy()
    expect(within(header).getByText('Test Studio')).toBeTruthy()
    expect(within(header).getByText('Live').className).toContain('text-green-700')
    fireEvent.click(screen.getByRole('radio', { name: 'Test' }))
    expect(within(header).getByText('Live')).toBeTruthy()
    expect(within(header).queryByText('Test')).toBeNull()
  })

  it('the header status reads Off, Test, and Live for a live-and-test row', async () => {
    for (const [flags, text, cls] of [
      [{ enabled: false, test_mode: false }, 'Off', 'text-un1t-muted'],
      [{ enabled: false, test_mode: true }, 'Test', 'text-amber-700'],
      [{ enabled: true, test_mode: true }, 'Live', 'text-green-700'],
    ]) {
      mockFetch([reply(200, { ...(await GOOD.json()), settings: { ...DEFAULTS, ...flags, social_enabled: false, glofox_auto_cancel: false } })])
      const { unmount } = render(<CustomerAgentClient canEdit />)
      await ready()
      expect(within(screen.getByRole('banner')).getByText(text).className, text).toContain(cls)
      unmount()
    }
  })

  it('the header shows the saved quiet hours window, and none when switched off', async () => {
    mockFetch([reply(200, { ...(await GOOD.json()), settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, quiet_hours: { start: '21:00', end: '08:00' } } })])
    const first = render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(screen.getByRole('banner')).getByText('Quiet 21:00 to 08:00')).toBeTruthy()
    first.unmount()
    mockFetch([reply(200, { ...(await GOOD.json()), settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, quiet_hours: { start: null, end: null, off: true } } })])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(screen.getByRole('banner')).queryByText(/^Quiet /)).toBeNull()
  })

  it('the template pickers\' empty options carry no dashes', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    openSection('Follow-ups')
    showAllSettings()
    expect(screen.getByRole('option', { name: 'None (in-window nudge only)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'None (open-window check-ins only)' })).toBeTruthy()
  })

  it('Voices sit in Personality and voice with their own permission', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit={false} canEditVoices />)
    await ready()
    expect(screen.getByTestId('section-personality').textContent).toContain('Mia\u2019s voices')
    expect(screen.getByTestId('mia-voices').closest('fieldset')).toBeNull()
  })
})

// MIASETTINGS.2d — one save bar, the unsaved-change guards and the menu dots.
describe('CustomerAgentClient — save bar and unsaved-change guards (MIASETTINGS.2d)', () => {
  const ready = () => waitFor(() => expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy())
  const bar = () => screen.getByRole('region', { name: 'Save settings' })
  const puts = () => global.fetch.mock.calls.filter(([u, i]) => String(u) === '/api/settings/customer-agent' && i?.method === 'PUT')
  const hatch = () => {
    const studio = { enabled: true }
    const { settings, sources } = mergeAgentSettings({ org: null, studio })
    return reply(200, {
      success: true, settings: { ...settings, social_enabled: false, glofox_auto_cancel: false }, studio, org: null, sources,
      inherited: mergeAgentSettings({ org: null, studio: null }).settings,
      membership_source_key: 'un1t_online',
      location: { id: 'loc1', name: 'Test Studio' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
    })
  }

  it('counts the fields edited, one quiet-hours edit as one, and Discard puts everything back', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(within(bar()).queryByText(/^\d+ unsaved change/)).toBeNull()
    openSection('Personality and voice')
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya' } })
    expect(within(bar()).getByText('1 unsaved change')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya2' } })
    expect(within(bar()).getByText('1 unsaved change')).toBeTruthy()
    openSection('Overview')
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '22:00' } })
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '07:00' } })
    expect(within(bar()).getByText('2 unsaved changes')).toBeTruthy()
    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }))
    expect(within(bar()).queryByText(/^\d+ unsaved change/)).toBeNull()
    expect(screen.getByLabelText('Quiet hours start').value).toBe('')
    openSection('Personality and voice')
    expect(screen.getByRole('textbox', { name: 'Agent name' }).value).not.toMatch(/Maya/)
  })

  it('Review Focus 4: an invalid trial finisher holds Save, names Follow-ups, and the hold opens it', async () => {
    mockFetch([hatch()])
    render(<CustomerAgentClient canEdit />)
    await ready()
    openSection('Follow-ups')
    showAllSettings(within(screen.getByTestId('trial-done-card')))
    fireEvent.change(within(screen.getByTestId('trial-done-card')).getByLabelText('Opener template'), { target: { value: 'Has Caps' } })
    openSection('Overview')
    expect(within(bar()).getByRole('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.click(within(bar()).getByRole('button', { name: /in Follow-ups$/ }))
    expect(screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.textContent)).toEqual(['Follow-ups'])
  })

  it('saving from Messages saves an edit made in Personality too', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    openSection('Personality and voice')
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya' } })
    openSection('Messages')
    openRow('No-credits escalation message')
    fireEvent.change(screen.getByRole('textbox', { name: 'No-credits escalation message' }), { target: { value: 'Call us' } })
    fireEvent.click(within(bar()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    const body = JSON.parse(puts()[0][1].body)
    expect(body.agent_name).toBe('Maya')
    expect(body.no_credits_handoff_text).toBe('Call us')
  })

  it('a non-owner gets no bar', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit={false} />)
    await ready()
    expect(screen.queryByRole('region', { name: 'Save settings' })).toBeNull()
  })

  it('a dot marks each section with unsaved changes, in the list and the select', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.queryAllByRole('img', { name: 'Unsaved changes' })).toHaveLength(0)
    openSection('Personality and voice')
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya' } })
    expect(screen.getAllByRole('img', { name: 'Unsaved changes' })).toHaveLength(1)
    expect(screen.getByRole('option', { name: 'Personality and voice (unsaved)' })).toBeTruthy()
    expect(screen.getByRole('option', { name: /^Messages \(\d+\)$/ })).toBeTruthy()
  })

  it('beforeunload is registered only while there are unsaved changes', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const fire = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }
    expect(fire()).toBe(false)
    openSection('Personality and voice')
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya' } })
    expect(fire()).toBe(true)
    fireEvent.click(within(bar()).getByRole('button', { name: 'Discard' }))
    expect(fire()).toBe(false)
  })

  it('the menu foot links ask before leaving only when dirty', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(fireEvent.click(screen.getByRole('link', { name: 'Activity' }))).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    openSection('Personality and voice')
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya' } })
    expect(fireEvent.click(screen.getByRole('link', { name: 'Requests' }))).toBe(false)
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes?')
    confirm.mockRestore()
  })

  it('Knowledge stays editable for a viewer without owner rights', async () => {
    mockFetch([GOOD])
    const inner = global.fetch
    global.fetch = vi.fn(async (url, init) => String(url).startsWith('/api/agent/knowledge') && !init?.method
      ? reply(200, { success: true, entries: [{ id: 'k1', category: 'sales', title: 'Opening hours', content: 'x', enabled: true }] })
      : inner(url, init))
    render(<CustomerAgentClient canEdit={false} />)
    await ready()
    openSection('Knowledge')
    expect(screen.getByRole('button', { name: '+ Add entry' }).matches(':disabled')).toBe(false)
    expect((await screen.findByDisplayValue('Opening hours')).matches(':disabled')).toBe(false)
  })

  it('Ruling 8: in Personality and voice the read-only note sits above the settings, not the voices', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit={false} canEditVoices />)
    await ready()
    openSection('Personality and voice')
    const note = screen.getByText("Only an owner can change Mia's settings here.")
    const section = screen.getByTestId('section-personality')
    const fieldset = section.querySelector('fieldset')
    expect(note.compareDocumentPosition(fieldset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('mia-voices').contains(note)).toBe(false)
  })
})

// MIASETTINGS.3c — Knowledge search and category filter.
describe('CustomerAgentClient — knowledge search and filter (MIASETTINGS.3c)', () => {
  const ENTRIES = [
    { id: 'k1', category: 'hours', title: 'Opening hours', content: 'Mon to Fri 6am', enabled: true },
    { id: 'k2', category: 'sales', title: 'Trial offer', content: 'First class free', enabled: true },
    { id: 'k3', category: 'faq', title: 'Parking', content: 'Opening times of the car park', enabled: true },
  ]
  const ready = () => screen.findByRole('button', { name: 'Knowledge' })
  async function openKnowledge({ canEdit = true } = {}) {
    mockFetch([GOOD])
    const inner = global.fetch
    global.fetch = vi.fn(async (url, init) => {
      if (String(url) === '/api/agent/knowledge' && !init?.method) return reply(200, { success: true, entries: ENTRIES })
      if (String(url).startsWith('/api/agent/knowledge/') && init?.method === 'PUT') return reply(200, { success: true })
      return inner(url, init)
    })
    render(<CustomerAgentClient canEdit={canEdit} />)
    await ready()
    openSection('Knowledge')
    await screen.findByDisplayValue('Opening hours')
  }
  const titles = () => screen.queryAllByPlaceholderText('Short title').map((i) => i.value)

  it('the search matches title and content; a miss says so', async () => {
    await openKnowledge()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: 'opening' } })
    expect(titles()).toEqual(['Opening hours', 'Parking'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: 'zzz' } })
    expect(titles()).toEqual([])
    expect(screen.getByText('No entries match.')).toBeTruthy()
  })

  it('the category narrows the list, alone or with the search; All categories restores it', async () => {
    await openKnowledge()
    const cat = screen.getByRole('combobox', { name: 'Category' })
    expect(within(cat).getByRole('option', { name: 'All categories' })).toBeTruthy()
    fireEvent.change(cat, { target: { value: 'sales' } })
    expect(titles()).toEqual(['Trial offer'])
    fireEvent.change(cat, { target: { value: 'faq' } })
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: 'opening' } })
    expect(titles()).toEqual(['Parking'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: '' } })
    fireEvent.change(cat, { target: { value: '' } })
    expect(titles()).toEqual(['Opening hours', 'Trial offer', 'Parking'])
  })

  it('an entry edited so it leaves the filtered list is still saved, and kept in the full list', async () => {
    await openKnowledge()
    const cat = screen.getByRole('combobox', { name: 'Category' })
    fireEvent.change(cat, { target: { value: 'sales' } })
    const entrySelect = screen.getByDisplayValue('Trial offer').closest('div').querySelector('select')
    fireEvent.change(entrySelect, { target: { value: 'faq' } })
    await waitFor(() => expect(global.fetch.mock.calls.some(([u, i]) => u === '/api/agent/knowledge/k2' && i?.method === 'PUT' && JSON.parse(i.body).category === 'faq')).toBe(true))
    expect(titles()).toEqual([])
    fireEvent.change(cat, { target: { value: '' } })
    expect(titles()).toEqual(['Opening hours', 'Trial offer', 'Parking'])
  })

  it('MIASETTINGS.3c fix: an entry stays listed while typed in, and its blur save still fires', async () => {
    await openKnowledge()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: 'opening' } })
    const input = screen.getByDisplayValue('Opening hours')
    fireEvent.change(input, { target: { value: 'Studio times' } })
    expect(screen.getByDisplayValue('Studio times')).toBe(input)
    fireEvent.blur(input)
    await waitFor(() => expect(global.fetch.mock.calls.some(([u, i]) => u === '/api/agent/knowledge/k1' && i?.method === 'PUT' && JSON.parse(i.body).title === 'Studio times')).toBe(true))
    await waitFor(() => expect(titles()).toEqual(['Parking']))
  })

  it('MIASETTINGS.3c fix: no count in the menu until the knowledge read succeeds', async () => {
    mockFetch([GOOD])
    const inner = global.fetch
    global.fetch = vi.fn(async (url, init) => String(url) === '/api/agent/knowledge' && !init?.method
      ? reply(200, { success: false }) : inner(url, init))
    render(<CustomerAgentClient canEdit />)
    await ready()
    expect(screen.getByRole('button', { name: 'Knowledge' }).parentElement.textContent).toBe('Knowledge')
    expect(screen.getByRole('option', { name: 'Knowledge' })).toBeTruthy()
  })

  it('MIASETTINGS.3c: the menu shows the total entries, unchanged by the filter, without changing the item name', async () => {
    await openKnowledge()
    const item = screen.getByRole('button', { name: 'Knowledge' })
    await waitFor(() => expect(item.parentElement.textContent).toContain('3'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: 'free' } })
    expect(titles()).toEqual(['Trial offer'])
    expect(item.parentElement.textContent).toBe('Knowledge3')
    expect(screen.getByRole('option', { name: 'Knowledge (3)' })).toBeTruthy()
  })

  it('MIASETTINGS.3c: the menu shows how many message fields this studio has', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await ready()
    const n = fieldsFor('studio', 'messages', {}).length
    expect(n).toBeGreaterThan(0)
    const item = screen.getByRole('button', { name: 'Messages' })
    expect(item.parentElement.textContent).toMatch(new RegExp(`^Messages${n}`))
  })

  it('MIASETTINGS.5: an entry added under a filter stays listed so it can be edited', async () => {
    await openKnowledge()
    const inner = global.fetch
    global.fetch = vi.fn(async (url, init) => String(url) === '/api/agent/knowledge' && init?.method === 'POST'
      ? reply(200, { success: true, entry: { id: 'k9', category: 'sales', title: 'New entry', content: '', enabled: true } }) : inner(url, init))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search knowledge' }), { target: { value: 'parking' } })
    expect(titles()).toEqual(['Parking'])
    fireEvent.click(screen.getByRole('button', { name: '+ Add entry' }))
    await waitFor(() => expect(titles()).toEqual(['Parking', 'New entry']))
  })

  it('the filter controls work for a viewer without owner rights', async () => {
    await openKnowledge({ canEdit: false })
    expect(screen.getByRole('searchbox', { name: 'Search knowledge' }).matches(':disabled')).toBe(false)
    expect(screen.getByRole('combobox', { name: 'Category' }).matches(':disabled')).toBe(false)
  })
})

// MIASETTINGS.4 — the organisation defaults behind a scope switch in the
// header, for masters and organisation admins only.
describe('CustomerAgentClient — the scope switch (MIASETTINGS.4)', () => {
  const ORG_ID = 'a0000000-0000-0000-0000-00000000a0a1'
  const ORG_DEFAULTS = { organizationId: ORG_ID, organizationName: 'Org A' }
  const STUDIO_ONLY = ['Bookings and sales', 'Cancellation form', 'Knowledge', 'Member app']
  const ORG_MENU = ['Overview', 'Personality and voice', 'Handoffs', 'Messages', 'Follow-ups']
  const current = () => screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.textContent)
  const orgRadio = () => screen.getByRole('radio', { name: 'All studios (organisation)' })
  const studioRadio = () => screen.getByRole('radio', { name: 'This studio' })
  const STUDIOS = [{ id: 'loc1', name: 'Test Studio', sets: [], mia_on: true }]
  const orgState = (raw = null) => reply(200, { success: true, data: { organization: { id: ORG_ID, name: 'Org A' }, settings: mergeAgentSettings({ org: raw }).settings, raw, defaults: DEFAULTS, studios: STUDIOS } })
  // A Glofox studio (Stillorgan-shaped): no Hatch-only field at the studio.
  function studioAnswer({ membership = 'glofox' } = {}) {
    const studio = { enabled: true }
    const { settings, sources } = mergeAgentSettings({ org: null, studio })
    return reply(200, {
      success: true, settings: { ...settings, social_enabled: false, glofox_auto_cancel: false }, studio, org: null, sources,
      inherited: mergeAgentSettings({ org: null, studio: null }).settings,
      membership_source_key: membership, bookings: true,
      location: { id: 'loc1', name: 'Test Studio', timezone: 'Europe/Dublin' },
      checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null },
    })
  }
  function mockAll({ org = () => orgState() } = {}) {
    global.fetch = vi.fn(async (url, init) => {
      const u = String(url)
      if (u.startsWith('/api/settings/customer-agent/org')) return org(init)
      if (u === '/api/settings/customer-agent' && init?.method === 'PUT') return reply(200, { success: true, settings: {} })
      if (u.startsWith('/api/settings/customer-agent')) return studioAnswer()
      if (u.startsWith('/api/agent/knowledge')) return reply(200, { success: true, entries: [] })
      return reply(200, { success: true, templates: [] })
    })
  }
  const readyStudio = () => waitFor(() => expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy())

  it('no switch without orgDefaults, and ?scope=org without rights opens the studio', async () => {
    window.history.replaceState(null, '', '/?scope=org&section=cancellation')
    mockAll()
    render(<CustomerAgentClient canEdit />)
    await readyStudio()
    expect(screen.queryByRole('radiogroup', { name: 'Editing' })).toBeNull()
    expect(current()).toEqual(['Cancellation form'])
    for (const name of STUDIO_ONLY) expect(screen.getByRole('button', { name })).toBeTruthy()
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/customer-agent/org'))).toBe(false)
  })

  it('switching shows the organisation fields and only the organisation sections, and writes scope=org', async () => {
    mockAll()
    const { container } = render(<CustomerAgentClient canEdit orgDefaults={ORG_DEFAULTS} />)
    await readyStudio()
    expect(screen.getByRole('radiogroup', { name: 'Editing' })).toBeTruthy()
    expect(studioRadio().getAttribute('aria-checked')).toBe('true')
    fireEvent.click(orgRadio())
    expect(orgRadio().getAttribute('aria-checked')).toBe('true')
    expect(window.location.search).toBe('?scope=org')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save organisation defaults' })).toBeTruthy())
    for (const name of ORG_MENU) expect(screen.getByRole('button', { name })).toBeTruthy()
    for (const name of STUDIO_ONLY) expect(screen.queryByRole('button', { name })).toBeNull()
    // the organisation's quiet hours, not the studio's status switch or bar
    expect(within(container.querySelector('[data-org-field="quiet_hours"]')).getByLabelText('Quiet hours start')).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Mia is' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByLabelText("Start from a studio's settings")).toBeTruthy()
    openSection('Follow-ups')
    expect(window.location.search).toBe('?section=followups&scope=org')
    // back to the studio: every section again, on the same section
    fireEvent.click(studioRadio())
    expect(window.location.search).toBe('?section=followups')
    for (const name of STUDIO_ONLY) expect(screen.getByRole('button', { name })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save organisation defaults' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })

  it('switching to the organisation from a studio-only section lands on Overview', async () => {
    window.history.replaceState(null, '', '/?section=knowledge')
    mockAll()
    render(<CustomerAgentClient canEdit orgDefaults={ORG_DEFAULTS} />)
    await readyStudio()
    expect(current()).toEqual(['Knowledge'])
    fireEvent.click(orgRadio())
    expect(current()).toEqual(['Overview'])
    expect(window.location.search).toBe('?scope=org')
  })

  it('Review Focus 5: ?scope=org&section=cancellation lands on the organisation Overview', async () => {
    window.history.replaceState(null, '', '/?scope=org&section=cancellation')
    mockAll()
    render(<CustomerAgentClient canEdit orgDefaults={ORG_DEFAULTS} />)
    await readyStudio()
    expect(orgRadio().getAttribute('aria-checked')).toBe('true')
    expect(current()).toEqual(['Overview'])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save organisation defaults' })).toBeTruthy())
  })

  it('a dirty studio edit asks before switching: No keeps it, Yes discards it and switches', async () => {
    mockAll()
    render(<CustomerAgentClient canEdit orgDefaults={ORG_DEFAULTS} />)
    await readyStudio()
    openSection('Personality and voice')
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya' } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(orgRadio())
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes?')
    expect(studioRadio().getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Agent name' }).value).toBe('Maya')
    confirm.mockReturnValue(true)
    fireEvent.click(orgRadio())
    expect(orgRadio().getAttribute('aria-checked')).toBe('true')
    confirm.mockClear()
    fireEvent.click(studioRadio())
    // the organisation had nothing unsaved: no question on the way back
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Agent name' }).value).not.toBe('Maya')
    expect(within(screen.getByRole('region', { name: 'Save settings' })).getByText('No unsaved changes')).toBeTruthy()
    confirm.mockRestore()
  })

  it('a dirty organisation edit asks before switching back, and Yes discards it', async () => {
    mockAll({ org: () => orgState({ tone: 'Org tone' }) })
    const { container } = render(<CustomerAgentClient canEdit orgDefaults={ORG_DEFAULTS} />)
    await readyStudio()
    fireEvent.click(orgRadio())
    openSection('Personality and voice')
    await waitFor(() => expect(container.querySelector('[data-org-field="tone"] textarea')).toBeTruthy())
    const orgTone = () => container.querySelector('[data-org-field="tone"] textarea')
    fireEvent.change(orgTone(), { target: { value: 'New org tone' } })
    expect(screen.getAllByRole('img', { name: 'Unsaved changes' })).toHaveLength(1)
    const fire = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }
    expect(fire()).toBe(true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(studioRadio())
    expect(confirm).toHaveBeenCalledWith('Discard your unsaved changes?')
    expect(orgRadio().getAttribute('aria-checked')).toBe('true')
    confirm.mockReturnValue(true)
    fireEvent.click(studioRadio())
    expect(studioRadio().getAttribute('aria-checked')).toBe('true')
    expect(orgTone().value).toBe('Org tone')
    expect(fire()).toBe(false)
    confirm.mockRestore()
  })

  it('the Hatch copy shows in the organisation scope while working from a Glofox studio', async () => {
    mockAll()
    const { container } = render(<CustomerAgentClient canEdit orgDefaults={ORG_DEFAULTS} />)
    await readyStudio()
    // at this studio the Hatch group is not there
    expect(screen.queryByTestId('hatch-copy-group')).toBeNull()
    fireEvent.click(orgRadio())
    openSection('Messages')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Hatch payments and booking (un1t.online studios)' })).toBeTruthy())
    expect(container.querySelector('[data-org-field="purchase_link_text"]')).toBeTruthy()
    expect(screen.getByText('Booking form message (studios with the WhatsApp booking Flow)')).toBeTruthy()
  })
})

describe('CustomerAgentClient — final review fixes (MIASETTINGS.5)', () => {
  const NC = 'No-credits escalation message'
  const putBtn = () => screen.getAllByRole('button', { name: /^Save( settings)?$/ })[0]

  it('an open message row stays listed while its search word is typed away', async () => {
    const g = { ...GOOD, json: async () => ({ ...(await GOOD.json()), settings: { ...DEFAULTS, enabled: true, social_enabled: false, glofox_auto_cancel: false, no_credits_handoff_text: 'zebrafish rule' } }) }
    mockFetch([g])
    render(<CustomerAgentClient canEdit />)
    await screen.findByRole('button', { name: 'Messages' })
    openSection('Messages')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), { target: { value: 'zebrafish' } })
    openRow(NC)
    fireEvent.change(screen.getByRole('textbox', { name: NC }), { target: { value: 'plain' } })
    expect(screen.getByRole('textbox', { name: NC }).value).toBe('plain')
  })

  it('a search shows matches in a folded group', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await screen.findByRole('button', { name: 'Messages' })
    openSection('Messages')
    const group = screen.getByRole('button', { name: /^Greeting and links \(/ })
    fireEvent.click(group)
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(within(screen.getByTestId('message-group-greeting')).queryAllByTestId(/message-row-/)).toHaveLength(0)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), { target: { value: 'a' } })
    expect(screen.getByRole('button', { name: /^Greeting and links \(/ }).getAttribute('aria-expanded')).toBe('true')
    expect(within(screen.getByTestId('message-group-greeting')).queryAllByTestId(/message-row-/).length).toBeGreaterThan(0)
  })

  it('the status switch looks disabled for a non-owner', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit={false} />)
    await screen.findByRole('button', { name: 'Overview' })
    for (const r of screen.getAllByRole('radio', { name: /^(Off|Test|Live)/ })) expect(r.disabled).toBe(true)
  })

  it('the template pickers have dash-free empty options', async () => {
    mockFetch([GOOD])
    render(<CustomerAgentClient canEdit />)
    await screen.findByRole('button', { name: 'Overview' })
    expect(screen.getAllByText('None (send by WhatsApp only inside the 24h window)', { selector: 'option' })).toHaveLength(1)
    expect(screen.getAllByText('None', { selector: 'option' }).length).toBeGreaterThanOrEqual(3)
    expect(screen.queryAllByText(/— none/, { selector: 'option' })).toHaveLength(0)
  })

  it('a 400 on a booking field is reachable from the save bar of any section', async () => {
    const a = { ...GOOD, json: async () => ({ ...(await GOOD.json()), bookings: false }) }
    mockFetch([a, reply(400, { success: false, error: 'Invalid request body', issues: [{ path: 'booking_cta_label', message: 'Too long' }] })])
    render(<CustomerAgentClient canEdit />)
    await screen.findByRole('button', { name: 'Overview' })
    openSection('Personality and voice')
    fireEvent.change(screen.getByRole('textbox', { name: 'Agent name' }), { target: { value: 'Maya' } })
    fireEvent.click(putBtn())
    const link = await screen.findByRole('button', { name: 'Too long in Bookings and sales' })
    fireEvent.click(link)
    expect(screen.getByRole('button', { name: 'Bookings and sales' }).getAttribute('aria-current')).toBe('page')
  })

  it('the studio status and quiet hours chips are hidden in the organisation scope', async () => {
    const ORG_ID = 'a0000000-0000-0000-0000-00000000a0a1'
    const studio = { enabled: true, quiet_hours: { start: '21:00', end: '07:00' } }
    const { settings, sources } = mergeAgentSettings({ org: null, studio })
    global.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.startsWith('/api/settings/customer-agent/org')) return reply(200, { success: true, data: { organization: { id: ORG_ID, name: 'Org A' }, settings: mergeAgentSettings({ org: null }).settings, raw: null, defaults: DEFAULTS, studios: [] } })
      if (u.startsWith('/api/settings/customer-agent')) return reply(200, { success: true, settings: { ...settings, social_enabled: false, glofox_auto_cancel: false }, studio, org: null, sources, inherited: mergeAgentSettings({ org: null, studio: null }).settings, membership_source_key: 'glofox', bookings: true, location: { id: 'loc1', name: 'Test Studio', timezone: 'Europe/Dublin' }, checkin_stats: { sent_today: 0, total: 0, last: null, last_run: null } })
      if (u.startsWith('/api/agent/knowledge')) return reply(200, { success: true, entries: [] })
      return reply(200, { success: true, templates: [] })
    })
    const { container } = render(<CustomerAgentClient canEdit orgDefaults={{ organizationId: ORG_ID, organizationName: 'Org A' }} />)
    await screen.findByRole('button', { name: 'Overview' })
    const chips = () => container.querySelectorAll('header span.rounded-full').length
    expect(screen.getByText('Quiet 21:00 to 07:00')).toBeTruthy()
    expect(chips()).toBe(2)
    fireEvent.click(screen.getByRole('radio', { name: 'All studios (organisation)' }))
    expect(screen.queryByText('Quiet 21:00 to 07:00')).toBeNull()
    expect(chips()).toBe(0)
  })
})
