// TABTITLE.1 — coverage guard: every STAFF page's tab names the active
// studio, and nothing customer-facing or public ever can.
//
// Staff pages do not share a layout. They are spread over six route groups,
// five top-level segments that had a layout and eight more that had none, so
// "the staff title" is 19 separate exports and the next new segment
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
//   redirect  listed in REDIRECT_ONLY: every page under it does nothing but
//             redirect(), so no tab is ever titled and a layout there would
//             be surface that never renders. PROVEN per page below, so the
//             exemption fails the day a real page is added.
//   no-pages  DERIVED: no page file anywhere under it (route handlers only),
//             so there is no tab to title. Adding a page reclassifies it.
// Anything else FAILS, so whoever adds a segment has to choose.
//
// The rules asserted per staff page are Next's, not house style; both are
// demonstrated against the installed resolver in staff-tab-title.test.js:
//   - two staff layouts on one route render "Studio · Studio";
//   - title.template skips a page in the SAME segment as the layout, so such
//     a page must not set a title of its own (it would drop the studio).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
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
  portfolio: 'org portfolio. Account tier, but still names the active studio',
  presentations: 'presenter remote (the wall display is /present, public)',
  settings: 'settings',
  'studio-management': 'class timer control, inside the staff shell',
}

const CUSTOMER = {
  account: 'member self-service. Signed in, but the audience is the customer (brand-chrome.test.js pins its metadata)',
}

// Hub index URLs. Each is one page.js that resolves the first tab the user may
// see and redirect()s there; the real pages live in the (group) of the same
// name, which IS staff. Proven below, page by page.
const REDIRECT_ONLY = {
  marketing: '/marketing -> first visible Marketing tab',
  members: '/members -> first visible Members tab',
  money: '/money -> first visible Money tab',
  operations: '/operations -> first visible Operations tab',
  sales: '/sales -> first visible Sales tab',
  team: '/team -> first visible Team tab',
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
// Next's default pageExtensions are tsx, ts, jsx, js (next.config.js does not
// override them). This repo is all .js/.jsx TODAY, which is exactly why the
// walker must not assume it: a guard that only sees .js classifies a segment
// holding page.tsx as "no pages" and passes, and cannot see a layout.tsx that
// doubles the studio. Fail CLOSED on every extension Next would route.
const EXT = '(js|jsx|ts|tsx)'
const PAGE_RE = new RegExp(`^page\\.${EXT}$`)
const LAYOUT_RE = new RegExp(`^layout\\.${EXT}$`)
const SOURCE_RE = new RegExp(`\\.${EXT}$`)
const TEST_RE = new RegExp(`\\.(test|spec)\\.${EXT}$`)

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}
const isPage = (f) => PAGE_RE.test(path.basename(f))
const isSource = (f) => SOURCE_RE.test(f) && !TEST_RE.test(f)
const layoutsIn = (dir) => readdirSync(dir).filter((e) => LAYOUT_RE.test(e)).map((e) => path.join(dir, e))
const pagesUnder = (dir) => walk(dir).filter(isPage)

const importsStaffHelper = (src) => /staff-tab-title/.test(src)
const resolvesStaffTitle = (src) =>
  importsStaffHelper(src) &&
  /export\s+async\s+function\s+generateMetadata\b/.test(src) &&
  /staffTabMetadata\(\)/.test(src)
const exportsOwnMetadata = (src) =>
  /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b|const\s+generateMetadata\b)/.test(src)

