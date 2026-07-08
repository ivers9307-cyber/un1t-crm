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
}

describe('confirmation email — characterization (default look)', () => {
  it('renders byte-for-byte today (full ctx)', () => {
    expect(buildConfirmationEmailHtml(CONFIRM_CTX)).toMatchInlineSnapshot(`
      "<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>
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
        <ul style="padding-left:20px;margin:0 0 24px;font-size:14px;line-height:1.7"><li>Alice Captain <em>(captain)</em> <span style="color:#7a5a00;font-size:11px;background:#fff4cc;padding:1px 6px;border-radius:9999px;margin-left:6px">UN1T member</span></li><li>Bob Member</li></ul>

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
          <strong>What's next:</strong> arrive 30 minutes before your wave. Bring water, a towel, and your race-day energy. We'll send a reminder the day before with parking + check-in details.
        </div>

        <p style="color:#999;font-size:12px;margin-top:24px;text-align:center">UN1T · UN1T Stillorgan</p>
      </div>"
    `)
  })

  it('has the black #000 "UN1T" header', () => {
    const html = buildConfirmationEmailHtml(CONFIRM_CTX)
    expect(html).toContain('<div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>')
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

  it('omits wave/where rows + QR grid when unset (minimal ctx)', () => {
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
        <div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>
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

        <p style="color:#999;font-size:12px;margin-top:24px;text-align:center">UN1T · </p>
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
    })).toMatchInlineSnapshot(`
      "<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
        <div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>
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

        <p style="color:#999;font-size:12px;margin-top:24px;text-align:center">UN1T · UN1T Stillorgan</p>
      </div>"
    `)
  })

  it('has the black #000 "UN1T" header', () => {
    const html = buildReminderEmailHtml({ eventName: 'E', whenLabel: 'w', locationName: 'L', members })
    expect(html).toContain('<div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>')
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
  }

  it('default header is the black #000 "UN1T" wordmark', () => {
    expect(buildEventEmailShell(base)).toContain(
      '<div style="background:#000;color:#fff;padding:24px;text-align:center;letter-spacing:2px;font-weight:700;font-size:24px">UN1T</div>'
    )
  })

  it('accentHex recolours the header band', () => {
    const html = buildEventEmailShell({ ...base, accentHex: '#ff8800' })
    expect(html).toContain('background:#ff8800;color:#fff;padding:24px;text-align:center')
    expect(html).not.toContain('background:#000;color:#fff;padding:24px;text-align:center')
    expect(html).toContain('>UN1T</div>')
  })

  it('ignores an invalid accentHex (falls back to #000, no style injection)', () => {
    const html = buildEventEmailShell({ ...base, accentHex: 'red;background:url(x)' })
    expect(html).toContain('background:#000;color:#fff')
    expect(html).not.toContain('url(x)')
  })

  it('headerImageUrl renders a banner image header (replacing the wordmark)', () => {
    const html = buildEventEmailShell({ ...base, headerImageUrl: 'https://cdn.example/banner.jpg' })
    expect(html).toContain('<img src="https://cdn.example/banner.jpg" alt="UN1T"')
    expect(html).not.toContain('>UN1T</div>')
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
    expect(buildEventEmailShell({ ...base, locationName: '<i>Loc</i>' })).toContain('UN1T · &lt;i&gt;Loc&lt;/i&gt;')
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
    expect(htmlBody).toContain('<img src="https://cdn/x.jpg" alt="UN1T"')
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
    expect(subject).toBe("Summer Hyrox Sim — you're in!")
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
