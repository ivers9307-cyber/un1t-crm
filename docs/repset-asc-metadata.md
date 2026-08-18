# Repset — App Store Connect metadata

Copy-paste reference for the App Store Connect metadata of the Repset iOS app (bundle ID `com.un1tdublin.crm`, ASC record `6770890839`). Originally written for the 1.0.0 submission under the app's former name **"CF Studio"**; renamed to Repset with the 2.1.0 rebrand build (REBRAND.2, 2026-07-27).

> **Rename checklist (one-time, alongside the 2.1.0 submission):** ASC only allows editing the app Name while a version is in an editable state (Prepare for Submission). Create the 2.1.0 version → App Information → change Name to `Repset` → attach the rebrand build → submit. The Mac app shares the record (Universal Purchase), so the name change covers both platforms.

This is an **internal staff tool**, not a consumer-facing product. The metadata tone reflects that — descriptive of what staff use it for, not promotional. Apple's review team is fine with internal tools as long as the metadata makes the intended audience clear.

Keep this doc in sync with future ASC updates so v1.1, v1.2 etc. inherit consistent copy.

---

## App Information (one-time, before first submission)

These fields are set once on the app record and persist across versions.

### Name
```
Repset
```
(30-char limit; this is what shows on the home screen. The record was created as "CF Studio" — see the rename checklist at the top.)

### Subtitle
```
Operations for UN1T Dublin staff
```
(30-char limit; appears under the app name in the App Store listing.)

### Primary Category
```
Business
```

### Secondary Category
```
Productivity
```

### Privacy Policy URL
```
https://crm.repset.ie/privacy
```
(Updated for the Phase-6 domain migration — crm.repset.ie is the canonical
CRM host. The page must be live on the repset host before any submission
that cites it; the old crm.un1tdublin.com host keeps redirecting, but ASC
should carry the canonical URL.)

### Bundle ID
```
com.un1tdublin.crm
```
(Read-only after creation; auto-populated from the build.)

### Content Rights
```
☑ Does this app contain, show, or access third-party content?
  → No
```
(All content shown in the app is data UN1T staff have entered into the CRM themselves.)

### Age Rating Questionnaire
Apple shows ~15 yes/no questions. For Repset, every answer is **No** (no gambling, no violence, no profanity, no mature themes, no user-generated content, no contests, no unrestricted web access, etc.). The resulting rating is **4+**.

---

## Version metadata (per release — fill in for 1.0.0)

### Promotional Text
```
Internal operations tool for UN1T Dublin staff and contractors. Updated independently of binary releases.
```
(170-char limit; can be changed without resubmitting for review. Use this for short announcements like "Now with Studio Management" between proper releases.)

### Description
```
Repset is the iOS companion to UN1T Dublin's internal CRM. It is designed exclusively for UN1T staff, coaches, and authorised contractors to manage the day-to-day operations of the gym.

Staff sign in with their existing UN1T account to:

• View their assigned shift schedule, request time off, and arrange shift swaps
• Manage member bookings, classes, and contact records
• Submit and track contractor invoices with PDF capture
• Send WhatsApp, SMS, and email messages to members from the inbox
• Update studio management settings, dashboards, and team rosters at their assigned locations
• Receive push notifications for messages, schedule changes, and policy updates

Repset mirrors the permission model of the UN1T CRM web app — what each staff member can see and do inside the app is controlled by their role and location assignments. Master and owner accounts can also impersonate other staff to troubleshoot what an employee is seeing on their own device.

This app is restricted to current UN1T staff and contractors. A valid UN1T account is required to sign in; the app cannot be used by members of the public.

For privacy and data-handling details, see https://crm.repset.ie/privacy
```
(4000-char limit. Above is ~1,000 chars — comfortably under.)

