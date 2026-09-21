// TABTITLE.1 — coverage guard: every STAFF page's tab names the active
// studio, and nothing customer-facing or public ever can.
//
// Staff pages do not share a layout. They are spread over six route groups,
// a dozen top-level segments that have a layout and a dozen more that had
// none, so "the staff title" is ~25 separate exports and the next new segment
// silently inherits the root title again (one site name for the whole
// deployment, the defect this ticket fixed). This file walks src/app and
// makes that a failing test instead.
//
// Every top-level entry of src/app is exactly one of:
//   staff     listed in STAFF below. EVERY page under it must sit under
//             exactly ONE layout that resolves staffTabMetadata.
//   public    DERIVED, not typed: its path is in AppShell's PUBLIC_PATHS, the
//             list that decides whether a page gets the staff shell at all.
//             Must never import the staff helper (a customer must never read
//             a staff studio name).
//   customer  signed-in but customer-facing, so not in PUBLIC_PATHS. Listed in
//             CUSTOMER with a reason; must use customerFacingMetadata and
//             never the staff helper.
//   no-pages  DERIVED: no page.js anywhere under it (route handlers only), so
//             there is no tab to title. Adding a page reclassifies it.
// Anything else FAILS, so whoever adds a segment has to choose.
//
// The rules asserted per staff page are Next's, not house style; both are
// demonstrated against the installed resolver in staff-tab-title.test.js:
//   - two staff layouts on one route render "Studio · Studio";
//   - title.template skips a page in the SAME segment as the layout, so such
//     a page must not set a title of its own (it would drop the studio).

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const APP = path.join(process.cwd(), 'src/app')
const rel = (abs) => path.relative(process.cwd(), abs)

// segment -> what it is. The value is documentation; the key is the rule.
const STAFF = {
  '(marketing)': 'Marketing hub route group',
  '(members)': 'Members hub route group',
  '(money)': 'Money hub route group',
  '(operations)': 'Operations hub route group',
  '(sales)': 'Sales hub route group',
  '(team)': 'Team hub route group (/schedule names itself through the template)',
  achievements: 'achievement admin',
  admin: 'master console. A master with an active studio reads that studio',
  approvals: 'approvals inbox',
  cars: 'CCF Autos car processing (the active location is the CCF one)',
  communications: 'Messages hub, mail, template editors',
  dashboard: 'dashboards',
  events: 'event check-in and control (staff side; /event is the public one)',
  issues: 'issue tracker',
  live: 'coach live heart-rate board, inside the staff shell',
  marketing: 'Marketing hub index',
  members: 'Members hub index',
  money: 'Money hub index',
  operations: 'Operations hub index',
  portfolio: 'org portfolio. Account tier, but still names the active studio',
  presentations: 'presenter remote (the wall display is /present, public)',
  sales: 'Sales hub index',
  settings: 'settings',
  'studio-management': 'class timer control, inside the staff shell',
  team: 'Team hub index',
}

const CUSTOMER = {
  account: 'member self-service. Signed in, but the audience is the customer (brand-chrome.test.js pins its metadata)',
}

// ── derive the public set from the allowlist that already decides it ──
function appShellPublicPaths() {
  const src = readFileSync(path.join(process.cwd(), 'src/components/AppShell.jsx'), 'utf8')
  const literal = src.match(/const PUBLIC_PATHS = \[([^\]]+)\]/)?.[1]
  if (!literal) throw new Error('AppShell.jsx PUBLIC_PATHS not found; this guard derives the public set from it')
  return [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1])
}
const PUBLIC_TOP_LEVEL = new Set(
  appShellPublicPaths()
    .map((p) => p.split('/').filter(Boolean))
    .filter((parts) => parts.length === 1) // '/auth/callback' is not the whole /auth segment
    .map((parts) => parts[0]),
)

// ── filesystem helpers ────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}
const isPage = (f) => /^page\.(js|jsx)$/.test(path.basename(f))
const isSource = (f) => /\.(js|jsx)$/.test(f) && !/\.test\.(js|jsx)$/.test(f)
const layoutIn = (dir) => ['layout.js', 'layout.jsx'].map((n) => path.join(dir, n)).find(existsSync) || null

const importsStaffHelper = (src) => /staff-tab-title/.test(src)
const resolvesStaffTitle = (src) =>
  importsStaffHelper(src) &&
  /export\s+async\s+function\s+generateMetadata\b/.test(src) &&
  /staffTabMetadata\(\)/.test(src)
const exportsOwnMetadata = (src) =>
  /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b|const\s+generateMetadata\b)/.test(src)

const SEGMENTS = readdirSync(APP).filter((e) => statSync(path.join(APP, e)).isDirectory())

function classify(segment) {
  const pages = walk(path.join(APP, segment)).filter(isPage)
  if (segment in STAFF) return 'staff'
  if (segment in CUSTOMER) return 'customer'
  if (PUBLIC_TOP_LEVEL.has(segment)) return 'public'
  if (pages.length === 0) return 'no-pages'
  return null
}

