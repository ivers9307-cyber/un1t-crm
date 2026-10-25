# Studio-TV kiosk — Raspberry Pi 4 setup (display-only)

The in-studio HR leaderboard runs as a hardened, always-on browser kiosk on a
Raspberry Pi 4 (the Fire TV Sticks blocked sideloading). This is the **display-
only** setup — the Pi shows one URL and nothing else (it is NOT the champ-bridge).

## The URL

Kiosk mode is the **token-gated** studio-TV route with `?kiosk=1`, plus the
kiosk's own fleet name as `?device=`:

```
https://crm.repset.ie/tv/live/<token>?kiosk=1&device=<device-name>
```

- `<token>` is the display's `tv_displays.token` — an opaque bearer secret that
  resolves to the studio server-side. Create / read it under **TV displays** in
  the CRM (one row per screen). The URL is the secret: never paste it anywhere
  public.
- `<device-name>` is the kiosk's `fleet_devices.name` (`stillorgan-tv1`,
  `hatch-tv2`, …). The board's own 2 s poll carries it, which is the
  FLEET-CMD.2 render heartbeat — proof the screen is actually rendering.
- The challenge board is the same shape: `/tv/live/<token>/challenges?kiosk=1&device=<device-name>`.

**The token URL is installed on the Pi by the un1t-pi CLI, not by hand.**
`pi prepare <device>` bakes it into the launcher on first provision, and
`pi kiosk-refresh <device>` rewrites a live kiosk's launcher (a deliberately
separate, gated operation — a provisioned kiosk keeps its baked URL until an
explicit refresh). The CLI reads the token from `tv_displays` for the device's
location; the script below is the fallback for a Pi provisioned without it,
and takes the token as `TV_TOKEN`.

> **Removed (W0.9c, Oct 2026):** the location-keyed `/tv/<LOCATION_ID>` page
> and its `/api/public/live/<location_id>` feed no longer exist — a bare
> location id is guessable, which exposed live HR data to anyone who had one.
> A kiosk still pointing at `/tv/<LOCATION_ID>` renders a 404 and must be
> refreshed with `pi kiosk-refresh`. There is no redirect.

`/tv/` is a **public route** (proxy allowlist) polling the token-gated
`/api/public/tv-live/<token>` feed every 2 s — the Pi never logs in. An unknown
or inactive token answers 404 (it never confirms whether a token exists).

`?kiosk=1` (`src/lib/tv-kiosk.js` + `LiveTvClient.jsx`) turns on: **Screen Wake
Lock** (no display sleep), **landscape lock**, **hidden cursor**, and
**self-healing reconnect** — a wifi blip shows a quiet corner "● reconnecting…"
pill (after 2 failed polls) and keeps the last-good board on screen instead of a
red error.

## OS

**Raspberry Pi OS (64-bit), "with Desktop"** — the latest stable from Raspberry
Pi Imager. Not Lite (no browser), not Full (bloat), not 32-bit. Current Pi OS
desktop is **Wayland (labwc)**.

Flash with **Raspberry Pi Imager** and use its edit-settings (gear) before
writing: set **hostname, Wi-Fi, enable SSH, username/password** — so the unit
comes up headless and you finish over SSH.

## Setup (run once over SSH)

Preferred: join the Pi to the tailnet and run `pi prepare <device>` from
un1t-pi, which does everything below (and bakes the token URL) in one pass.

Fallback, by hand: save the script below as `setup-kiosk.sh` on the Pi
(`nano setup-kiosk.sh`, paste, Ctrl-O, Ctrl-X), then:

```bash
# the display's tv_displays.token and the kiosk's fleet name are REQUIRED:
TV_TOKEN=<token> DEVICE_NAME=<device-name> bash setup-kiosk.sh
# then:
sudo reboot
```

