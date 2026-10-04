#!/bin/sh
# Opens the weather calendar full screen (kiosk mode), once the server
# answers. Run it from the desktop, or over SSH with:
#   DISPLAY=:0 ~/weather-kiosk.sh &
# To close it: pkill chromium (the desktop comes back on its own)

URL=http://192.168.4.140:3001
# The page, with the clouds drawn on the CPU: this Pi has no GPU fast enough for
# WebGL clouds, so this skips timing it (seconds of work on every page load)
PAGE=$URL/?clouds=cpu
PROFILE="$HOME/.config/weather-kiosk"

# Keep the screen on while it's showing
xset s off
xset -dpms
xset s noblank

# Wait for the server
until curl -s -m 3 -o /dev/null "$URL/api/health"; do sleep 5; done

# The desktop's panel and background are hidden behind the kiosk anyway, so
# they're closed while it runs to leave Chromium more memory
pkill -x lxpanel
pkill -x pcmanfm

# Don't offer to restore pages after a power cut
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
  "$PROFILE/Default/Preferences" 2>/dev/null
# A smaller GPU memory budget, as the Pi 3 shares its 512 MB with the GPU
chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run \
  --check-for-update-interval=31536000 --remote-debugging-port=9222 \
  --force-gpu-mem-available-mb=64 \
  --user-data-dir="$PROFILE" "$PAGE"

# Chromium has closed: bring the desktop back
lxpanel --profile LXDE-pi > /dev/null 2>&1 &
pcmanfm --desktop --profile LXDE-pi > /dev/null 2>&1 &
