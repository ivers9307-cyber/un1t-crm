// TABTITLE.1 — pass-through layout. /live had no layout of its own, so its
// tab inherited the ROOT title: one site name for the whole deployment (the
// first company_settings.company_name by location_id), whichever studio the
// operator was actually working in. This adds NO chrome and NO gate; pages
// here keep their own. It exists only to name the ACTIVE studio in the tab.
// See src/lib/staff-tab-title.js for why the root generateMetadata must not
// resolve it (who can read the name, not rendering cost).

import { staffTabMetadata } from '@/lib/staff-tab-title'

// Belt-and-braces, NOT what makes these routes dynamic: the root layout
// already reads the session for every route (AppShellServer), and every page
// under here is force-dynamic itself. Stated so the intent survives if either
// of those ever changes.
export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return staffTabMetadata()
}

export default function LiveTabTitleLayout({ children }) {
  return children
}
