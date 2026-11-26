#!/bin/sh
# Checks the built app without a person, on a new library in a temporary folder: the server child
# runs; a file copied in with cp is registered as brought by the owner; a download address set with
# xattr becomes its source; a file dropped (through the drop handler's code, by a test hook) lands
# in inbox/ with its source; an agent's puts stay the agent's; quitting and killing the app leave no
# process behind. Uses the spike home, app/.spike-home.
set -eu
cd "$(dirname "$0")"
app="$(pwd)/dist/Pneuma Base.app"
home="$(pwd)/.spike-home"
log="$home/app/app.log"
work=$(mktemp -d "${TMPDIR:-/tmp}/pneuma-verify.XXXXXX")
lib="$work/library"

# The command line as the owner, with no agent-session variables, or as an agent with --as.
pb() { env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin PNEUMA_BASE_HOME="$home" node ../packages/cli/dist/bin.js "$@"; }
hook() { osascript -l JavaScript -e "ObjC.import('Foundation'); \$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('dev.pneumabase.spike', '$1', \$(), true)" >/dev/null; }
leftovers() { pgrep -fl "Pneuma Base.app/Contents/MacOS|parent-watch.mjs" || true; }
quit_app() { osascript -e 'quit app "Pneuma Base"' >/dev/null 2>&1 || true; i=0; while pgrep -f "Pneuma Base.app/Contents/MacOS" >/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; sleep 1; }
# Waits up to $2 seconds for the log to have a line matching $1.
wait_for() { i=0; while ! grep -q "$1" "$log" && [ $i -lt $(($2 * 10)) ]; do sleep 0.1; i=$((i+1)); done; grep -q "$1" "$log"; }
ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; status=1; }
status=0

pb init "$lib" >/dev/null
quit_app
mkdir -p "$home/app"
: > "$log"
open "$app" --args --library "$lib"
wait_for "server: ready" 10 && ok "server started" || fail "server started"
app_pid=$(pgrep -f "Pneuma Base.app/Contents/MacOS")
child=$(pgrep -P "$app_pid" -f "parent-watch.mjs" || true)
[ -n "$child" ] && ok "the server is a child of the app (pid $child): $(ps -o command= -p "$child" | cut -c1-60)…" || fail "server child running"

echo "copied with cp" > "$work/copied.txt"
cp "$work/copied.txt" "$lib/copied.txt"
mkdir -p "$work/Downloads"
echo "%PDF downloaded" > "$work/Downloads/report.pdf"
hex=$(printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array><string>https://example.com/files/report.pdf</string><string>https://example.com/</string></array></plist>' | plutil -convert binary1 -o - - | xxd -p | tr -d '\n')
xattr -wx com.apple.metadata:kMDItemWhereFroms "$hex" "$work/Downloads/report.pdf"
cp "$work/Downloads/report.pdf" "$lib/report.pdf"
wait_for "watcher: registered.*copied.txt" 20 && ok "cp: registered by the watcher" || fail "cp: registered by the watcher"
pb --library "$lib" inspect copied.txt | sed 's/^/     /'
pb --library "$lib" inspect report.pdf | grep -q "出处：https://example.com/files/report.pdf" && ok "xattr: the download address is the source" || fail "xattr: the download address is the source"

echo "dropped" > "$work/Downloads/dropped.txt"
hook "drop:$work/Downloads/dropped.txt"
wait_for "drop (菜单栏): placed" 10 && ok "drop: placed" || fail "drop: placed"
pb --library "$lib" inspect inbox/dropped.txt | grep -q "出处：Downloads" && ok "drop: inbox/dropped.txt, source Downloads" || fail "drop: inbox/dropped.txt, source Downloads"

for i in 1 2 3 4 5; do
  echo "made by an agent $i" > "$work/made-$i.md"
  pb --library "$lib" --as verify-agent put "$work/made-$i.md" --to "notes/made-$i.md" --made >/dev/null
done
sleep 12
taken=0
for i in 1 2 3 4 5; do pb --library "$lib" inspect "notes/made-$i.md" | grep -q "做出来的 · verify-agent" || taken=$((taken + 1)); done
[ $taken -eq 0 ] && ok "agent puts: 5 of 5 stay the agent's" || fail "agent puts: $taken of 5 taken for the owner's"
grep -q "watcher: registered.*notes/" "$log" && fail "the watcher registered an agent's file" || ok "the watcher registered none of them"

[ -n "$(leftovers)" ] && ok "control: the process check sees the running app and server" || fail "control: the process check sees nothing while the app runs"
quit_app
[ -z "$(leftovers)" ] && ok "quit: no process left" || fail "quit: left $(leftovers)"
: > "$log"
open "$app" --args --library "$lib"
wait_for "server: ready" 10 || true
kill -9 "$(pgrep -f "Pneuma Base.app/Contents/MacOS")"
sleep 1
[ -z "$(leftovers)" ] && ok "kill -9: no process left" || fail "kill -9: left $(leftovers)"
echo "library left in $lib"
exit $status
