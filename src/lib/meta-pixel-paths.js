// METADATASET.1 — which Meta pixels a page loads (after marketing consent).
//
// The site has always loaded ONE pixel everywhere: the "UN1T Web" dataset,
// owned by the UN1T Dublin Meta business. A studio whose ads run from its
// own Meta business has its own dataset, and its ad account can only
// optimise on events sent THERE, so that studio's pages load its pixel as
// well. The site-wide pixel still loads on those pages, exactly as before.
//
// Pure, and importable from the client bundle.

export const SITE_META_PIXEL_ID = '1866914428028977' // UN1T Web dataset

// A page matches a prefix exactly or below it ('/hatch-street',
// '/hatch-street/events'), never by string prefix alone ('/hatch-streetx').
const STUDIO_META_PIXELS = [
  // UN1T Hatch Street Data Set (business "UN1T HatchStreet").
  { id: '39174085025538525', prefixes: ['/hatch-street', '/welcome/hatch-street', '/start/hatch-street'] },
]

export function metaPixelIdsForPath(pathname) {
  const path = typeof pathname === 'string' ? pathname : ''
  const ids = [SITE_META_PIXEL_ID]
  for (const studio of STUDIO_META_PIXELS) {
    if (studio.prefixes.some((p) => path === p || path.startsWith(`${p}/`))) ids.push(studio.id)
  }
  return ids
}
