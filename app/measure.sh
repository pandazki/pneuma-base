#!/bin/sh
# Measures the built app three times on one library: launch to menu bar item, opening the window
# (first and second time), memory and CPU idle with the window open and with none.
#   app/measure.sh <library> [runs]
# The app is driven through its test hooks (distributed notifications, see App.swift); while it is
# idle with the window open, the window is parked almost off the screen so it stays visible to
# WebKit without covering anything. Uses a temporary PNEUMA_BASE_HOME, never the real one.
set -eu
cd "$(dirname "$0")"
lib=$1
runs=${2:-3}
app="$(pwd)/dist/Pneuma Base.app"
pb_home=$(mktemp -d "${TMPDIR:-/tmp}/pneuma-measure.XXXXXX")
log="$pb_home/app/app.log"
mkdir -p "$pb_home/app"

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
hook() { osascript -l JavaScript -e "ObjC.import('Foundation'); \$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('dev.pneumabase.hooks.measure', '$1', \$(), true)" >/dev/null; }
running() { pgrep -f "Pneuma Base.app/Contents/MacOS" >/dev/null; }
quit_app() {
  osascript -e 'quit app "Pneuma Base"' >/dev/null 2>&1 || true
  while running; do sleep 0.1; done
  sleep 1
}
# Waits until the log has at least $2 lines matching $1.
wait_for() { i=0; while [ "$(grep -c "$1" "$log" || true)" -lt "$2" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; }
alive() { [ -n "$1" ] && ps -p "$1" >/dev/null 2>&1; }
mb() { alive "$1" || { printf "exited"; return; }; footprint -p "$1" --noCategories 2>/dev/null | sed -n 's/.*Footprint: \([0-9.]*\) \([KMG]B\).*/\1 \2/p' | awk '{ v=$1; if ($2=="KB") v/=1024; if ($2=="GB") v*=1024; printf "%.0f", v }'; }
cpu() { ps -o time= -p "$1" 2>/dev/null | awk -F'[:.]' '{ printf "%.2f", $1*60 + $2 + $3/100 }'; }
webkit_helpers() { pgrep -f 'com.apple.WebKit.(GPU|Networking)' | sort; }
# CPU percent of each pid over 60 seconds; "exited" for one that is gone at the end, whose
# counter would otherwise read as all the CPU it ever used.
cpu_minute() {
  before=""; for p in "$@"; do before="$before $(cpu "$p")"; done
  sleep 60
  set -- "$@"; i=1; out=""
  for p in "$@"; do
    b=$(echo $before | cut -d' ' -f$i)
    if alive "$p" && [ -n "$b" ]; then out="$out $(echo "$(cpu "$p") $b" | awk '{ printf "%.2f%%", ($1-$2)/60*100 }')"; else out="$out exited"; fi
    i=$((i+1))
  done
  echo $out
}

echo "library: $lib ($(find "$lib" -type f -not -path '*/.pneuma-base/*' | wc -l | tr -d ' ') files)"
echo "app size: $(du -sh "$app" | cut -f1)"
r=1
while [ $r -le "$runs" ]; do
  quit_app
  : > "$log"
  helpers_before=$(webkit_helpers)
  t0=$(now)
  open "$app" --env PNEUMA_BASE_HOME="$pb_home" --args --library "$lib" --hooks measure
  wait_for "status item shown" 1
  t1=$(grep "status item shown" "$log" | head -1 | cut -d' ' -f1)
  launch=$(echo "$t0 $t1" | awk '{ printf "%.0f", ($2-$1)*1000 }')
  wait_for "server: ready" 1
  sleep 2

  hook open; wait_for "page drawn" 1
  first=$(grep "page drawn" "$log" | sed -n '1s/.*drawn \([0-9]*\) ms.*/\1/p')
  hook park; sleep 10
  hook pids; wait_for "pids:" 1
  set -- $(grep "pids:" "$log" | tail -1 | sed 's/.*app \([0-9]*\) server \([0-9]*\) web \([0-9]*\).*/\1 \2 \3/')
  appp=$1 server=$2 web=$3
  helpers=$(for p in $(webkit_helpers); do echo "$helpers_before" | grep -qx "$p" || echo "$p"; done)
  gpu=$(for p in $helpers; do ps -o command= -p "$p" | grep -q GPU && echo "$p"; done; true)
  net=$(for p in $helpers; do ps -o command= -p "$p" | grep -q Networking && echo "$p"; done; true)
  mem_open="app $(mb "$appp") · node $(mb "$server") · web content $(mb "$web") · gpu $(mb "$gpu") · networking $(mb "$net") MB"
  cpu_open=$(cpu_minute "$appp" "$server" "$web" "$gpu" "$net")

  hook close; sleep 2
  hook open; wait_for "page drawn" 2
  second=$(grep "page drawn" "$log" | sed -n '2s/.*drawn \([0-9]*\) ms.*/\1/p')
  sleep 1
  # WebKit's GPU process exits about a minute after the last web view is gone; wait past that.
  hook close; sleep 75
  mem_closed="app $(mb "$appp") · node $(mb "$server") · gpu $(mb "$gpu") · networking $(mb "$net") MB; web content $(alive "$web" && echo alive || echo exited)"
  cpu_closed=$(cpu_minute "$appp" "$server" "$gpu" "$net")

  echo "run $r: launch → menu bar item ${launch} ms (in process: $(grep "status item shown" "$log" | sed 's/.*process age \([0-9]*\) ms/\1/') ms after exec)"
  echo "  open window → page drawn: first ${first} ms, second ${second} ms"
  echo "  idle, window open:  $mem_open; CPU over 60 s (app node web gpu net): $cpu_open"
  echo "  idle, no window:    $mem_closed; CPU over 60 s (app node gpu net): $cpu_closed"
  r=$((r+1))
done
quit_app
defaults delete dev.pneumabase.PneumaBase "NSWindow Frame PneumaBaseMain" 2>/dev/null || true
