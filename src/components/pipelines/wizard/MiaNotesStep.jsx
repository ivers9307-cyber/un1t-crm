'use client'

import { Field } from '@/components/ui'
import { MIA_NOTES_MAX } from '@shared/pipelines/offer-config.js'
import { INPUT } from './styles'

// Step 6: what Mia should know about this offer when people on the board message.
export default function MiaNotesStep({ state, dispatch, disabled = false }) {
  const length = state.miaNotes.length
  return (
    <Field
      id="wiz-mia"
      label="Notes for Mia"
      hint={`Optional. What Mia should know about this offer when people on the board message. ${length} of ${MIA_NOTES_MAX} characters.`}
    >
      {(p) => (
        <textarea {...p} disabled={disabled} rows={6} className={INPUT} value={state.miaNotes}
          onChange={(e) => dispatch({ type: 'setMiaNotes', notes: e.target.value })} />
      )}
    </Field>
  )
}
