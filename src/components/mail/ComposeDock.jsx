'use client'

// MAIL-DOCK.2 — the card a new email is written in.
//
// THIN ON PURPOSE, exactly like MailDock: every branchable decision — which
// modes persist, what Esc does while dirty, who yields the bottom-right slot
// — lives in mail-display.js where it is unit-tested; MailSurface owns the
// state and TicketCompose owns the fields and the send. This file is the
// pixels: the same dark title bar, the same control set and geometry as the
// reader's card, wrapped around TicketCompose's form.
//
// THREE MODES, ONE CARD (MAIL-DOCK.1's vocabulary, verbatim):
//   dock — bottom-right of the Mail pane, the list still working underneath.
//   full — the SAME card at the near-fullscreen takeover (`fixed inset-4`),
//          body centred at the reading measure.
//   min  — only the title bar. The FORM STAYS MOUNTED (the typed draft is
//          the whole reason min exists) — hidden, never removed.
//
// WHERE IT DIVERGES FROM MailDock, AND WHY:
//   • ESC IS HANDLED HERE, SCOPED. Esc from inside the compose fields IS the
//     minimise gesture (Gmail's behaviour), so the card carries its own
//     keydown and stops propagation — the surface's window listener (whose
//     Esc ladder belongs to the READER) never sees it. The ladder itself is
//     the caller's (dirty lives in TicketCompose); this file only routes.
//   • THE TITLE BAR IS ALWAYS VISIBLE, not hidden below md. MailDock hides
//     its bar there because the thread has its own mobile header; this form
//     has no other chrome. A mobile OPEN never reaches this component at all
//     (below md MailSurface renders the Modal composer, byte-for-byte) — the
//     below-md classes here are only the safety net for a desktop window
//     resized mid-draft, where remounting into the Modal would cost the
//     words. That safety net is a full-screen card.
//   • ONE SLOT, TWO OCCUPANTS. `readerOccupancy` ('none'|'bar'|'card') says
//     what the reader currently shows as, so the compose BAR can stack to
//     the LEFT of it; the compose CARD always owns right-4 (the reader's bar
//     shifts instead — MailDock's `shifted`).

import { Minus, Maximize2, Minimize2, X } from 'lucide-react'
import { COMPOSE_MODE_MIN, composeCardTitle } from './mail-preferences'

