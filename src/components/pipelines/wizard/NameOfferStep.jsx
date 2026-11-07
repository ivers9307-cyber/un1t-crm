'use client'

import { Field } from '@/components/ui'
import { OFFER_NAME_MAX, SIGNER_MAX } from '@shared/pipelines/offer-config.js'
import { BOARD_NAME_MAX } from '@/lib/pipeline-wizard'
import { INPUT, NUMBER_INPUT } from './styles'

// Step 2: the board's name, the offer's wording fill-ins, its length and priority.
export default function NameOfferStep({ state, dispatch }) {
  const studio = state.studio?.name || 'the studio'
  return (
    <div className="space-y-4">
      <Field id="wiz-name" label="Board name" required hint="Staff see this on the pipelines page.">
        {(p) => (
          <input {...p} className={INPUT} maxLength={BOARD_NAME_MAX} value={state.name}
            onChange={(e) => dispatch({ type: 'setName', name: e.target.value })} />
        )}
      </Field>
      <Field id="wiz-offer" label="Offer name" hint="Fills {offer} in the messages. Leave it blank to use the board name.">
        {(p) => (
          <input {...p} className={INPUT} maxLength={OFFER_NAME_MAX} value={state.offerName}
            onChange={(e) => dispatch({ type: 'setOfferName', name: e.target.value })} />
        )}
      </Field>
      <Field id="wiz-signer" label="Sign-off" hint={`Fills {signer} in the messages. Leave it blank to use ${studio}.`}>
        {(p) => (
          <input {...p} className={INPUT} maxLength={SIGNER_MAX} value={state.signer}
            onChange={(e) => dispatch({ type: 'setSigner', name: e.target.value })} />
        )}
      </Field>
      <Field id="wiz-days" label="Offer length in days" hint="Fills {days} in the messages.">
        {(p) => (
          <input {...p} type="number" min={1} max={365} className={NUMBER_INPUT} value={state.durationDays ?? ''}
            onChange={(e) => dispatch({ type: 'setDurationDays', days: e.target.value })} />
        )}
      </Field>
      <Field id="wiz-priority" label="Priority" hint="If someone fits more than one board, the lower number wins.">
        {(p) => (
          <input {...p} type="number" min={1} max={1000} className={NUMBER_INPUT} value={state.priority ?? ''}
            onChange={(e) => dispatch({ type: 'setPriority', priority: e.target.value })} />
        )}
      </Field>
    </div>
  )
}
