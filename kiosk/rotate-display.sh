#!/bin/sh
# Sets up portrait mode when the desktop starts (see
# ~/.config/lxsession/LXDE-pi/autostart): what was the left edge of the
# screen is now the top, and touches are turned to match.
# The firmware already rotates the screen (display_rotate=3 in
# /boot/config.txt); if it hasn't, xrandr does it, where the driver allows.

TOUCHSCREEN="ILITEK ILITEK-TP"

size=$(xrandr | awk '/ connected/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+x[0-9]+\+/) { print $i; exit } }')
width=${size%%x*}
height=${size#*x}
height=${height%%+*}
if [ -n "$width" ] && [ "$width" -gt "$height" ]; then
  OUTPUT=$(xrandr | awk '/ connected/ { print $1; exit }')
  xrandr --output "$OUTPUT" --rotate left
fi

# The touch screen can take a moment to appear
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  xinput set-prop "$TOUCHSCREEN" "Coordinate Transformation Matrix" 0 -1 1 1 0 0 0 0 1 && break
  sleep 2
done
