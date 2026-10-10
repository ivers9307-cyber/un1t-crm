# `*.repset.ie` wildcard certificate renewal

**Workflow:** `.github/workflows/wildcard-cert.yml` ("Wildcard cert" in the Actions tab).
**Runs:** 04:17 UTC on the 1st of every month, and on demand.

## Why this exists

`repset.ie` is on Cloudflare nameservers (`kim` / `robert.ns.cloudflare.com`), not Vercel's.
Vercel renews the certificate for every *fixed* hostname on the `un1t-crm` project itself
(HTTP-01, no DNS needed), but a **wildcard** can only be proven over DNS-01, and Vercel
can only plant that `_acme-challenge` TXT when it runs the zone. With external DNS the
`*.repset.ie` certificate is therefore a custom certificate on the project that **somebody
has to renew every ~90 days** (Let's Encrypt lifetime). The first one was issued by hand and
expires **2027-01-08**. This workflow is the somebody.

The apex `repset.ie` and the fixed hostnames (`crm.repset.ie`, `api.repset.ie`, ...) are
not touched: Vercel keeps renewing those on its own.

## What one run does

1. **Is it due?** Reads the certificate currently served for the probe host
   (`openssl s_client`, see below). If more than **45 days** remain and the run was not
   forced, it logs "nothing to do" and exits green. Monthly cron + 45-day threshold on a
   90-day certificate = a renewal roughly every two months, with a spare monthly run in hand
   if one fails. An unreadable probe counts as *due*, so a probe outage can never hide an
   expiry (worst case: one spare issuance, then a loud verify failure).
2. **Issue.** `acme.sh`, pinned to a release tag *and* that tag's commit, run straight from a
   shallow clone (never `--install` / `--install-online`), issues `*.repset.ie` from Let's
   Encrypt with the `dns_cf` hook. The Cloudflare zone id is looked up with the same token
   and passed as `CF_Zone_ID`. Key type `ec-256`. Each run registers a fresh ACME account
   (nothing is persisted between runs: an account key is a secret too).
3. **Upload.** `vercel certs add --crt cert.pem --key key.pem --ca ca.pem --scope
   accounts-1909s-projects`. `--crt` is the **leaf**, `--ca` the intermediate chain
   (acme.sh's `ca.pem`), not the fullchain: the CLI reads the three files verbatim into
   `PUT /v3/certs {cert, key, ca}`. Vercel serves the newest certificate for the name.
4. **Verify.** Polls the probe host for up to 3 minutes until the served serial is the new
   one; fails the job otherwise. Only subject + notAfter are ever printed.
5. **Shred** the working directory (key included), pass or fail.

A scheduled failure emails the repo owner (GitHub default); the old certificate keeps
serving until it expires, so there is a month to act.

## Configuration (repo → Settings → Secrets and variables → Actions)

| Kind | Name | Scope |
|---|---|---|
| Secret | `CLOUDFLARE_DNS_API_TOKEN` | Cloudflare API token with **Zone:DNS:Edit** + **Zone:Zone:Read**, zone resources limited to **repset.ie only**. (Zone:Read is what the zone-id lookup needs.) |
| Secret | `VERCEL_TOKEN` | Vercel token scoped to the **`accounts-1909s-projects`** team (plan Pro, custom certificates allowed). |
| Variable | `ACME_ACCOUNT_EMAIL` | Let's Encrypt account contact (expiry notices). **Required**; the job fails early with a clear message if it is unset. It is a repo *variable*, not a hard-coded address, because the repo is public. |

No other secret is referenced. Rotating either token is a paste in the Actions settings;
nothing in the repo changes.

## Run it by hand

Actions → **Wildcard cert** → *Run workflow* → tick **force** → Run.

`force=true` skips the 45-day check and renews now. Use it for the first run after the
secrets are created, and after rotating a token, to prove the pipeline end to end. Keep
forced runs rare: Let's Encrypt allows 5 identical certificates per week.

Without `force` a manual run behaves like the cron (renews only when due).

## Manual fallback (if the workflow is broken and the expiry is close)

Vercel can still issue the wildcard itself if you plant the TXT by hand:

```bash
npx vercel@63.1.0 certs issue '*.repset.ie' --challenge-only --scope accounts-1909s-projects
# → prints the _acme-challenge.repset.ie TXT value to add in Cloudflare (DNS → Records)
#   leave it DNS-only (grey cloud); wait for `dig TXT _acme-challenge.repset.ie` to show it
npx vercel@63.1.0 certs issue '*.repset.ie' --scope accounts-1909s-projects
```

The result is a Vercel-managed (Let's Encrypt) certificate exactly like the hand-issued
first one. It still does not auto-renew, so the workflow (or this procedure) is needed
again ~60 days later.

## The probe host

`wildcard-probe.repset.ie` is a CNAME to `cname.vercel-dns.com` that exists **only** so the
workflow has a hostname matched by the wildcard and nothing else: it must not have its own
fixed-domain certificate on Vercel, or the probe would read that one and never see the
wildcard. Do not add it as a fixed domain on the project. `crm.repset.ie` currently serves
the same wildcard certificate, but a fixed hostname can acquire its own certificate at any
time, which is why the probe is a name nothing else uses.

Check what is being served right now:

```bash
openssl s_client -servername wildcard-probe.repset.ie -connect wildcard-probe.repset.ie:443 </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -enddate -serial
```

## Things to know

- **If "Verify" fails, the upload already happened.** Look at the project's certificates in
  the Vercel dashboard before re-running; a re-run would issue another certificate.
- **Pinning.** `ACME_SH_TAG` and `ACME_SH_COMMIT` in the workflow must move together; the
  commit check is what actually pins (a tag can be re-pointed). `VERCEL_CLI_VERSION` is
  pinned too; bump it only after checking `vercel certs add --help` still takes
  `--crt/--key/--ca`.
- **Key type.** `KEY_TYPE` defaults to `ec-256` (acme.sh's default). The hand-issued first
  certificate was RSA-2048. If Vercel ever refuses an EC key at upload, set `KEY_TYPE: 2048`.
- **Nothing persists between runs** except what Vercel holds. There is no ACME account to
  back up and no key on disk anywhere.
- **If Vercel does renew it after all, the workflow is a no-op.** The hand-issued entry
  (`cert_fpNq…`, 8 Oct 2026) reports `autoRenew: true`; whether Vercel can honour that
  without running the zone's DNS is exactly the doubt this workflow covers. Either way the
  45-day check reads the *served* certificate, so a Vercel renewal simply means the cron
  finds nothing to do.
- **Plan gate (unverified until the first forced run).** Vercel's REST reference for
  `PUT /certs` lists a 402 "only available for Enterprise customers"; the team is on Pro,
  where the dashboard offers custom certificates. If the upload step 402s, use the manual
  fallback above (Vercel-issued, which is how the first one was made) until the plan
  question is settled.
