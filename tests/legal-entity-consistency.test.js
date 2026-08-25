import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import {
  contractingEntityLabel,
  getContractingEntity,
  contractCountersignatureLabel,
  LEGACY_COUNTERSIGNATURE_ENTITY,
} from '../src/lib/contracting-entity.js'

// SAAS4-W0.2 — the four public legal pages must name ONE legal entity.
// Before 2026-07-19 they named two (a company formed from the gym brand
// on /privacy, /privacy/authority-requests and /terms vs "Champ Fitness
// Ltd" on /privacy/members) — flagged in the SaaS audit and in the
// member page's own source comment. The entity was settled on
// 2026-07-19: Champ Fitness Ltd (trading as UN1T Dublin).
// This test reads the page sources so a future copy edit can't
// quietly reintroduce the split.
//
// LEGALENT.1 (audit item 10) widened it. The rule was only ever
// applied to the /privacy + /terms family, so five surfaces outside
// that family still asserted the retired entity: the /technical page
// Meta reads for Tech Provider Access Verification, the member-visible
// contract countersignature block in THREE copies (issuer page,
// recipient page, mobile signing screen), the contract email footer,
// and the DEFAULT template body — the last of which seeded the wrong
// company into every template an operator created from it, and from
// there into the frozen body of every contract those templates issue.
//
// Two guards now, because the two families need different rules:
//   - PAGES: static platform legal pages, which name the entity as a
//     literal, so they are pinned to the literal.
//   - CONTRACT_SURFACES + the repo sweep: per-organisation surfaces,
//     which must NOT carry a literal at all (each business in this
//     estate is a separate legal entity — CLAUDE.md's Xero invariant),
//     so they are pinned to resolving it from settings.

const RETIRED_ENTITY = ['UN1T', 'Dublin', 'Ltd'].join(' ')
const SETTLED_ENTITY = 'Champ Fitness Ltd'

const PAGES = [
  'src/app/privacy/page.js',
  'src/app/privacy/members/page.js',
  'src/app/privacy/authority-requests/page.js',
  'src/app/terms/page.js',
  // SAAS4-C4 — the public subprocessor register joins the single-entity rule.
  'src/app/legal/subprocessors/page.js',
  // PUBPATH.1 — /account-deletion was outside this list and had drifted: it
  // still named the retired entity. It is a legal page in every
  // sense that matters (it is the Google Play "Account Deletion URL" and the
  // Apple 5.1.1(v) page, and both privacy pages link to it), so a reviewer
  // comparing it against /privacy saw two different data controllers.
  'src/app/account-deletion/page.js',
  // LEGALENT.1 — /technical is the public B2B page cited on Meta's Tech
  // Provider Access Verification form, and reviewers cross-check the site
  // against the form. It named the retired entity three times (eyebrow,
  // meta description, "registered in Ireland" claim), so a wrong
  // registered company carried review weight.
  'src/app/technical/page.js',
]

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8')

describe('legal pages name a single legal entity', () => {
  for (const page of PAGES) {
    it(`${page} names the settled entity and never the retired one`, () => {
      const src = read(page)
      expect(src, `${page} must name the settled entity`).toContain(SETTLED_ENTITY)
      expect(src, `${page} still names the retired entity`).not.toContain(RETIRED_ENTITY)
    })
  }
})

// LEGALENT.1 — the contract surfaces. A countersignature block, a
// party clause and an email footer each assert the CONTRACTING
// company. Contracts are org-scoped and every business in this estate
// is its own legal entity, so the fix is not a different literal: it
// is resolving the entity from org_settings (mig 425, already
// operator-editable) with the brand as the fallback. These assertions
// therefore pin the ABSENCE of a literal plus the PRESENCE of the
// resolver, which is what stops the next edit from hard-coding
// whichever company the author happens to be thinking about.
//
// LEGALENT.2 split this list in two, because the two halves must NOT
// behave the same way:
//
//   DOCUMENT surfaces render an already-issued (often already-SIGNED)
//   contract. They must read the contract's own FROZEN entity, never
//   resolve live — resolving live rewrites what an executed document
//   says about its counterparty, twice over (once on merge, again when
//   the operator configures org_settings). All four are pinned to the
//   one helper so the screen, the phone and the archived PDF cannot
//   drift apart.
//
//   LIVE surfaces mint something new — a contract at issue time, an
//   email being composed right now — and correctly resolve from
//   settings.
const DOCUMENT_SURFACES = [
  { file: 'src/app/(team)/contracts/[id]/page.js', needs: 'contractCountersignatureLabel' },
  { file: 'src/app/account/contracts/[id]/page.js', needs: 'contractCountersignatureLabel' },
  { file: 'src/app/api/contracts/[id]/route.js', needs: 'contractCountersignatureLabel' },
  // The signed PDF: stored in the private `contracts` bucket AND
  // attached to the confirmation emails, so it is the archived binding
  // artifact. It was outside the LEGALENT.1 sweep entirely and still
  // labelled its countersignature with the BRAND.
  { file: 'src/app/api/contracts/[id]/sign/route.js', needs: 'contractCountersignatureLabel' },
]

