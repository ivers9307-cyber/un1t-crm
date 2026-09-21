// TABTITLE.1 — pass-through layout. /events had no layout of its own, so its
// tab inherited the ROOT title: one site name for the whole deployment (the
// first company_settings.company_name by location_id), whichever studio the
// operator was actually working in. This adds NO chrome and NO gate; pages
// here keep their own. It exists only to name the ACTIVE studio in the tab.
// See src/lib/staff-tab-title.js for why this cannot live in the root layout.

import { staffTabMetadata } from '@/lib/staff-tab-title'

// Already true of every page under here (each reads the session). Stated so
// a page added later cannot be prerendered with a sessionless title.
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return staffTabMetadata()
}

export default function EventsTabTitleLayout({ children }) {
  return children
}
