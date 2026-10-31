// PAGES.1 — the pinned offer block of a page (blocks[0]): its PAGE half
// (words, media) through the type's own editor with `pageOnly`, saved by the
// page form's Save; then one StudioOfferRow per studio, in sort order, each
// saving its own STUDIO half.
//
// The four per-type editors live in LandingPageSettingsForm (their legacy
// mode still edits the studio pages until PR3), so this file imports them
// back from it; they are only read at render time (PageHalf), so the
// import cycle is harmless.

import { useMemo } from 'react'
import {
  PaidTrialEdit, ClassFunnelEdit, CampaignFunnelEdit, CorpPromoEdit,
} from '@/components/LandingPageSettingsForm'
import StudioOfferRow from '@/components/landing-pages/StudioOfferRow'

// The page-half editor for the block type, with pageOnly. Resolved at render
// time, never at module load, because of the import cycle.
function PageHalf({ type, ...props }) {
  switch (type) {
    case 'paid_trial': return <PaidTrialEdit pageOnly {...props} />
    case 'class_funnel': return <ClassFunnelEdit pageOnly {...props} />
    case 'campaign_funnel': return <CampaignFunnelEdit pageOnly {...props} />
    case 'corp_promo': return <CorpPromoEdit pageOnly {...props} />
    default: return null
  }
}

export default function OfferBlockEditor({
  page, block, studios = [], onUpdateBlock, onSaveStudio, canEdit,
  locationId = null, membershipSource = null, uploadMedia, uploading = {}, uploadErr = {}, progress = {},
}) {
  const rows = useMemo(
    () => [...studios].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [studios],
  )
  // The un1t.online copy fields (paid trial) show when any studio is on it.
  const pageSource = studios.some((s) => s.membership_source === 'un1t_online') ? 'un1t_online' : membershipSource
  // The rows judge readiness on the block as it is now, not as it was loaded.
  const livePage = useMemo(() => ({ ...page, blocks: [block] }), [page, block])

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <PageHalf
          type={block?.type}
          block={block}
          onUpdate={onUpdateBlock}
          locationId={locationId}
          membershipSource={pageSource}
          availableBookingTypes={[]}
          uploadMedia={uploadMedia}
          uploading={uploading}
          uploadErr={uploadErr}
          progress={progress}
        />
      </div>
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