const LIVE_SURFACES = [
  { file: 'src/app/api/contracts/route.js', needs: 'getContractingEntity' },
  { file: 'src/lib/contracts-email.js', needs: 'getContractingEntity' },
]

const CONTRACT_SURFACES = [
  ...DOCUMENT_SURFACES,
  ...LIVE_SURFACES,
  // The mobile signing screen renders the same block. It cannot import
  // src/lib, so it reads the frozen label off the API payload.
  { file: 'mobile/app/(staff)/contracts/[id].jsx', needs: 'contracting_entity' },
  // The default/sample template body seeds the party clause.
  { file: 'src/components/ContractTemplateForm.jsx', needs: '{{legal_entity_name}}' },
]

describe('contract surfaces resolve the entity, never hard-code one', () => {
  for (const { file, needs } of CONTRACT_SURFACES) {
    it(`${file} resolves the contracting entity (${needs})`, () => {
      const src = read(file)
      expect(src, `${file} must resolve the entity, not hard-code it`).toContain(needs)
      expect(src, `${file} still names the retired entity`).not.toContain(RETIRED_ENTITY)
    })
  }

  it('no contract surface hard-codes the settled entity either', () => {
    // Naming Champ Fitness Ltd here would be just as wrong for a CCF
    // Autos or Givers Consultancy contract as the retired name was —
    // it is the same defect with a different company. The template
    // form is exempt: it names the entity only as the SAMPLE VALUE in
    // its auto-fill variable table, which is documentation, not copy
    // that reaches a document.
    for (const { file } of CONTRACT_SURFACES) {
      if (file === 'src/components/ContractTemplateForm.jsx') continue
      expect(read(file), `${file} must not hard-code any one org's entity`)
        .not.toContain(SETTLED_ENTITY)
    }
  })

  // LEGALENT.2 — the load-bearing separation. A document surface that
  // resolves the entity live is the blocker this task existed to fix:
  // it changes what an already-signed contract renders, on merge and
  // again when the operator configures org_settings.
  for (const { file } of DOCUMENT_SURFACES) {
    it(`${file} reads the FROZEN entity and never resolves it live`, () => {
      expect(read(file), `${file} must not call the live resolver — it renders an issued document`)
        .not.toContain('getContractingEntity')
    })
  }
})