```bash
#!/usr/bin/env bash
# UN1T studio-TV kiosk — Raspberry Pi 4, Raspberry Pi OS 64-bit "with Desktop"
# (Bookworm, Wayland/labwc). DISPLAY-ONLY unit.
set -euo pipefail

: "${TV_TOKEN:?set TV_TOKEN to the display's tv_displays.token}"
: "${DEVICE_NAME:?set DEVICE_NAME to the kiosk's fleet_devices.name}"
KIOSK_URL="https://crm.repset.ie/tv/live/${TV_TOKEN}?kiosk=1&device=${DEVICE_NAME}"
BIN="$HOME/.local/bin"
echo ">> Kiosk device: $DEVICE_NAME (token URL baked into $BIN/un1t-kiosk.sh)"

# 1. Chromium (+ wlr-randr for the resolution set) — on 64-bit Bookworm the
#    package/binary is `chromium`; older 32-bit builds use `chromium-browser`.
sudo apt-get update
sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
sudo apt-get install -y wlr-randr
CHROMIUM="$(command -v chromium || command -v chromium-browser || true)"
[ -n "$CHROMIUM" ] || { echo "!! chromium not found"; exit 1; }

# 2. Boot to desktop autologin + never blank the screen (do_blanking 1 = disable;
#    works on Wayland, where xset does not).
sudo raspi-config nonint do_boot_behaviour B4
sudo raspi-config nonint do_blanking 1

# 3. Kiosk launcher: relaunch loop; --incognito => fresh session each boot, so no
#    "restore pages" bar after a power cut.
mkdir -p "$BIN"
cat > "$BIN/un1t-kiosk.sh" <<EOF
#!/usr/bin/env bash
URL="$KIOSK_URL"
sleep 8   # let the compositor + network come up
# Force 1080p — 4K TVs report a 4096x2160 / 3840x2160 mode that renders the board
# tiny; 1080p is large + crisp (and lighter on the Pi). Find the output name with
# \`wlr-randr\` (Stillorgan's is HDMI-A-1).
wlr-randr --output HDMI-A-1 --mode 1920x1080 2>/dev/null || true
while true; do
  "$CHROMIUM" \\
    --kiosk --force-device-scale-factor=2 --incognito \\
    --password-store=basic \\
    --noerrdialogs --disable-infobars --disable-session-crashed-bubble \\
    --disable-features=Translate --check-for-update-interval=31536000 \\
    --autoplay-policy=no-user-gesture-required \\
    --ozone-platform=wayland \\
    "\$URL"
  sleep 3   # crashed or closed => relaunch
done
EOF
chmod +x "$BIN/un1t-kiosk.sh"

# 4. Autostart: labwc (current Bookworm default) + wayfire (older Bookworm).
mkdir -p "$HOME/.config/labwc"
touch "$HOME/.config/labwc/autostart"
grep -q 'un1t-kiosk.sh' "$HOME/.config/labwc/autostart" \
  || echo "$BIN/un1t-kiosk.sh &" >> "$HOME/.config/labwc/autostart"

WF="$HOME/.config/wayfire.ini"
if [ -f "$WF" ] || pgrep -x wayfire >/dev/null 2>&1; then
  touch "$WF"
  grep -q '^\[autostart\]' "$WF" || printf '\n[autostart]\n' >> "$WF"
  grep -q 'un1t-kiosk' "$WF" \
    || sed -i '/^\[autostart\]/a un1t_kiosk = '"$BIN"'/un1t-kiosk.sh' "$WF"
fi

# 5. 4am reboot (root crontab, idempotent).
sudo bash -c '( crontab -l 2>/dev/null | grep -v "un1t-kiosk 4am"; \
  echo "0 4 * * * /sbin/reboot   # un1t-kiosk 4am" ) | crontab -'

echo ">> Done. Launch the kiosk with:  sudo reboot"
```

## After reboot

The Pi boots straight into the full-screen leaderboard. To verify without a
keyboard: SSH in and `pgrep -a chromium` should show the kiosk URL
(`/tv/live/<token>?kiosk=1&device=<device-name>`). The CRM's fleet page shows
the device's **last render** stamp moving once the board is polling.

## Troubleshooting

- **Black screen / Chromium won't start on Wayland** → remove the
  `--ozone-platform=wayland` line from `~/.local/bin/un1t-kiosk.sh` (falls back
  to XWayland), then `sudo reboot`.
