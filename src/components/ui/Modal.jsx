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
 */
export default function Modal({ open, onClose, title, footer, size = 'md', dismissable = true, className, children }) {
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
  const handlers = useRef({ onClose, dismissable })
  useEffect(() => {
    handlers.current = { onClose, dismissable }
  }, [onClose, dismissable])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && handlers.current.dismissable) handlers.current.onClose?.()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Move focus into the dialog for keyboard + screen-reader users. This runs
    // on OPEN only — re-running it on every render is the focus-steal bug.
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (dismissable && e.target === e.currentTarget) onClose?.() }}
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