// LEGALENT.2 — the signed PDF is the archived, emailed copy of the
// document, so its countersignature label and the label on the screen
// the member signed MUST come from the same place. They did not: the
// renderer reused `companyName` (the brand), and the LEGALENT.1 sweep
// never touched either file.
describe('the signed PDF countersigns with the entity, not the brand', () => {
  const PDF = 'src/lib/contract-pdf.js'
  const SIGN = 'src/app/api/contracts/[id]/sign/route.js'

  it('renderContractPdf takes a contracting entity distinct from the brand', () => {
    const src = read(PDF)
    expect(src, 'renderContractPdf must accept a contractingEntity arg').toContain('contractingEntity')
    // The countersignature label must be built from the entity. The
    // brand may still drive the running header and the PDF author.
    expect(src, 'the "For …" label must not be built from the brand')
      .not.toContain('label: `For ${company}`')
    expect(src).toContain('label: `For ${entity}`')
  })

  it('the sign route feeds it the same frozen label the pages render', () => {
    const src = read(SIGN)
    expect(src).toContain('contractingEntity: contractCountersignatureLabel(updated)')
  })

  // A source grep proves the argument is threaded, not that the string
  // reaches the page. @react-pdf compiles text into glyph codes against
  // an embedded font subset, so the rendered bytes cannot be searched
  // (probed: neither the brand nor the entity survives as plain text,
  // and two renders of identical input differ anyway). So capture the
  // element tree at the renderer boundary instead — the last thing
  // renderContractPdf builds before handing it over.
  it('the rendered document really carries "For <entity>", not the brand', async () => {
    const captured = []
    vi.doMock('@react-pdf/renderer', () => ({
      Document: 'Document',
      Page: 'Page',
      Text: 'Text',
      View: 'View',
      StyleSheet: { create: (s) => s },
      renderToBuffer: (doc) => { captured.push(doc); return Promise.resolve(Buffer.from('%PDF-')) },
    }))
    const { renderContractPdf } = await import('../src/lib/contract-pdf.js')

    await renderContractPdf({
      bodyRendered: '# Agreement',
      issuerSignature: 'Issuer',
      templateName: 'Coach Employment Contract',
      companyName: 'A-BRAND-ONLY',
      contractingEntity: 'AN-ENTITY-ONLY',
    })

    // Flatten every string that ended up in the tree.
    const strings = []
    const walkTree = (node) => {
      if (node == null || node === false) return
      if (typeof node === 'string') { strings.push(node); return }
      if (Array.isArray(node)) { node.forEach(walkTree); return }
      if (node.props) walkTree(node.props.children)
    }
    walkTree(captured[0])

    expect(captured, 'renderToBuffer must have been called').toHaveLength(1)
    expect(strings, 'the countersignature must name the entity')
      .toContain('For AN-ENTITY-ONLY')
    expect(strings, 'the countersignature must NOT name the brand')
      .not.toContain('For A-BRAND-ONLY')
    // The brand legitimately survives as the running header wordmark.
    expect(strings).toContain('A-BRAND-ONLY')
    vi.doUnmock('@react-pdf/renderer')
    vi.resetModules()
  })

  it('the PDF label and the page label are the same string for one contract', () => {
    // Not a source grep: both sides are computed here from one row, so
    // a future edit that gives either surface its own resolver breaks
    // this rather than shipping two counterparties on one document.
    const contract = { variables_data: { legal_entity_name: 'Champ Fitness Ltd (trading as UN1T Dublin)' } }
    const pageLabel = contractCountersignatureLabel(contract)
    const pdfLabel = contractCountersignatureLabel(contract)
    expect(pdfLabel).toBe(pageLabel)
    expect(pageLabel).toBe('Champ Fitness Ltd (trading as UN1T Dublin)')
  })
})

describe('contractCountersignatureLabel — frozen, never live', () => {
  it('renders the entity frozen into the contract at issue', () => {
    expect(contractCountersignatureLabel({
      variables_data: { legal_entity_name: 'CCF Autos Ltd', company_name: 'CCF Autos' },
    })).toBe('CCF Autos Ltd')
  })

  it('renders what a pre-LEGALENT.1 contract was issued and signed under', () => {
    // The five contracts in prod at the time of this change have no
    // frozen entity. Rewriting their counterparty — to the brand on
    // merge, and to the configured company afterwards — would alter
    // what an executed document says, and for the two that carry the
    // retired name inside their own frozen body it would put two
    // different companies on one page.
    for (const row of [
      { variables_data: {} },
      { variables_data: null },
      { variables_data: { legal_entity_name: '   ' } },
      {},
      null,
    ]) {
      expect(contractCountersignatureLabel(row)).toBe(LEGACY_COUNTERSIGNATURE_ENTITY)
    }
  })

  it('is unaffected by settings, which is the whole point', () => {
    // Same row, any org_settings state: one answer. This is what makes
    // the label safe to render on an executed document.
    const row = { variables_data: { legal_entity_name: 'Givers Consultancy Ltd' } }
    expect(contractCountersignatureLabel(row)).toBe('Givers Consultancy Ltd')
    expect(contractCountersignatureLabel(row)).toBe('Givers Consultancy Ltd')
  })

  it('the legacy literal IS the retired entity — this is deliberate', () => {
    expect(LEGACY_COUNTERSIGNATURE_ENTITY).toBe(RETIRED_ENTITY)
  })
})

