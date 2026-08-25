# Studio-TV kiosk — Raspberry Pi 4 setup (display-only)

The in-studio HR leaderboard runs as a hardened, always-on browser kiosk on a
Raspberry Pi 4 (the Fire TV Sticks blocked sideloading). This is the **display-
only** setup — the Pi shows one URL and nothing else (it is NOT the champ-bridge).

## The URL

Kiosk mode is the studio-TV route with `?kiosk=1`:

```
https://crm.repset.ie/tv/<LOCATION_ID>?kiosk=1
```

Stillorgan (`a0000000-0000-0000-0000-000000000001`):

```
https://crm.repset.ie/tv/a0000000-0000-0000-0000-000000000001?kiosk=1
```

> **Legacy devices:** these URLs apply to **new** kiosk setups. A live kiosk
> keeps the URL baked into it at provision time until an explicit per-device
> refresh (`pi kiosk-refresh` in un1t-pi) — deliberately a separate, gated
> operation. Kiosks provisioned against the legacy `crm.un1tdublin.com` host
> keep working until that pass.

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
KIOSK_URL="https://crm.repset.ie/tv/${LOCATION_ID}?kiosk=1"
BIN="$HOME/.local/bin"
echo ">> Kiosk URL: $KIOSK_URL"

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
- **"Unlock keyring" prompt on every boot** → gnome-keyring's login keyring
  can't auto-unlock under desktop autologin (no login password is entered).
  `--password-store=basic` (in the launcher) makes Chromium skip the keyring —
  fine here, the kiosk stores no secrets. If a prompt still appears, clear the
  keyring once: `rm -f ~/.local/share/keyrings/login.keyring` then reboot.
- **Board looks tiny** → the TV is running 4K. The launcher forces `1920x1080`
  (via `wlr-randr`) + `--force-device-scale-factor=2`, which is right for the
  Stillorgan 4K panels. Different TV? check the output name with `wlr-randr` and
  tune the mode / scale factor in `~/.local/bin/un1t-kiosk.sh`, then reboot.
- **Change the URL / resolution / zoom later** → edit `~/.local/bin/un1t-kiosk.sh`
  and reboot (disable the Overlay File System first, or the edit won't persist).

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
  System → **disable** → reboot → make the change → **re-enable** → reboot.

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

- Both Stillorgan units get the **identical** setup (same `LOCATION_ID`).
- The 4am reboot clears any overnight memory creep; it lives in root's crontab.
- Distinct from the token-based **TV display management** (`/tv/<token>`, "UC
  Cast Pro") for operator-managed template rotation — `?kiosk=1` hardens either.
