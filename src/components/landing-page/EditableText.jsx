'use client'

// EditableText — controlled-ish contentEditable wrapper used inside
// the iframe edit overlay (Phase 3c.2). Click any text → cursor
// drops in → type to edit. Every keystroke fires onChange so the
// parent state stays in sync; the parent then pushes state back
// via postMessage on every change, but this component knows NOT to
// clobber the DOM while it's focused (otherwise the cursor would
// jump to start on every re-render).
//
// Why not a plain controlled <input>? Because we want the edit
// surface to BE the rendered text — same fonts, same colours,
// same line wrapping. Swapping in an input would shift layout +
// look weird. contentEditable on the rendered element keeps the
// visual continuity that makes WYSIWYG editing feel direct.
//
// Cursor preservation:
//   - When focused, React must NOT replace the contentEditable's
//     children, because that destroys + recreates the text node
//     and the caret moves to position 0.
//   - We render the element with NO React children. The initial
//     content is set in a useEffect that only writes when not
//     focused.
//   - onInput propagates new value to parent. Parent state
//     updates. State is pushed back. Effect re-runs with new
//     value — but focusedRef is true, so the DOM stays put.
//   - On blur, focusedRef flips false. If the parent value is
//     out-of-sync with the DOM (e.g. trimmed server-side), the
//     next render will reconcile.

import { useRef, useEffect } from 'react'

export default function EditableText({
  value = '',
  onChange,
  multiline = false,
  as = 'span',
  className = '',
  placeholder = '',
}) {
  const ref = useRef(null)
  const focusedRef = useRef(false)

  // Set initial / external content. Skip while focused — would
  // clobber the caret position.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (focusedRef.current) return
    const next = value || ''
    if (el.textContent !== next) {
      el.textContent = next
    }
  }, [value])

  const Tag = as

  return (
    <Tag
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={multiline ? 'true' : 'false'}
      data-placeholder={placeholder || undefined}
      onFocus={() => { focusedRef.current = true }}
      onBlur={() => {
        focusedRef.current = false
        const v = ref.current?.textContent ?? ''
        // Trim trailing line breaks browsers tend to insert in
        // contentEditable but don't reflect in the visible text.
        if (v !== (value ?? '')) onChange?.(v)
      }}
      onInput={(e) => {
        const v = e.currentTarget.textContent ?? ''
        onChange?.(v)
      }}
      onKeyDown={(e) => {
        // Single-line fields shouldn't accept newlines — Enter blurs.
        if (!multiline && e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      // Prevent the wrapping block's click-to-select handler from
      // firing when the operator clicks inside the text — they want
      // to edit, not just select the block.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={`${className} cursor-text outline-none rounded px-1 -mx-1 transition-colors hover:bg-white/10 focus:bg-white/15 focus:ring-2 focus:ring-blue-500/70 focus:ring-offset-0`}
    />
  )
}