### Keywords
```
gym,crm,staff,scheduling,roster,bookings,invoices,whatsapp,studio,operations
```
(100-char limit, comma-separated. Don't include the app name "Repset" or "UN1T" — Apple indexes those automatically.)

### Support URL
```
https://crm.repset.ie/technical
```
> **⚠️ This value changed — the old one was never real.** Earlier revisions
> of this doc (and possibly the live ASC listing — check the version page)
> cited `https://crm.un1tdublin.com/support`. **No `/support` route has ever
> existed in the CRM** (`src/app/` contains only the `api/support-session`
> API route); the URL 307-redirects to the staff login screen
> (`/login?redirect=%2Fsupport`). Apple does click through — a login wall or
> 404 fails review. `/technical` is a live, public, allowlisted page
> describing the platform, with a working contact link. If the live listing
> still shows the `/support` URL, correct it at the next editable version
> (the 2.3.0 submission — see `mobile/docs/store-release-one-app.md` §1).

### Marketing URL (optional)
```
https://un1tdublin.com
```

### What's New in This Version (1.0.0)
```
Initial release of Repset — the iOS companion to UN1T Dublin's CRM.

• Shift schedule, time-off requests, and swap requests
• Member bookings and inbox messaging
• Contractor invoice capture
• Studio management settings and dashboards
• Push notifications for messages and schedule changes
```
(4000-char limit. Future versions: list 3–6 bullets per release. Apple recommends user-visible changes only — "Bug fixes" alone is allowed but discouraged.)

---

## Screenshots

Apple requires at least one device size; for an iPhone-only app the easiest set is just **iPhone 6.7"** (currently used by the iPhone 15/16 Pro Max series). Optional but recommended: also upload **iPhone 6.5"** and **iPhone 5.5"** (the latter is being phased out by Apple in mid-2026 but is still accepted for existing apps).

Required count per device size: **3 to 10 screenshots**.

Suggested screens to capture for Repset:
1. **Home tab** — dashboard tiles for the role
2. **Schedule** — week view with assigned shifts highlighted
3. **Inbox** — WhatsApp conversation list
4. **Pipeline / Contacts** — kanban or contact detail
5. **Invoices** — a contractor's invoice list
6. **Studio Management** — settings or team roster

Tools that work well for taking these:
- iOS Simulator → File → New Screen Shot (saves to Desktop at the exact resolution Apple wants)
- Real device → Side button + Volume Up

Apple no longer requires status-bar styling; you can submit raw screenshots with whatever battery / signal / time the simulator shows.

---

## App Review Information

These fields aren't customer-facing — they're a private channel between you and Apple's review team. Fill them in carefully because Apple **will** actually use the test account to sign in and check the app works.

### Sign-In Required?
```
Yes
```

### Test Account credentials
Create a **dedicated review-only staff account** in the un1t-crm before submitting. Don't reuse a real staff account.

Suggested setup:
- Email: `apple-review@un1tdublin.com` (or whatever a real address you control routes to)
- Password: A strong password — paste it in the ASC "Password" field
- Role: `staff` with `mobile.*` permissions enabled but limited to a test location (e.g. a "Sandbox" location you create just for review)
- Active: yes
- Test mode: ensure this account doesn't trigger live WhatsApp sends or live emails — the easiest way is to assign them to a location that has no integrations configured

### Contact Information
- First name, Last name: yours
- Phone, Email: yours
- Apple will email this person if review has questions

### Notes (the big free-text field — this is what saves you from rejections)
```
Repset is the iOS app for UN1T Dublin, a fitness club in Dublin, Ireland. It is the internal operations tool used by our staff and contractors — not a consumer product.

The app cannot be used without a UN1T staff account. We have provisioned a review-only account for App Review (credentials above) with a non-production "Sandbox" location attached. Any actions taken by the review account will not affect real members or trigger external integrations (WhatsApp, SMS, email).

Once signed in, the reviewer will see:
- Home tab with a dashboard for the test account's role
- Schedule, Inbox, Tasks, Bookings, and More tabs
- Schedule is empty for the test account because they have no shifts assigned — this is intentional, not a bug
- The More tab includes Policies, Profile, and Sign Out

Note on the "Impersonate" feature: master accounts can sign in as another user for support purposes. The review account is not a master, so this feature is hidden by design. The web app (crm.repset.ie) is where master operators run this flow; the iOS app is read/write but follows the same permission model.

If anything is unclear, please reach out to richard@un1tdublin.com before issuing a rejection — happy to walk through any flow over a quick call.
```

### Attachments
You can attach a screen recording or a PDF walkthrough if you want to be extra-safe. Not required.

---

## Pre-submission checklist

Before clicking "Submit for Review" on the version page:

- [ ] App Information → all four required sections green (Privacy Policy URL, Category, Content Rights, Age Rating)
- [ ] App Privacy questionnaire → published (labels visible at the bottom of the page)
- [ ] App Accessibility → VoiceOver, Larger Text, Sufficient Contrast, Differentiate Without Colour, Reduced Motion all ticked (Reduced Motion needs `mobile-a11y-reduced-motion` branch deployed first)
- [ ] Version 1.0.0 page → all required fields filled (description, keywords, support URL, screenshots, what's new)
- [ ] Build attached to the version (TestFlight processed it after upload — should appear in the "Build" section of the version page)
- [ ] Export Compliance → No (already set via `ITSAppUsesNonExemptEncryption: false` in app.config.js, so this section auto-completes)
- [ ] Review-only test account created in CRM with `apple-review@un1tdublin.com` and a non-production location assigned
- [ ] App Review Information → notes filled in, test credentials filled in
- [ ] Agreements / Tax / Banking → all Active (top-right account menu in ASC)

When all are checked, click **Add for Review** → **Submit to App Review**. Apple's current SLA is 24–48 hours for first-time submissions.

---

## After submission

Watch for these states on the version page:

- **Waiting for Review** — in the queue, usually clears in <12 hours
- **In Review** — actively being reviewed, typically clears within 24 hours
- **Pending Developer Release** (if you ticked manual release) or **Ready for Sale** (if automatic) — approved
- **Rejected** — read the message in Resolution Center, fix, click "Resubmit"

Common first-time rejection reasons for internal staff apps:
1. **"Sign-in required without explaining"** — fixed by the Notes above
2. **"App is missing functionality available to consumers"** — Apple sometimes assumes apps are consumer-facing; the Notes block above explicitly disclaims that
3. **"Privacy policy doesn't list all the data we collect"** — fixed by the existing `/privacy` page matching the App Privacy labels
4. **"Screenshots show content unrelated to the app"** — make sure screenshots come from the actual app, not the web CRM or a Figma mockup
