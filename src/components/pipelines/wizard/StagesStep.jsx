'use client'

import { INPUT, NUMBER_INPUT } from './styles'

// Step 4: the recipe's stages. The first stage is always on; the rest can be
// switched off and renamed, and a check-in day or class count changed (a
// check-in day the recipe's message is written for stays fixed).
export default function StagesStep({ state, dispatch }) {
  return (
    <ul className="space-y-3">
      {state.stages.map((s, index) => (
        <li key={`${s.role}-${index}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-un1t-border bg-un1t-surface p-3">
          <input
            type="checkbox"
            aria-label={`Use the ${s.defaultName} stage`}
            checked={s.enabled}
            disabled={s.locked}
            onChange={() => dispatch({ type: 'toggleStage', index })}
          />
          <input
            aria-label={`Name for the ${s.defaultName} stage`}
            className={`${INPUT} max-w-xs`}
            value={s.name}
            disabled={!s.enabled}
            onChange={(e) => dispatch({ type: 'renameStage', index, name: e.target.value })}
          />
          {s.role === 'checkpoint' && s.fixedDay != null && (
            <span className="text-sm text-un1t-subtle">
              Day {s.fixedDay}
              <span className="block text-xs">{`Fixed at day ${s.fixedDay} for this recipe's check-in message.`}</span>
            </span>
          )}
          {s.role === 'checkpoint' && s.fixedDay == null && (
            <label className="flex items-center gap-2 text-sm text-un1t-subtle">
              Day
              <input
                type="number"
                min={1}
                aria-label={`Check-in day for ${s.defaultName}`}
                className={NUMBER_INPUT}
                value={s.day ?? ''}
                disabled={!s.enabled}
                onChange={(e) => dispatch({ type: 'setStageDay', index, day: e.target.value })}
              />
            </label>
          )}
          {s.role === 'class_n' && (
            <label className="flex items-center gap-2 text-sm text-un1t-subtle">
              Class number
              <input
                type="number"
                min={2}
                aria-label={`Class number for ${s.defaultName}`}
                className={NUMBER_INPUT}
                value={s.count ?? ''}
                disabled={!s.enabled}
                onChange={(e) => dispatch({ type: 'setStageCount', index, count: e.target.value })}
              />
            </label>
          )}
          {s.locked && <span className="text-xs text-un1t-subtle">Everyone starts here</span>}
        </li>
      ))}
    </ul>
  )
}
