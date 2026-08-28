'use client'

// MAIL-RAIL.1 — the Mail surface's left rail.
//
// It replaces TWO things that used to sit along the top: the view pills
// (Inbox / Needs reply / Archived) and the account tab strip. Both are
// navigation between sets of the same mail, which is what a rail is for, and
// moving them off the top gives the list and the reading pane the full
// height. It is also where Gmail and Outlook put them, so there is nothing
// to learn.
//
// PRESENTATIONAL ONLY: every count is handed in and every click is handed
// back. It never fetches, so it can never disagree with the list about what
// is there.

import { Inbox, Clock, Archive, Circle, CircleDot } from 'lucide-react'

const VIEW_ICONS = { inbox: Inbox, needs_reply: Clock, archived: Archive }

/**
 * ARIA-CURRENT IS SCOPED TO ONE THING ON THIS RAIL: THE VIEW.
 *
 * The view (Inbox / Needs reply / Archived) is what the reading pane is
 * actually showing, so `aria-current="true"` — "this is where you are" — is
 * exactly right for it. The account switcher is a *filter* over that view,
 * not a second "where you are": an operator on "All accounts" + "Inbox" has
 * exactly one location, the inbox, filtered to zero mailboxes in particular.
 * So the account buttons take `aria-pressed` instead, matching the toggle
 * semantics `TabPill` already uses elsewhere in this surface for the same
 * kind of control. This also keeps the rail's `aria-current="true"` count at
 * one, not two — a screen reader asking "where am I" should get one answer.
 */
function RailButton({ current, pressed, icon: Icon, label, count, warn, onClick }) {
  const active = current || pressed
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'true' : undefined}
      aria-pressed={pressed !== undefined ? pressed : undefined}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        active
          ? 'bg-un1t-bg font-semibold text-un1t-text ring-1 ring-inset ring-un1t-border'
          : 'text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      {Icon && <Icon size={14} className="shrink-0 opacity-80" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* A zero is information — "nothing is waiting" — but an unknown count
          is not, and rendering it as 0 would claim nothing is waiting when we
          simply could not find out. */}
      {typeof count === 'number' && (
        <span className={`text-[11px] tabular-nums ${warn && count > 0 ? 'font-semibold text-amber-700' : 'text-un1t-muted'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

export default function MailRail({
  views, viewId, onView,
  mailboxes = [], mailboxId, onMailbox,
  locationLabel,
}) {
  // One mailbox is not a choice — a switcher offering it is furniture that
  // only earns its place once there is something to switch between.
  const manyAccounts = mailboxes.length > 1

  return (
    <nav
      aria-label="Mail folders"
      className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-un1t-border bg-un1t-surface p-2"
    >
      {locationLabel && (
        <p className="px-2 pb-2 pt-0.5 text-[10px] font-bold uppercase tracking-widest text-un1t-muted">
          {locationLabel}
        </p>
      )}

      {views.map(v => (
        <RailButton
          key={v.id}
          current={v.id === viewId}
          icon={VIEW_ICONS[v.id]}
          label={v.label}
          count={v.count}
          warn={v.id === 'needs_reply'}
          onClick={() => onView?.(v.id)}
        />
      ))}

      {manyAccounts && (
        <>
          <div className="mx-2 my-2 h-px bg-un1t-border" />
          <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-un1t-muted">
            Accounts
          </p>
          <RailButton
            pressed={!mailboxId}
            icon={CircleDot}
            label="All accounts"
            onClick={() => onMailbox?.(null)}
          />
          {mailboxes.map(m => (
            <RailButton
              key={m.id}
              pressed={m.id === mailboxId}
              icon={Circle}
              label={m.label || m.address}
              onClick={() => onMailbox?.(m.id)}
            />
          ))}
        </>
      )}
    </nav>
  )
}