// The card per mode. Base classes are the resize safety net (a full-screen
// card); everything dock-shaped is md:-prefixed, mirroring MailDock's map.
//
// Exported for dock-geometry.test.js (MAILFIX-DOCK.1), which pins the
// cross-file width agreements AND derives every constant below from the
// shell's own numbers; full literal strings stay, for Tailwind's scanner.
//
// MAILFIX-DOCK.1 — THE GEOMETRY DECISION, stated. This card renders at
// FRAGMENT level (the DOCK.2 invariant: same child slot on every MailSurface
// return path, so a dirty draft survives an empty-state transition), so its
// containing block is the VIEWPORT — there is no positioned ancestor between
// here and the root — while MailDock's is the Mail pane's shell (its padding
// box, 1px inside the shell border). TWO FRAMES, ONE SCREEN: the sidebar is
// viewport-x [0, 224] (Sidebar.jsx md:w-56), the hub's p-6 puts the shell at
// [248, 100vw-24] and its padding box at [249, 100vw-25]. So a reader card
// or bar at the pane's right-4 has its right edge 41px inside the viewport's
// (24 hub pad + 1 shell border + 16); this card's right-4 edge sits 16px
// inside it. Every compose-side constant is written in the VIEWPORT frame
// and carries that 25px difference explicitly.
//
// THE DOCK CARD IS KEYED ON WHAT THE READER SHOWS AS — the width term
// reserves room only for what is actually beside it:
//
//   none → min(1120px, calc(100vw - 288px))    288 = 224 sidebar + 48 hub pad + 16 margin
//          Fills the pane the way the reader card does (left edge at
//          viewport-x 272, 7px right of the reader card's 265 — the frame
//          difference), never touches the sidebar, caps at the approved 1120.
//   bar  → min(1120px, calc(100vw - 672px))    672 = 288 + 24 step + 360 bar cap
//          The reader's minimised bar is parked beside this card, stepped
//          left by 1.5rem + THIS SAME TERM (MailDock.minShifted — the test
//          pins the two equal). Same expression, same min() branch at every
//          width, so the bar's left edge sits a constant ~14px inside the
//          pane (the nominal 16 less the shell's borders) and the bar↔card
//          gap is a constant ~33px. This is the ONLY state in which
//          minShifted is in play, so it is the only state that pays for the
//          reservation.
//   card → cannot occur: one bottom-right slot, MailSurface minimises the
//          reader before this card opens. An unknown occupancy falls back to
//          the RESERVED term — the one that can never overlap anything.
//
// At a 1,280px window this gives: (a) a 992px card with no reader, a 608px
// card beside a parked reader — neither clips the viewport nor covers the
// sidebar; (b) the shifted reader bar at viewport-x [263, 623], fully inside
// the pane's [249, 1255]; (c) at ≥1,792px both terms cap at 1120px and the
// wide-screen side-by-side is the approved layout.
//
// ACCEPTED, with the real numbers: in the `bar` state on narrow-md windows
// the reserved term is small — 768px → 96px card, 960px → 288px, 1024px →
// 352px (1280 → 608, 1440 → 768). Below ~1,000px the intended path is ⤢
// full: one click, a fixed inset-4 takeover that never clips. Do NOT add a
// px floor here — minShifted quotes the same term, so a floor pushes the
// reader bar back off the pane, which is the audit's HIGH.
// dock-geometry.test.js asserts the 768px value so the next change to 672
// meets this edge in a test, not on an iPad.
//
// Assumptions the arithmetic rests on: an OVERLAY scrollbar on <main> (the
// macOS default) — a classic scrollbar (Windows, or "always show") narrows
// the pane by 15–17px that the 100vw terms cannot see, and it comes out of
// the 2rem margins; and the shell's 1px border (plus the card's own) makes
// the visible margins ~14px, not the nominal 16. The card stays at right-4
// rather than right-10: coinciding right edges with the reader card would
// read tidier across the slot swap, but every compose-side constant (288,
// 672, 4.5rem, 624) is derived against right-4 and the 25px mismatch is the
// hub padding showing — cosmetic, so it is left as DOCK.2 shipped it.
export const CONTAINER = {
  full: 'fixed inset-0 z-50 flex flex-col bg-un1t-bg md:inset-4 md:overflow-hidden md:rounded-xl md:border md:border-un1t-border md:shadow-2xl',
}

export const DOCK_BY_READER = {
  none: 'fixed inset-0 z-50 flex flex-col bg-un1t-bg md:absolute md:inset-auto md:bottom-0 md:right-4 md:z-30 md:h-[78vh] md:max-h-[calc(100%-0.5rem)] md:w-[min(1120px,calc(100vw-288px))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
  bar: 'fixed inset-0 z-50 flex flex-col bg-un1t-bg md:absolute md:inset-auto md:bottom-0 md:right-4 md:z-30 md:h-[78vh] md:max-h-[calc(100%-0.5rem)] md:w-[min(1120px,calc(100vw-672px))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
}

