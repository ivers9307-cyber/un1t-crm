// CC.2 — command-centre header band for /contacts/[id].
//
// Everything the operator should see without scrolling, whatever else
// they're doing on the page: member photo + PersonHeader (name, stage
// pill, linked chip), the churn-radar risk chip + PersonActionBar in
// the actions slot, alert chips (needs-attention + credits + next
// class), and a health-stats strip (LTV / arrears / attended / deals /
// first-90 / last attended). Server component — all data via props.

import PersonHeader from '@/components/PersonHeader'
import PersonActionBar from '@/components/PersonActionBar'
// HOST-MASTER.6 — "No auto-enrol" chip + Manager+ toggle (client component).
import AutomationsExemptToggle from '@/components/AutomationsExemptToggle'
import { formatLastSeen } from '@/lib/person-view'
import { formatMoney, formatDate } from './format'

// PULSE-90.4 — first-90-days journey status chips. Light-theme contrast
// recipe (bg-<c>-500/10 text-<c>-700 — never the -300/-400 ramp).
const PULSE_STATUS_CHIP = {
  on_track:  'bg-emerald-500/10 text-emerald-700',
  completed: 'bg-emerald-500/10 text-emerald-700',
  behind:    'bg-amber-500/10 text-amber-700',
  at_risk:   'bg-red-500/10 text-red-700',
  expired:   'bg-gray-500/10 text-gray-600',
}
const PULSE_STATUS_LABEL = {
  on_track:  'On track',
  completed: 'Completed',
  behind:    'Behind',
  at_risk:   'At risk',
  expired:   'Window over',
}

// CANCEL-FORM.4 — the cancellation-form link chip. Hidden once the link is
// revoked or expired; red once submitted (a request is waiting in Approvals).
export function cancellationLinkChip(link) {
  if (!link || link.revoked_at) return null
  const via = link.channel === 'whatsapp' ? 'WhatsApp' : 'email'
  if (link.used_at) {
    return { label: 'Cancel form submitted', cls: 'bg-red-500/10 text-red-700', title: `Submitted ${new Date(link.used_at).toLocaleDateString('en-IE')} — see Approvals` }
  }
  if (Date.parse(link.expires_at || '') < Date.now()) return null
  if (link.opened_at) {
    return { label: 'Cancel form opened', cls: 'bg-amber-500/10 text-amber-700', title: `Opened ${new Date(link.opened_at).toLocaleDateString('en-IE')}, not submitted yet` }
  }
  return { label: `Cancel form sent`, cls: 'bg-gray-500/10 text-gray-600', title: `Sent by ${via} ${new Date(link.issued_at).toLocaleDateString('en-IE')}, not opened yet` }
}

const ATTENTION_CHIP = {
  danger: 'bg-red-500/10 text-red-700',
  warn: 'bg-amber-500/10 text-amber-700',
}

// Funnel stages show the trial-credit + next-class chips (mirrors the
// DealCard BADGE_SLUGS set).
const BADGE_SLUGS = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])

function StatTile({ label, value, tone = 'default' }) {
  const valueCls = tone === 'danger' ? 'text-red-700' : 'text-un1t-text'
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2 min-w-[92px]">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-un1t-subtle whitespace-nowrap">{label}</p>
      <p className={`text-base font-bold mt-0.5 tabular-nums ${valueCls}`}>{value}</p>
    </div>
  )
}

