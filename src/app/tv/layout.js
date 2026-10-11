// CHROME.1 / W1.S1b — the /tv subtree is the GYM FLOOR, and the gym floor
// wears the GYM's brand, not the platform's.
//
// CHROME.1 locked the split: staff/platform chrome reads Repset, in-studio
// boards read the gym. Before W1.S1b "the gym" was a literal ('UN1T') here;
// now every board names the brand its STUDIO is configured with
// (company_settings → org_settings → locations.name):
//   • /tv/cast/[token] titles itself from its own content payload
//     (display.company_name) in its generateMetadata;
//   • /tv/live/[token] and its /challenges board set the tab title from the
//     `brand` their token-gated payloads carry;
//   • this layout is the floor for anything else under /tv: the REQUEST
//     HOST's organisation brand (the one per-host cache, host-brand.js).
//     A kiosk on the CRM host has no organisation, so the layout declares
//     nothing and the board's own title is the only one that applies.
//
// On-screen impact is nil (a kiosk browser hides the tab); this is the code
// stating whose floor it is rather than inheriting the platform's name.
import { headers } from 'next/headers'
import { resolveHostBrand } from '@/lib/host-brand'

export async function generateMetadata() {
  const { companyName } = await resolveHostBrand({ host: (await headers()).get('host') })
  return companyName ? { title: companyName } : {}
}

export default function TvLayout({ children }) {
  return children
}