- **Board shows "Not found" / 404** → the token is wrong, the display row is
  inactive, or the kiosk still carries the removed `/tv/<LOCATION_ID>` URL.
  Check the row under TV displays, then `pi kiosk-refresh <device>`.
- **Wrong studio** → the token belongs to another location's display. Point the
  kiosk at the right display's token (`pi kiosk-refresh`, or re-run the script
  with the right `TV_TOKEN`).
- **No render heartbeat on the fleet page** → the URL is missing
  `&device=<device-name>` or the name does not match `fleet_devices.name`.
- **Screen sleeps** → confirm `sudo raspi-config nonint do_blanking 1` ran; the
  page's Wake Lock also keeps it awake once loaded.
- **"Restore pages" bar after a power cut** → shouldn't happen (incognito), but
  confirm the launcher has `--incognito --disable-session-crashed-bubble`.
- **"Unlock keyring" prompt on every boot** → gnome-keyring's login keyring
  can't auto-unlock under desktop autologin (no login password is entered).
  `--password-store=basic` (in the launcher) makes Chromium skip the keyring —
  fine here, the kiosk stores no secrets beyond the URL. If a prompt still
  appears, clear the keyring once: `rm -f ~/.local/share/keyrings/login.keyring`
  then reboot.
- **Board looks tiny** → the TV is running 4K. The launcher forces `1920x1080`
  (via `wlr-randr`) + `--force-device-scale-factor=2`, which is right for the
  Stillorgan 4K panels. Different TV? check the output name with `wlr-randr` and
  tune the mode / scale factor in `~/.local/bin/un1t-kiosk.sh`, then reboot.
- **Change the URL / resolution / zoom later** → `pi kiosk-refresh <device>`
  for the URL; otherwise edit `~/.local/bin/un1t-kiosk.sh` and reboot (disable
  the Overlay File System first, or the edit won't persist — `pi rw` / `pi ro`).

## Surviving power cuts (SD-card corruption)

Yanking mains power mid-write corrupts the ext4 filesystem on the SD card — the
#1 killer of always-on Pis. A display-only kiosk needs **nothing** persisted, so
the definitive fix is to make the card **read-only**.

**1. Read-only root (Overlay File System) — do this LAST, once the kiosk works.**
`sudo raspi-config` → **Performance Options → Overlay File System** → enable it,
and say **yes** to making `/boot` read-only too → reboot. Now the SD card is
never written during operation, so a power cut physically cannot corrupt it.
Chromium's cache lives in a RAM overlay (fine — incognito, non-persistent), and
the 4am reboot is still a clean reboot.
- **To change anything later** (URL, `apt` updates): raspi-config → Overlay File
  System → **disable** → reboot → make the change → **re-enable** → reboot
  (un1t-pi wraps this as `pi rw` / `pi ro`; `pi kiosk-refresh` does it for you).

**2. If you skip the overlay, at least cut the writes:**
- Disable swap: `sudo dphys-swapfile swapoff && sudo systemctl disable dphys-swapfile`
- Logs to RAM: set `Storage=volatile` in `/etc/systemd/journald.conf`
- `/tmp` on tmpfs; mount root `noatime`.

**3. Hardware (biggest reliability wins):**
- Use a **High Endurance** microSD (CCTV/dashcam-grade), never a bargain card.
- Better: **boot the Pi 4 from a USB SSD** — SSDs tolerate power loss far better
  than SD cards, and there's no SD to corrupt.
- Optional: a **UPS HAT** (or a power-loss board) that lets the Pi shut down
  cleanly on mains loss.

Overlay FS alone (#1) is enough for a display-only unit; #3 is worth it if these
TVs lose power often.

## Notes

- Each screen is its own `tv_displays` row, so two kiosks in one studio carry
  **different tokens** (and different `device` names); only the location they
  resolve to is shared.
- The 4am reboot clears any overnight memory creep; it lives in root's crontab.
- Distinct from the token-based **TV display management** (`/tv/cast/<token>`,
  "UC Cast Pro") for operator-managed template rotation — the same
  `tv_displays` row and token serve both URLs, and `?kiosk=1` hardens either.
