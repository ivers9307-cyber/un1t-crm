# EAS Update code signing — runbook (MOBILE-AUDIT.2)

> **⚠️ BLOCKED BY EXPO PLAN (discovered live 2026-06-11).** EAS Update code
> signing is an **Enterprise-plan feature**. The full setup below was wired
> and shipped (#446) and the very first CI publish was rejected by Expo's
> server: *"EAS Update code signing requires a subscription to the EAS
> Enterprise plan. This account (champ026) currently has a subscription to
> the Starter plan."* The config was reverted the same day — a binary that
> embeds the cert REQUIRES signed updates, so shipping one on a plan that
> can't sign would permanently cut that fleet off from OTAs.
>
> **State as of the revert:** key material is generated and retained —
> `certs/certificate.pem` (committed, CN=CF Studio, valid to 2036),
> `mobile/keys/private-key.pem` (gitignored, on the operator Mac — also
> store in a password manager), and the `EXPO_UPDATES_PRIVATE_KEY` GitHub
> secret (set). To enable for real: upgrade the Expo plan at
> https://expo.dev/accounts/champ026/settings/subscriptions, re-add the two
> `updates.codeSigning*` fields to app.config.js + the "materialise key" /
> `--private-key-path` wiring to .github/workflows/eas-update.yml (see PR
> #446 for the exact diff), then cut a native build. Until then, the
> compensating controls are the account-hardening steps below (2FA,
> minimal membership) — do those regardless.

## Why
`expo-updates` is enabled (`app.config.js → updates`, `checkAutomatically: 'ON_LOAD'`), so the app pulls a JS bundle from `u.expo.dev` on every launch. **Without code signing, anyone who gains access to the Expo account can publish an arbitrary JS bundle that runs on every installed device on next launch** — a full client-side takeover that bypasses App Store review. Code signing makes the client cryptographically verify each update against a public key baked into the build, and reject anything not signed by the matching private key.

This is **not wired up yet** on purpose: it requires generating a key pair, and the **private key must never be committed to git**. Run the steps below from a trusted machine.

## One-time setup

```bash
cd mobile

# 1. Generate the signing key pair + certificate.
#    Writes: keys/private-key.pem (SECRET), keys/public-key.pem, certs/certificate.pem
npx expo-updates codesigning:generate \
  --key-output-directory keys \
  --certificate-output-directory certs \
  --certificate-validity-duration-years 10 \
  --certificate-common-name "CF Studio"

# 2. Wire the certificate into the app config (adds updates.codeSigningCertificate
#    + updates.codeSigningMetadata to app.config.js / app.json).
npx expo-updates codesigning:configure \
  --certificate-input-directory certs \
  --key-input-directory keys
```

Then:

1. **Commit** `certs/certificate.pem` and the `updates.codeSigningCertificate` / `codeSigningMetadata` config (these are public — they go in the build).
2. **Do NOT commit** `keys/private-key.pem`. Add `mobile/keys/` to `.gitignore`. Store the private key in a password manager / EAS secret — it's needed to sign every future `eas update`.
3. Rebuild and resubmit (a native build is required so the certificate is embedded — existing installs only start verifying after they update to a signed build).

## Publishing updates after setup
`eas update` automatically signs with the private key when `keys/private-key.pem` is present locally (or configured as an EAS secret in CI). An unsigned or wrongly-signed bundle is rejected by the client.

## Hardening the Expo account (do alongside)
- Enable 2FA on the Expo organisation owner.
- Minimise org membership; use per-person accounts (no shared login).
- Treat the EAS Update publish capability as production-deploy access.

## Verify
- Build a signed binary, install it, publish a normally-signed `eas update` → it applies.
- Publish an update signed with a different/no key (test only) → the client should refuse it (check device logs for the signature-verification rejection).

## References
- Expo: "Code signing" — https://docs.expo.dev/eas-update/code-signing/
