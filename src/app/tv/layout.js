// CHROME.1 — the /tv subtree is the GYM FLOOR, and the gym floor keeps UN1T.
//
// That half of the brand split is a locked product decision: staff/platform
// chrome reads Repset, in-studio boards and "UN1T Points" stay UN1T, and
// anything naming the gym to a customer resolves from operator branding.
//
// Why a layout and not a per-page export: the boards under /tv declared no
// metadata of their own (only /tv/cast/[token] did), so they inherited the
// ROOT layout's title. CHROME.1 moved that root title off a gym literal onto
// the resolved platform/operator name — which silently rebranded a locked
// surface, and left /tv/[locationId] disagreeing with its own sibling
// /tv/cast/[token]. Declaring it once here covers every board in the subtree,
// including any added later, instead of relying on each page to remember.
// /tv/cast/[token] keeps its own export (it also pins a kiosk viewport) and
// that page-level metadata still wins over this.
//
// On-screen impact is nil — a kiosk browser hides the tab — so this is about
// the code stating the decision rather than inheriting a contradiction.
export const metadata = {
  title: 'UN1T',
}

export default function TvLayout({ children }) {
  return children
}
