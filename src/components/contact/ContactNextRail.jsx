// CC.2 — the "what happens next" rail of the command-centre contact
// page: needs-attention, open tasks, active sequences, upcoming event
// registrations, deals, races, HR devices, and the admin actions
// cluster at the bottom. Server component — cards moved verbatim from
// the old Overview / Activity / Admin tabs.

import { CheckSquare, Clock } from 'lucide-react'
import ContactRaceHistory from '@/components/ContactRaceHistory'
import ContactEditDeleteActions from '@/components/ContactEditDeleteActions'
import InviteToAppButton from '@/components/InviteToAppButton'
import ContactAppAccountCard from '@/components/ContactAppAccountCard'
import MemberPasswordOverrideButton from '@/components/MemberPasswordOverrideButton'
import ContactDevicesCard from '@/components/ContactDevicesCard'
import { UpcomingEventsCard } from './EventRegistrationsCards'
import { relativeTime, formatTime } from './format'

const ATTENTION_TONE = {
  danger: { dot: 'bg-red-500', text: 'text-red-700' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-700' },
}

export default function ContactNextRail({
  contact,
  attention = [],
  openTasks = [],
  sequences = [],
  upcomingBookings = [],
  deals = [],
  admin, // { canEditDelete, canPasswordOverride, canInvite, hasUserAccount, canEditDevices, canLinkAccount }
}) {
  return (
    <>
      {/* Needs attention — derived, forward-looking (contact-view lib). */}
      {attention.length > 0 && (
        <div className="bg-un1t-surface border border-red-200 rounded-lg p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-red-700 mb-2">Needs attention</h3>
          {attention.map((a) => {
            const tone = ATTENTION_TONE[a.tone] || ATTENTION_TONE.warn
            return (
              <div key={a.key} className="flex items-start gap-2 py-1.5">
                <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${tone.dot}`} />
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${tone.text}`}>{a.label}</p>
                  {a.detail && <p className="text-xs text-un1t-subtle">{a.detail}</p>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Open tasks — manual to-dos only (mig 073). */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Open tasks</h3>
        {openTasks.length === 0 && (
          <p className="text-sm text-un1t-muted">No open tasks</p>
        )}
        {openTasks.map(a => (
          <div key={a.id} className="flex items-start gap-2 py-2 border-b border-un1t-border last:border-0">
            <CheckSquare size={14} className="text-un1t-muted mt-0.5 shrink-0" />
            <div>
              <p className="text-sm">{a.subject}</p>
              {a.due_date && (
                <p className="text-xs text-un1t-subtle flex items-center gap-1 mt-0.5">
                  <Clock size={10} /> {a.due_date} {a.due_time ? formatTime(a.due_time) : ''}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* CHURN-CONTACT.1 — Active sequences: what's queued to happen
          next, so you can see (and not double-enrol) an automation
          already running for this contact. */}
      {sequences.length > 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3 flex items-center gap-1.5">
            <Clock size={12} /> Active sequences
          </h3>
          {sequences.map((s) => (
            <div key={s.id} className="flex items-center justify-between py-2 border-b border-un1t-border last:border-0">
              <span className="text-sm">{s.email_sequences?.name || 'Sequence'}</span>
              <span className="text-xs text-un1t-muted whitespace-nowrap">
                {s.next_step_at ? `next ${relativeTime(s.next_step_at)}` : 'queued'}
              </span>
            </div>
          ))}
        </div>
      )}

      <UpcomingEventsCard bookings={upcomingBookings} />

      {/* Deals */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Deals</h3>
        {deals.length === 0 && <p className="text-sm text-un1t-muted">No deals</p>}
        {deals.map(deal => (
          <div key={deal.id} className="flex items-center justify-between py-2 border-b border-un1t-border last:border-0">
            <span className="text-sm">{deal.title}</span>
            <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: deal.pipeline_stages?.color + '30', color: deal.pipeline_stages?.color }}>
              {deal.pipeline_stages?.name}
            </span>
          </div>
        ))}
      </div>

      {/* Race-event history (mig 086; HOST-MASTER.6b — host + internal
          events, hence "Events"). Always rendered; the component shows
          a "no races yet" message when empty. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Events</h3>
        <ContactRaceHistory contactId={contact.id} />
      </div>

      {/* HR devices: chest strap MAC registry. */}
      <ContactDevicesCard contactId={contact.id} canEdit={admin.canEditDevices} />

      {/* REPSET-P5 — App account link state + admin link/unlink tool.
          Master/owner only (staff never self-link their member contact —
          the Repset app hard-disables self-linking for anyone with
          has_ever_been_staff; an admin links from here instead). */}
      {admin.canLinkAccount && (
        <ContactAppAccountCard contactId={contact.id} contactName={contact.name} />
      )}

      {/* Admin actions — edit / delete, app invite, password override.
          Each keeps its existing permission gate. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">Admin</h3>
        <div className="flex flex-wrap items-center gap-3">
          {/* AUTH.1 — admin password override for members with a linked
              CRM auth account. Master/owner only; contacts without a
              user_id link have no CRM login to reset. */}
          {admin.canPasswordOverride && (
            <MemberPasswordOverrideButton
              contactId={contact.id}
              contactLabel={contact.name || contact.email || 'this contact'}
            />
          )}
          <ContactEditDeleteActions
            contact={contact}
            canEdit={admin.canEditDelete}
            canDelete={admin.canEditDelete}
          />
          {admin.canInvite && (
            <InviteToAppButton
              contactId={contact.id}
              hasUserAccount={admin.hasUserAccount}
            />
          )}
          {/* NB: "Create in Glofox" (CreateInGlofoxButton) is NOT duplicated
              here — it lives inside GlofoxProfileCard for unlinked contacts.
              One place per component, as before. */}
        </div>
      </div>
    </>
  )
}
