'use client'

// Pipeline kanban card. DRAWER.5 — clicking the card body no longer
// hard-navigates to /contacts/[id]; it opens the contact slide-over via
// the onOpenContact callback KanbanBoard provides (which writes the
// ?contact=<id> search param, so back-button and refresh restore the
// drawer). The kebab menu (PersonActionBar) still offers the shared
// per-contact actions without leaving the kanban view.
//
// PERSON-ACTIONS.1 — the bespoke 3-dots menu + "Add to sequence" modal
// that used to live here moved into the reusable PersonActionBar so the
// pipeline card, contact header, etc. share one consistent affordance.

import { User, Clock } from 'lucide-react'
import PersonActionBar from './PersonActionBar'
import { personActionsFor } from '@/lib/activity-write-gate'
import { nextClassLabel } from '@/components/contact/format'
import { useViewerZone } from '@/lib/use-viewer-zone'
import { SIGNAL_SLUGS } from '@/lib/pipeline-card-signal-slugs'

// HATCHCARD.1 — a un1t.online board's card shows the person's signals (the
// server attaches deal.signals: src/lib/pipeline-card-signals.js). Chip tones
// follow the light-theme recipe (bg-<c>-500/10 text-<c>-700); literal classes
// so the guardrails linter can see them. The tone is the LAST class on each
// chip.
const CHIP = 'inline-block text-[10px] px-1.5 py-0.5 rounded'
const TONE = {
  neutral: 'bg-un1t-border text-un1t-subtle',
  classes: 'bg-teal-500/10 text-teal-700',
  credits: 'bg-purple-500/10 text-purple-700',
  good:    'bg-emerald-500/10 text-emerald-700',
  warn:    'bg-amber-500/10 text-amber-700',
  bad:     'bg-red-500/10 text-red-700',
}
const ago = (d) => (d === 0 ? 'today' : `${d}d ago`)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()

// HATCHCARD.2 — "15 Nov" in the board studio's zone. Server and browser format
// with the same zone, so SSR and hydration agree; without a zone the card shows
// days only rather than a date that could be a day out.
const TRIAL_WARN_DAYS = 3
function shortDate(iso, zone) {
  if (!iso || !zone) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  try {
    return new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'short', timeZone: zone }).format(t)
  } catch {
    return null
  }
}
function trialChip(sig, zone) {
  if (!sig?.trial_kind) return null
  const name = sig.trial_kind === 'paid' ? '€39 trial' : 'Trial'
  if (sig.trial_days_left === 0) return { text: `${name} ends today`, tone: TONE.warn }
  if (sig.trial_days_left != null) {
    const date = shortDate(sig.trial_ends_at, zone)
    const text = date ? `${name} ends ${date} · ${sig.trial_days_left}d left` : `${name} ends in ${sig.trial_days_left}d`
    return { text, tone: sig.trial_days_left <= TRIAL_WARN_DAYS ? TONE.warn : TONE.neutral }
  }
  if (sig.trial_ended_days != null) return { text: `${name} ended ${ago(sig.trial_ended_days)}`, tone: TONE.warn }
  return null
}

// PIPE-AGE.1 footer tones — colour keys on the server-derived
// deal.age.tone (time in stage, falling back to time in pipeline).
// Literal classes so the guardrails linter can see them.
const AGE_TONES = {
  quiet: 'text-un1t-subtle',
  warm:  'text-amber-700',
  stale: 'text-red-700',
}

// Keyed on pipeline_stage_slug (FUNNEL.1 taxonomy).
const statusColors = {
  new_lead:     'border-l-blue-500',
  first_class:  'border-l-green-500',
  second_class: 'border-l-teal-500',
  trial_done:   'border-l-amber-500',
  converted:    'border-l-emerald-500',
  member:       'border-l-slate-500',
  pack_member:  'border-l-cyan-600',
  classpass:    'border-l-purple-500',
  gympass:      'border-l-orange-500',
  cold_lead:    'border-l-zinc-600',
  dormant:      'border-l-gray-500',
}

