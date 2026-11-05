'use client'

// MIASETTINGS.1c — the tag beside an inheritable field's label (staff copy,
// MIAORG.1 T3-F): "Organisation default" / "Default" while the field follows
// the organisation or the built-in default, or, once the studio sets it
// itself, the way back ("Use organisation default" / "Use default"). A
// read-only viewer sees nothing for the studio's own field. Moved out of
// CustomerAgentClient's sourceTag() with identical output.
//   source   fieldSource(paths, { overridden, org }): 'studio' | 'org' | 'default'
//   orgHas   orgSetsAny(paths, org): the organisation sets one of the paths

import { Button } from '@/components/ui'
import { sourceTagLabel } from '@/lib/agent/settings-overrides'

export default function SourceTag({ source, canEdit = false, orgHas = false, onRevert }) {
  if (source === 'studio') {
    if (!canEdit) return null
    return (
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs underline" onClick={onRevert}>
        {orgHas ? 'Use organisation default' : 'Use default'}
      </Button>
    )
  }
  return (
    <span className="text-[11px] rounded-full border border-un1t-border px-2 py-0.5 text-un1t-muted whitespace-nowrap">
      {sourceTagLabel(source)}
    </span>
  )
}