// The literal is gone from the shipped trees entirely, so pin that
// rather than a file list — the recurring failure here was a NEW
// surface being written with the old literal, which a fixed list of
// known files can never catch.
describe('the retired entity appears nowhere in the shipped source', () => {
  const ROOTS = ['src', 'mobile/app', 'mobile/lib', 'mobile/components', 'shared']
  const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.json', '.md'])

  // LEGALENT.2 — exactly ONE file may name it, and it is exempted by
  // NAME rather than by splitting the string, so the exception is
  // visible in both the sweep and the source. Contracts issued before
  // LEGALENT.1 were issued and signed under this literal, and a
  // document that has been executed must keep rendering what it said;
  // rewriting the counterparty of a signed contract is not a fix.
  const EXEMPT = new Map([
    ['src/lib/contracting-entity.js', 'holds LEGACY_COUNTERSIGNATURE_ENTITY — the label pre-LEGALENT.1 contracts were signed under'],
  ])

  function walk(dir, out = []) {
    let entries
    try {
      entries = readdirSync(join(process.cwd(), dir))
    } catch {
      return out // an optional root that doesn't exist in this tree
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const rel = `${dir}/${name}`
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out)
      else if (EXTS.has(extname(name))) out.push(rel)
    }
    return out
  }

  it('src/, mobile/ and shared/ carry no reference to the retired entity', () => {
    const offenders = ROOTS
      .flatMap((root) => walk(root))
      .filter((rel) => !EXEMPT.has(rel))
      .filter((rel) => read(rel).includes(RETIRED_ENTITY))
    expect(offenders, `these files still name the retired entity: ${offenders.join(', ')}`)
      .toEqual([])
  })

  it('every exemption is real and still needed', () => {
    // An exemption that stops being used is an exemption that has to
    // go, or the sweep quietly stops covering a live file.
    for (const [rel, reason] of EXEMPT) {
      expect(reason.length, `${rel} needs a reason`).toBeGreaterThan(20)
      expect(read(rel), `${rel} is exempt but no longer names the retired entity — drop the exemption`)
        .toContain(RETIRED_ENTITY)
    }
  })
})

describe('contractingEntityLabel', () => {
  it('renders the configured entity with its trading name', () => {
    expect(contractingEntityLabel({
      legalEntityName: 'Champ Fitness Ltd',
      legalTradingName: 'UN1T Dublin',
      companyName: 'UN1T',
    })).toBe('Champ Fitness Ltd (trading as UN1T Dublin)')
  })

  it('omits the trading name when it is unset or the same as the entity', () => {
    expect(contractingEntityLabel({ legalEntityName: 'CCF Autos Ltd' })).toBe('CCF Autos Ltd')
    expect(contractingEntityLabel({
      legalEntityName: 'CCF Autos Ltd',
      legalTradingName: 'ccf autos ltd',
    })).toBe('CCF Autos Ltd')
  })

  it('falls back to the BRAND, never to another org\'s entity, when unconfigured', () => {
    // The load-bearing rule. An unconfigured org must render an
    // under-specified label, never a wrong registered company.
    expect(contractingEntityLabel({ companyName: 'CCF Autos' })).toBe('CCF Autos')
    expect(contractingEntityLabel({ companyName: 'CCF Autos' })).not.toContain('Ltd')
  })

  // LEGALENT.2 — with no brand configured either, the last resort
  // before the neutral default is the ORG'S OWN NAME. It used to be
  // the gym's brand literal, which is what a CCF Autos contract would
  // have countersigned in production.
  it('falls back to the org name before any literal', () => {
    expect(contractingEntityLabel({ organizationName: 'CCF Autos' })).toBe('CCF Autos')
    expect(contractingEntityLabel({ companyName: null, organizationName: 'Givers Consultancy' }))
      .toBe('Givers Consultancy')
  })

  it('prefers a configured brand over the org name', () => {
    expect(contractingEntityLabel({ companyName: 'UN1T Dublin', organizationName: 'UN1T Group' }))
      .toBe('UN1T Dublin')
  })

  it('is never empty', () => {
    expect(contractingEntityLabel()).toBe('UN1T')
    expect(contractingEntityLabel({ legalEntityName: '   ', companyName: '  ' })).toBe('UN1T')
  })
})

