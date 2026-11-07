'use client'

import { useReducer, useRef, useState } from 'react'
import Link from 'next/link'
import { Button, Card } from '@/components/ui'
import { RECIPES } from '@shared/pipelines/recipes.js'
import {
  initialWizardState, wizardReducer, stepErrors, wizardCreateBody, wizardBodies,
  followupPacks, WIZARD_STEPS, OWNER_ONLY_NOTICE, entryTypesFor,
} from '@/lib/pipeline-wizard'
import RecipeStep from './wizard/RecipeStep'
import NameOfferStep from './wizard/NameOfferStep'
import EntryStep from './wizard/EntryStep'
import StagesStep from './wizard/StagesStep'
import FollowupsStep from './wizard/FollowupsStep'
import MiaNotesStep from './wizard/MiaNotesStep'
import ReviewStep from './wizard/ReviewStep'
import BoardLaunchPanel from './BoardLaunchPanel'

const STEP_COMPONENTS = {
  Recipe: RecipeStep,
  'Name and offer': NameOfferStep,
  'Who enters': EntryStep,
  Stages: StagesStep,
  'Follow-ups': FollowupsStep,
  'Notes for Mia': MiaNotesStep,
}

async function send(url, method, body) {
  let res
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    return { ok: false, json: { error: 'Could not reach the server. Try again.' } }
  }
  let json = null
  try { json = await res.json() } catch { /* a non-JSON failure gets the generic message */ }
  return { ok: res.ok && !!json?.success, json }
}

// The board stage a pack belongs to: same role, and for a checkpoint the same day.
function stageForPack(board, pack) {
  const same = (board.stages || []).filter((s) => s.stage_role === pack.role)
  if (pack.day != null) return same.find((s) => s.role_config?.day === pack.day) || null
  return same[0] || null
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
 *
 * PIPEBUILD.5j: with no `onCreate`, the wizard finishes itself: create the board
 * (off), install each ticked follow-up one at a time, then show the launch panel.
 */
export default function BoardWizard({
  locationId, studioName, canEdit, membershipSource, bookingFlowId, appLinks,
  onCreate, creating: creatingProp = false, createError: createErrorProp = null,
}) {
  const [state, dispatch] = useReducer(
    wizardReducer,
    { studioName, bookingFlowId, appLinks, entryTypes: entryTypesFor(membershipSource) },
    initialWizardState,
  )

  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)
  const [launch, setLaunch] = useState(null) // { board, followups, issues, wording }
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  async function installOne(board, packKey, wording) {
    const pack = RECIPES[state.recipeKey]?.packs.find((p) => p.key === packKey)
    const stage = pack && stageForPack(board, pack)
    const label = pack?.name || packKey
    if (!stage) return { key: packKey, label, error: pack?.day != null ? 'No stage for this check-in message.' : 'This stage is not on the board.' }
    const bodies = wording[packKey]
    const { ok, json } = await send(
      `/api/pipelines/${board.id}/followups/${stage.id}`, 'PUT',
      { action: 'install', pack_key: packKey, ...(bodies ? { bodies } : {}) },
    )
    if (!ok) return { key: packKey, label, error: json?.error || 'The follow-up could not be installed.' }
    const publishError = json.data?.publish_error || json.data?.publishError
    return { key: packKey, label, stageId: stage.id, followup: json.data?.followup, ...(publishError ? { error: publishError } : {}) }
  }

  function applyResult(prev, r) {
    const rest = (prev.followups || []).filter((f) => f.pack_key !== r.key)
    const issues = prev.issues.filter((i) => i.key !== r.key)
    return {
      ...prev,
      followups: r.followup ? [...rest, { ...r.followup, stage_id: r.followup.stage_id || r.stageId, pack_key: r.followup.pack_key || r.key }] : rest,
      issues: r.error ? [...issues, { key: r.key, label: r.label, error: r.error }] : issues,
    }
  }

  async function finish(body, wording, wizardState) {
    if (inFlight.current) return
    inFlight.current = true
    setCreating(true); setCreateError(null)
    try {
      const created = await send(`/api/locations/${locationId}/pipelines`, 'POST', body)
      if (!created.ok) { setCreateError(created.json?.error || 'The board could not be created.'); return }
      const board = created.json.data.board
      setLaunch({ board, followups: [], issues: [], wording })
      setBusy(true)
      for (const pack of followupPacks(wizardState)) {
        const r = await installOne(board, pack.key, wording)
        setLaunch((prev) => applyResult(prev, r))
      }
    } catch {
      setCreateError('The board could not be created.')
    } finally {
      inFlight.current = false
      setBusy(false)
      setCreating(false)
    }
  }

  async function retry(key) {
    if (inFlight.current || !launch) return
    inFlight.current = true
    setBusy(true)
    try {
      const r = await installOne(launch.board, key, launch.wording)
      setLaunch((prev) => applyResult(prev, r))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!canEdit) return <Card><p className="text-sm text-un1t-text">{OWNER_ONLY_NOTICE}</p></Card>

  if (launch) {
    return (
      <div className="space-y-4">
        <Card>
          <h2 className="text-lg font-semibold text-un1t-text">{launch.board.name} is created and switched off</h2>
          <p className="mt-1 text-sm text-un1t-subtle">
            Check who would enter, then turn it on.{' '}
            <Link href={`/settings/pipelines/${launch.board.id}`} className="text-un1t-accent">Open the board</Link>
          </p>
        </Card>
        <BoardLaunchPanel board={launch.board} followups={launch.followups} issues={launch.issues} onRetry={retry} retryDisabled={busy} />
      </div>
    )
  }

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
            onCreate={() => (typeof onCreate === 'function'
              ? onCreate(wizardCreateBody(state), wizardBodies(state), state)
              : finish(wizardCreateBody(state), wizardBodies(state), state))}
            creating={creating || creatingProp}
            createError={createError || createErrorProp}
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
