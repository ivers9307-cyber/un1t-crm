// EVENTS-EMAILCFG.1 — CHARACTERIZATION tests for the per-event event emails.
//
// These are written FIRST and lock the CURRENT default HTML of BOTH the
// signup/confirmation email (race-confirmations.buildConfirmationEmailHtml) and
// the pre-event reminder email (event-attendee-reminders.buildReminderEmailHtml)
// byte-for-byte via inline snapshots. The refactor to route both through the
// shared branded shell (event-email.js) MUST keep these green when no per-event
// config is set — that is the behaviour-preserving guarantee for LIVE emails.
//
// The shell-specific behaviour (accent_hex / hero_image_url header, operator
// intro copy, and the full-HTML template override) is exercised further down.

import { describe, it, expect } from 'vitest'
import { buildConfirmationEmailHtml, buildConfirmationDefaults } from './race-confirmations'
import { buildReminderEmailHtml, buildReminderDefaults } from './event-attendee-reminders'
import {
  buildEventEmailShell,
  resolveEventEmail,
  applyEventMergeTags,
  applyEventMergeTagsHtml,
} from './event-email'

// Minimal chainable fake for db.from('email_templates')...single().
function fakeDb(templateRow) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: () => Promise.resolve({ data: templateRow, error: templateRow ? null : { message: 'not found' } }),
  }
  return { from: () => chain }
}

// W1.S1a — a fake for getLocationBranding: company_settings / locations /
// org_settings rows keyed by location id ({ name, company_name }).
function brandDb(byLocation) {
  return {
    from(table) {
      let id = null
      const chain = {
        select: () => chain,
        eq: (_col, v) => { id = v; return chain },
        limit: () => {
          const row = byLocation[id]
          if (table === 'company_settings') return Promise.resolve({ data: row?.company_name ? [{ company_name: row.company_name }] : [], error: null })
          if (table === 'locations') return Promise.resolve({ data: row ? [{ name: row.name, organization_id: null }] : [], error: null })
          return Promise.resolve({ data: [], error: null })
        },
      }
      return chain
    },
  }
}

// A representative, fully-populated confirmation ctx (the shape
// sendRaceConfirmations composes): captain + member badge, a wave, a location,
// a fee breakdown, and a per-person check-in QR each.
const CONFIRM_CTX = {
  raceName: 'Summer Hyrox Sim',
  raceDateLabel: 'Saturday, 11 July 2026',
  waveLabel: 'Wave A · 09:30',
  locationName: 'UN1T Stillorgan',
  teamName: 'The Quaddies',
  teamSize: 2,
  teamMembers: [
    { id: 'm1', name: 'Alice Captain', role: 'captain', is_member: true, qrSrc: 'https://crm.example/api/public/events/checkin-qr?t=TOKEN_A' },
    { id: 'm2', name: 'Bob Member', role: 'member', is_member: false, qrSrc: 'https://crm.example/api/public/events/checkin-qr?t=TOKEN_B' },
  ],
  captainFirstName: 'Alice',
  amountLabel: '€40.00',
  memberCount: 1,
  nonMemberCount: 1,
  memberFeeLabel: '€15.00',
  nonMemberFeeLabel: '€25.00',
  // EVENT-MOVE.6 — the entry's own page. DELIBERATE snapshot change: the
  // default "what's next" copy now ends with "Need a different date? Change
  // it here." linking here. The minimal ctx below has no link, and pins that
  // the copy is then exactly as before.
  manageUrl: 'https://crm.example/event/entry/PAYLOAD.SIG',
  // W1.S1a — the SENDING location's brand (sendEmail resolves it from the
  // comms location). DELIBERATE snapshot change: the header wordmark, the
  // member badge and the signature line used to be a fixed gym name.
  brand: 'UN1T Stillorgan',
}

