# Kiosk Pi files

The display runs on a Raspberry Pi 3 (user `pi`, 192.168.4.45) showing the page
from the server Pi in Chromium's kiosk mode. These files live in `/home/pi` on
that Pi; the copies here are for reference and reinstalling.

| File | What it does |
| --- | --- |
| `weather-kiosk.sh` | Opens the page full screen once the server answers. Started at login from `~/.config/lxsession/LXDE-pi/autostart`. |
| `rotate-display.sh` | Turns the screen and touch input to portrait. Started at login. |
| `reload-display.sh` | Reloads the page (from the server: `npm run reload-display`), closing any other tabs. |
| `display-power.py` + `.service` | Turns the screen off and on for bedtime mode. A system service. |
| `memory-watchdog.sh` + `.service` | Reloads the page, or restarts the kiosk, if memory runs low, so the Pi can't freeze swapping. Logs to `~/memory-watchdog.log`. A system service. |

To install a service: copy the script to `/home/pi`, copy the `.service` file
to `/etc/systemd/system/`, then `sudo systemctl enable --now <name>`.