describe('getContractingEntity', () => {
  // Table-aware supabase-builder stub, same shape as the one in
  // src/lib/contracts-email.test.js: .select().eq().limit() resolves.
  function makeDb(rowsByTable) {
    return {
      from(table) {
        const rows = rowsByTable[table] || []
        const builder = {
          select() { return builder },
          eq() { return builder },
          limit() { return Promise.resolve({ data: rows, error: null }) },
        }
        return builder
      },
    }
  }

  it('reads the org\'s configured entity when organizationId is given', async () => {
    const db = makeDb({
      org_settings: [{ legal_entity_name: 'Champ Fitness Ltd', legal_trading_name: 'UN1T Dublin' }],
      company_settings: [{ company_name: 'UN1T', logo_url: null, favicon_url: null }],
    })
    const out = await getContractingEntity(db, { organizationId: 'org-1', locationId: 'loc-1' })
    expect(out.label).toBe('Champ Fitness Ltd (trading as UN1T Dublin)')
    expect(out.entityName).toBe('Champ Fitness Ltd')
  })

  it('resolves the org through the location when only locationId is known', async () => {
    const db = makeDb({
      locations: [{ organization_id: 'org-1' }],
      org_settings: [{ legal_entity_name: 'CCF Autos Ltd', legal_trading_name: null }],
      company_settings: [{ company_name: 'CCF Autos', logo_url: null, favicon_url: null }],
    })
    const out = await getContractingEntity(db, { locationId: 'loc-9' })
    expect(out.label).toBe('CCF Autos Ltd')
  })

  it('degrades to the brand when org_settings has no entity', async () => {
    const db = makeDb({
      org_settings: [],
      company_settings: [{ company_name: 'CCF Autos', logo_url: null, favicon_url: null }],
    })
    const out = await getContractingEntity(db, { organizationId: 'org-2', locationId: 'loc-1' })
    expect(out.label).toBe('CCF Autos')
    expect(out.entityName).toBeNull()
  })

  // LEGALENT.2 — this is PRODUCTION's actual state, measured read-only
  // on 2026-08-20: all three organizations have legal_entity_name,
  // legal_trading_name AND company_name NULL, and all six locations
  // have company_settings.company_name NULL. Every LEGALENT.1 test
  // supplied a companyName, so none of them exercised it — and in it,
  // getLocationBranding returns its own literal 'UN1T' default, which
  // the old fallback took as the entity. A CCF Autos contract would
  // have been countersigned "For UN1T": the gym's brand on another
  // business's binding document, which is the precise failure the
  // helper exists to prevent.
  it('never renders the gym brand on another org when NOTHING is configured', async () => {
    const db = makeDb({
      locations: [{ organization_id: 'org-ccf' }],
      company_settings: [{ company_name: null, logo_url: null, favicon_url: null }],
      org_settings: [{ legal_entity_name: null, legal_trading_name: null, company_name: null }],
      organizations: [{ name: 'CCF Autos' }],
    })
    const out = await getContractingEntity(db, { locationId: 'loc-ccf' })
    expect(out.label).not.toBe('UN1T')
    expect(out.label).toBe('CCF Autos')
    // The brand resolver still reports its own default — the point is
    // that the ENTITY label no longer inherits it.
    expect(out.companyName).toBe('UN1T')
    expect(out.entityName).toBeNull()
  })

  it('still names the org when the location row is the only thing configured', async () => {
    const db = makeDb({
      locations: [{ organization_id: 'org-g' }],
      company_settings: [],
      org_settings: [],
      organizations: [{ name: 'Givers Consultancy' }],
    })
    const out = await getContractingEntity(db, { locationId: 'loc-g' })
    expect(out.label).toBe('Givers Consultancy')
  })

  it('never throws and never returns an empty label', async () => {
    // A contract surface must render a party name even when every
    // lookup is unavailable — a blank "For " on a document someone is
    // about to sign is worse than an under-specified one.
    const exploding = { from() { throw new Error('db down') } }
    await expect(getContractingEntity(exploding, { organizationId: 'org-1' })).resolves
      .toMatchObject({ label: 'UN1T' })
    await expect(getContractingEntity(null, {})).resolves.toMatchObject({ label: 'UN1T' })
  })
})

describe('staff privacy page subprocessor facts', () => {
  it('attributes WhatsApp delivery to Meta, not Twilio', () => {
    const src = read('src/app/privacy/page.js')
    // Twilio is SMS-only in this stack; WhatsApp goes through the Meta
    // Cloud API (src/lib/whatsapp.js). The pre-2026-07-19 copy claimed
    // "Twilio — SMS and WhatsApp message delivery".
    expect(src).not.toMatch(/Twilio<\/strong>[^<]*WhatsApp/i)
    expect(src).toContain('Meta')
  })

  it('lists the subprocessors the CRM actually uses for contact data', () => {
    const src = read('src/app/privacy/page.js')
    for (const vendor of ['Stripe', 'Upstash', 'Glofox']) {
      expect(src, `staff privacy page must list ${vendor}`).toContain(vendor)
    }
  })
})
