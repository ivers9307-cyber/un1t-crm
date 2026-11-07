'use client'

import { RECIPES } from '@shared/pipelines/recipes.js'

// Step 1: pick a recipe. Picking another recipe starts its stages and wording afresh.
export default function RecipeStep({ state, dispatch }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {Object.values(RECIPES).map((r) => {
        const selected = state.recipeKey === r.key
        return (
          <button
            key={r.key}
            type="button"
            aria-pressed={selected}
            onClick={() => dispatch({ type: 'pickRecipe', recipeKey: r.key })}
            className={`rounded-lg border p-4 text-left transition-colors ${selected ? 'border-un1t-accent bg-un1t-accent/10' : 'border-un1t-border bg-un1t-surface hover:border-un1t-muted'}`}
          >
            <span className="block text-sm font-semibold text-un1t-text">{r.name}</span>
            <span className="mt-1 block text-xs text-un1t-subtle">{r.description}</span>
          </button>
        )
      })}
    </div>
  )
}
