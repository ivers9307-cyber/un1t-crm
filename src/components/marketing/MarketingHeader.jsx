// MKTSHELL.1 — the one header every Marketing page renders: the section title
// and the hub tab strip on a single row, at the same left edge on every tab.
//
// Before this, the (marketing) layout drew a bare seven-tab strip with no
// title and the communications (marketing-era) layout drew a "Marketing
// sends" title, a subtitle and a five-tab strip, each at a different inset.
// Moving between Automations and Send changed the strip, the title and the
// left edge. Both layouts now hand their permission-filtered MARKETING_TABS
// here, so the strip never changes shape as you move between tabs.
//
// The title is a <p>, not a heading: every page under it has its own <h1>.
//
// No hooks: HubTabs is the client part. Renders the title even when the user
// can see fewer than two tabs (HubTabs itself renders nothing then).

import HubTabs from '@/components/HubTabs'

export default function MarketingHeader({ tabs }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-3 print:hidden">
      <p className="text-2xl font-bold text-un1t-text">Marketing</p>
      <HubTabs tabs={tabs} className="min-w-0 max-w-full" />
    </div>
  )
}