// The minimised bar, positioned around whatever the READER currently shows
// as: right-4 when the corner is free (or the reader is the full-screen
// overlay, which holds no corner), left of the reader's 360px bar, left of
// its docked card. Full literal strings so Tailwind's scanner sees every
// class; the widths are MailDock's own, quoted not derived.
// Audit F5 — below md the min shape is a BOTTOM BAR, never the full-sheet
// safety net (dock/full degrade to a full-screen FORM, which makes sense;
// a minimised card's body is hidden, so a full sheet was an opaque blank
// page with a title bar). The bar keeps the whole-bar restore target.
//
// MAILFIX-DOCK.1 — THE COMPOSE-SIDE STEP IS 4.5rem, NOT THE READER'S 1.5rem.
// This bar is viewport-anchored; the reader it steps past is pane-anchored,
// and the pane's right-4 edge sits 41px inside the viewport's (24 hub pad +
// 1 shell border + 16) against this bar's 16. A 1.5rem step measured from
// the viewport therefore landed this bar 17px ON TOP of the reader bar's
// left end at every md+ width (shipped that way since DOCK.2; the reader
// card's, by the same 17px, above ~1,520px). 4.5rem = 24 hub pad + 16
// right-4 + 32 gap — the mirror of the ~33px gap minShifted keeps in the
// other direction (dock-geometry.test.js pins both frame constants and the
// two gaps equal within the borders' rounding).
//
// `bar` — beside the reader's parked BAR — IS CLAMPED EXACTLY LIKE `card`
// below, and for exactly the same reason. An UNCLAMPED calc(4.5rem + 360)
// is a constant 432px offset, so the bar's left edge is 100vw − 792: under
// the sidebar's 224 for EVERY width below 1,016px and past the viewport's
// own left edge below 792px. That is the round-1 BLOCKER's shape moved to
// md-edge widths — this bar paints at fragment level, z-30, so it covers
// the sidebar's bottom-anchored account/Sign-out footer — and the 4.5rem
// step WIDENED the band that reaches it (968 → 1,016), it did not fix it.
//   step  = calc(4.5rem + 360px), the reader bar's cap. Binds at ≥1,056px,
//           where it keeps the 31px gap the frame arithmetic asks for.
//   clamp = calc(100vw - 624px) — the SAME 624 as `card` (224 sidebar + 24
//           hub pad + 16 margin + 360 bar cap), so this bar's left edge is
//           floored at the pane's left margin, viewport-x 264, at every
//           width under ~1,056. It never touches the sidebar and never
//           leaves the viewport.
//   ACCEPTED COST, with the real numbers: below ~1,025px (= 624 clamp + 41
//   reader-frame inset + 360 bar cap) the two parked bars OVERLAP
//   horizontally. Both keep their right-end controls visible — at 768 the
//   compose bar is [264, 624] painting on top and the reader's is
//   [367, 727], showing its right 103px; at 960, [264, 624] over
//   [559, 919]; at 1024 they touch by 1px. Overlapping a bar whose controls
//   stay reachable is strictly better than covering Sign-out, which is what
//   the unclamped step did. dock-geometry.test.js derives the 624 from the
//   named constants and pins both the 1,025 threshold and the 103px.
//
// `card` — beside the reader's DOCKED card — is min(step, clamp):
//   step  = calc(4.5rem + 1120px), the reader card's cap. Its old inner
//           min(1120px, calc(100vw - 2rem)) was DEAD: below 1,152px the
//           clamp is always the smaller branch, above it the 1120 cap always
//           wins, so that fallback never rendered — dropped, not translated.
//   clamp = calc(100vw - 624px), 624 = 224 sidebar + 24 hub pad + 16 margin
//           + 360 bar cap: floors this bar's LEFT edge at the PANE's left
//           margin (viewport-x 264), never the viewport's — a viewport clamp
//           parked a dirty draft over the sidebar's account/Sign-out footer.
//   The clamp binds below ~1,816px (4.5rem + 1120 = 1192 > 100vw - 624).
//   RESIDUAL, accepted and known — the HORIZONTAL half is certain: while a
//   reader card is open under ~1,785px its left edge (265 pane-filling,
//   then 100vw - 1161) is left of 624, so this bar sits under the card's
//   left edge. Beyond ~1,785px the card's left edge clears the bar
//   entirely. The VERTICAL half is NOT pinned here and must not be: this
//   bar sits at the VIEWPORT's bottom, the card at the PANE's, and the gap
//   between them is the hub's header stack (CommsShell p-6 + the h1, the
//   lede and the tabs) against the shell's h-[calc(100vh-13rem)] — which
//   lands the shell's padding-box bottom and this bar's top within a few px
//   of each other, either way, depending on the header's font metrics. So
//   it is a hair of clearance or a hair of overlap, not a number. jsdom
//   cannot see layout (it reports every box as 0x0), so NOTHING asserts it
//   — confirm it with one in-browser look at a reader card + parked compose
//   bar under ~1,785px. Either way the card's reply pill stays clickable.
export const MIN_BY_READER = {
  none: 'fixed bottom-0 inset-x-0 z-50 flex flex-col bg-un1t-bg border-t border-un1t-border md:absolute md:inset-auto md:bottom-0 md:right-4 md:z-30 md:h-auto md:w-[min(360px,calc(100vw-2rem))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
  bar: 'fixed bottom-0 inset-x-0 z-50 flex flex-col bg-un1t-bg border-t border-un1t-border md:absolute md:inset-auto md:bottom-0 md:right-[min(calc(4.5rem+360px),calc(100vw-624px))] md:z-30 md:h-auto md:w-[min(360px,calc(100vw-2rem))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
  card: 'fixed bottom-0 inset-x-0 z-50 flex flex-col bg-un1t-bg border-t border-un1t-border md:absolute md:inset-auto md:bottom-0 md:right-[min(calc(4.5rem+1120px),calc(100vw-624px))] md:z-30 md:h-auto md:w-[min(360px,calc(100vw-2rem))] md:overflow-hidden md:rounded-t-xl md:border md:border-b-0 md:border-un1t-border md:shadow-2xl',
}

