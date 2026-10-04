#!/bin/sh
# Reloads the weather display in the kiosk: opens the page fresh in a new tab
# through Chromium's remote debugging port, then closes every other tab. Each
# close is checked and retried, as a tab left open keeps running hidden in the
# background, using the Pi's CPU and memory.
# Install on the kiosk Pi as ~/reload-display.sh. Run it there, or from the
# server with: npm run reload-display
# The page the kiosk shows (PAGE in the kiosk script, built from its URL)
URL=$(grep "^URL=" "$HOME/weather-kiosk.sh" | cut -d= -f2-)
PAGE=$(grep "^PAGE=" "$HOME/weather-kiosk.sh" | cut -d= -f2- | sed "s#\$URL#$URL#")
[ -n "$PAGE" ] || PAGE="$URL/"
DEBUG=http://localhost:9222

# The ids of the open pages other than $1
other_pages() {
  curl -s -m 20 "$DEBUG/json/list" | python3 -c "
import json, sys
print(' '.join(t['id'] for t in json.load(sys.stdin) if t['type'] == 'page' and t['id'] != '$1'))"
}

new=$(curl -s -m 20 "$DEBUG/json/new?$PAGE" | python3 -c "import json, sys; print(json.load(sys.stdin)['id'])") || {
  echo "The kiosk is not running (no answer from Chromium)"
  exit 1
}
sleep 2
for attempt in 1 2 3 4 5; do
  others=$(other_pages "$new")
  [ -z "$others" ] && break
  for id in $others; do curl -s -m 20 "$DEBUG/json/close/$id" > /dev/null; done
  sleep 2
done

others=$(other_pages "$new")
if [ -n "$others" ]; then
  echo "Reloaded $PAGE, but couldn't close these tabs: $others"
  exit 1
fi
echo "Reloaded $PAGE"
