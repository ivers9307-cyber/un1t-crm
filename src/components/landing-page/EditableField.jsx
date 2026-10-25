// Pass-through wrapper used by every block renderer. When `onEdit`
// is provided (i.e. we're rendering inside the iframe edit
// overlay), the text becomes contentEditable and edits propagate
// via onEdit(path, newValue). When `onEdit` is absent (public page
// render), it's a plain text fragment — zero overhead.
//
// Lives in its own module rather than in BlockRenderers.jsx because
// OfferPanel needs it too, and importing it back out of
// BlockRenderers — which imports OfferPanel — would be a cycle.
// NO 'use client' here, matching BlockRenderers: EditableText brings
// its own, and this module must stay importable from a server page.

import EditableText from './EditableText'

export function E({ value, onEdit, path, multiline }) {
  if (!onEdit) return <>{value}</>
  return (
    <EditableText
      value={value || ''}
      onChange={(v) => onEdit(path, v)}
      multiline={multiline}
    />
  )
}
