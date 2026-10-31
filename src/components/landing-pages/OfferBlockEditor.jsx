'use client'

// PAGES.1 — the pinned offer block of a page (blocks[0]): its PAGE half
// (words, media), drawn by the caller's renderPageHalf(block, onUpdate) (the
// form passes the type's own editor with pageOnly, so this file never imports
// the form), saved by the page form's Save; then one StudioOfferRow per
// studio, in sort order, each saving its own STUDIO half.

import { useMemo } from 'react'
import StudioOfferRow from '@/components/landing-pages/StudioOfferRow'

export default function OfferBlockEditor({
  page, block, studios = [], onUpdateBlock, onSaveStudio, canEdit, renderPageHalf,
}) {
  const rows = useMemo(
    () => [...studios].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [studios],
  )
  // The rows judge readiness on the block as it is now, not as it was loaded.
  const livePage = useMemo(() => ({ ...page, blocks: [block] }), [page, block])

  return (
    <div className="space-y-4">
      <div className="space-y-3">{renderPageHalf ? renderPageHalf(block, onUpdateBlock) : null}</div>
      <div className="space-y-2 pt-3 border-t border-un1t-border">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Studios</h3>
        <p className="text-[11px] text-un1t-muted">
          Each studio&apos;s plan, price and tracking. Each studio saves on its own, apart from the page&apos;s Save.
        </p>
        {rows.length === 0 && <p className="text-sm text-un1t-subtle">No studio is on this page yet.</p>}
        {rows.map((row) => (
          <StudioOfferRow key={row.location_id} page={livePage} row={row} onSave={onSaveStudio} canEdit={canEdit} />
        ))}
      </div>
    </div>
  )
}
