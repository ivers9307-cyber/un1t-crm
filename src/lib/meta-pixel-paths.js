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

// The path table below stays for the old links (/welcome/..., /start/...,
// /corp). A page matches a prefix exactly or below it ('/hatch-street',
// '/hatch-street/events'), never by string prefix alone ('/hatch-streetx').
const STUDIO_META_PIXELS = [
  // UN1T Hatch Street Data Set (business "UN1T HatchStreet").
  // CORPPROMO.1: /corp's only promos run at Hatch Street today.
  { id: '39174085025538525', prefixes: ['/hatch-street', '/welcome/hatch-street', '/start/hatch-street', '/corp'] },
]

// PAGES.1 — a studio page is a database page at /<slug>, so its pixel follows
// the page's studio (the page's primary studio, or the studio an all-studios
// page resolved to), not a hard-coded path. location id -> dataset id.
export const STUDIO_META_PIXELS_BY_LOCATION = Object.freeze({
  '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4': '39174085025538525', // UN1T Hatch Street
})

// The studio the rendered page speaks for: the [slug] route stamps its root
// element with `data-page-location`. Null on the server, or on a page without it.
export function pageLocationIdFromDocument() {
  if (typeof document === 'undefined') return null
  const v = document.querySelector('[data-page-location]')?.getAttribute('data-page-location')
  return typeof v === 'string' && v ? v : null
}

// The site pixel always; a studio's own dataset when the page's studio has one
// (`primaryLocationId`) or the path is one of the old studio links. Each id once.
export function metaPixelIdsForPath(pathname, { primaryLocationId = null } = {}) {
  const path = typeof pathname === 'string' ? pathname : ''
  const ids = [SITE_META_PIXEL_ID]
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id) }
  add(typeof primaryLocationId === 'string' ? STUDIO_META_PIXELS_BY_LOCATION[primaryLocationId] : null)
  for (const studio of STUDIO_META_PIXELS) {
    if (studio.prefixes.some((p) => path === p || path.startsWith(`${p}/`))) add(studio.id)
  }
  return ids
}
