# Draft policy clauses — automatic attendance detection

**Status: PUBLISHED 2026-07-31.** Employee Handbook v3 (§2.5-2.8) and Staff Privacy Notice v3 (§10, plus §2.5 category and §6 retention row) are live in the CRM. Retention set to **3 years** per Richard, matching the Organisation of Working Time Act 1997. This file is kept as the drafting record and the open-questions list for the solicitor.
Prepared 2026-07-31 alongside GEO-ATT going live at Stillorgan (100 m radius).

Both live documents are versioned in the CRM (`policies` → `policy_versions`), so publishing these means cutting a **new version**, which flags every staff member with an unread policy. That is Richard's call, not an automated one. The existing documents are also still marked as needing solicitor sign-off — this text should go into that same review.

---

## 1. Employee Handbook — new subsections under §2 (Hours, breaks, and the right to disconnect)

> **2.x Recording your attendance**
>
> Your shift start time may be recorded automatically. Where the Company has enabled this at your location, the Repset staff app detects when you arrive at the gym and records that arrival against your rostered shift. You do not need to clock in manually.
>
> **2.x.1** Detection works only at the gym. The app identifies that you have arrived at the premises; it does not record where you are at any other time, and it does not track your movements between locations or outside working hours.
>
> **2.x.2** For this to work, the app requires location access set to "Always" on your phone. Until that permission is granted the app will ask for it each time you open it.
>
> **2.x.3** Automatic detection is a convenience, not the record of truth. If it fails — your phone is off, out of battery, left at home, or the detection simply does not fire — tell your manager and your attendance will be recorded manually. You will never be treated as absent solely because a phone did not report.
>
> **2.x.4** If you do not wish to use automatic detection, or you do not carry a suitable phone, tell your manager. You will be exempted and your attendance recorded manually instead. Being exempt has no effect on your terms of employment.
>
> **2.x.5** Attendance records are used for payroll, rostering and management of working time. They are not used for any other purpose. See the Staff Privacy Notice for the full detail on how this data is handled.

---

## 2. Staff Privacy Notice — new section (suggested placement: immediately after §9 CCTV, as §10, renumbering the current §10–12)

> **10. LOCATION-BASED ATTENDANCE DETECTION**
>
> **10.1** Where enabled at your location, the Repset staff app records the time at which you arrive at the gym premises, so that your rostered shift start can be recorded automatically.
>
> **10.2** What we process: the fact that your device entered a defined area around the gym, the time this happened, the gym it relates to, and basic device information (device name, app version, and whether location permission has been granted).
>
> **10.3** What we do not process: your location at any other time or place. The detection is performed by your phone's operating system, which notifies the app only when you cross the boundary of the defined area around the gym. We do not receive, store, or have access to your coordinates, your movements between locations, or your location outside working hours.
>
> **10.4** Lawful basis: our legitimate interests (Article 6(1)(f) GDPR) in accurately recording working time, administering payroll, and managing rosters. We have assessed that this is proportionate because detection is limited to arrival at the workplace, is no more intrusive than a physical clock-in, and an exemption is available on request.
>
> **10.5** Retention: 3 years (SETTLED — Richard, 2026-07-31), consistent with the Organisation of Working Time Act 1997. Applies to the arrival events and the shift records they inform.
>
> **10.6** Your rights: you may object to this processing. Tell your manager and you will be exempted, and your attendance will be recorded manually instead. You may also request a copy of your attendance records at any time (see §7).
>
> **10.7** Automated decision-making: attendance records are reviewed by managers. No disciplinary or other decision affecting you is taken automatically on the basis of this data alone.

---

## Open questions for the solicitor

1. ~~Retention period~~ — SETTLED at 3 years (2026-07-31). Worth a sanity check that 3 years is right for the *detection events* specifically, as distinct from the shift records; we have applied it to both, which is the conservative reading.
2. Whether a **standalone legitimate-interests assessment (LIA)** should be documented for §10.4, or whether the paragraph as drafted is sufficient.
3. Whether the **exemption route** (§10.6 / handbook 2.x.4) should be a written request rather than a verbal one to a manager, for evidential purposes.
4. Whether the handbook needs an explicit statement that attendance data **will not be used for disciplinary purposes without corroboration** — currently implied by 2.x.3 and §10.7 but not stated as a commitment.

## Technical facts these clauses rely on (verified 2026-07-31)

- Detection is OS-level geofencing: the phone reports only enter events for a defined region; the app never polls or stores coordinates. Confirmed in `mobile/lib/geofence.js` (`notifyOnEnter: true`, `notifyOnExit: false`).
- The server stores: profile, location, event time, outcome, device name, and whether the client timestamp was clamped. No coordinates. Confirmed in `src/app/api/attendance/geofence-checkin/route.js`.
- Exemption is a per-staff, per-location flag (`profile_locations.geofence_exempt`) which both suppresses the permission gate and prevents any stamping.
- Radius at Stillorgan is currently 100 m.
