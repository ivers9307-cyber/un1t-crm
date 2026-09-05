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
//
// MAIL-ALLLOC.1 — the rail grows a HEAD: location tiles (All + one per
// readable studio), rendered only when `tiles` arrives with 2+ studios. A
// single-location caller passes no tiles and sees exactly the rail that was
// here before, byte for byte. Each studio tile carries its needs-reply count
// as an amber chip when > 0; a null count (digest in flight, or that studio
// unreachable) renders NO chip — an unknown must never dress up as 0.

import { Inbox, Clock, Archive, Send, ShieldAlert, Circle, CircleDot } from 'lucide-react'
import { MAIL_SCOPE_ALL } from './mail-digest'

// Every view has an icon. `sent` shipped without one (MAIL-SENT.1 added the
// view and this map never learnt it — an audit item MAIL-SPAM.1 closed while
// adding `spam`); MailRail.test pins the full set so the next view cannot
// repeat that.
const VIEW_ICONS = { inbox: Inbox, needs_reply: Clock, sent: Send, archived: Archive, spam: ShieldAlert }

/**
 * One location tile. `aria-pressed`, not `aria-current`, for the same reason
 * the account buttons below use it: the scope is a filter over the mail, and
 * the rail's single "where am I" answer stays the view.
 */
function LocationTile({ tile, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        active
          ? 'border-un1t-text bg-un1t-text font-semibold text-un1t-bg'
          : 'border-un1t-border bg-un1t-bg text-un1t-subtle hover:text-un1t-text'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{tile.name}</span>
      {/* The chip is ALWAYS needs-reply, whatever view is active. Zero and
          unknown both render nothing: > 0 is the only number that is a call
          to action, and null must never masquerade as "nothing waiting". */}
      {typeof tile.count === 'number' && tile.count > 0 && (
        <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-700">
          {tile.count}
        </span>
      )}
    </button>
  )
}

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
  // MAIL-ALLLOC.1 — the tile row: [{id, name, count}] with 'all' first, from
  // buildLocationTiles. Undefined/short for single-location callers, whose
  // rail must stay exactly as it was.
  tiles,
  scope,
  onScope,
}) {
  // One mailbox is not a choice — a switcher offering it is furniture that
  // only earns its place once there is something to switch between.
  const manyAccounts = mailboxes.length > 1
  // All + 2 studios is the floor; All + 1 studio is not a choice either.
  const manyLocations = Array.isArray(tiles) && tiles.length > 2
  const allMode = manyLocations && scope === MAIL_SCOPE_ALL

  return (
    <nav
      aria-label="Mail folders"
      className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-un1t-border bg-un1t-surface p-2"
    >
      {manyLocations ? (
        <>
          <p className="px-2 pb-1 pt-0.5 text-[10px] font-bold uppercase tracking-widest text-un1t-muted">
            Location
          </p>
          <div className="flex flex-col gap-1 border-b border-un1t-border pb-2 mb-1">
            {tiles.map(t => (
              <LocationTile
                key={t.id}
                tile={t}
                active={t.id === scope}
                onClick={() => onScope?.(t.id)}
              />
            ))}
          </div>
        </>
      ) : locationLabel ? (
        <p className="px-2 pb-2 pt-0.5 text-[10px] font-bold uppercase tracking-widest text-un1t-muted">
          {locationLabel}
        </p>
      ) : null}

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

      {/* MAIL-ALLLOC.1 — the account filter exists ONLY when scoped to one
          studio. All mode never enumerates accounts (six addresses across
          two studios is rail soup — the locked design); where the chips
          would sit, a quiet disclosure says how to get them back. */}
      {allMode && (
        <p className="px-2 pb-1 pt-2 text-[10px] leading-relaxed text-un1t-muted">
          Pick a studio to filter by account.
        </p>
      )}

      {!allMode && manyAccounts && (
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
