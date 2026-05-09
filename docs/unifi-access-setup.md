# UniFi Access — exposing a controller to the CRM

This runbook covers wiring a per-location UniFi Access controller so the
CRM (hosted on Vercel) can reach it. Use this when:

- Adding door access at a new location (Hatch Street, future studios)
- Migrating an existing location onto a public hostname
- Replacing a controller and re-issuing the API token

The CRM stores per-location config under `locations.settings.unifi`
(see `src/lib/unifi-access.js`). Master-only via mig 034.

---

## What we're connecting

```
                                  ┌──────────────────────────┐
                                  │         INTERNET         │
                                  │                          │
   crm.un1tdublin.com  ────────►  │  unifi-stillorgan.       │
   (Vercel serverless)            │   un1tdublin.com         │
                                  │   (UniFi DDNS hostname)  │
                                  └────────────┬─────────────┘
                                               │
                                               ▼
                                  ┌──────────────────────────┐
                                  │   Gym router (UniFi GW)  │
                                  │                          │
                                  │   - Public WAN IP        │
                                  │   - DDNS keeps DNS in    │
                                  │     sync with WAN IP     │
                                  │   - Port-forward         │
                                  │     12445/tcp ──┐        │
                                  └─────────────────┼────────┘
                                                    │
                                                    ▼
                                  ┌──────────────────────────┐
                                  │  UniFi Access controller │
                                  │  192.168.0.126:12445     │
                                  │  (Developer API)         │
                                  └──────────────────────────┘
```

---

## Step 1 — Confirm the controller's API port

UniFi Access Developer API runs on **TCP 12445** by default (HTTPS,
self-signed cert). Verify before forwarding:

1. SSH or web-console into the gym network
2. From a LAN machine, run:

```bash
curl -k https://<controller-lan-ip>:12445/api/v1/developer/doors \
     -H 'Authorization: Bearer <api-token>'
```

You should get JSON back (`{"code":"SUCCESS",...}` or similar). If
you get HTML or `404 page not found`, the API isn't on this port —
check Access settings → System → Advanced for the right port.

> If your earlier setup used `:18443`, that wasn't the Access API
> — it was probably the controller's web UI port. Don't forward 18443.

---

## Step 2 — Set up UniFi DDNS

UniFi gateways have built-in DDNS clients. The exact menu path
depends on your UniFi OS version:

- **UniFi OS 3.x and newer**:
  Network → Settings → Internet → WAN1 → **Dynamic DNS** → Create New
- **Older UniFi OS / USG**:
  Settings → Services → Dynamic DNS

Recommended providers:

| Provider          | Free tier | Notes |
| ----------------- | --------- | ----- |
| **Cloudflare**    | yes       | Best — orange-cloud proxy gives DDoS + cert + IP hiding. Available natively in UniFi OS 3.x+. |
| Dynu / DuckDNS    | yes       | Simple, fewer features |
| No-IP             | yes       | Requires re-confirmation every 30 days on free tier |

### Recommended: Cloudflare DDNS

If `un1tdublin.com` is on Cloudflare:

1. In Cloudflare → DNS → Records, create an A record:
   - Name: `unifi-stillorgan` (or `unifi-hatchst`, etc — one per location)
   - IPv4: any placeholder (e.g. `1.1.1.1`) — UniFi will overwrite
   - Proxy status: **DNS only** (grey cloud) — orange-cloud strips
     non-standard ports
2. In Cloudflare → My Profile → API Tokens → Create Token:
   - Template: "Edit zone DNS"
   - Zone resources: include only `un1tdublin.com`
   - Copy the token
3. In UniFi → Network → Settings → Internet → WAN1 → Dynamic DNS:
   - Service: Cloudflare
   - Hostname: `unifi-stillorgan.un1tdublin.com`
   - Username: leave blank
   - Password: paste the API token
   - Save → confirm the A record updates within 60s

### Verifying the DDNS works

```bash
dig +short unifi-stillorgan.un1tdublin.com
# Should return your gym's public IP, NOT 192.168.x.x
```

If it returns 192.168.x.x, the DNS is published wrong — see the
"Common pitfalls" section.

---

## Step 3 — Port forward the API port

In UniFi → Network → Settings → Security → Port Forwarding → Create:

- Name: `UniFi Access API`
- Interface: WAN1
- Port: 12445 (or whatever you confirmed in step 1)
- Forward IP: the LAN IP of the Access controller
- Forward port: same as Port
- Protocol: TCP

