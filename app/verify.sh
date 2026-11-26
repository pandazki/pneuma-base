#!/bin/sh
# Checks the built app without a person, along the path a new owner walks, with a temporary HOME
# and a temporary PNEUMA_BASE_HOME, so no real agent configuration or library is read or written.
# The first launch shows the welcome window; choosing a folder (the same code, by a test hook) makes
# it a library and opens the window on home with 「开始」; a file dropped on the window (the drop code,
# by a test hook) is put as brought by the owner, into inbox/ or the folder the library page shows; a file written straight into the library is
# registered as the owner's and seen, a direct change recorded as seen; an agent's puts stay the
# agent's; connecting the fake Claude Code folds the first step; an ask puts the dot on the icon and
# shows in the menu bar panel; quitting and killing the app leave no process behind.
#
# Only the copy of the app this script starts is driven or stopped: it has its own hook name and is
# found by it, never by the app's name. With PNEUMA_BASE_SHOTS set to a folder, it saves pictures of
# the first-launch window and the panel there, light and dark.
set -eu
cd "$(dirname "$0")"
app="$(pwd)/dist/Pneuma Base.app"
work=$(mktemp -d "${TMPDIR:-/tmp}/pneuma-verify.XXXXXX")
fake_home="$work/home"
pb_home="$work/pneuma-base-home"
lib="$work/我的库"
tag="verify$$"
log="$pb_home/app/app.log"
shots="${PNEUMA_BASE_SHOTS:-}"
mkdir -p "$fake_home/.claude" "$pb_home/app" "$work/Downloads"
: > "$log"

