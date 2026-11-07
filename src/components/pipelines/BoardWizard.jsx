'use client'

import { useReducer } from 'react'
import { Button, Card } from '@/components/ui'
import {
  initialWizardState, wizardReducer, stepErrors, wizardCreateBody, wizardBodies,
  WIZARD_STEPS, UN1T_STUDIO_NOTICE, OWNER_ONLY_NOTICE, isUn1tStudio,
} from '@/lib/pipeline-wizard'
import RecipeStep from './wizard/RecipeStep'
import NameOfferStep from './wizard/NameOfferStep'
import EntryStep from './wizard/EntryStep'
import StagesStep from './wizard/StagesStep'
import FollowupsStep from './wizard/FollowupsStep'
import MiaNotesStep from './wizard/MiaNotesStep'
import ReviewStep from './wizard/ReviewStep'

const STEP_COMPONENTS = {
  Recipe: RecipeStep,
  'Name and offer': NameOfferStep,
  'Who enters': EntryStep,
  Stages: StagesStep,
  'Follow-ups': FollowupsStep,
  'Notes for Mia': MiaNotesStep,
}

/**
 * PIPEBUILD.5i — the new-board wizard (/settings/pipelines/new).
 *
 * @param {object} props
 * @param {string} props.locationId
 * @param {string} props.studioName
 * @param {boolean} props.canEdit           owner, org admin or master at the studio
 * @param {string|null} props.membershipSource
 * @param {string} [props.bookingFlowId]   the Book button the follow-ups would carry
 * @param {{ iosUrl: string, androidUrl: string }} [props.appLinks]
 * @param {(body: object, bodies: object, state: object) => void} [props.onCreate]
 *   called with the create route's body ({ name, recipe_key, config, priority })
 *   and the changed follow-up wording by pack and ref
 * @param {boolean} [props.creating]
 * @param {string|null} [props.createError]
 */
export default function BoardWizard({
  locationId, studioName, canEdit, membershipSource, bookingFlowId, appLinks,
  onCreate, creating = false, createError = null,
}) {
  const [state, dispatch] = useReducer(
    wizardReducer,
    { studioName, bookingFlowId, appLinks },
    initialWizardState,
  )

  if (!canEdit) return <Card><p className="text-sm text-un1t-text">{OWNER_ONLY_NOTICE}</p></Card>
  if (isUn1tStudio(membershipSource)) return <Card><p className="text-sm text-un1t-text">{UN1T_STUDIO_NOTICE}</p></Card>

  const stepName = WIZARD_STEPS[state.step]
  const errors = state.showErrors ? stepErrors(state, state.step) : []
  const isReview = stepName === 'Review'
  const StepComponent = STEP_COMPONENTS[stepName]

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Steps">
        {WIZARD_STEPS.map((name, i) => (
          <li
            key={name}
            aria-current={i === state.step ? 'step' : undefined}
            className={`rounded-full px-2 py-0.5 ${i === state.step ? 'bg-un1t-accent/10 text-un1t-text font-semibold' : 'text-un1t-subtle'}`}
          >
            {i + 1}. {name}
          </li>
        ))}
      </ol>
      <Card>
        <h2 className="mb-4 text-lg font-semibold text-un1t-text">{stepName}</h2>
        {isReview ? (
          <ReviewStep
            state={state}
            onCreate={typeof onCreate === 'function'
              ? () => onCreate(wizardCreateBody(state), wizardBodies(state), state)
              : undefined}
            creating={creating}
            createError={createError}
          />
        ) : (
          <StepComponent state={state} dispatch={dispatch} locationId={locationId} />
        )}
        {errors.length > 0 && (
          <ul className="mt-4 space-y-1" role="alert">
            {errors.map((e) => <li key={e} className="text-sm text-red-700">{e}</li>)}
          </ul>
        )}
      </Card>
      <div className="flex gap-2">
        {state.step > 0 && <Button variant="secondary" onClick={() => dispatch({ type: 'back' })}>Back</Button>}
        {!isReview && <Button onClick={() => dispatch({ type: 'next' })}>Next</Button>}
      </div>
    </div>
  )
}
