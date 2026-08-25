# App Review notes — Repset Fitness (ie.repset.app)

**Purpose:** the draft pasted into App Store Connect → App Review Information
→ Notes, plus the demo-credential fields, when submitting the public app.
Update the placeholders at submission time. The reviewer-login mechanics live
in `src/app/api/mobile/review-login/route.js`; the gate is DORMANT until
`REVIEW_LOGIN_CODE` is set in Vercel (fresh code per submission — the repo is
public, never reuse one).

---

## Demo account (goes in the ASC credential fields)

- Username: `appreview@un1tdublin.com`
- Password field: `<REVIEW_LOGIN_CODE — generate fresh, set in Vercel FIRST>`

## Notes text (paste into ASC)

> **What Repset Fitness is**: the companion app for members and staff of
> UN1T gym studios (Dublin, Ireland). Members track their fitness — heart-rate
> session reports, progress, goals, class information. Studio staff
> additionally manage day-to-day operations (schedules, member communications,
> on-site studio controls). The surface shown depends on the signed-in
> account; the demo account below opens the MEMBER experience, which is the
> consumer-facing side of the app.
>
> **How to sign in with the demo account**: on the login screen, enter the
> demo email above and tap continue. Instead of the usual emailed code, the
> app will ask for an access code — enter the password provided above. This
> is a review-only mechanism: the app has no public self-service signup
> (accounts are provisioned by the gyms for their own members and staff), so
> this path exists to give App Review working access without an email
> round-trip.
>
> **Permissions the app requests and why**:
> - **Notifications** — class and membership updates; staff operational
>   alerts.
> - **Location ("While Using" / "Always")** — staff-only features: automatic
>   shift attendance at the studio (geofenced) and showing the right studio's
>   on-site controls when a coach walks in. The member demo account is never
>   prompted for Always.
> - **HealthKit** — members can connect Apple Health to enrich their fitness
>   reports. Optional; the demo account can decline and the app functions
>   fully.
> - **Camera / photo library** — staff-only (expense receipts, issue
>   reports). Not reachable from the member surface.
>
> **No purchases**: the app sells nothing — memberships are handled by the
> gyms directly; there is no IAP, no external purchase link.
>
> **Prior history**: this is the public successor to our unlisted internal
> app (same team). Apple advised that unlisted distribution cannot be made
> public, hence this new app record.

## Submission-time checklist (operator)

1. Generate a fresh code (e.g. `openssl rand -base64 18`, trim to something
   typeable — letters+digits, 12+ chars). Set `REVIEW_LOGIN_CODE` in the
   **un1t-crm** Vercel project (Production). Redeploy is not needed — the
   route reads it per-request.
2. Sanity-check the flow once yourself on a device: demo email → code field
   appears → code works → lands on member home.
3. Paste the notes + credentials above into ASC. Screenshots from
   `mobile/asc-screenshots/` (iPad: the "use iPhone screenshots" toggle is
   acceptable). Privacy questionnaire: copy the answers from the old record
   (6770890839) — the app is unchanged.
4. After approval: UNSET or rotate `REVIEW_LOGIN_CODE` if desired (the gate
   404s when unset; Apple may re-review updates, so leaving a set code is
   also fine — it mints member-only sessions and is IP-throttled).