# The command line as the owner, with no agent-session variables, or as an agent with --as.
pb() { env -i HOME="$fake_home" PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin PNEUMA_BASE_HOME="$pb_home" node ../packages/cli/dist/bin.js "$@"; }
hook() { osascript -l JavaScript -e "ObjC.import('Foundation'); \$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('dev.pneumabase.spike.$tag', '$1', \$(), true)" >/dev/null; }
app_pid() { pgrep -f "Pneuma Base.app/Contents/MacOS/Pneuma Base --hooks $tag" || true; }
start() {
  open -n -a "$app" --env HOME="$fake_home" --env PNEUMA_BASE_HOME="$pb_home" --args --hooks "$tag" "$@"
  i=0; while [ -z "$(app_pid)" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
}
# Waits up to $2 seconds for the log to have a line matching $1.
wait_for() { i=0; while ! grep -q "$1" "$log" && [ $i -lt $(($2 * 10)) ]; do sleep 0.1; i=$((i+1)); done; grep -q "$1" "$log"; }
# The window's page text, or the panel's ($2 = text-tray), into $work/$1.
page_text() { rm -f "$work/$1"; hook "${2:-text}:$work/$1"; i=0; while [ ! -f "$work/$1" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; cat "$work/$1" 2>/dev/null || true; }
# Polls the page text until it matches $2, for up to $3 seconds; $4 = text-tray for the panel's.
page_shows() { i=0; while [ $i -lt "$3" ]; do page_text "$1" "${4:-text}" | grep -q "$2" && return 0; sleep 1; i=$((i+1)); done; return 1; }
snap() { [ -z "$shots" ] && return 0; mkdir -p "$shots"; for look in light dark; do hook "$look"; sleep 1; hook "$1:$shots/$2-$look.png"; wait_for "snap: wrote $2-$look.png" 5 || echo "     (no picture $2-$look)"; done; hook system; }
ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; status=1; }
status=0

start
wait_for "welcome: shown" 10 && ok "first launch with no library: the welcome window" || fail "first launch: the welcome window"
snap snap-welcome first-launch

hook "library:$lib"
wait_for "app: made 我的库 a library" 15 && ok "choosing a folder makes it a library" || fail "choosing a folder makes it a library"
wait_for "window: shown" 15 && ok "the main window opens" || fail "the main window opens"
pid=$(app_pid)
child=$(pgrep -P "$pid" -f "parent-watch.mjs" || true)
[ -n "$child" ] && ok "the server is a child of the app (pid $child)" || fail "server child running"
page_shows home-0.txt "接上你的 agent" 10 && page_text home-0.txt | grep -q "做完了 0 步，还有 3 步" && ok "home opens with 开始, 0 of 3 done" || fail "home opens with 开始: $(head -c 300 "$work/home-0.txt")"

echo "dropped" > "$work/Downloads/dropped.txt"
hook "drop-window:$work/Downloads/dropped.txt"
wait_for "drop (窗口): placed" 10 && ok "drop on the window: placed" || fail "drop on the window: placed"
pb --library "$lib" inspect inbox/dropped.txt | grep -q "带进来的，主人给的 · 主人" && ok "drop: inbox/dropped.txt, brought by the owner" || fail "drop: brought by the owner: $(pb --library "$lib" inspect inbox/dropped.txt | head -3)"
pb --library "$lib" inspect inbox/dropped.txt | grep -q "出处：Downloads" && ok "drop: its source is the folder it came from" || fail "drop: source"
page_shows home-1.txt "库里有 1 样东西" 10 && ok "the second step folds: 库里有 1 样东西" || fail "the second step folds"
hook "route:view=ledger.items&view.dir=docs"
sleep 1
echo "into the folder shown" > "$work/Downloads/shown.txt"
hook "drop-window:$work/Downloads/shown.txt"
wait_for 'drop (窗口): placed \["docs/shown.txt"\]' 10 && ok "with the library page on docs/, a drop goes into docs/" || fail "a drop goes into the folder shown: $(grep 'drop (窗口)' "$log" | tail -1)"
hook "route:"
sleep 1
echo "dropped on the icon" > "$work/Downloads/on-icon.txt"
hook "drop:$work/Downloads/on-icon.txt"
wait_for 'drop (菜单栏): placed \["inbox/on-icon.txt"\]' 10 && ok "a drop on the menu bar icon goes into inbox/" || fail "a drop on the menu bar icon: $(grep 'drop (菜单栏)' "$log" | tail -1)"

echo "written in place" > "$lib/direct.txt"
echo "%PDF downloaded" > "$work/Downloads/report.pdf"
hex=$(printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array><string>https://example.com/files/report.pdf</string><string>https://example.com/</string></array></plist>' | plutil -convert binary1 -o - - | xxd -p | tr -d '\n')
xattr -wx com.apple.metadata:kMDItemWhereFroms "$hex" "$work/Downloads/report.pdf"
cp "$work/Downloads/report.pdf" "$lib/report.pdf"
wait_for "watcher: registered.*direct.txt" 20 && ok "a file written into the library: registered by the watcher" || fail "a file written into the library: registered"
pb --library "$lib" inspect direct.txt | grep -q "带进来的，主人给的（自动登记） · 主人" && ok "it is the owner's, seen: 带进来的，主人给的（自动登记）" || fail "it is the owner's, seen: $(pb --library "$lib" inspect direct.txt | head -3)"
pb --library "$lib" inspect report.pdf | grep -q "出处：https://example.com/files/report.pdf" && ok "xattr: the download address is the source" || fail "xattr: the download address is the source"

echo "changed in place" >> "$lib/inbox/dropped.txt"
wait_for "watcher: registered \[\] seen \[\"inbox/dropped.txt\"\]" 20 && ok "a direct change: recorded" || fail "a direct change: recorded"
pb --library "$lib" inspect inbox/dropped.txt | grep -q "直接改的，自动登记" && ok "it is recorded as seen: 直接改的，自动登记" || fail "the change is recorded as seen"

page_text home-2.txt | grep -q "Claude Code" && ok "step 1 lists Claude Code, found in the fake HOME" || fail "step 1 lists Claude Code"
pb --library "$lib" agent connect claude-code >/dev/null
[ -f "$fake_home/.claude/skills/pneuma-base-claude-code/SKILL.md" ] && ok "connect wrote the skill into the fake HOME" || fail "connect wrote the skill"
page_shows home-3.txt "已接上 Claude Code" 10 && ok "the first step folds: 已接上 Claude Code" || fail "the first step folds: $(head -c 300 "$work/home-3.txt")"

for i in 1 2 3 4 5; do
  echo "made by an agent $i" > "$work/made-$i.md"
  pb --library "$lib" --as verify-agent put "$work/made-$i.md" --to "notes/made-$i.md" --made >/dev/null
done
sleep 8
taken=0
for i in 1 2 3 4 5; do pb --library "$lib" inspect "notes/made-$i.md" | grep -q "做出来的 · verify-agent" || taken=$((taken + 1)); done
[ $taken -eq 0 ] && ok "agent puts: 5 of 5 stay the agent's" || fail "agent puts: $taken of 5 taken for the owner's"
grep -q "watcher: registered.*notes/" "$log" && fail "the watcher registered an agent's file" || ok "the watcher registered none of them"

pb --library "$lib" plugin add deploy >/dev/null
pb --library "$lib" deploy target set --kind dir --to "$work/www" >/dev/null
mkdir -p "$work/site" && echo "<h1>shop</h1>" > "$work/site/index.html"
pb --library "$lib" --as claude-code put "$work/site" --to sites/shop --made >/dev/null
pb --library "$lib" --as claude-code say deployable sites/shop >/dev/null
wait_for "dot: 1 waiting" 20 && ok "an ask puts the dot on the icon" || fail "the dot on the icon"
page_shows home-4.txt "等你决定" 10 && ! grep -q "接上你的 agent" "$work/home-4.txt" && ok "an agent has worked here: 开始 is gone" || fail "开始 is gone: $(head -c 300 "$work/home-4.txt")"

hook tray
wait_for "tray: shown" 5 && ok "a click on the icon opens the panel" || fail "the panel opens"
page_shows tray.txt "要上线吗" 10 text-tray && grep -q "我的库" "$work/tray.txt" && grep -q "打开窗口" "$work/tray.txt" && ok "the panel: the library, the ask, 打开窗口" || fail "the panel: $(head -c 300 "$work/tray.txt")"
snap snap-tray tray-app

hook quit
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
sleep 1
kill -0 "$pid" 2>/dev/null && fail "quit: the app is still running" || ok "quit: the app ended"
kill -0 "$child" 2>/dev/null && fail "quit: the server $child is left" || ok "quit: no server left"
: > "$log"
start
wait_for "server: ready" 10 || true
pid=$(app_pid)
child=$(pgrep -P "$pid" -f "parent-watch.mjs" || true)
kill -9 "$pid"
sleep 1.5
[ -n "$child" ] && ! kill -0 "$child" 2>/dev/null && ok "kill -9: no server left" || fail "kill -9: left ${child:-no server seen}"
echo "library left in $lib"
exit $status