export default function ContactHeaderBand({ contact, person, risk, journey, metrics, attention = [], nextClassAt = null, canToggleExempt = false, cancellationLink = null }) {
  // CANCEL-FORM.4 — latest issued form link → one chip (sent / opened / submitted).
  const cancelChip = cancellationLinkChip(cancellationLink)
  const funnel = BADGE_SLUGS.has(contact.pipeline_stage_slug)
  const lastAttended = person?.lastAttendedAt || contact.last_attended_at
  // GLOFOX-REACTIVE (mig 428) — membership pause, surfaced prominently
  // beside the name but framed NEUTRAL (amber, not the red "needs
  // attention" band): a paused member is on a planned freeze, not a
  // chase. resume_date comes from the Glofox service webhook; a past
  // date means the pause has lapsed, so we drop the "resumes …" suffix.
  const membershipPaused = contact.glofox_membership_state === 'paused'
  const pauseResumeFuture = membershipPaused && contact.glofox_membership_resume_at
    ? new Date(contact.glofox_membership_resume_at).getTime() > Date.now()
    : false
  const pauseResumeLabel = pauseResumeFuture ? formatDate(contact.glofox_membership_resume_at) : null

  return (
    <div className="mb-6">
      <div className="flex items-start gap-4">
        {/* GLOFOX-PROFILE — member photo (mig 196 glofox_image_url).
            Plain <img>: Glofox CDN URLs aren't whitelisted for
            next/image and adding a remote pattern per third-party
            host isn't worth it for one avatar. */}
        {contact.glofox_image_url && (
          <img
            src={contact.glofox_image_url}
            alt={contact.name || 'Member'}
            className="w-16 h-16 rounded-full object-cover border border-un1t-border shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <PersonHeader
            name={contact.name}
            stageSlug={contact.pipeline_stage_slug}
            linkedCount={person ? person.accounts.length : 1}
          >
            {/* CHURN-CONTACT.1 — the radar's at-risk signal, on the person. */}
            {risk && (
              <span title={risk.title} className={`px-3 py-1 rounded-full text-sm border ${risk.cls}`}>
                {risk.label}
              </span>
            )}
            {/* GLOFOX-REACTIVE — membership pause: prominent but neutral. */}
            {membershipPaused && (
              <span
                title={pauseResumeLabel ? `Membership paused — resumes ${pauseResumeLabel}` : 'Membership paused'}
                className="px-3 py-1 rounded-full text-sm border bg-amber-500/10 text-amber-700 border-amber-500/20"
              >
                Paused{pauseResumeLabel ? ` · resumes ${pauseResumeLabel}` : ''}
              </span>
            )}
            {/* FUNNEL.4 — Message / Task / Sequence + the Cold toggle. */}
            <PersonActionBar
              contactId={contact.id}
              locationId={contact.location_id}
              actions={['message', 'task', 'sequence', 'cancel_form', 'cold']}
              isCold={contact.pipeline_stage_slug === 'cold_lead'}
            />
          </PersonHeader>

          {/* Contact line — phone + email at a glance, clickable, with
              source + created for quick context. */}
          <p className="text-xs text-un1t-subtle mt-1.5 truncate">
            {contact.phone && (
              <a href={`tel:${contact.phone}`} className="hover:text-un1t-text hover:underline">{contact.phone}</a>
            )}
            {contact.phone && contact.email && ' · '}
            {contact.email && (
              <a href={`mailto:${contact.email}`} className="hover:text-un1t-text hover:underline">{contact.email}</a>
            )}
            {(contact.lead_source || contact.source) && (
              <span> · {contact.lead_source || contact.source}</span>
            )}
            {contact.created_at && (
              <span> · added {new Date(contact.created_at).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            )}
          </p>

          {/* Alert chips — needs-attention + funnel context. */}
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {attention.map((a) => (
              <span
                key={a.key}
                title={a.detail}
                className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${ATTENTION_CHIP[a.tone] || ATTENTION_CHIP.warn}`}
              >
                {a.label}
              </span>
            ))}
            {funnel && nextClassAt && (
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700">
                Next: {new Date(nextClassAt).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Dublin' })}
              </span>
            )}
            {funnel && contact.trial_credits_remaining != null && (
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-700">
                {contact.trial_credits_remaining} trial credit{contact.trial_credits_remaining === 1 ? '' : 's'}
              </span>
            )}
            {journey?.inWindow && (
              <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${PULSE_STATUS_CHIP[journey.status] || 'bg-gray-500/10 text-gray-600'}`}>
                First 90: {PULSE_STATUS_LABEL[journey.status] || journey.status}
              </span>
            )}
            {cancelChip && (
              <span title={cancelChip.title} className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${cancelChip.cls}`}>
                {cancelChip.label}
              </span>
            )}
            {/* HOST-MASTER.6 — mig 464 flag on host-sourced contacts. Chip
                for everyone while the flag is on; toggle for Manager+. Not
                rendered at all when the flag is off (non-managers never see
                it; the toggle only appears alongside an active chip). */}
            {contact.automations_exempt && (
              <AutomationsExemptToggle
                contactId={contact.id}
                initial={contact.automations_exempt}
                canToggle={canToggleExempt}
              />
            )}
          </div>
        </div>
      </div>

      {/* Health-stats strip. Uses the person aggregate when grouped,
          single-contact figures otherwise (same sources as the old
          Overview metric grid). */}
      <div className="flex flex-wrap gap-2 mt-4">
        <StatTile label="Lifetime value" value={formatMoney(metrics.ltvCents, metrics.currency) || '—'} />
        <StatTile
          label="Arrears"
          value={metrics.arrearsCents != null ? (formatMoney(metrics.arrearsCents, metrics.currency) || '—') : '—'}
          tone={metrics.arrearsCents > 0 ? 'danger' : 'default'}
        />
        <StatTile label="Attended (30d)" value={metrics.attended} />
        <StatTile label="Deals" value={metrics.deals} />
        {journey?.inWindow && (
          <StatTile label="First 90 days" value={`Day ${journey.dayIndex}/${journey.windowDays} · ${journey.attended}/${journey.target}`} />
        )}
        {lastAttended && (
          <StatTile label="Last attended" value={formatLastSeen(lastAttended)} />
        )}
      </div>
    </div>
  )
}
