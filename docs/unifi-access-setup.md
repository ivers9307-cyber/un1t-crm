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

---

## Lessons from the Stillorgan rollout (2026-05-09)

The first end-to-end setup at Stillorgan turned up several gotchas
worth knowing before doing the next one. Captured here so the next
location takes 30 minutes, not five hours.

### The unlock endpoint depends on the firmware family

Different UniFi Access firmware versions expose unlock at different
URLs and methods. Don't trust generic blog posts — pull the API
reference PDF from the controller itself (Access UI → Settings →
System → Developer API → Documentation) and search for "Remote
Door Unlocking". The current Stillorgan UDM-SE Access firmware
expects:

```
PUT /api/v1/developer/doors/:id/unlock
Permission Key: edit:space
Body (all optional):
  {
    "actor_id":   "<crm user uuid>",
    "actor_name": "<crm user display name>",
    "extra":      { "source": "un1t-crm" }
  }
```

If `actor_id` and `actor_name` are both present they're logged
together as the actor. If both are omitted the controller uses
the API token name. **If only one is present the request fails** —
must be both or neither. `extra` is fully passthrough — appears
verbatim in UniFi webhook payloads.

For previous firmware versions the path was `POST /remote_unlock`
or `POST /remote_unlocking` and the body field was `actor_email`.
The lib (`src/lib/unifi-access.js#remoteUnlockDoor`) currently
codes against the new `PUT /unlock` shape. If a future location
runs older firmware, expect to widen the helper to try multiple
paths or branch by firmware version.

### Token scopes on the new firmware

UniFi Access reorganised resources into "spaces" (the new umbrella
for doors + door groups + readers + hubs). Tokens generated on
this firmware need:

- `view:space` — for `GET /doors` (`listDoors()`)
- `edit:space` — for `PUT /doors/:id/unlock` (`remoteUnlockDoor()`)
- `view:user` + `edit:user` — for the staff sync flow
  (`syncUnifiUserPolicyForRole()`)
- `view:policy` — for read-only policy listing in the admin UI

If the doors list works but unlock fails with 401/403, the token
is missing `edit:space`. Regenerate.

### Public DNS to a private IP is the silent killer

The first DDNS attempt resolved `unifi-stillorgan.un1tdublin.com`
to `192.168.0.126` — a private LAN address — because UniFi DDNS
detects the IP from the WAN interface and the gateway's WAN was
itself behind double-NAT (Virgin's Hub had not yet been put in
bridge mode). It looked correct from inside the gym (hairpin DNS
served the right LAN IP) but was completely unreachable from
outside. Always test from cellular before assuming DNS is fine.

### Virgin Business needs bridge mode AND static IP config

Even with a Virgin Business static IP, the UDM-SE doesn't get the
public IP until two things are true:

1. The Virgin Hub is in **Modem Mode** (Settings → Advanced)
2. The UDM-SE WAN1 is configured as **Static IP** with the
   gateway, subnet, and DNS Virgin provided — DHCP doesn't work
   on the bridged port for static-IP customers

Virgin's static block is a `/30`: `<assigned>` is yours,
`<assigned-1>` is the gateway, the other two are network +
broadcast.

### UDM-SE OS 9.x firewall doesn't auto-allow port forwards

The new zone-based firewall replaced the auto-rule generation
that older UniFi Network had. After creating a port-forward you
must ALSO create a Firewall Policy:

- Type / Source Zone: External (Internet)
- Destination Zone: Gateway (since Access on UDM-SE is the
  gateway itself, not a downstream device)
- Action: Allow
- Destination: `192.168.1.1` port `12445` TCP

Without this policy the port-forward NATs the packet to the right
destination but the firewall drops it before it reaches the
service. The UI WILL warn you ("Forward IP Address does not match
any virtual networks. Create a Firewall Policy…") — the warning
goes away when the destination IP matches a known LAN, but the
allow rule still has to be created manually.

### Cloudflare orange-cloud doesn't proxy port 12445

Cloudflare's HTTP proxy only handles a fixed list of ports (80,
443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096, 8080, 8443,
8880). Port 12445 is not on the list. Keep the DNS record
**grey-cloud (DNS only)** for the unifi subdomain. If you want
the protection of orange-cloud, terminate TLS on a reverse proxy
behind a tunnel and bind it to one of Cloudflare's allowed ports.

### UniFi DDNS overwrites the proxied flag

If the Cloudflare DDNS provider in UniFi pushes an update, it
sometimes resets `proxied=true` on the record (overwriting your
grey-cloud setting). If port-forwarding starts failing weeks
later, check Cloudflare and re-grey-cloud the record. Long-term
fix: switch to a different DDNS provider that respects the
existing record state, or pre-create the record with proxied=false
and confirm UniFi's update doesn't change it on the next push.

### Updated rollout checklist

In light of all the above, the canonical checklist for the next
location is:

- [ ] Confirm with the ISP whether the line gets a real public
      IP or CGNAT (call ahead — saves a day)
- [ ] If not yet bridged, get the ISP modem into bridge mode
- [ ] On the UDM, configure WAN1 as Static IP with the values
      from the ISP
- [ ] Create the Cloudflare A record `unifi-<slug>.un1tdublin.com`
      grey-cloud, placeholder IP `1.1.1.1`
- [ ] In UniFi → Internet → WAN1 → Dynamic DNS, configure
      Cloudflare provider with Hostname, Zone Name, and
      API Token
- [ ] Verify `dig +short unifi-<slug>.un1tdublin.com` returns
      the static public IP from cellular
- [ ] Port-forward 12445/tcp → UDM `192.168.1.1:12445`
- [ ] Add Firewall Policy: External → Gateway, Allow, TCP 12445
- [ ] Test from cellular: `curl -k https://unifi-<slug>...:12445/api/v1/developer/doors`
- [ ] Generate UniFi Access token with `view:space + edit:space +
      view:user + edit:user + view:policy`
- [ ] Update `/settings/locations/<id>` UniFi panel
- [ ] Verify doors list populates on `/studio-management`
- [ ] Test one unlock end-to-end
- [ ] Stash the token in 1Password