// WAITLIST.5 — the Cold button is a DERIVED-board affordance. All it does is
// write contacts.pipeline_dismissed_at, and the only thing that reads that
// stamp is the classifier (shared/pipeline-classifier.js), which never runs on
// a manual board. So on Hatch Street's waitlist board the item is at best a
// second, invisible way to say what column 4 ("Not interested") already says
// by hand — and at worst it looks like a move and produces none.
//
// WAITLIST.6 closed the two call sites this note used to leave open.
// ContactDrawer takes `manual` straight from KanbanBoard (which already knows
// the board), and ContactHeaderBand takes it from its server page, which
// resolves the contact's location's primary pipeline in a round trip it was
// making anyway — so neither pays a per-render lookup after all. Both default
// to `derived`, so a caller that cannot resolve a board still shows Cold.
const CARD_ACTIONS = {
  derived: ['message', 'task', 'sequence', 'cold'],
  manual: ['message', 'task', 'sequence'],
}

// Funnel columns 1–4 show the next-class badge; Converted and the
// off-funnel stages don't (it'd be noise there).
const BADGE_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])

// C146 TASKSNEEDCONTACTS.1 — `canTask` (the pipeline page's
// canWriteActivitiesAt at the board's studio) drops the Task item where the
// person cannot read Contacts. Defaults true so a caller that does not judge
// it keeps today's menu; the pipeline page always passes it.
// TZ.16 (D3 = A) — `timezone` is the board's studio zone; the next-class chip
// reads in it, with the abbreviation only when the viewer's browser is elsewhere.
export default function DealCard({ deal, locationId, timezone = null, stageName, stageSlug = null, onOpenContact, manual = false, canTask = true }) {
  const viewerZone = useViewerZone()
  const contact = deal.contacts || {}
  const borderColor = statusColors[contact.pipeline_stage_slug] || 'border-l-blue-500'

  // Age footer (PIPE-AGE.1; backfilled in PIPE-AGE.2 so both metrics
  // show on every card): time in current stage when the stage stamp
  // exists, else time in pipeline. Strings are server-derived
  // (toBoardDeal) so SSR and hydration render identical text.
  // Colour only alarms on the four active funnel stages — a long stay
  // in Member/Converted/dormant piles is fine (or good), not stale.
  // HATCHPIPE.5 — a board with the next-class badge off (a un1t.online board,
  // boardDealMapper) marks its deals next_class_badge:false: no "Next: …" and
  // no "No class booked" there, since the badge never looked for a booking.
  const showClassBadge = deal.next_class_badge !== false && BADGE_SLUGS.has(contact.pipeline_stage_slug)
  const age = deal.age || {}
  const ageTone = BADGE_SLUGS.has(contact.pipeline_stage_slug)
    ? (AGE_TONES[age.tone] || AGE_TONES.quiet)
    : AGE_TONES.quiet
  const primaryAge = age.stage
    ? (age.stage === 'today' ? `Entered ${stageName || 'stage'} today` : `${age.stage} in ${stageName || 'stage'}`)
    : (age.total
      ? (age.backfilled
        ? "In pipeline since May '26"
        : (age.total === 'today' ? 'Joined pipeline today' : `${age.total} in pipeline`))
      : null)
  const secondaryAge = age.stage && age.total
    ? (age.backfilled ? "since May '26" : `${age.total} total`)
    : null

  // HATCHCARD.1 — signals render only in a live funnel column (this board's
  // column, not the home studio's slug), and only when the server sent them.
  const columnSlug = stageSlug ?? contact.pipeline_stage_slug
  const sig = deal.signals && SIGNAL_SLUGS.has(columnSlug) ? deal.signals : null
  const paidBoard = typeof columnSlug === 'string' && columnSlug.startsWith('paid_trial_')
  const classesLabel = sig
    ? (!paidBoard && sig.classes_attended <= 3
      ? `${sig.classes_attended} of 3 classes`
      : plural(sig.classes_attended, 'class', 'classes'))
    : null
  const trial = sig ? trialChip(sig, timezone) : null

  function openContact() {
    if (!contact.id || !onOpenContact) return
    onOpenContact(contact.id)
  }

  return (
    <div className="relative mb-2">
      <div
        onClick={openContact}
        className={`block bg-un1t-bg border border-un1t-border ${borderColor} border-l-2 rounded-md p-3 hover:border-un1t-muted transition-colors cursor-pointer`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium truncate flex-1">{deal.title}</p>
          {contact.id && (
            <PersonActionBar
              contactId={contact.id}
              locationId={locationId}
              actions={personActionsFor(CARD_ACTIONS[manual ? 'manual' : 'derived'], { canTask })}
              // HATCHCOLD.2 — this board's column, not the home studio's slug
              // (contacts.pipeline_stage_slug), which differs for a contact
              // whose home is another studio.
              isCold={(stageSlug ?? contact.pipeline_stage_slug) === 'cold_lead'}
              boardLocationId={locationId}
            />
          )}
        </div>
        {contact.name && !(sig && sameName(contact.name, deal.title)) && (
          <div className="flex items-center gap-1.5 mt-1.5 text-xs text-un1t-subtle">
            <User size={12} />
            <span className="truncate">{contact.name}</span>
          </div>
        )}
        {contact.lead_source && (
          <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-un1t-border rounded text-un1t-subtle">
            {contact.lead_source}
          </span>
        )}
        {contact.trial_credits_remaining != null && BADGE_SLUGS.has(contact.pipeline_stage_slug) && (
          <span className="inline-block mt-1.5 ml-1 text-[10px] px-1.5 py-0.5 bg-green-500/10 rounded text-green-700">
            {contact.trial_credits_remaining} credits
          </span>
        )}
        {sig && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            <span className={`${CHIP} ${sig.classes_attended > 0 ? TONE.classes : TONE.neutral}`}>{classesLabel}</span>
            {sig.credits_unlimited ? (
              <span className={`${CHIP} ${TONE.credits}`}>Unlimited</span>
            ) : sig.credits_left != null ? (
              <span className={`${CHIP} ${sig.credits_left > 0 ? TONE.credits : TONE.warn}`}>{plural(sig.credits_left, 'credit left', 'credits left')}</span>
            ) : null}
            {trial && <span className={`${CHIP} ${trial.tone}`}>{trial.text}</span>}
            {sig.next_class_at ? (
              <span className={`${CHIP} ${TONE.good}`}>Next: {nextClassLabel(sig.next_class_at, timezone, viewerZone)}</span>
            ) : (
              <span className={`${CHIP} ${TONE.bad}`}>No class booked</span>
            )}
            {sig.last_class_days != null && (
              <span className={`${CHIP} ${sig.last_class_warm ? TONE.warn : TONE.neutral}`}>Last class {ago(sig.last_class_days)}</span>
            )}
            {sig.wa_state === 'replied' ? (
              <span className={`${CHIP} ${TONE.good}`}>{sig.wa_days == null ? 'Replied' : `Replied ${ago(sig.wa_days)}`}</span>
            ) : sig.wa_state === 'no_reply' ? (
              <span className={`${CHIP} ${TONE.warn}`}>{sig.wa_days == null ? 'No reply' : `No reply, ${sig.wa_days}d`}</span>
            ) : (
              <span className={`${CHIP} ${TONE.neutral}`}>Never messaged</span>
            )}
          </div>
        )}
        {showClassBadge && (
          contact.next_class_at ? (
            <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-emerald-500/10 rounded text-emerald-700">
              Next: {nextClassLabel(contact.next_class_at, timezone, viewerZone)}
            </span>
          ) : (
            <span className="inline-block mt-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/10 rounded text-red-700">
              No class booked
            </span>
          )
        )}
        {primaryAge && (
          <div className="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-un1t-border text-[10px]">
            <span className={`flex items-center gap-1 min-w-0 ${ageTone}`}>
              <Clock size={11} className="shrink-0" />
              <span className="truncate">{primaryAge}</span>
            </span>
            {secondaryAge && (
              <span className="text-un1t-muted shrink-0">{secondaryAge}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
