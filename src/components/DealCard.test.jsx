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
