'use client'
// UI-FOUND.2 — Modal primitive.
//
// Accessible dialog: Esc to close, click-backdrop to close, focus moved
// to the panel on open, body scroll locked while open, role="dialog" +
// aria-modal + aria-labelledby. Replaces the bespoke *Modal.jsx
// components (PasswordOverrideModal, ContactBulkDeleteModal, …) which
// each re-implemented overlay + close handling.
//
// 'use client' because it uses effects (key listener, scroll lock,
// focus management). Panel width logic is unit-tested in styles.js.
// Title id comes from useId() — SSR-safe and never read during render
// from a ref (React 19 / react-hooks/refs).
import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { modalPanelClasses } from './styles.js'

// Everything the browser would normally stop on with Tab. `[tabindex]:not(
// [tabindex="-1"])` catches the roving-tabindex widgets; the panel itself is
// tabindex="-1" so it is never in the list.
const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

// ROSTER-FIX.6b-7 — focus a container that is not normally focusable, then take
// the tabindex back off once it loses focus so it never joins the Tab order
// permanently. Used only for the close-time fallbacks below.
function focusTransient(el) {
  if (!el || !el.isConnected || typeof el.focus !== 'function') return false
  if (el.hasAttribute('tabindex')) {
    el.focus()
    return true
  }
  el.setAttribute('tabindex', '-1')
  el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true })
  el.focus()
  return true
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {()=>void} props.onClose
 * @param {React.ReactNode} [props.title]
 * @param {React.ReactNode} [props.footer]  right-aligned action row
 * @param {'sm'|'md'|'lg'|'xl'} [props.size]
 * @param {boolean} [props.dismissable]  when false, Esc / backdrop /
 *   close-button are disabled — for flows that require an explicit
 *   acknowledgement before closing (e.g. a one-time secret reveal).
 *   Defaults to true.
 * @param {boolean} [props.dismissOnBackdrop]  when false, only Esc and the
 *   close button dismiss — a stray click on the backdrop does nothing.
 *   ROSTER-FIX.6b: for modals holding a half-filled form. Deliberately NOT
 *   `dismissable={false}`, which would also take the close button and Esc
 *   away and leave the operator with no exit at all. Defaults to true.
 * @param {React.RefObject<HTMLElement>} [props.restoreFocusRef]  where focus
 *   should land on close when the control that OPENED the dialog is gone from
 *   the DOM by then. ROSTER-FIX.6b-7: two schedule flows unmount their own
 *   trigger (Add-coach closes the block-detail dialog it was clicked in; the
 *   swap icon does the same), so the captured element is disconnected and
 *   focusing it is a no-op that leaves the operator on document.body.
 */
export default function Modal({ open, onClose, title, footer, size = 'md', dismissable = true, dismissOnBackdrop = true, restoreFocusRef, className, children }) {
  const panelRef = useRef(null)
  const titleId = useId()

  // UI-MODAL-FOCUS.1 — the open-effect must depend on `open` ALONE.
  //
  // It previously listed [open, onClose, dismissable]. Every call site passes
  // an inline arrow (onClose={() => setEditing(null)}), which is a fresh
  // function identity on every render — so typing one character into any input
  // inside a modal re-ran this effect, and its panelRef.focus() yanked focus
  // out of the field. The operator had to re-click after EVERY keystroke
  // (reported 2026-08-01 while entering equipment types).
  //
  // Keeping the callbacks in a ref lets the Escape listener always invoke the
  // LATEST props without putting their identity in the deps. Regression-locked
  // in Modal.focus.test.jsx.
  const handlers = useRef({ onClose, dismissable, restoreFocusRef })
  useEffect(() => {
    handlers.current = { onClose, dismissable, restoreFocusRef }
  }, [onClose, dismissable, restoreFocusRef])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && handlers.current.dismissable) {
        handlers.current.onClose?.()
        return
      }
      // ROSTER-FIX.6b — focus trap. Without it Tab walks straight out of the
      // dialog into the page behind it, which is still fully interactive: a
      // keyboard operator ends up editing the calendar underneath an open
      // modal with no visible cursor. aria-modal alone tells assistive tech
      // the background is inert; it does not make Tab obey.
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const list = Array.from(panel.querySelectorAll(FOCUSABLE))
        .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true')
      if (list.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      const outside = !panel.contains(active) || active === panel
      if (e.shiftKey) {
        if (active === first || outside) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || outside) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // ROSTER-FIX.6b — remember where focus came from so it can go back there
    // on close. A keyboard operator who closed a modal was dumped on
    // document.body and had to Tab from the top of the page to get back to
    // the button they had just used.
    const restoreTo = document.activeElement
    // Captured here, not read from the ref in the cleanup: React detaches
    // refs before passive-effect cleanup runs, so panelRef.current is already
    // null by then (react-hooks/exhaustive-deps flags exactly this).
    const panelNode = panelRef.current
    // Move focus into the dialog for keyboard + screen-reader users. This runs
    // on OPEN only — re-running it on every render is the focus-steal bug.
    panelNode?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      // Only reclaim focus if it is still parked inside the (now unmounting)
      // dialog. If the close handler moved focus somewhere deliberate, leave it.
      const stillInside = !document.activeElement || document.activeElement === document.body
        || !!panelNode?.contains(document.activeElement)
      if (!stillInside) return
      // `restoreTo === document.body` is NOT a trigger: it is what
      // activeElement already reads as when the control that opened this
      // dialog was removed in the very commit that opened it (the schedule's
      // stacked flows do exactly that). Focusing body is the no-op the
      // fallbacks below exist to replace.
      const hasTrigger = restoreTo && restoreTo !== document.body
        && typeof restoreTo.focus === 'function' && restoreTo.isConnected
      if (hasTrigger) {
        restoreTo.focus()
        return
      }
      // ROSTER-FIX.6b-7 — the trigger is GONE (it lived in the dialog this one
      // replaced). Falling through here used to leave focus on document.body,
      // which is the exact bug the restore was added to fix, just one flow
      // deeper. Land on the caller's container, or failing that on the page's
      // main landmark, so the next Tab starts somewhere the operator recognises.
      if (focusTransient(handlers.current.restoreFocusRef?.current)) return
      focusTransient(document.querySelector('[role="main"], main'))
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (dismissable && dismissOnBackdrop && e.target === e.currentTarget) onClose?.() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        tabIndex={-1}
        className={modalPanelClasses({ size, className }) + ' outline-none'}
      >
        {(title != null) && (
          <div className="flex items-center justify-between border-b border-un1t-border px-5 py-3 shrink-0">
            <h2 id={titleId} className="text-sm font-semibold text-un1t-text">{title}</h2>
            {dismissable && (
              <button
                type="button"
                onClick={() => onClose?.()}
                aria-label="Close"
                className="rounded-md p-1 text-un1t-subtle hover:bg-un1t-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-un1t-accent"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div className="px-5 py-4 flex-1 min-h-0 overflow-y-auto">{children}</div>
        {footer != null && (
          <div className="flex items-center justify-end gap-2 border-t border-un1t-border px-5 py-3 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