describe('every top-level segment of src/app is classified (TABTITLE.1)', () => {
  it.each(SEGMENTS)('%s', (segment) => {
    expect(
      classify(segment),
      `src/app/${segment} has pages but is not classified. Decide what it is:\n` +
        `  staff    -> add it to STAFF in src/lib/staff-tab-title-coverage.test.js and export generateMetadata = staffTabMetadata() from its outermost layout\n` +
        `  public   -> it needs all FOUR public allowlists (CLAUDE.md); AppShell's PUBLIC_PATHS is the one this test reads\n` +
        `  customer -> add it to CUSTOMER with a reason and give it customerFacingMetadata()`,
    ).not.toBeNull()
  })

  it('the hand-written lists name real segments, once', () => {
    for (const segment of [...Object.keys(STAFF), ...Object.keys(CUSTOMER)]) {
      expect(SEGMENTS, `${segment} is listed here but is not a directory of src/app`).toContain(segment)
    }
    for (const segment of Object.keys(STAFF)) {
      expect(segment in CUSTOMER, `${segment} is listed as both staff and customer`).toBe(false)
      // A staff segment in PUBLIC_PATHS never gets the staff shell, and an
      // anonymous visitor can reach it: one of the two lists is wrong.
      expect(PUBLIC_TOP_LEVEL.has(segment), `${segment} is STAFF here but public in AppShell PUBLIC_PATHS`).toBe(false)
    }
  })
})

describe('every STAFF page resolves the active studio, exactly once (TABTITLE.1)', () => {
  const staffPages = Object.keys(STAFF).flatMap((segment) =>
    walk(path.join(APP, segment)).filter(isPage).map((page) => [rel(page), page]),
  )

  it('found the staff pages at all', () => {
    expect(staffPages.length).toBeGreaterThan(100)
  })

  it.each(staffPages)('%s', (_label, page) => {
    // Layout files from the page's own directory up to (not including) src/app.
    const chain = []
    for (let dir = path.dirname(page); dir !== APP; dir = path.dirname(dir)) {
      const layout = layoutIn(dir)
      if (layout) chain.push({ dir, layout, src: readFileSync(layout, 'utf8') })
    }
    const resolvers = chain.filter((l) => resolvesStaffTitle(l.src))

    expect(
      resolvers.map((l) => rel(l.layout)),
      'a staff page needs exactly ONE ancestor layout exporting generateMetadata -> staffTabMetadata(). ' +
        'None: the tab falls back to the deployment-wide site name. Two: it reads "Studio · Studio".',
    ).toHaveLength(1)

    // Any OTHER layout on the route that sets metadata would replace the
    // staff title (a nested string title wins over the parent's default).
    for (const l of chain.filter((c) => !resolvers.includes(c))) {
      expect(exportsOwnMetadata(l.src), `${rel(l.layout)} sets its own metadata under a staff layout`).toBe(false)
    }

    // title.template never reaches a page in the SAME segment as the layout
    // that defines it, so a title set there would drop the studio name.
    const pageSrc = readFileSync(page, 'utf8')
    if (exportsOwnMetadata(pageSrc)) {
      expect(
        path.dirname(page),
        `${rel(page)} sets a title but shares a segment with ${rel(resolvers[0].layout)}; the template will not apply to it`,
      ).not.toBe(resolvers[0].dir)
    }
  })
})

describe('no customer-facing or public surface can read a staff studio name (TABTITLE.1)', () => {
  const guarded = SEGMENTS.filter((s) => ['public', 'customer', 'no-pages'].includes(classify(s)))

  it.each(guarded)('%s never imports the staff tab helper', (segment) => {
    const offenders = walk(path.join(APP, segment))
      .filter(isSource)
      .filter((f) => importsStaffHelper(readFileSync(f, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it.each(Object.keys(CUSTOMER))('%s declares customer-facing metadata', (segment) => {
    const layout = layoutIn(path.join(APP, segment))
    expect(layout, `src/app/${segment} needs a layout exporting customerFacingMetadata()`).not.toBeNull()
    expect(readFileSync(layout, 'utf8')).toContain('customerFacingMetadata')
  })

  // The root layout is every page's ancestor, public ones included. Reading
  // the session there would make the whole app dynamic and put the studio
  // name within reach of anonymous pages.
  it('the ROOT layout stays cookie-free', () => {
    const src = readFileSync(path.join(APP, 'layout.js'), 'utf8')
    const body = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('export const viewport'))
    expect(importsStaffHelper(src)).toBe(false)
    expect(body).not.toMatch(/getCurrentUser|cookies\(|headers\(/)
  })

  // '/' is not a segment, so nothing above sees it. It renders no tab: every
  // branch redirects. If it ever renders, it needs a classification too.
  it('the root page only ever redirects', () => {
    const src = readFileSync(path.join(APP, 'page.js'), 'utf8')
    expect(src).not.toMatch(/return\s*\(|return\s*</)
    expect(exportsOwnMetadata(src)).toBe(false)
  })
})
