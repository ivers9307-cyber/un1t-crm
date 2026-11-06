// WAITLIST.5 — the Cold action is offered on a DERIVED board only.
//
// Cold writes contacts.pipeline_dismissed_at, and the only reader of that stamp
// is the classifier, which never runs on a manual board (pipelines.mode, mig
// 594). On Hatch Street's waitlist board "Not interested" is column 4, so the
// button was a second, invisible way to say the same thing — and pressing it
// produced no visible change at all.
//
// Asserted on the `actions` PersonActionBar receives rather than on rendered
// text: the menu is closed until a click, so static markup contains no menu
// item either way and a markup assertion would pass for the wrong reason.

import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('./PersonActionBar', () => ({
  // HATCHCOLD.2 — the last props are kept for the board-scoped Cold tests; the
  // markup stays exactly what the inline snapshots below pin.
  default: (props) => {
    globalThis.__dealCardBarProps = props
    return <div data-actions={(props.actions || []).join(',')} />
  },
}))

const { default: DealCard } = await import('./DealCard.jsx')

const DEAL = {
  id: 'd-1',
  title: 'Ada',
  contacts: { id: 'c-1', name: 'Ada Lovelace', pipeline_stage_slug: 'new_lead' },
}

const actionsOf = (html) => {
  const m = html.match(/data-actions="([^"]*)"/)
  return m ? m[1].split(',') : null
}

const render = (props) => renderToStaticMarkup(
  <DealCard deal={DEAL} locationId="l-1" stageName="New Enquiry" {...props} />,
)

describe('DealCard — Cold on a derived board', () => {
  it('offers Cold when manual is false', () => {
    expect(actionsOf(render({ manual: false }))).toContain('cold')
  })

  it('offers Cold when manual is not passed at all', () => {
    // Stillorgan's acquisition board renders through this default; nothing
    // about it changes.
    expect(actionsOf(render({}))).toEqual(['message', 'task', 'sequence', 'cold'])
  })
})

describe('DealCard — Cold is hidden on a manual board', () => {
  it('drops Cold from the menu when manual is true', () => {
    expect(actionsOf(render({ manual: true }))).toEqual(['message', 'task', 'sequence'])
  })

  it('keeps the other three actions', () => {
    const actions = actionsOf(render({ manual: true }))
    expect(actions).toContain('message')
    expect(actions).toContain('task')
    expect(actions).toContain('sequence')
  })
})

describe('DealCard — Task follows Contacts at the board\'s studio (C146 TASKSNEEDCONTACTS.1)', () => {
  it('drops Task when canTask is false, on either board', () => {
    expect(actionsOf(render({ canTask: false }))).toEqual(['message', 'sequence', 'cold'])
    expect(actionsOf(render({ manual: true, canTask: false }))).toEqual(['message', 'sequence'])
  })

  it('keeps Task when canTask is true', () => {
    expect(actionsOf(render({ canTask: true }))).toContain('task')
  })
})

