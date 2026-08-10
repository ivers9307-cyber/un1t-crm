// COMMS-DETAIL-FIX.4 — the send-detail title, when the record's name is
// editable in place (WhatsApp today).
//
// Two defects it replaces. The WhatsApp title was a bare `<input class="w-64">`
// with no border and no background, so (a) it was visually identical to SMS's
// static <h2> — nothing said you could type in it — and (b) at a fixed 256px
// the status pill after it sat at a constant offset, leaving a dead gap after
// a short name and clipping a long one inside the box.
//
// The width is solved with the overlay-sizer idiom rather than JS: an invisible
// twin of the value occupies the same grid cell as the input, so the cell — and
// therefore the input — is exactly as wide as the text, between a sensible
// minimum and the column width. No resize observer, no measurement pass, and it
// is correct on the first paint (a JS measure would flash at the wrong width).

import { Pencil } from 'lucide-react'

export default function EditableSendTitle({
  value = '',
  onChange,
  placeholder = 'Broadcast name…',
  disabled = false,
  ariaLabel = 'Broadcast name',
}) {
  return (
    // -ml-2 cancels the input's own px-2, so the text starts on the same
    // vertical as the static <h2> the other two channels render.
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full -ml-2">
      <span className="grid items-center min-w-0 max-w-full">
        <span
          data-testid="editable-send-title-sizer"
          aria-hidden="true"
          className="col-start-1 row-start-1 invisible whitespace-pre overflow-hidden px-2 min-w-[7rem] max-w-full text-lg font-semibold"
        >
          {value || placeholder}
        </span>
        <input
          data-testid="editable-send-title"
          type="text"
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="col-start-1 row-start-1 w-full min-w-0 bg-transparent rounded-md border border-transparent px-2 text-lg font-semibold text-un1t-text placeholder:text-un1t-muted transition-colors hover:border-un1t-border focus:border-un1t-text/30 focus:outline-none disabled:opacity-70 disabled:hover:border-transparent"
        />
      </span>
      {/* The affordance is the point: a borderless input reads as a heading
          until you happen to click it. Dropped when the record is read-only,
          where it would promise an edit that is refused. */}
      {!disabled && (
        <Pencil
          data-testid="editable-send-title-affordance"
          size={12}
          aria-hidden="true"
          className="shrink-0 text-un1t-muted"
        />
      )}
    </span>
  )
}