export default function ComposeDock({
  mode = 'dock',
  subject,
  readerOccupancy = 'none',
  onMinimise,   // ─ while open
  onRestore,    // the bar (or ─ again) while minimised
  onExpand,     // ⤢ dock → full
  onContract,   // ⤡ full → dock
  onClose,      // ✕ — requestClose (TicketCompose's own dirty-confirm)
  onEscape,     // the dirty-aware ladder — the caller decides, this routes
  footer,       // the submit row, moved inside the card bottom
  children,     // TicketCompose's form
}) {
  const min = mode === COMPOSE_MODE_MIN
  const full = mode === 'full'

  // MAILFIX-DOCK.1 — the dock card's width reserves room only for a parked
  // reader bar (DOCK_BY_READER); an unknown occupancy takes the reserved
  // term, the one that can never overlap anything. An unknown mode is dock.
  const container = min
    ? (MIN_BY_READER[readerOccupancy] || MIN_BY_READER.none)
    : full
      ? CONTAINER.full
      : (DOCK_BY_READER[readerOccupancy] || DOCK_BY_READER.bar)

  // Same icon-button recipe as MailDock — the bar is the house ink, so the
  // hover is a light wash.
  const control = 'shrink-0 rounded p-1 text-un1t-bg/80 transition-colors hover:bg-un1t-bg/15 hover:text-un1t-bg'

  return (
    <section
      aria-label="New email"
      data-compose-mode={mode}
      className={container}
      // 🔴 Esc from inside the compose card is the MINIMISE gesture, not the
      // reader's dismissal — stopPropagation is what keeps the surface's
      // window listener (and its reader Esc ladder) from ever seeing it.
      // Scoped here rather than on window so an Esc pressed with focus
      // OUTSIDE the card changes nothing about a draft it was not aimed at.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // Audit F4 — an Esc cancelling an IME composition (CJK input) is not
        // a dismissal; yanking the card to its bar mid-word is jarring.
        if (e.isComposing || e.keyCode === 229) return
        e.stopPropagation()
        onEscape?.()
      }}
    >
      {/* The dark title bar — MAIL-DOCK.1's exact vocabulary. While minimised
          the WHOLE bar is a restore target, with the controls stopping the
          bubble so ✕ stays a close; ─ doubles as the keyboard-reachable
          restore, same as the reader's bar. */}
      <div
        onClick={min ? onRestore : undefined}
        className={`flex shrink-0 items-center gap-2 bg-un1t-text px-3 py-2 text-un1t-bg ${min ? 'cursor-pointer' : ''}`}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {composeCardTitle(subject)}
        </span>
        <button
          type="button"
          aria-label={min ? 'Restore the email' : 'Minimise the email'}
          title={min ? 'Restore' : 'Minimise'}
          onClick={(e) => { e.stopPropagation(); (min ? onRestore : onMinimise)?.() }}
          className={control}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        {!min && (full ? (
          <button
            type="button"
            aria-label="Restore to docked size"
            title="Restore to docked size"
            onClick={onContract}
            className={control}
          >
            <Minimize2 size={13} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Expand to full screen"
            title="Expand to full screen"
            onClick={onExpand}
            className={control}
          >
            <Maximize2 size={13} aria-hidden="true" />
          </button>
        ))}
        <button
          type="button"
          aria-label="Close the email"
          title="Close"
          onClick={(e) => { e.stopPropagation(); onClose?.() }}
          className={control}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      {/* The form. Minimised = hidden, NOT unmounted — the typed draft is the
          whole reason the bar exists. `hidden` (not md:hidden): a minimised
          compose has no below-md life to preserve, unlike the reader's
          mobile pane. Full mode centres the column at the reading measure. */}
      <div
        className={`${min ? 'hidden ' : ''}flex min-h-0 w-full flex-1 flex-col${full ? ' md:mx-auto md:w-full md:max-w-[680px]' : ''}`}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {children}
        </div>
        {/* The submit footer, inside the card bottom — the Modal's sibling
            footer has no Modal to live in here. */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-un1t-border px-4 py-3">
          {footer}
        </div>
      </div>
    </section>
  )
}
