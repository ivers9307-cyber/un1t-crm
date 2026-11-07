'use client'

import { Button } from '@/components/ui'
import { RECIPES } from '@shared/pipelines/recipes.js'
import { entryDescription, followupPacks, stepErrors, wizardBodies } from '@/lib/pipeline-wizard'

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-3 gap-3 border-b border-un1t-border py-2 text-sm last:border-0">
      <dt className="text-un1t-subtle">{label}</dt>
      <dd className="col-span-2 text-un1t-text">{children}</dd>
    </div>
  )
}

// Step 7: everything on one page, and the create button. The board is created
// switched off; `onCreate` (wired by the caller) does the create.
export default function ReviewStep({ state, onCreate, creating = false, createError = null }) {
  const recipe = RECIPES[state.recipeKey]
  const errors = stepErrors(state, 'Review')
  const changed = wizardBodies(state)
  const studio = state.studio?.name || 'the studio'
  const stages = state.stages.filter((s) => s.enabled)
  const packs = followupPacks(state)
  return (
    <div className="space-y-4">
      <dl>
        <Row label="Recipe">{recipe?.name}</Row>
        <Row label="Board name">{state.name.trim()}</Row>
        <Row label="Offer name">{state.offerName.trim() || `${state.name.trim()} (the board name)`}</Row>
        <Row label="Sign-off">{state.signer.trim() || `${studio} (the studio name)`}</Row>
        <Row label="Offer length">{state.durationDays} days</Row>
        <Row label="Priority">{state.priority}</Row>
        <Row label="Who enters">
          <span className="block">{entryDescription(state.entry)}</span>
          <ul className="mt-1 flex flex-wrap gap-1">
            {(state.entry?.values || []).map((v) => (
              <li key={v} className="rounded-full bg-gray-500/10 px-2 py-0.5 text-xs text-gray-700">{v}</li>
            ))}
          </ul>
        </Row>
        <Row label="Stages">
          <ol className="list-decimal pl-5">
            {stages.map((s) => (
              <li key={`${s.role}-${s.day ?? s.count ?? ''}`}>
                {s.name.trim()}
                {s.role === 'checkpoint' && <span className="text-un1t-subtle"> (day {s.day})</span>}
                {s.role === 'class_n' && <span className="text-un1t-subtle"> (class {s.count})</span>}
              </li>
            ))}
          </ol>
        </Row>
        <Row label="Follow-ups">
          {packs.length === 0 ? 'None' : (
            <ul>
              {packs.map((p) => (
                <li key={p.key}>
                  {p.name}
                  <span className="text-un1t-subtle">{changed[p.key] ? ' (your wording)' : ' (recipe wording)'}</span>
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Notes for Mia">{state.miaNotes.trim() || 'None'}</Row>
      </dl>
      <p className="text-sm text-un1t-subtle">
        The board is created switched off. Switching it on later never messages people who already qualify.
      </p>
      {errors.length > 0 && (
        <ul className="space-y-1" role="alert">
          {errors.map((e) => <li key={e} className="text-sm text-red-700">{e}</li>)}
        </ul>
      )}
      {createError && <p className="text-sm text-red-700" role="alert">{createError}</p>}
      <Button
        disabled={errors.length > 0 || typeof onCreate !== 'function'}
        loading={creating}
        onClick={() => onCreate?.()}
      >
        Create board (switched off)
      </Button>
    </div>
  )
}
