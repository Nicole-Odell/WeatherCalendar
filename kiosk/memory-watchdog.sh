#!/bin/sh
# Keeps the kiosk Pi from running out of memory. Swapping to the SD card can
# freeze the whole Pi (taps, SSH, everything) for hours, so when available
# memory stays low, this reloads the page (freeing what it built up), and if
# that doesn't help, restarts the kiosk. What it does is logged to
# ~/memory-watchdog.log.
# Installed as a system service on the kiosk Pi (see memory-watchdog.service).

LOW_MB=60          # available memory below this is low
LOW_CHECKS=3       # this many checks in a row (10 s apart) before acting
RESTART_AFTER=120  # seconds after a reload that memory may still be low before restarting
LOG="$HOME/memory-watchdog.log"

available_mb() {
  awk '/^MemAvailable/ { print int($2 / 1024) }' /proc/meminfo
}

log() {
  echo "$(date '+%F %T') $*" >> "$LOG"
}

low=0
reloaded_at=0
while true; do
  mb=$(available_mb)
  if [ "$mb" -lt "$LOW_MB" ]; then low=$((low + 1)); else low=0; fi
  if [ "$low" -ge "$LOW_CHECKS" ]; then
    now=$(date +%s)
    if [ $((now - reloaded_at)) -gt "$RESTART_AFTER" ]; then
      log "available ${mb} MB: reloading the page ($("$HOME/reload-display.sh" 2>&1))"
      reloaded_at=$now
    else
      log "available ${mb} MB after reloading: restarting the kiosk"
      pkill -x chromium-browse
      sleep 10
      setsid "$HOME/weather-kiosk.sh" > /dev/null 2>&1 < /dev/null &
      reloaded_at=0
    fi
    low=0
  fi
  sleep 10
done