> Some UniFi versions automatically generate a firewall rule; others
> require you to add one manually under Settings → Security →
> Firewall. The forwarding rule must be reachable from WAN.

---

## Step 4 — Test from outside the gym network

Critical — this can't be tested from the gym LAN, because the LAN
has hairpin DNS that "works" even when public DNS is broken.

From a phone on cellular (turn off Wi-Fi) or any cloud shell:

```bash
curl -k https://unifi-stillorgan.un1tdublin.com:12445/api/v1/developer/doors \
     -H 'Authorization: Bearer <api-token>'
```

Expected: a JSON response with a `code: "SUCCESS"` envelope and a
`data` array. If you get a connection timeout, port forward isn't
working; if you get HTML or 404, you forwarded the wrong port.

---

## Step 5 — Update the CRM config

In the CRM (logged in as master):

1. Settings → Locations → \[location\] → UniFi Access
2. Set:
   - Host: `https://unifi-stillorgan.un1tdublin.com:12445`
   - API token: from your UniFi Access controller → Settings →
     System → Developer API → Generate
   - Staff policy ID: from UniFi Access → Access Policies → \[Staff\]
   - Manager policy ID: from UniFi Access → Access Policies → \[Manager\]
   - Allow self-signed cert: **on** (UniFi controllers ship with a
     self-signed cert; turning this off only makes sense if you've
     installed a real cert via a reverse proxy — see Optional
     hardening below)
3. Save → open `/studio-management` → the doors list should populate
   within 2 seconds. If it doesn't, the error message tells you
   which step needs revisiting.

---

## Common pitfalls

**DNS resolves to a 192.168 / 10.0 / 172.16 address.**
Public DNS records pointing at private IPs are unreachable from the
internet — this is what you hit on the first attempt. Check
`dig +short <hostname>` from any non-gym network and confirm a
public IP comes back.

**Cloudflare orange-cloud proxy + non-standard port.**
Cloudflare's HTTP proxy only handles a fixed list of ports (80,
443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8080, 8443,
8880). Port 12445 isn't on the list — orange-cloud silently breaks.
**Solution:** grey-cloud the record (DNS only) so Cloudflare just
serves the A record without proxying. You lose the WAF benefit but
keep DDoS protection at the DNS layer.

**Wrong port forwarded.**
The UniFi controller hosts multiple services on different ports —
the web UI is on `:8443` (TCP), the inform protocol on `:8080`,
the Access Developer API on `:12445`. Forward the right one.

**API token has wrong scopes.**
The CRM needs: `view:user`, `edit:user`, `view:policy`, plus door
operations (`view:device`, `edit:device` on newer firmwares).
Generate a token with all of these or the `/doors` list will 403.

**Firewall blocks Vercel egress IPs.**
If you've added a source-IP whitelist on the gym router, Vercel's
outbound IPs change frequently and aren't easily enumerable.
Either whitelist all of Cloudflare (if you put CF in front) or
rely on the bearer token + HTTPS for auth, no IP allow-list.

---

## Optional hardening

Once the basic flow works, consider:

1. **Real TLS cert via reverse proxy.**
   Stick a Caddy or nginx container on the same LAN, point it at
   `192.168.0.126:12445`, terminate Let's Encrypt on
   `unifi-stillorgan.un1tdublin.com:443`, port-forward 443 instead
   of 12445. Then turn off "Allow self-signed cert" in CRM.

2. **Cloudflare Tunnel instead of port forwarding.**
   No public ports exposed at all. Cloudflared runs on a small box
   on the LAN, makes outbound HTTPS to Cloudflare, and Cloudflare
   routes back to it. Replaces step 3 entirely. Free tier covers
   this. Trade-off: one more piece of software to maintain.

3. **Cloudflare Access in front of the tunnel.**
   Adds zero-trust auth — only requests with a Cloudflare Access
   JWT can reach the controller. Vercel functions get a service
   token. Useful if you ever need to grant temporary external
   access for support.

---

## Per-location rollout checklist

When adding a second / third / Nth location's controller, repeat:

- [ ] Step 1: confirm Developer API port (typically 12445)
- [ ] Step 2: create `unifi-<location-slug>.un1tdublin.com` DDNS record
- [ ] Step 3: port-forward 12445 → controller LAN IP
- [ ] Step 4: external test (cellular curl) returns SUCCESS
- [ ] Step 5: update `/settings/locations/<id>` UniFi panel
- [ ] Verify `/studio-management` doors list populates
- [ ] Test a single unlock from the panel
- [ ] Note the API token in 1Password (or wherever credentials live)
