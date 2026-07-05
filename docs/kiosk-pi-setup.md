# Studio-TV kiosk — Raspberry Pi 4 setup (display-only)

The in-studio HR leaderboard runs as a hardened, always-on browser kiosk on a
Raspberry Pi 4 (the Fire TV Sticks blocked sideloading). This is the **display-
only** setup — the Pi shows one URL and nothing else (it is NOT the champ-bridge).

## The URL

Kiosk mode is the studio-TV route with `?kiosk=1`:

```
https://crm.un1tdublin.com/tv/<LOCATION_ID>?kiosk=1
```

Stillorgan (`a0000000-0000-0000-0000-000000000001`):

```
https://crm.un1tdublin.com/tv/a0000000-0000-0000-0000-000000000001?kiosk=1
```

`/tv/` is a **public route** (proxy allowlist) polling the public
`/api/public/live/<location_id>` feed every 2 s — the Pi never logs in.

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

Save the script below as `setup-kiosk.sh` on the Pi (`nano setup-kiosk.sh`,
paste, Ctrl-O, Ctrl-X), then:

```bash
# Stillorgan (default):
bash setup-kiosk.sh
# any other location:
LOCATION_ID=<uuid> bash setup-kiosk.sh
# then:
sudo reboot
```

```bash
#!/usr/bin/env bash
# UN1T studio-TV kiosk — Raspberry Pi 4, Raspberry Pi OS 64-bit "with Desktop"
# (Bookworm, Wayland/labwc). DISPLAY-ONLY unit.
set -euo pipefail

LOCATION_ID="${LOCATION_ID:-a0000000-0000-0000-0000-000000000001}"   # Stillorgan
KIOSK_URL="https://crm.un1tdublin.com/tv/${LOCATION_ID}?kiosk=1"
BIN="$HOME/.local/bin"
echo ">> Kiosk URL: $KIOSK_URL"

# 1. Chromium — on 64-bit Bookworm the package/binary is `chromium`; older
#    32-bit builds use `chromium-browser`. Install whichever exists.
sudo apt-get update
sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
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
while true; do
  "$CHROMIUM" \\
    --kiosk --noerrdialogs --disable-infobars --incognito \\
    --disable-session-crashed-bubble --disable-features=Translate \\
    --check-for-update-interval=31536000 \\
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
keyboard: SSH in and `pgrep -a chromium` should show the kiosk URL.

## Troubleshooting

- **Black screen / Chromium won't start on Wayland** → remove the
  `--ozone-platform=wayland` line from `~/.local/bin/un1t-kiosk.sh` (falls back
  to XWayland), then `sudo reboot`.
- **Wrong studio** → re-run with `LOCATION_ID=<uuid> bash setup-kiosk.sh`.
- **Screen sleeps** → confirm `sudo raspi-config nonint do_blanking 1` ran; the
  page's Wake Lock also keeps it awake once loaded.
- **"Restore pages" bar after a power cut** → shouldn't happen (incognito), but
  confirm the launcher has `--incognito --disable-session-crashed-bubble`.
- **Change the URL later** → edit `~/.local/bin/un1t-kiosk.sh` and reboot.

## Notes

- Both Stillorgan units get the **identical** setup (same `LOCATION_ID`).
- The 4am reboot clears any overnight memory creep; it lives in root's crontab.
- Distinct from the token-based **TV display management** (`/tv/<token>`, "UC
  Cast Pro") for operator-managed template rotation — `?kiosk=1` hardens either.