// HATCHPIPE.5 — a board with the next-class badge switched off (a un1t.online
// board: boardCardOptionsForModule) shows neither "No class booked" nor
// "Next: …". Stillorgan's cards (badge on) render byte-identically: the markup
// below was recorded against DealCard BEFORE this change.
describe('DealCard — next-class chip follows the board badge', () => {
  const card = (contacts, extra = {}) => renderToStaticMarkup(
    <DealCard
      deal={{ id: 'd-9', title: 'Bea', age: { stage: '3d', total: '2w', backfilled: false, tone: 'quiet' }, contacts, ...extra }}
      locationId="l-1" timezone="Europe/Dublin" stageName="1st Class"
    />,
  )
  const NEXT = '2026-10-20T18:00:00.000Z'

  it('Stillorgan, booked: markup unchanged', () => {
    expect(card({ id: 'c-9', name: 'Bea B', pipeline_stage_slug: 'first_class', lead_source: 'web', trial_credits_remaining: 2, next_class_at: NEXT }))
      .toMatchInlineSnapshot(`"<div class="relative mb-2"><div class="block bg-un1t-bg border border-un1t-border border-l-green-500 border-l-2 rounded-md p-3 hover:border-un1t-muted transition-colors cursor-pointer"><div class="flex items-start justify-between gap-2"><p class="text-sm font-medium truncate flex-1">Bea</p><div data-actions="message,task,sequence,cold"></div></div><div class="flex items-center gap-1.5 mt-1.5 text-xs text-un1t-subtle"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg><span class="truncate">Bea B</span></div><span class="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-un1t-border rounded text-un1t-subtle">web</span><span class="inline-block mt-1.5 ml-1 text-[10px] px-1.5 py-0.5 bg-green-500/10 rounded text-green-700">2 credits</span><span class="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-emerald-500/10 rounded text-emerald-700">Next: Tue, 20 Oct</span><div class="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-un1t-border text-[10px]"><span class="flex items-center gap-1 min-w-0 text-un1t-subtle"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg><span class="truncate">3d in 1st Class</span></span><span class="text-un1t-muted shrink-0">2w total</span></div></div></div>"`)
  })

  it('Stillorgan, nothing booked: markup unchanged (still says No class booked)', () => {
    expect(card({ id: 'c-9', name: 'Bea B', pipeline_stage_slug: 'new_lead', next_class_at: null }))
      .toMatchInlineSnapshot(`"<div class="relative mb-2"><div class="block bg-un1t-bg border border-un1t-border border-l-blue-500 border-l-2 rounded-md p-3 hover:border-un1t-muted transition-colors cursor-pointer"><div class="flex items-start justify-between gap-2"><p class="text-sm font-medium truncate flex-1">Bea</p><div data-actions="message,task,sequence,cold"></div></div><div class="flex items-center gap-1.5 mt-1.5 text-xs text-un1t-subtle"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg><span class="truncate">Bea B</span></div><span class="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/10 rounded text-red-700">No class booked</span><div class="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-un1t-border text-[10px]"><span class="flex items-center gap-1 min-w-0 text-un1t-subtle"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg><span class="truncate">3d in 1st Class</span></span><span class="text-un1t-muted shrink-0">2w total</span></div></div></div>"`)
  })

  it('Stillorgan, off-funnel stage: markup unchanged', () => {
    expect(card({ id: 'c-9', name: 'Bea B', pipeline_stage_slug: 'member', next_class_at: null }))
      .toMatchInlineSnapshot(`"<div class="relative mb-2"><div class="block bg-un1t-bg border border-un1t-border border-l-slate-500 border-l-2 rounded-md p-3 hover:border-un1t-muted transition-colors cursor-pointer"><div class="flex items-start justify-between gap-2"><p class="text-sm font-medium truncate flex-1">Bea</p><div data-actions="message,task,sequence,cold"></div></div><div class="flex items-center gap-1.5 mt-1.5 text-xs text-un1t-subtle"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-user" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg><span class="truncate">Bea B</span></div><div class="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-un1t-border text-[10px]"><span class="flex items-center gap-1 min-w-0 text-un1t-subtle"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock shrink-0" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg><span class="truncate">3d in 1st Class</span></span><span class="text-un1t-muted shrink-0">2w total</span></div></div></div>"`)
  })

  it('badge off (deal.next_class_badge === false): no "No class booked" and no "Next:" line', () => {
    const off = { next_class_badge: false }
    for (const slug of ['new_lead', 'first_class', 'second_class', 'trial_done']) {
      const none = card({ id: 'c-9', name: 'Bea B', pipeline_stage_slug: slug, next_class_at: null }, off)
      expect(none, slug).not.toContain('No class booked')
      expect(none, slug).not.toContain('Next:')
      // a stale next_class_at cannot sneak a chip back either
      expect(card({ id: 'c-9', name: 'Bea B', pipeline_stage_slug: slug, next_class_at: NEXT }, off), slug).not.toContain('Next:')
    }
    // the rest of the card is still there
    expect(card({ id: 'c-9', name: 'Bea B', pipeline_stage_slug: 'new_lead', next_class_at: null }, off)).toContain('3d in 1st Class')
  })

  it('through the real mappers: a un1t.online board card has no chip; a Glofox board card keeps it', async () => {
    const { boardDealMapper, boardCardOptionsForModule } = await import('@/lib/pipeline-board')
    const row = { id: 'd-9', title: 'Bea', created_at: '2026-10-01T00:00:00Z', stage_entered_at: '2026-10-10T00:00:00Z',
      contacts: { id: 'c-9', name: 'Bea B', pipeline_stage_slug: 'first_class', recent_bookings: [] } }
    const render2 = (d) => renderToStaticMarkup(<DealCard deal={d} locationId="l-1" stageName="1st Class" />)
    const hatch = render2(boardDealMapper(boardCardOptionsForModule('acquisition_un1t'))(row))
    expect(hatch).not.toContain('No class booked')
    const still = render2(boardDealMapper(boardCardOptionsForModule('acquisition'))(row))
    expect(still).toContain('No class booked')
  })
})

