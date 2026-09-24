// TABTITLE.1 — the browser tab of every STAFF page names the ACTIVE studio.
//
// The defect: the root layout's generateMetadata resolves ONE site name for
// the whole deployment (resolveDefaultSiteName — the first configured
// company_settings.company_name ordered by location_id), so an operator
// working in UN1T Stillorgan read "UN1T Hatch Street" on every tab.
// ROSTERLOOK.1 fixed /schedule alone; this is the same fix for all of them.
//
// WHY IT IS NOT IN THE ROOT LAYOUT. Not rendering cost: the root layout
// already reads the session for every route (AppShellServer calls
// getCurrentUser()), so nothing here is "kept static" by staying out of it.
// The reasons are about WHO can resolve the name:
//   (a) the root generateMetadata is every page's metadata ancestor, public
//       and customer-facing ones included. A staff member with a live
//       session opens /book, /event or /host links too, and a studio name
//       resolved there would title a customer surface with staff context. Keeping session reads out of the root generateMetadata
//       means a staff studio name is simply not resolvable on those routes.
//   (b) customer-facing titles are OWNED by customerFacingMetadata()
//       (src/lib/default-site-name.js, pinned by brand-chrome.test.js). One
//       resolver per audience; a root-level staff title would be a second
//       answer competing with it.
// So the name is resolved only from layouts that sit above staff pages.
// getCurrentUser is React.cache()'d, so a staff layout's generateMetadata
// shares the read its own render already makes.
//
// THE NEXT RULES THIS LEANS ON (verified against next@16.3.4:
// node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
// generate-metadata.md, and lib/metadata/resolvers/resolve-title.js +
// resolve-metadata.js accumulateMetadata):
//   1. title.template applies to CHILD segments only, never to a page in the
//      same segment as the layout that defines it. Every tree node counts as
//      a segment, layout or not, so (team)/layout.js DOES template
//      (team)/schedule/page.js, while approvals/layout.js does NOT template
//      approvals/page.js. A page sharing its layout's directory therefore
//      shows title.default, and must not set a title of its own.
//   2. A nested layout's title.default is itself run through the PARENT's
//      template. Two staff layouts on one route would render
//      "Studio · Studio", so this is exported from the OUTERMOST staff
//      layout of a subtree only, never from a layout nested under one.
//   3. {} contributes nothing: metadata merges shallowly by key, so a user
//      with no active studio inherits the root title exactly as before.
// src/lib/staff-tab-title-coverage.test.js enforces 1 and 2 over src/app.
//
// A title is never worth a 500: any failure resolves {} (today's tab).

import { unstable_rethrow } from 'next/navigation'
import { getCurrentUser } from './auth'

// Matches the separator ROSTERLOOK.1 already shipped on /schedule. Not an
// em-dash: house rule for anything a person reads.
export const STAFF_TITLE_SEPARATOR = ' · '

/**
 * The metadata fragment for a studio name. Pure, so the shape is testable
 * without a session. Returns {} for a blank name.
 *
 * @param {unknown} studioName
 * @returns {{ title?: { default: string, template: string } | string }}
 */
export function staffTabMetadataFor(studioName) {
  const studio = typeof studioName === 'string' ? studioName.trim() : ''
  // A whitespace-only name would render an empty tab.
  if (!studio) return {}
  // Next fills a template with String.replace(/%s/g, pageTitle), so a studio
  // whose NAME contains "%s" would have the page title spliced into it.
  // locations.name is operator-editable; name the studio and skip the
  // template rather than render nonsense.
  if (studio.includes('%s')) return { title: studio }
  return {
    title: {
      default: studio,
      template: `%s${STAFF_TITLE_SEPARATOR}${studio}`,
    },
  }
}

/**
 * generateMetadata body for the outermost layout of a STAFF subtree.
 *
 * Follows the EFFECTIVE user: while a master is viewing as someone else,
 * getCurrentUser() returns that person, and the tab names their studio.
 *
 * @returns {Promise<object>} a Next.js Metadata fragment ({} = inherit root)
 */
export async function staffTabMetadata() {
  try {
    const user = await getCurrentUser()
    return staffTabMetadataFor(user?.activeLocation?.name)
  } catch (err) {
    // Next signals "this route is dynamic" / redirect / notFound by THROWING.
    // Swallowing one of those here could let a route be prerendered with {}
    // baked in as its metadata. Everything else is ours to swallow.
    unstable_rethrow(err)
    // Swallowed, but not silently: the page renders fine either way, so a
    // sustained failure here would otherwise be visible nowhere.
    console.error('[staff-tab-title] could not resolve the active studio; tab keeps the default title', err)
    return {}
  }
}
