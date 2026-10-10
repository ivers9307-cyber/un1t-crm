# `*.repset.ie` wildcard certificate renewal

**Workflow:** `.github/workflows/wildcard-cert.yml` ("Wildcard cert" in the Actions tab).
**Runs:** 04:17 UTC on the 1st of every month, and on demand.

## Why this exists

`repset.ie` is on Cloudflare nameservers (`kim` / `robert.ns.cloudflare.com`), not Vercel's.
Vercel renews the certificate for every *fixed* hostname on the `un1t-crm` project itself
(HTTP-01, no DNS needed), but a **wildcard** can only be proven over DNS-01, and Vercel
can only plant that `_acme-challenge` TXT when it runs the zone. With external DNS the
`*.repset.ie` certificate therefore has to be **re-issued by hand every ~90 days** (the
Let's Encrypt lifetime). The first one was issued by hand on 8 Oct 2026 and expires
**2027-01-08**. This workflow does the re-issuing.

The apex `repset.ie` and the fixed hostnames (`crm.repset.ie`, `api.repset.ie`, ...) are
not touched: Vercel keeps renewing those on its own.

## Why Vercel issues it (and we only answer the challenge)

The obvious design, issue with acme.sh and upload with `vercel certs add`, is closed to us:
`PUT /v3/certs` (custom certificate upload) answers **402 "only available for Enterprise
customers"** on this Pro team (verified 2026-10-10). So the workflow does what
`vercel certs issue` does by hand, which is what worked on 8 Oct:

1. `PATCH /v3/certs {op:"startOrder", domains:["*.repset.ie"]}` starts a Vercel order and
   returns `challengesToResolve[]`, one pending DNS challenge with a `value`. (This is the
   API form of `vercel certs issue --challenge-only`; the workflow calls the API with
   `curl` so the value arrives as JSON, not a table to parse.)
2. The value is written to the `_acme-challenge.repset.ie` TXT through the Cloudflare API
   (any older TXT at that name is deleted first; TTL 60, DNS-only), and the job waits until
   1.1.1.1 and 8.8.8.8 both return it (up to 3 minutes).
3. `vercel certs issue '*.repset.ie'` finishes the order (`op:"finalizeOrder"`); Let's
   Encrypt reads the TXT and Vercel installs the certificate. Three attempts, 30 s apart.

No private key, no ACME account and no certificate file ever touches the runner: Vercel
holds all of it, exactly as for the hand-issued one.

## What one run does

1. **Is it due?** Reads the certificate currently served for the probe host
   (`openssl s_client`, see below). If more than **45 days** remain and the run was not
   forced, it logs "nothing to do" and exits green. Monthly cron + 45-day threshold on a
   90-day certificate = a renewal roughly every two months, with a spare monthly run in hand
   if one fails. An unreadable probe counts as *due*, so a probe outage can never hide an
   expiry (worst case: one spare issuance, then a loud verify failure).
2. **Start the order**, capture and mask the challenge value.
3. **Publish the TXT** at Cloudflare and wait for it to resolve.
4. **Issue** with the CLI (3 attempts).
5. **Verify.** Polls the probe host for up to 3 minutes until the served serial differs
   from the one read in step 1 *and* the new notAfter is more than 60 days out; fails the
   job otherwise. Only subject + notAfter are printed.
6. Removes its working files. **The TXT record is left in DNS on purpose**: a stale
   challenge value is harmless and the next run replaces it.

A scheduled failure emails the repo owner (GitHub default); the old certificate keeps
serving until it expires, so there is a month to act.

## Configuration (repo → Settings → Secrets and variables → Actions → Secrets)

| Name | Scope |
|---|---|
| `CLOUDFLARE_DNS_API_TOKEN` | Cloudflare API token with **Zone:DNS:Edit** + **Zone:Zone:Read**, zone resources limited to **repset.ie only**. (Zone:Read is what the zone-id lookup needs.) |
| `VERCEL_TOKEN` | Vercel token scoped to the **`accounts-1909s-projects`** team. |

No repository variable and no other secret is referenced. Rotating either token is a paste
in the Actions settings; nothing in the repo changes.

## Run it by hand

Actions → **Wildcard cert** → *Run workflow* → tick **force** → Run.

`force=true` skips the 45-day check and renews now. Use it for the first run after the
secrets are created, and after rotating a token, to prove the pipeline end to end. Keep
forced runs rare: Let's Encrypt allows 5 identical certificates per week.

Without `force` a manual run behaves like the cron (renews only when due).

## Manual fallback (if the workflow is broken and the expiry is close)

The same two CLI commands, with the TXT added by hand in Cloudflare:

```bash
npx vercel@63.1.0 certs issue '*.repset.ie' --challenge-only --scope accounts-1909s-projects
# → prints the _acme-challenge.repset.ie TXT value. Cloudflare → repset.ie → DNS → Records:
#   edit (or add) the TXT `_acme-challenge` with that value, DNS-only (grey cloud), TTL Auto.
#   Wait for `dig +short TXT _acme-challenge.repset.ie @1.1.1.1` to show it.
npx vercel@63.1.0 certs issue '*.repset.ie' --scope accounts-1909s-projects
# → "Success! Certificate entry for *.repset.ie created"
```

That is exactly how the 8 Oct certificate was made. It still does not auto-renew, so the
workflow (or this procedure) is needed again ~60 days later.

## The probe host

`wildcard-probe.repset.ie` is a CNAME to `cname.vercel-dns.com` that exists **only** so the
workflow has a hostname matched by the wildcard and nothing else: it is deliberately **not**
a fixed domain on the Vercel project, or the probe would read that hostname's own
certificate and never see the wildcard. Do not add it as a project domain. `crm.repset.ie`
happens to serve the same wildcard certificate today, but a fixed hostname can acquire its
own certificate at any time, which is why the probe is a name nothing else uses.

Check what is being served right now:

```bash
openssl s_client -servername wildcard-probe.repset.ie -connect wildcard-probe.repset.ie:443 </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -enddate -serial
```

## Things to know

- **If "Verify" fails, the issuance already happened.** Look at the project's domains /
  certificates in the Vercel dashboard before re-running; a re-run would issue another one.
- **If "Issue" fails all three times, the TXT is still in place**; re-running with
  `force=true` starts a fresh order (new value) and replaces it.
- **Pinning.** `VERCEL_CLI_VERSION` is pinned (63.1.0); bump it only after checking
  `vercel certs issue --help` still takes `--challenge-only` and the API calls above are
  still what it makes. Nothing is cloned.
- **If Vercel does renew it after all, the workflow is a no-op.** The hand-issued entry
  (`cert_fpNq…`) reports `autoRenew: true`; whether Vercel can honour that without running
  the zone's DNS is exactly the doubt this workflow covers. Either way the 45-day check
  reads the *served* certificate, so a Vercel renewal simply means the cron finds nothing
  to do.
- **Not yet run end to end.** The two secrets did not exist when this shipped; the first
  forced run is the proof. Two things only that run can confirm: that `startOrder` returns
  the challenge with `domain` = `repset.ie` or `*.repset.ie` (the job refuses to write a
  TXT for any other name), and that the CLI's non-zero exit on an unseen challenge is what
  the retry loop expects.