// HATCHCOLD.2 — Cold follows the board's column and studio, not the contact's
// home studio (whose slug can say something else for a dual-studio contact).
describe('DealCard — Cold on the board it is drawn on', () => {
  const bar = () => globalThis.__dealCardBarProps
  const coldAtHome = { ...DEAL, contacts: { ...DEAL.contacts, pipeline_stage_slug: 'cold_lead' } }

  it('the column slug decides the Cold label over the home slug', () => {
    render({ stageSlug: 'cold_lead' })
    expect(bar().isCold).toBe(true)
    renderToStaticMarkup(<DealCard deal={coldAtHome} locationId="l-1" stageName="New Enquiry" stageSlug="new_lead" />)
    expect(bar().isCold).toBe(false)
  })
  it('falls back to the home slug when no column slug is given', () => {
    renderToStaticMarkup(<DealCard deal={coldAtHome} locationId="l-1" stageName="Cold" />)
    expect(bar().isCold).toBe(true)
  })
  it('hands the board\'s studio to the action bar', () => {
    render({})
    expect(bar().boardLocationId).toBe('l-1')
  })
})

// HATCHCARD.1 — a un1t.online board's card shows the person's signals.
describe('DealCard — un1t card signals (HATCHCARD.1)', () => {
  const SIG = { classes_attended: 1, credits_left: 2, credits_unlimited: false, next_class_at: null, last_class_days: 9, last_class_warm: true, wa_state: 'no_reply', wa_days: 6 }
  const deal = (signals, slug = 'first_class', over = {}) => ({
    id: 'd-9', title: 'Jane O\'Quigley', next_class_badge: false, signals, showSignals: true, classesOf3: true,
    contacts: { id: 'c-9', name: 'Jane O\'Quigley', lead_source: 'website', pipeline_stage_slug: slug },
    ...over,
  })
  const r = (d, stageSlug = d.contacts.pipeline_stage_slug) => renderToStaticMarkup(<DealCard deal={d} locationId="l-1" stageName="1st Class" stageSlug={stageSlug} />)

  it('acquisition column: classes of 3, credits left, no class booked, last class amber, no reply', () => {
    const html = r(deal(SIG))
    expect(html).toContain('1 of 3 classes')
    expect(html).toContain('2 credits left')
    expect(html).toContain('No class booked')
    expect(html).toContain('Last class 9d ago')
    expect(html).toMatch(/bg-amber-500\/10 text-amber-700">Last class 9d ago</)
    expect(html).toContain('No reply, 6d')
    expect(html).toContain('website')
  })
  it('drops the contact line that only repeats the title', () => {
    const html = r(deal(SIG))
    expect(html.match(/Jane O(&#x27;|')Quigley/g)).toHaveLength(1)
  })
  it('singulars, unlimited credits, a booked class, a reply, today', () => {
    const html = r(deal({ ...SIG, classes_attended: 1, credits_left: null, credits_unlimited: true, next_class_at: '2026-11-03T08:00:00Z', last_class_days: 0, last_class_warm: false, wa_state: 'replied', wa_days: 0 }, 'paid_trial_first_class', { classesOf3: false }))
    expect(html).toContain('1 class')
    expect(html).not.toContain('of 3')
    expect(html).toContain('Unlimited')
    expect(html).toContain('Next:')
    expect(html).not.toContain('No class booked')
    expect(html).toContain('Last class today')
    expect(html).toContain('Replied today')
    expect(html).not.toContain('credits left')
    expect(html).toMatch(/bg-un1t-border text-un1t-subtle">Last class today</)   // not amber within a week
  })
  it('a never-trained lead: 0 of 3, no last-class chip, never messaged', () => {
    const html = r(deal({ ...SIG, classes_attended: 0, last_class_days: null, last_class_warm: false, wa_state: 'never', wa_days: null }, 'new_lead'))
    expect(html).toContain('0 of 3 classes')
    expect(html).not.toContain('Last class')
    expect(html).toContain('Never messaged')
  })
  it('more than three classes reads as a count, not "4 of 3"', () => {
    expect(r(deal({ ...SIG, classes_attended: 4 }, 'trial_done'))).toContain('4 classes')
  })
  it('null signals (a contact the read had nothing for) render no chips and keep the contact line', () => {
    const html = r(deal(null))
    expect(html).not.toContain('classes')
    expect(html).not.toContain('Never messaged')
  })
  it('a Converted or pile column shows no signal chips even when a deal carries them', () => {
    const html = r(deal(SIG, 'converted', { showSignals: false }), 'converted')
    expect(html).not.toContain('of 3 classes')
    expect(html).not.toContain('No reply')
  })
  it('renders signals iff the server said showSignals, whatever the slug', () => {
    expect(r(deal(SIG, 'my_custom_stage'), 'my_custom_stage')).toContain('of 3 classes')
    expect(r(deal(SIG, 'new_lead', { showSignals: false }), 'new_lead')).not.toContain('of 3 classes')
    expect(r(deal(SIG, 'new_lead', { showSignals: undefined }), 'new_lead')).not.toContain('of 3 classes')
  })
  it('classesOf3OnlyOnAcquisition', () => {
    // the server decides by board kind; the slug prefix no longer matters
    const sig = { ...SIG, classes_attended: 2 }
    expect(r(deal(sig, 'paid_trial_first_class', { classesOf3: false }))).toContain('2 classes')
    expect(r(deal(sig, 'paid_trial_first_class', { classesOf3: false }))).not.toContain('of 3')
    expect(r(deal(sig, 'bought', { classesOf3: false }))).toContain('2 classes')       // offer board
    expect(r(deal(sig, 'bought', { classesOf3: false }))).not.toContain('of 3')
    expect(r(deal(sig, 'paid_trial_odd_slug', { classesOf3: true }))).toContain('2 of 3 classes')   // acquisition, any slug
    expect(r(deal(sig, 'first_class', { classesOf3: undefined }))).toContain('2 classes')
  })
  it('a Glofox card (no signals key) renders exactly as before', () => {
    const glofox = { id: 'd-1', title: 'Ada', contacts: { id: 'c-1', name: 'Ada Lovelace', pipeline_stage_slug: 'new_lead', lead_source: 'website', trial_credits_remaining: 3 } }
    const html = renderToStaticMarkup(<DealCard deal={glofox} locationId="l-1" stageName="New Leads" />)
    expect(html).toContain('Ada Lovelace')
    expect(html).toContain('3 credits')
    expect(html).toContain('No class booked')
    expect(html).not.toContain('of 3 classes')
    expect(html).not.toContain('messaged')
  })
})

// HATCHCARD.2 — the trial's end on the card.
describe('DealCard — trial end chip (HATCHCARD.2)', () => {
  const base = { classes_attended: 0, credits_left: null, credits_unlimited: true, next_class_at: null, last_class_days: null, last_class_warm: false, wa_state: 'never', wa_days: null, trial_kind: null, trial_ends_at: null, trial_days_left: null, trial_ended_days: null }
  const card = (sig, slug = 'paid_trial_new_lead', tz = 'Europe/Dublin') => renderToStaticMarkup(
    <DealCard deal={{ id: 'd', title: 'Aoife Morgan', next_class_badge: false, showSignals: true, signals: { ...base, ...sig }, contacts: { id: 'c', name: 'Aoife Morgan', pipeline_stage_slug: slug } }}
      locationId="l-1" stageName="New Leads" stageSlug={slug} timezone={tz} />,
  )
  it('a running €39 trial: its end date in the studio zone and the days left', () => {
    const html = card({ trial_kind: 'paid', trial_ends_at: '2026-11-15T12:16:53Z', trial_days_left: 13 })
    expect(html).toContain('€39 trial ends 15 Nov · 13d left')
    expect(html).toMatch(/bg-un1t-border text-un1t-subtle">€39 trial ends/)
  })
  it('three days or fewer left turns amber; a free trial says Trial', () => {
    const html = card({ trial_kind: 'free', trial_ends_at: '2026-11-04T09:00:00Z', trial_days_left: 2 }, 'new_lead')
    expect(html).toMatch(/bg-amber-500\/10 text-amber-700">Trial ends 4 Nov · 2d left</)
  })
  it('ending later today: "ends today", amber (HATCHCARD.4)', () => {
    expect(card({ trial_kind: 'paid', trial_ends_at: '2026-11-02T20:00:00Z', trial_days_left: 0 }))
      .toMatch(/bg-amber-500\/10 text-amber-700">€39 trial ends today</)
  })
  it('an ended trial: how long ago, amber', () => {
    expect(card({ trial_kind: 'free', trial_ends_at: '2026-10-30T09:00:00Z', trial_ended_days: 3 }, 'first_class'))
      .toMatch(/bg-amber-500\/10 text-amber-700">Trial ended 3d ago</)
    expect(card({ trial_kind: 'paid', trial_ends_at: '2026-11-02T09:00:00Z', trial_ended_days: 0 }, 'paid_trial_done'))
      .toContain('€39 trial ended today')
  })
  it('no studio zone: days only, never a date in the wrong zone', () => {
    const html = card({ trial_kind: 'paid', trial_ends_at: '2026-11-15T12:16:53Z', trial_days_left: 13 }, 'paid_trial_new_lead', null)
    expect(html).toContain('€39 trial ends in 13d')
    expect(html).not.toContain('15 Nov')
  })
  it('no trial known, or no end known: no chip', () => {
    expect(card({})).not.toContain('trial ')
    expect(card({ trial_kind: 'free' }, 'new_lead')).not.toMatch(/Trial (ends|ended)/)
  })
})