describe('confirmation email — characterization (default look)', () => {
  it('renders byte-for-byte today (full ctx)', () => {
    expect(buildConfirmationEmailHtml(CONFIRM_CTX)).toMatchInlineSnapshot(`
      "<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T Stillorgan</div>
        <h1 style="font-size:24px;margin:24px 0 8px">You're registered, Alice.</h1>
        <p style="margin:0 0 16px;color:#444;font-size:15px">Team <strong>The Quaddies</strong> is locked in for <strong>Summer Hyrox Sim</strong>.</p>

        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px">
          <tr><td style="padding:8px 0;color:#666;width:120px">Date</td><td style="padding:8px 0;font-weight:600">Saturday, 11 July 2026</td></tr>
          <tr><td style="padding:8px 0;color:#666">Wave</td><td style="padding:8px 0;font-weight:600">Wave A · 09:30</td></tr>
          <tr><td style="padding:8px 0;color:#666">Where</td><td style="padding:8px 0;font-weight:600">UN1T Stillorgan</td></tr>
          <tr><td style="padding:8px 0;color:#666">Team size</td><td style="padding:8px 0;font-weight:600">2-person</td></tr>
          <tr><td style="padding:8px 0;color:#666;vertical-align:top">Total paid</td><td style="padding:8px 0;font-weight:600">€40.00<p style="color:#666;font-size:13px;margin:4px 0 0">1 × member €15.00 &nbsp;·&nbsp; 1 × non-member €25.00</p></td></tr>
        </table>

        <h3 style="font-size:16px;margin:24px 0 8px">Your team</h3>
        <ul style="padding-left:20px;margin:0 0 24px;font-size:14px;line-height:1.7"><li>Alice Captain <em>(captain)</em> <span style="color:#7a5a00;font-size:11px;background:#fff4cc;padding:1px 6px;border-radius:9999px;margin-left:6px">UN1T Stillorgan member</span></li><li>Bob Member</li></ul>

        <h3 style="font-size:16px;margin:24px 0 8px">Check-in codes</h3>
        <p style="margin:0 0 12px;color:#666;font-size:13px">Show your code to a team member at the door for a quick check-in.</p>
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px">
          <tr>
            <td style="padding:10px 0;font-size:14px;vertical-align:middle">Alice Captain <em style="color:#666">(captain)</em></td>
            <td style="padding:10px 0;text-align:right"><img src="https://crm.example/api/public/events/checkin-qr?t=TOKEN_A" alt="Check-in code" width="110" height="110" style="border:1px solid #eee;border-radius:8px"/></td>
          </tr><tr>
            <td style="padding:10px 0;font-size:14px;vertical-align:middle">Bob Member</td>
            <td style="padding:10px 0;text-align:right"><img src="https://crm.example/api/public/events/checkin-qr?t=TOKEN_B" alt="Check-in code" width="110" height="110" style="border:1px solid #eee;border-radius:8px"/></td>
          </tr>
        </table>
        <div style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:13px;color:#333;line-height:1.5">
          <strong>What's next:</strong> arrive 30 minutes before your wave. Bring water, a towel, and your race-day energy. We'll send a reminder the day before with parking + check-in details.<br><br>Need a different date? <a href="https://crm.example/event/entry/PAYLOAD.SIG" style="color:#111;font-weight:600">Change it here</a>.
        </div>

        <p style="color:#999;font-size:12px;margin-top:24px;text-align:center">UN1T Stillorgan</p>
      </div>"
    `)
  })

  it('the black #000 header carries the sending location brand as its wordmark (W1.S1a)', () => {
    const html = buildConfirmationEmailHtml(CONFIRM_CTX)
    expect(html).toContain('<div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T Stillorgan</div>')
  })

  it('names the member badge for the brand, and says "Member" when no brand is known (W1.S1a)', () => {
    expect(buildConfirmationEmailHtml({ ...CONFIRM_CTX, brand: 'Northside Strength' })).toContain('>Northside Strength member</span>')
    const bare = buildConfirmationEmailHtml({ ...CONFIRM_CTX, brand: '' })
    expect(bare).toContain('>Member</span>')
    expect(bare).not.toMatch(/UN1T member|UN1T<\/div>/)
  })

  it('has the key info rows (date/wave/where/team size/total paid)', () => {
    const html = buildConfirmationEmailHtml(CONFIRM_CTX)
    expect(html).toContain('>Date</td>')
    expect(html).toContain('Saturday, 11 July 2026')
    expect(html).toContain('>Wave</td>')
    expect(html).toContain('Wave A · 09:30')
    expect(html).toContain('>Where</td>')
    expect(html).toContain('UN1T Stillorgan')
    expect(html).toContain('>Team size</td>')
    expect(html).toContain('2-person')
    expect(html).toContain('>Total paid</td>')
    expect(html).toContain('€40.00')
  })

  it('labels the start-time row "Time" for a non-race event (EVENT-MULTITIME.1)', () => {
    const html = buildConfirmationEmailHtml({ ...CONFIRM_CTX, waveLabel: '08:00', waveRowLabel: 'Time' })
    expect(html).toContain('>Time</td><td style="padding:8px 0;font-weight:600">08:00</td>')
    expect(html).not.toContain('>Wave</td>')
  })

  it('has the QR check-in grid (one <img> per member with a QR)', () => {
    const html = buildConfirmationEmailHtml(CONFIRM_CTX)
    expect(html).toContain('Check-in codes')
    expect(html).toContain('TOKEN_A')
    expect(html).toContain('TOKEN_B')
    expect(html.match(/<img /g)).toHaveLength(2)
  })

  it("has the \"What's next\" copy block", () => {
    const html = buildConfirmationEmailHtml(CONFIRM_CTX)
    expect(html).toContain("<strong>What's next:</strong> arrive 30 minutes before your wave.")
  })

  it('escapes the team name (no raw injection)', () => {
    const html = buildConfirmationEmailHtml({ ...CONFIRM_CTX, teamName: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('omits wave/where rows + QR grid when unset (minimal ctx; no brand = an empty band, never another gym)', () => {
    const minimal = {
      raceName: 'Bare Event',
      raceDateLabel: '1 Jan 2026',
      waveLabel: '',
      locationName: '',
      teamName: 'Solo',
      teamSize: 1,
      teamMembers: [{ id: 'm1', name: 'Solo Runner', role: 'captain', is_member: false, qrSrc: '' }],
      captainFirstName: '',
      amountLabel: 'Free entry',
      memberCount: 0,
      nonMemberCount: 0,
      memberFeeLabel: null,
      nonMemberFeeLabel: null,
    }
    expect(buildConfirmationEmailHtml(minimal)).toMatchInlineSnapshot(`
      "<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px"></div>
        <h1 style="font-size:24px;margin:24px 0 8px">You're registered, team captain.</h1>
        <p style="margin:0 0 16px;color:#444;font-size:15px">Team <strong>Solo</strong> is locked in for <strong>Bare Event</strong>.</p>

        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px">
          <tr><td style="padding:8px 0;color:#666;width:120px">Date</td><td style="padding:8px 0;font-weight:600">1 Jan 2026</td></tr>
          
          
          <tr><td style="padding:8px 0;color:#666">Team size</td><td style="padding:8px 0;font-weight:600">1-person</td></tr>
          <tr><td style="padding:8px 0;color:#666;vertical-align:top">Total paid</td><td style="padding:8px 0;font-weight:600">Free entry</td></tr>
        </table>

        <h3 style="font-size:16px;margin:24px 0 8px">Your team</h3>
        <ul style="padding-left:20px;margin:0 0 24px;font-size:14px;line-height:1.7"><li>Solo Runner <em>(captain)</em></li></ul>

        <div style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:13px;color:#333;line-height:1.5">
          <strong>What's next:</strong> arrive 30 minutes before your wave. Bring water, a towel, and your race-day energy. We'll send a reminder the day before with parking + check-in details.
        </div>

        <p style="color:#999;font-size:12px;margin-top:24px;text-align:center"></p>
      </div>"
    `)
  })
})

describe('reminder email — characterization (default look)', () => {
  const members = [
    { name: 'Alice Captain', qrSrc: 'https://crm.example/api/public/events/checkin-qr?t=TOKEN_A' },
    { name: 'Bob Member', qrSrc: 'https://crm.example/api/public/events/checkin-qr?t=TOKEN_B' },
  ]

  it('renders byte-for-byte today (full args)', () => {
    expect(buildReminderEmailHtml({
      eventName: 'Summer Hyrox Sim',
      whenLabel: 'Saturday, 11 July 2026 · 09:30',
      locationName: 'UN1T Stillorgan',
      members,
      brand: 'UN1T Stillorgan',
    })).toMatchInlineSnapshot(`
      "<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T Stillorgan</div>
        <h1 style="font-size:24px;margin:24px 0 8px">See you soon.</h1>
        <p style="margin:0 0 16px;color:#444;font-size:15px">A quick reminder for <strong>Summer Hyrox Sim</strong>.</p>

        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:24px 0;font-size:14px">
          <tr><td style="padding:8px 0;color:#666;width:120px">When</td><td style="padding:8px 0;font-weight:600">Saturday, 11 July 2026 · 09:30</td></tr>
          <tr><td style="padding:8px 0;color:#666">Where</td><td style="padding:8px 0;font-weight:600">UN1T Stillorgan</td></tr>
        </table>

        <h3 style="font-size:16px;margin:24px 0 8px">Check-in codes</h3>
        <p style="margin:0 0 12px;color:#666;font-size:13px">Show your code to a team member at the door for a quick check-in.</p>
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 24px">
          <tr>
            <td style="padding:10px 0;font-size:14px;vertical-align:middle">Alice Captain</td>
            <td style="padding:10px 0;text-align:right"><img src="https://crm.example/api/public/events/checkin-qr?t=TOKEN_A" alt="Check-in code" width="110" height="110" style="border:1px solid #eee;border-radius:8px"/></td>
          </tr><tr>
            <td style="padding:10px 0;font-size:14px;vertical-align:middle">Bob Member</td>
            <td style="padding:10px 0;text-align:right"><img src="https://crm.example/api/public/events/checkin-qr?t=TOKEN_B" alt="Check-in code" width="110" height="110" style="border:1px solid #eee;border-radius:8px"/></td>
          </tr>
        </table>
        <div style="background:#f5f5f5;padding:16px;border-radius:8px;font-size:13px;color:#333;line-height:1.5">
          <strong>Before you arrive:</strong> get here 30 minutes early, and bring water + a towel. Can't make it? Just reply to let us know.
        </div>

        <p style="color:#999;font-size:12px;margin-top:24px;text-align:center">UN1T Stillorgan</p>
      </div>"
    `)
  })

  it('the black #000 header carries the brand it is given (W1.S1a)', () => {
    const html = buildReminderEmailHtml({ eventName: 'E', whenLabel: 'w', locationName: 'L', members, brand: 'UN1T Hatch Street' })
    expect(html).toContain('<div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T Hatch Street</div>')
  })

  it('has the when/where rows and QR grid', () => {
    const html = buildReminderEmailHtml({ eventName: 'E', whenLabel: 'Sat 09:30', locationName: 'Stillorgan', members })
    expect(html).toContain('>When</td>')
    expect(html).toContain('Sat 09:30')
    expect(html).toContain('>Where</td>')
    expect(html).toContain('Stillorgan')
    expect(html).toContain('Check-in codes')
    expect(html.match(/<img /g)).toHaveLength(2)
  })

  it('has the "Before you arrive" copy block', () => {
    const html = buildReminderEmailHtml({ eventName: 'E', whenLabel: 'w', locationName: 'L', members })
    expect(html).toContain('<strong>Before you arrive:</strong> get here 30 minutes early')
  })
})

// ============================================================
// SHELL — per-event styling (accent / hero image / escaping)
// ============================================================

describe('buildEventEmailShell — per-event styling', () => {
  const base = {
    heading: 'Hi',
    introHtml: 'intro',
    infoRows: '    <tr><td>x</td></tr>',
    memberQrs: [],
    afterInfoHtml: '',
    footerHtml: 'foot',
    locationName: 'Stillorgan',
    brand: 'UN1T Hatch Street',
  }

  it('default header is the black #000 band with the brand as its wordmark (W1.S1a)', () => {
    expect(buildEventEmailShell(base)).toContain(
      '<div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T Hatch Street</div>'
    )
  })

  it('escapes the brand and never falls back to another gym\'s wordmark (W1.S1a)', () => {
    const evil = buildEventEmailShell({ ...base, brand: '<b>Gym</b>' })
    expect(evil).toContain('>&lt;b&gt;Gym&lt;/b&gt;</div>')
    expect(evil).not.toContain('<b>Gym</b>')
    const blank = buildEventEmailShell({ ...base, brand: '' })
    expect(blank).toContain('<div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px"></div>')
    expect(blank).toContain('text-align:center">Stillorgan</p>')
    expect(blank).not.toContain('UN1T')
  })

  it('signature line is "brand · location", dropping a location that IS the brand (W1.S1a)', () => {
    expect(buildEventEmailShell(base)).toContain('text-align:center">UN1T Hatch Street · Stillorgan</p>')
    expect(buildEventEmailShell({ ...base, locationName: 'UN1T Hatch Street' })).toContain('text-align:center">UN1T Hatch Street</p>')
    expect(buildEventEmailShell({ ...base, locationName: '' })).toContain('text-align:center">UN1T Hatch Street</p>')
  })

  it('accentHex recolours the header band', () => {
    const html = buildEventEmailShell({ ...base, accentHex: '#ff8800' })
    expect(html).toContain('background:#ff8800;color:#fff;padding:24px;text-align:center')
    expect(html).not.toContain('background:#000;color:#fff;padding:24px;text-align:center')
    expect(html).toContain('>UN1T Hatch Street</div>')
  })

  it('ignores an invalid accentHex (falls back to #000, no style injection)', () => {
    const html = buildEventEmailShell({ ...base, accentHex: 'red;background:url(x)' })
    expect(html).toContain('background:#000;color:#fff')
    expect(html).not.toContain('url(x)')
  })

  it('headerImageUrl renders a banner image header (replacing the wordmark)', () => {
    const html = buildEventEmailShell({ ...base, headerImageUrl: 'https://cdn.example/banner.jpg' })
    expect(html).toContain('<img src="https://cdn.example/banner.jpg" alt="UN1T Hatch Street"')
    expect(html).not.toContain('>UN1T Hatch Street</div>')
  })

  it('escapes the header image url', () => {
    const html = buildEventEmailShell({ ...base, headerImageUrl: 'https://x/a.jpg"><script>' })
    expect(html).not.toContain('"><script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
  })

  it('escapes member QR names, escapes the src, and tags the captain', () => {
    const html = buildEventEmailShell({
      ...base,
      memberQrs: [
        { name: '<b>Cap</b>', qrSrc: 'https://x/qr?t=A', captain: true },
        { name: 'Reg', qrSrc: 'https://x/qr?t=B' },
      ],
    })
    expect(html).toContain('&lt;b&gt;Cap&lt;/b&gt; <em style="color:#666">(captain)</em>')
    expect(html).not.toContain('<b>Cap</b>')
    expect(html.match(/<img /g)).toHaveLength(2)
  })

  it('escapes the location signature line', () => {
    expect(buildEventEmailShell({ ...base, locationName: '<i>Loc</i>' })).toContain('UN1T Hatch Street · &lt;i&gt;Loc&lt;/i&gt;')
  })
})

// ============================================================
// resolveEventEmail — per-event precedence
// ============================================================

describe('resolveEventEmail — precedence', () => {
  const contact = { first_name: 'Sam', name: 'Sam Jones', email: 's@x.com' }
  const extras = { event_name: 'Hyrox', team_name: 'Quaddies', when: 'Sat 09:30', location: 'Stillorgan' }
  const defaults = {
    subject: 'Default subject',
    heading: 'H',
    introHtml: 'intro',
    infoRows: '    <tr><td>x</td></tr>',
    afterInfoHtml: '',
    memberQrs: [],
    footerHtml: "<strong>What's next:</strong> default copy.",
    locationName: 'Stillorgan',
  }

  it('unconfigured → shell with default subject + default footer copy', async () => {
    const { subject, htmlBody } = await resolveEventEmail({ db: null, kind: 'confirmation', race: {}, contact, extras, defaults })
    expect(subject).toBe('Default subject')
    expect(htmlBody).toContain('default copy.')
    expect(htmlBody).toContain('background:#000;color:#fff')
  })

  it('applies the race accent_hex + hero_image_url to the shell', async () => {
    const race = { accent_hex: '#123456', hero_image_url: 'https://cdn/x.jpg' }
    const { htmlBody } = await resolveEventEmail({ db: null, kind: 'confirmation', race, contact, extras, defaults })
    expect(htmlBody).toContain('background:#123456')
    expect(htmlBody).toContain('<img src="https://cdn/x.jpg" alt=""')
  })

  it('operator subject overrides the default and is merge-tagged', async () => {
    const race = { confirmation_email_subject: 'You + {{team_name}} are in for {{event_name}}' }
    const { subject } = await resolveEventEmail({ db: null, kind: 'confirmation', race, contact, extras, defaults })
    expect(subject).toBe('You + Quaddies are in for Hyrox')
  })

  it('operator intro replaces the grey box copy (merge-tagged, escaped, newlines → <br>)', async () => {
    const race = { confirmation_email_intro: 'Doors open early, {{first_name}}.\nBring <chalk>.' }
    const { htmlBody } = await resolveEventEmail({ db: null, kind: 'confirmation', race, contact, extras, defaults })
    expect(htmlBody).toContain('Doors open early, Sam.<br>Bring &lt;chalk&gt;.')
    expect(htmlBody).not.toContain('default copy.')
    expect(htmlBody).not.toContain('<chalk>')
  })

  it('template_id → full-HTML template rendered with merge tags; subject = operator || default', async () => {
    const db = fakeDb({ subject: 'ignored', html_content: '<h1>{{event_name}} — hi {{first_name}}</h1>' })
    const race = { confirmation_email_template_id: 'tpl-1' }
    const { subject, htmlBody } = await resolveEventEmail({ db, kind: 'confirmation', race, contact, extras, defaults })
    expect(subject).toBe('Default subject')
    expect(htmlBody).toBe('<h1>Hyrox — hi Sam</h1>')
  })

  it('escapes attacker-influenced merge values in the template path', async () => {
    const db = fakeDb({ html_content: '<p>Team {{team_name}}</p>' })
    const race = { confirmation_email_template_id: 'tpl-1' }
    const evilExtras = { ...extras, team_name: '<img src=x onerror=alert(1)>' }
    const { htmlBody } = await resolveEventEmail({ db, kind: 'confirmation', race, contact, extras: evilExtras, defaults })
    expect(htmlBody).not.toContain('<img src=x onerror')
    expect(htmlBody).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('falls back to the shell when the configured template is missing (never drops a live email)', async () => {
    const db = fakeDb(null)
    const race = { confirmation_email_template_id: 'gone' }
    const { subject, htmlBody } = await resolveEventEmail({ db, kind: 'confirmation', race, contact, extras, defaults })
    expect(subject).toBe('Default subject')
    expect(htmlBody).toContain('default copy.')
    expect(htmlBody).toContain('background:#000')
  })

  it('W1.S1a: the shell carries the configured brand of the SENDING location (brandLocationId)', async () => {
    const db = brandDb({ L_SEND: { name: 'UN1T Stillorgan', company_name: 'UN1T Stillorgan' }, L_EVENT: { name: 'Pride (host events)' } })
    const { htmlBody } = await resolveEventEmail({ db, kind: 'confirmation', race: { location_id: 'L_EVENT' }, contact, extras, defaults, brandLocationId: 'L_SEND' })
    expect(htmlBody).toContain('font-size:24px">UN1T Stillorgan</div>')
    expect(htmlBody).toContain('text-align:center">UN1T Stillorgan · Stillorgan</p>')
    expect(htmlBody).not.toContain('Pride')
  })

  it('W1.S1a: with no brandLocationId it falls back to the race sending_location_id, then location_id', async () => {
    const db = brandDb({ L_SEND: { name: 'Hatch', company_name: 'UN1T Hatch Street' }, L_EVENT: { name: 'Northside Strength' } })
    const viaSending = await resolveEventEmail({ db, kind: 'confirmation', race: { sending_location_id: 'L_SEND', location_id: 'L_EVENT' }, contact, extras, defaults })
    expect(viaSending.htmlBody).toContain('font-size:24px">UN1T Hatch Street</div>')
    const viaEvent = await resolveEventEmail({ db, kind: 'confirmation', race: { location_id: 'L_EVENT' }, contact, extras, defaults })
    expect(viaEvent.htmlBody).toContain('font-size:24px">Northside Strength</div>')
  })

  it('W1.S1a: a caller-resolved defaults.brand wins without a lookup', async () => {
    const { htmlBody } = await resolveEventEmail({ db: null, kind: 'confirmation', race: {}, contact, extras, defaults: { ...defaults, brand: 'Given Brand' } })
    expect(htmlBody).toContain('font-size:24px">Given Brand</div>')
  })

  it('reads the kind-specific columns (reminder ignores confirmation_* config)', async () => {
    const race = { reminder_email_subject: 'See you {{when}}', confirmation_email_subject: 'WRONG' }
    const { subject } = await resolveEventEmail({ db: null, kind: 'reminder', race, contact, extras, defaults })
    expect(subject).toBe('See you Sat 09:30')
  })
})

// ============================================================
// Sender paths reproduce the default builders when unconfigured — this is the
// behaviour-preserving guarantee for the LIVE senders (they call resolveEventEmail).
// ============================================================

describe('resolveEventEmail reproduces the default builders (unconfigured)', () => {
  it('confirmation shell === buildConfirmationEmailHtml', async () => {
    const { subject, htmlBody } = await resolveEventEmail({
      db: null,
      kind: 'confirmation',
      race: {},
      contact: { first_name: 'Alice', name: 'Alice Captain', email: 'a@x.com' },
      extras: {
        event_name: CONFIRM_CTX.raceName,
        team_name: CONFIRM_CTX.teamName,
        when: CONFIRM_CTX.waveLabel,
        location: CONFIRM_CTX.locationName,
      },
      defaults: buildConfirmationDefaults(CONFIRM_CTX),
    })
    expect(htmlBody).toBe(buildConfirmationEmailHtml(CONFIRM_CTX))
    expect(subject).toBe("Summer Hyrox Sim: you're in!")
  })

  it('reminder shell === buildReminderEmailHtml', async () => {
    const args = {
      eventName: 'Summer Hyrox Sim',
      whenLabel: 'Sat · 09:30',
      locationName: 'UN1T Stillorgan',
      members: [{ name: 'Alice', qrSrc: 'https://x/qr?t=A' }],
    }
    const { htmlBody } = await resolveEventEmail({
      db: null,
      kind: 'reminder',
      race: {},
      contact: { first_name: 'Alice' },
      extras: { event_name: args.eventName, team_name: '', when: args.whenLabel, location: args.locationName },
      defaults: { subject: 'Reminder: Summer Hyrox Sim is tomorrow', ...buildReminderDefaults(args) },
    })
    expect(htmlBody).toBe(buildReminderEmailHtml(args))
  })
})

// ============================================================
// Merge-tag helpers
// ============================================================

describe('event merge tags', () => {
  const contact = { first_name: 'Jo', name: 'Jo Bloggs' }
  const extras = { event_name: 'Hyrox', team_name: 'A & B', when: 'Sat', location: 'Stillorgan' }

  it('applyEventMergeTags fills contact + event tags as plain text (unescaped)', () => {
    expect(
      applyEventMergeTags('Hi {{first_name}} — {{event_name}} / {{team_name}} / {{when}} / {{location}}', contact, extras)
    ).toBe('Hi Jo — Hyrox / A & B / Sat / Stillorgan')
  })

  it('applyEventMergeTagsHtml escapes the interpolated values', () => {
    expect(applyEventMergeTagsHtml('<p>{{team_name}}</p>', contact, extras)).toBe('<p>A &amp; B</p>')
  })

  it('are no-ops on empty input', () => {
    expect(applyEventMergeTags('', contact, extras)).toBe('')
    expect(applyEventMergeTagsHtml(undefined, contact, extras)).toBe(undefined)
  })
})

describe('event merge tags — EVENT-MOVE.1', () => {
  const contact = { first_name: 'Aoife', name: 'Aoife Byrne', email: 'a@x.ie' }
  it('fills old_event_name and old_when in plain text', () => {
    const out = applyEventMergeTags('Moved from {{old_event_name}} ({{old_when}}) to {{event_name}}', contact,
      { event_name: 'Oct 25', old_event_name: 'Oct 18', old_when: 'Saturday 18 October · 11:00' })
    expect(out).toBe('Moved from Oct 18 (Saturday 18 October · 11:00) to Oct 25')
  })
  it('escapes them in HTML', () => {
    const out = applyEventMergeTagsHtml('<p>{{old_event_name}}</p>', contact, { old_event_name: '<b>x</b>', old_when: '' })
    expect(out).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>')
  })
  it('blank when absent', () => {
    expect(applyEventMergeTags('[{{old_event_name}}]', contact, {})).toBe('[]')
  })
})

describe('event merge tags — EVENT-MOVE.5', () => {
  const contact = { first_name: 'Aoife', name: 'Aoife Byrne', email: 'a@x.ie' }
  it('fills difference, old_event_name and pay_url in plain text', () => {
    const out = applyEventMergeTags('{{old_event_name}} to {{event_name}} costs {{difference}} more: {{pay_url}}', contact,
      { event_name: 'Oct 25', old_event_name: 'Oct 18', difference: '€10.00', pay_url: 'https://crm.test/event-pay/p1' })
    expect(out).toBe('Oct 18 to Oct 25 costs €10.00 more: https://crm.test/event-pay/p1')
  })
  it('escapes them in HTML', () => {
    const out = applyEventMergeTagsHtml('<p>{{difference}} {{pay_url}}</p>', contact, { difference: '<i>€1</i>', pay_url: 'https://x.test/?a=1&b="2"' })
    expect(out).toBe('<p>&lt;i&gt;€1&lt;/i&gt; https://x.test/?a=1&amp;b=&quot;2&quot;</p>')
  })
  it('blank when absent', () => {
    expect(applyEventMergeTags('[{{difference}}][{{pay_url}}]', contact, {})).toBe('[][]')
  })
})

describe('event merge tags — EVENT-MOVE.6', () => {
  const contact = { first_name: 'Aoife', name: 'Aoife Byrne', email: 'a@x.ie' }
  it('fills manage_url in plain text', () => {
    expect(applyEventMergeTags('Change your date: {{manage_url}}', contact, { manage_url: 'https://crm.test/event/entry/a.b' }))
      .toBe('Change your date: https://crm.test/event/entry/a.b')
  })
  it('escapes it in HTML (a template href cannot be broken out of)', () => {
    const out = applyEventMergeTagsHtml('<a href="{{manage_url}}">x</a>', contact, { manage_url: 'https://x.test/?a=1&b="2"' })
    expect(out).toBe('<a href="https://x.test/?a=1&amp;b=&quot;2&quot;">x</a>')
  })
  it('blank when absent', () => {
    expect(applyEventMergeTags('[{{manage_url}}]', contact, {})).toBe('[]')
  })
  it('the operator intro path merges then escapes it', async () => {
    const { htmlBody } = await resolveEventEmail({
      kind: 'confirmation',
      race: { confirmation_email_intro: 'Need another date? {{manage_url}}' },
      contact,
      extras: { manage_url: 'https://crm.test/event/entry/a.b?x=1&y=2' },
      defaults: { footerHtml: 'default' },
    })
    expect(htmlBody).toContain('Need another date? https://crm.test/event/entry/a.b?x=1&amp;y=2')
  })
})