// "Does nothing but redirect": calls redirect(), returns no JSX, contains no
// JSX at all once comments are gone. Deliberately strict; a page that renders
// anything, even a fallback, titles a tab and is not exempt.
function redirectOnlyProblems(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const problems = []
  if (!/\bredirect\(/.test(code)) problems.push('never calls redirect()')
  if (/\breturn\s*[(<]/.test(code)) problems.push('returns a rendered value')
  if (/<[A-Za-z][\w.]*(\s|\/|>)/.test(code)) problems.push('contains JSX')
  return problems
}

const segmentsOf = (appDir) => readdirSync(appDir).filter((e) => statSync(path.join(appDir, e)).isDirectory())
const SEGMENTS = segmentsOf(APP)

function classify(segment, appDir = APP) {
  if (segment in STAFF) return 'staff'
  if (segment in CUSTOMER) return 'customer'
  if (segment in REDIRECT_ONLY) return 'redirect'
  if (PUBLIC_TOP_LEVEL.has(segment)) return 'public'
  if (pagesUnder(path.join(appDir, segment)).length === 0) return 'no-pages'
  return null
}

// Everything wrong with one staff page's route, as strings ([] = fine).
function staffPageProblems(page, appDir = APP) {
  const show = (abs) => path.relative(appDir, abs)
  // Layout files from the page's own directory up to (not including) the app root.
  const chain = []
  for (let dir = path.dirname(page); dir !== appDir; dir = path.dirname(dir)) {
    for (const layout of layoutsIn(dir)) chain.push({ dir, layout, src: readFileSync(layout, 'utf8') })
  }
  const resolvers = chain.filter((l) => resolvesStaffTitle(l.src))
  const problems = []
  if (resolvers.length === 0) {
    problems.push('no ancestor layout exports generateMetadata -> staffTabMetadata(): the tab falls back to the deployment-wide site name')
  }
  if (resolvers.length > 1) {
    problems.push(`${resolvers.length} ancestor layouts resolve staffTabMetadata (${resolvers.map((l) => show(l.layout)).join(', ')}): the tab reads "Studio · Studio"`)
  }
  // Any OTHER layout on the route that sets metadata would replace the staff
  // title (a nested string title wins over the parent's default).
  for (const l of chain.filter((c) => !resolvers.includes(c))) {
    if (exportsOwnMetadata(l.src)) problems.push(`${show(l.layout)} sets its own metadata under a staff layout`)
  }
  // title.template never reaches a page in the SAME segment as the layout
  // that defines it, so a title set there would drop the studio name.
  if (resolvers.length === 1 && exportsOwnMetadata(readFileSync(page, 'utf8')) && path.dirname(page) === resolvers[0].dir) {
    problems.push(`sets a title but shares a segment with ${show(resolvers[0].layout)}; the template will not apply to it`)
  }
  return problems
}

describe('every top-level segment of src/app is classified (TABTITLE.1)', () => {
  it.each(SEGMENTS)('%s', (segment) => {
    expect(
      classify(segment),
      `src/app/${segment} has pages but is not classified. Decide what it is:\n` +
        `  staff    -> add it to STAFF in src/lib/staff-tab-title-coverage.test.js and export generateMetadata = staffTabMetadata() from its outermost layout\n` +
        `  public   -> it needs all FOUR public allowlists (CLAUDE.md); AppShell's PUBLIC_PATHS is the one this test reads\n` +
        `  customer -> add it to CUSTOMER with a reason and give it customerFacingMetadata()\n` +
        `  redirect -> only if EVERY page under it just redirect()s: add it to REDIRECT_ONLY`,
    ).not.toBeNull()
  })

  it('the hand-written lists name real segments, once', () => {
    const listed = [...Object.keys(STAFF), ...Object.keys(CUSTOMER), ...Object.keys(REDIRECT_ONLY)]
    expect(new Set(listed).size, 'a segment is in two of STAFF / CUSTOMER / REDIRECT_ONLY').toBe(listed.length)
    for (const segment of listed) {
      expect(SEGMENTS, `${segment} is listed here but is not a directory of src/app`).toContain(segment)
    }
    for (const segment of Object.keys(STAFF)) {
      // A staff segment in PUBLIC_PATHS never gets the staff shell, and an
      // anonymous visitor can reach it: one of the two lists is wrong.
      expect(PUBLIC_TOP_LEVEL.has(segment), `${segment} is STAFF here but public in AppShell PUBLIC_PATHS`).toBe(false)
    }
  })
})

describe('every STAFF page resolves the active studio, exactly once (TABTITLE.1)', () => {
  const staffPages = Object.keys(STAFF).flatMap((segment) =>
    pagesUnder(path.join(APP, segment)).map((page) => [rel(page), page]),
  )

  it('found the staff pages at all', () => {
    expect(staffPages.length).toBeGreaterThan(100)
  })

  it.each(staffPages)('%s', (_label, page) => {
    expect(staffPageProblems(page)).toEqual([])
  })
})

describe('no customer-facing or public surface can read a staff studio name (TABTITLE.1)', () => {
  const guarded = SEGMENTS.filter((s) => ['public', 'customer', 'redirect', 'no-pages'].includes(classify(s)))

  it.each(guarded)('%s never imports the staff tab helper', (segment) => {
    const offenders = walk(path.join(APP, segment))
      .filter(isSource)
      .filter((f) => importsStaffHelper(readFileSync(f, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it.each(Object.keys(CUSTOMER))('%s declares customer-facing metadata', (segment) => {
    const [layout] = layoutsIn(path.join(APP, segment))
    expect(layout, `src/app/${segment} needs a layout exporting customerFacingMetadata()`).toBeTruthy()
    expect(readFileSync(layout, 'utf8')).toContain('customerFacingMetadata')
  })

  // The root generateMetadata is every page's metadata ancestor, public and
  // customer-facing ones included. This is NOT about rendering cost (the root
  // layout already reads the session for every route, via AppShellServer). It
  // is that a session read HERE would make a staff studio name resolvable in
  // the metadata of customer surfaces, whose titles customerFacingMetadata()
  // owns. Scoped to generateMetadata on purpose: the layout BODY may read it.
  it('the ROOT generateMetadata never reads the session', () => {
    const src = readFileSync(path.join(APP, 'layout.js'), 'utf8')
    const body = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('export const viewport'))
    expect(body.length).toBeGreaterThan(0)
    expect(importsStaffHelper(src)).toBe(false)
    expect(body).not.toMatch(/getCurrentUser|cookies\(|headers\(/)
  })

  // '/' is not a segment, so nothing above sees it. It renders no tab: every
  // branch redirects. If it ever renders, it needs a classification too.
  it('the root page only ever redirects', () => {
    const src = readFileSync(path.join(APP, 'page.js'), 'utf8')
    expect(redirectOnlyProblems(src)).toEqual([])
    expect(exportsOwnMetadata(src)).toBe(false)
  })
})

// The exemption that could rot: "this segment never titles a tab". So it is
// not taken on trust. Every page under a REDIRECT_ONLY segment is read and
// must do nothing but redirect; add a real page and this fails, and the fix is
// to move the segment to STAFF and give it a layout.
describe('REDIRECT_ONLY segments really only redirect (TABTITLE.1)', () => {
  it.each(Object.keys(REDIRECT_ONLY))('%s', (segment) => {
    const pages = pagesUnder(path.join(APP, segment))
    expect(pages.length, `src/app/${segment} has no pages left; drop it from REDIRECT_ONLY`).toBeGreaterThan(0)
    for (const page of pages) {
      expect(
        redirectOnlyProblems(readFileSync(page, 'utf8')),
        `${rel(page)} is a real page, so src/app/${segment} is not redirect-only: move it to STAFF and add a layout exporting staffTabMetadata()`,
      ).toEqual([])
    }
    // Less surface: a layout here would resolve a title nothing ever shows.
    expect(layoutsIn(path.join(APP, segment)).map(rel)).toEqual([])
  })

  it('the proof can tell a real page from a redirect', () => {
    expect(redirectOnlyProblems("export default async function P() { redirect('/x') }")).toEqual([])
    expect(redirectOnlyProblems('export default function P() { return <div>hi</div> }')).not.toEqual([])
    expect(redirectOnlyProblems("export default function P() { if (!u) redirect('/login')\n return (\n <Hub /> ) }")).not.toEqual([])
    // JSX in a comment is not JSX.
    expect(redirectOnlyProblems("// renders <HubTabs /> elsewhere\nexport default function P() { redirect('/x') }")).toEqual([])
  })
})

// PROBES. The guard above is only worth having if it fails CLOSED, and the
// first cut did not: it matched .js/.jsx only, so a segment holding page.tsx
// classified as "no pages" and passed, and a layout.tsx doubling the studio
// was invisible. These run the same functions over a throwaway app tree (never
// src/app: other suites walk that concurrently).
describe('the guard fails closed on TypeScript routes (TABTITLE.1 probes)', () => {
  let fixture
  const write = (relPath, content) => {
    const abs = path.join(fixture, relPath)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    return abs
  }
  const STAFF_LAYOUT =
    "import { staffTabMetadata } from '@/lib/staff-tab-title'\n" +
    'export async function generateMetadata() { return staffTabMetadata() }\n' +
    'export default function L({ children }) { return children }\n'

  beforeAll(() => { fixture = mkdtempSync(path.join(os.tmpdir(), 'tabtitle-probe-')) })
  afterAll(() => { rmSync(fixture, { recursive: true, force: true }) })

  it('a .tsx page in an unclassified segment is UNCLASSIFIED, not "no-pages"', () => {
    write('newthing/page.tsx', 'export default function P() { return null }\n')
    write('handlers/route.ts', 'export async function GET() {}\n')
    expect(segmentsOf(fixture).sort()).toEqual(['handlers', 'newthing'])
    expect(classify('newthing', fixture)).toBeNull()
    // ...while a genuinely page-less segment still derives as such.
    expect(classify('handlers', fixture)).toBe('no-pages')
  })

  it.each(['ts', 'tsx', 'jsx', 'js'])('a page.%s under a staff layout is seen and passes', (ext) => {
    write(`ok-${ext}/layout.${ext}`, STAFF_LAYOUT)
    const page = write(`ok-${ext}/inner/page.${ext}`, 'export default function P() { return null }\n')
    expect(pagesUnder(path.join(fixture, `ok-${ext}`))).toEqual([page])
    expect(staffPageProblems(page, fixture)).toEqual([])
  })

  it('a second resolver in a layout.tsx is seen ("Studio · Studio")', () => {
    write('doubled/layout.js', STAFF_LAYOUT)
    write('doubled/inner/layout.tsx', STAFF_LAYOUT)
    const page = write('doubled/inner/page.js', 'export default function P() { return null }\n')
    const problems = staffPageProblems(page, fixture)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/2 ancestor layouts/)
  })

  it('a staff page with no resolver above it, and a nested layout.ts that sets metadata, are both reported', () => {
    const bare = write('bare/page.tsx', 'export default function P() { return null }\n')
    expect(staffPageProblems(bare, fixture).join(' ')).toMatch(/no ancestor layout/)

    write('clobber/layout.js', STAFF_LAYOUT)
    write('clobber/inner/layout.ts', "export const metadata = { title: 'Mine' }\nexport default function L({ children }) { return children }\n")
    const page = write('clobber/inner/page.js', 'export default function P() { return null }\n')
    expect(staffPageProblems(page, fixture).join(' ')).toMatch(/sets its own metadata/)
  })

  it('a titled page.tsx in the SAME segment as the staff layout is reported', () => {
    write('same/layout.tsx', STAFF_LAYOUT)
    const page = write('same/page.tsx', "export const metadata = { title: 'Approvals' }\nexport default function P() { return null }\n")
    expect(staffPageProblems(page, fixture).join(' ')).toMatch(/template will not apply/)
  })
})
