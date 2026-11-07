'use client'

import WhatsAppTemplatePreview from '@/components/WhatsAppTemplatePreview'
import { RECIPES } from '@shared/pipelines/recipes.js'
import { followupPacks, previewTemplate } from '@/lib/pipeline-wizard'
import { INPUT } from './styles'

const REF_LABELS = {
  main: 'message',
  nudge: "message if they haven't booked",
  followup: "follow-up if they don't reply",
}
export const TOKEN_NOTE = "{{1}} is the person's first name. You can use {studio}, {offer}, {days}, {days_left} and {signer}."

// Step 5: the wording of each ticked stage's follow-up, beside a preview of
// what WhatsApp will show ({{1}} as Tim, the fill-ins filled in).
// `packKeys` (the settings page's Change wording, PIPEBUILD.5k) shows just
// those packs of the recipe.
export default function FollowupsStep({ state, dispatch, packKeys = null }) {
  const packs = packKeys
    ? (RECIPES[state.recipeKey]?.packs || []).filter((p) => packKeys.includes(p.key))
    : followupPacks(state)
  if (packs.length === 0) return <p className="text-sm text-un1t-subtle">No ticked stage has a follow-up.</p>
  const stageName = (role) => state.stages.find((s) => s.role === role)?.name || ''
  return (
    <div className="space-y-6">
      {packs.map((pack) => (
        <section key={pack.key} className="space-y-3">
          <h3 className="text-sm font-semibold text-un1t-text">
            {pack.name}
            <span className="ml-2 font-normal text-un1t-subtle">{stageName(pack.role)}</span>
          </h3>
          {pack.templates.map((t) => {
            const id = `wiz-body-${pack.key}-${t.ref}`
            const { components, error } = previewTemplate(state, pack.key, t.ref)
            return (
              <div key={t.ref} className="grid gap-3 md:grid-cols-2">
                <div>
                  <label htmlFor={id} className="mb-1 block text-sm font-medium text-un1t-text">
                    {`${pack.name}: ${REF_LABELS[t.ref] || t.ref}`}
                  </label>
                  <textarea
                    id={id}
                    rows={7}
                    className={INPUT}
                    value={state.bodies[pack.key]?.[t.ref] ?? ''}
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => dispatch({ type: 'setBody', packKey: pack.key, ref: t.ref, body: e.target.value })}
                  />
                  {error && <p className="mt-1 text-xs text-red-700" role="alert">{error}</p>}
                  <p className="mt-1 text-xs text-un1t-subtle">{TOKEN_NOTE}</p>
                </div>
                <WhatsAppTemplatePreview components={components} />
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}
