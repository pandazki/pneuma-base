#!/bin/sh
# Checks the built app without a person, along the path a new owner walks, with a temporary HOME
# and a temporary PNEUMA_BASE_HOME, so no real agent configuration or library is read or written.
# Build it first: app/build.sh. Everything runs on the app's own Node and command line, with nothing
# on PATH but system tools. The first launch points the machine's launcher at the app's Node and
# command line and shows the welcome window; choosing a folder (the same code, by a test hook) makes
# it a library and opens the window on home with 「开始」; a file dropped on the window (the drop code,
# by a test hook) is put as brought by the owner, into inbox/ or the folder the library page shows; a file written straight into the library is
# registered as the owner's and seen, a direct change recorded as seen; an agent's puts stay the
# agent's; connecting the fake Claude Code folds the first step; with env -i and system tools only,
# the exact command lines the installed skill names and the command the fake Claude Desktop's MCP
# entry names work, and what they do is the agent's; an ask puts the dot on the icon and shows in the
# menu bar panel; the local endpoint's address is in machine state and its sentence on the agents page,
# its guide names the launcher, a foreign Host or Origin is refused, a pairing asked over HTTP shows on
# home with its code and, allowed, lets the application put by MCP over HTTP under its own name;
# 在终端里用 pneuma-base puts a link in a folder on PATH and takes it out; a moved copy
# of the app repoints the launcher and the agents keep working; quitting and killing the app leave no
# process behind.
#
# Only the copy of the app this script starts is driven or stopped: it has its own hook name and is
# found by it, never by the app's name. With PNEUMA_BASE_SHOTS set to a folder, it saves pictures of
# the first-launch window and the panel there, light and dark.
set -eu
cd "$(dirname "$0")"
app="$(pwd)/dist/Pneuma Base.app"
work=$(mktemp -d "${TMPDIR:-/tmp}/pneuma-verify.XXXXXX")
# As the system spells it: /private/var, one slash. The app and the command line both see it so.
work=$(cd "$work" && pwd -P)
fake_home="$work/home"
pb_home="$work/pneuma-base-home"
lib="$work/我的库"
tag="verify$$"
log="$pb_home/app/app.log"
shots="${PNEUMA_BASE_SHOTS:-}"
launcher="$pb_home/bin/pneuma-base"
mkdir -p "$fake_home/.claude" "$fake_home/Library/Application Support/Claude" "$pb_home/app" "$work/Downloads" "$work/bin"
: > "$log"

# The command line as the owner, with no agent-session variables, or as an agent with --as: the app's own Node and command line.
pb() { env -i HOME="$fake_home" PATH=/usr/bin:/bin PNEUMA_BASE_HOME="$pb_home" "$app/Contents/MacOS/node" "$app/Contents/Resources/cli/dist/bin.js" "$@"; }
# A command line as an agent product runs it: through sh, with system tools only, a HOME, no PNEUMA_BASE_HOME.
bare() { env -i HOME="$fake_home" PATH=/usr/bin:/bin CLAUDE_CODE_SESSION_ID=verify-session /bin/sh -c "$1"; }
hook() { osascript -l JavaScript -e "ObjC.import('Foundation'); \$.NSDistributedNotificationCenter.defaultCenter.postNotificationNameObjectUserInfoDeliverImmediately('dev.pneumabase.hooks.$tag', '$1', \$(), true)" >/dev/null; }
app_pid() { pgrep -f "Pneuma Base.app/Contents/MacOS/Pneuma Base --hooks $tag" || true; }
# Starts the app at $1 (default the built one); its PATH has $work/bin, a folder the owner can write.
start() {
  open -n -a "${1:-$app}" --env HOME="$fake_home" --env PNEUMA_BASE_HOME="$pb_home" --env PATH="$work/bin:/usr/bin:/bin" --args --hooks "$tag"
  i=0; while [ -z "$(app_pid)" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
}
stop() {
  pid=$(app_pid); hook quit
  i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
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
wait_for "launcher: written" 10 && ok "first launch writes the launcher $launcher" || fail "the launcher: $(grep 'launcher:' "$log")"
grep -q "exec '$app/Contents/MacOS/node' '$app/Contents/Resources/cli/dist/bin.js'" "$launcher" && grep -q "PNEUMA_BASE_HOME='$pb_home'" "$launcher" && ok "the launcher runs the app's own Node and command line, with this home" || fail "the launcher's content: $(cat "$launcher")"
snap snap-welcome first-launch

hook "library:$lib"
wait_for "app: made 我的库 a library" 15 && ok "choosing a folder makes it a library" || fail "choosing a folder makes it a library"
wait_for "window: shown" 15 && ok "the main window opens" || fail "the main window opens"
pid=$(app_pid)
child=$(pgrep -P "$pid" -f "parent-watch.mjs" || true)
[ -n "$child" ] && ok "the server is a child of the app (pid $child)" || fail "server child running"
ps -o command= -p "$child" | grep -q "$app/Contents/MacOS/node .*$app/Contents/Resources/cli/dist/bin.js view" && ok "the server runs the app's own Node and command line" || fail "the server runs: $(ps -o command= -p "$child")"
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
skill="$fake_home/.claude/skills/pneuma-base-claude-code/SKILL.md"
[ -f "$skill" ] && ok "connect wrote the skill into the fake HOME" || fail "connect wrote the skill"
page_shows home-3.txt "已接上 Claude Code" 10 && ok "the first step folds: 已接上 Claude Code" || fail "the first step folds: $(head -c 300 "$work/home-3.txt")"

# The skill's own three command lines, run as Claude Code would: placeholders filled, system tools only.
echo "# 书单" > "$work/books.md"
line() { grep "^$launcher @claude-code $1 " "$skill" | sed 's/ *#.*//'; }
start_line=$(line start | sed 's/"<一句话：这次在做什么>"/整理读书笔记/')
put_line=$(line put | sed -e "s|<库外的文件或目录>|$work/books.md|" -e 's|<库内路径>|notes/books.md|' -e 's| --from <依据的库内路径…>||')
find_line=$(line find | sed 's/<文字>/书单/')
[ -n "$start_line" ] && [ -n "$put_line" ] && [ -n "$find_line" ] && ok "the skill names the launcher by absolute path in its three command lines" || fail "the skill's command lines: $(grep '@claude-code' "$skill")"
for l in "$start_line" "$put_line" "$find_line"; do
  out=$(bare "$l" 2>&1) && echo "     \$ $l" && echo "$out" | sed -n '1,3s/^/       /p' || fail "with env -i: $l: $out"
done
bare "$find_line" | grep -q "notes/books.md" && ok "with env -i: start, put, find from the skill work; find finds what put put" || fail "find finds what put put"
pb --library "$lib" inspect notes/books.md | grep -q "做出来的 · claude-code" && pb --library "$lib" inspect notes/books.md | grep -q "整理读书笔记" && ok "the scene is Claude Code's, in this library: 做出来的 · claude-code, 整理读书笔记" || fail "the scene: $(pb --library "$lib" inspect notes/books.md | head -5)"

# The fake Claude Desktop by MCP: start what its entry names, with system tools only, and list its tools.
pb --library "$lib" agent connect claude-desktop >/dev/null
desktop="$fake_home/Library/Application Support/Claude/claude_desktop_config.json"
entry() { plutil -extract "mcpServers.pneuma-base-claude-desktop.$1" raw -o - "$desktop"; }
[ "$(entry command)" = "$launcher" ] && [ "$(entry args.0) $(entry args.1)" = "@claude-desktop mcp" ] && ! entry env >/dev/null 2>&1 && ok "the MCP entry: $(entry command) @claude-desktop mcp, no env" || fail "the MCP entry: $(cat "$desktop")"
{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"put","arguments":{"to":"notes/desktop.md","made":true,"text":"# 桌面\n"}}}'; sleep 4; } \
  | env -i HOME="$fake_home" PATH=/usr/bin:/bin "$(entry command)" "$(entry args.0)" "$(entry args.1)" > "$work/mcp.out" 2> "$work/mcp.err"
tools=$(grep '"id":2' "$work/mcp.out" | grep -o '"name":"[a-z_]*"' | sed 's/"name":"\(.*\)"/\1/' | tr '\n' ' ')
echo "$tools" | grep -q "start find inspect put" && ok "with env -i: the MCP entry starts and lists its tools: $tools" || fail "the MCP entry's tools: $(head -c 400 "$work/mcp.out") $(head -c 300 "$work/mcp.err")"
pb --library "$lib" inspect notes/desktop.md | grep -q "做出来的 · claude-desktop" && ok "a put through MCP is Claude Desktop's" || fail "the MCP put: $(pb --library "$lib" inspect notes/desktop.md | head -3)"

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

# The local endpoint: the address the server got, the sentence on the page, the guide, and one pairing
# asked over HTTP by an application not in the products table, allowed by the owner, then MCP over HTTP.
record=$(ls "$pb_home/endpoints/" 2>/dev/null | head -1)
port=${record%.json}
endpoint="http://127.0.0.1:$port"
[ -n "$record" ] && grep -q "\"library\": \"$lib\"" "$pb_home/endpoints/$record" && ! grep -q token "$pb_home/endpoints/$record" && ok "the endpoint's address is in machine state, without the token: $endpoint" || fail "the endpoint record: $(ls "$pb_home/endpoints/" 2>&1)"
[ "$(pb guide --url)" = "$endpoint/guide" ] && ok "pneuma-base guide --url prints $endpoint/guide" || fail "guide --url: $(pb guide --url 2>&1)"
pb show agents --library "$lib" | grep -q "读一下 $endpoint/guide，接上我的 Pneuma Base 库。" && ok "the agents page shows the sentence to say" || fail "the sentence: $(pb show agents --library "$lib" | head -20)"
curl -s "$endpoint/guide/claude-code" | grep -q "$launcher" && ok "GET /guide/claude-code names this machine's command" || fail "the guide: $(curl -s "$endpoint/guide/claude-code" | head -5)"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$endpoint/guide")" = 403 ] && [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: http://evil.example' "$endpoint/guide")" = 403 ] && ok "a foreign Host or Origin is refused" || fail "Host and Origin checks"
paired=$(curl -s -X POST -H 'content-type: application/json' -d '{"product":"verify-app","why":"验证配对"}' "$endpoint/pair")
pair_id=$(echo "$paired" | sed -n 's/.*"id":"\(p-[0-9a-f]*\)".*/\1/p')
pair_code=$(echo "$paired" | sed -n 's/.*"code":"\([0-9-]*\)".*/\1/p')
[ -n "$pair_id" ] && [ -n "$pair_code" ] && ok "POST /pair: pairing $pair_id, code $pair_code" || fail "POST /pair: $paired"
wait_for "dot: 2 waiting" 10 && ok "the pairing is a second thing waiting: the dot counts it at once" || fail "the dot with the pairing: $(grep 'dot:' "$log" | tail -1)"
page_shows home-pair.txt "verify-app 想接入这个库" 10 && grep -q "$pair_code" "$work/home-pair.txt" && ok "home shows the pairing with its code" || fail "home shows the pairing: $(grep -n '想接入' "$work/home-pair.txt")"
pb --library "$lib" pair allow "$pair_id" >/dev/null && curl -s "$endpoint/pair/$pair_id" | grep -q '"state":"connected"' && ok "allowed: GET /pair/$pair_id answers connected" || fail "allowed: $(curl -s "$endpoint/pair/$pair_id")"
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'
sid=$(curl -s -D - -o /dev/null -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$init" "$endpoint/mcp/verify-app" | tr -d '\r' | sed -n 's/^[Mm]cp-[Ss]ession-[Ii]d: //p')
curl -s -o /dev/null -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $sid" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$endpoint/mcp/verify-app"
curl -s -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $sid" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"put","arguments":{"to":"notes/over-http.md","made":true,"text":"# HTTP\n"}}}' "$endpoint/mcp/verify-app" > "$work/mcp-http.out"
[ -n "$sid" ] && pb --library "$lib" inspect notes/over-http.md | grep -q "做出来的 · verify-app" && ok "MCP over HTTP at /mcp/verify-app: a put is verify-app's" || fail "MCP over HTTP: session '$sid', $(head -c 300 "$work/mcp-http.out")"

hook settings
wait_for "settings: PATH folders" 10
hook "text-settings:$work/settings.txt"; sleep 1
grep -q "在终端里用 pneuma-base：关着" "$work/settings.txt" && grep -q "登录时打开：关着" "$work/settings.txt" && ok "settings: both conveniences start off" || fail "settings: $(cat "$work/settings.txt")"
grep -q "PATH 上能放的文件夹：.*$work/bin" "$work/settings.txt" && ok "settings: a folder on the owner's PATH they can write is offered" || fail "settings: the PATH folders: $(cat "$work/settings.txt")"
snap snap-settings settings
hook "path-link:$work/bin"; sleep 1
[ "$(readlink "$work/bin/pneuma-base")" = "$launcher" ] && env -i HOME="$fake_home" PATH="$work/bin:/usr/bin:/bin" pneuma-base --library "$lib" find 书单 | grep -q "notes/books.md" && ok "在终端里用 pneuma-base: a link on PATH, and pneuma-base runs in a terminal" || fail "the link on PATH: $(ls -l "$work/bin")"
hook path-unlink; sleep 1
[ ! -e "$work/bin/pneuma-base" ] && [ ! -L "$work/bin/pneuma-base" ] && ok "turned off: the link is gone" || fail "the link is left"

hook quit
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
sleep 1
kill -0 "$pid" 2>/dev/null && fail "quit: the app is still running" || ok "quit: the app ended"
kill -0 "$child" 2>/dev/null && fail "quit: the server $child is left" || ok "quit: no server left"

# The app moves: a copy elsewhere repoints the launcher at its own Node and command line, and the
# agents' entries, untouched, keep working. Moved away, the launcher dangles and agent list says so;
# the next launch of an app repairs it.
mkdir -p "$work/moved"
ditto "$app" "$work/moved/Pneuma Base.app"
desktop_before=$(cat "$desktop"); skill_before=$(cat "$skill")
: > "$log"
start "$work/moved/Pneuma Base.app"
wait_for "launcher: written" 10 && grep -q "exec '$work/moved/Pneuma Base.app/Contents/MacOS/node'" "$launcher" && ok "moved: the launcher now runs the moved app's Node" || fail "moved: $(grep 'launcher:' "$log") $(tail -1 "$launcher")"
[ "$(cat "$desktop")" = "$desktop_before" ] && [ "$(cat "$skill")" = "$skill_before" ] && bare "$find_line" | grep -q "notes/books.md" && ok "moved: the skill and the MCP entry are unchanged and still work" || fail "moved: the entries"
stop
mv "$work/moved/Pneuma Base.app" "$work/moved/gone.app"
pb agent list | grep -q "指向的 node 不在了" && ok "moved away: agent list says the launcher points at a Node that is gone" || fail "moved away: $(pb agent list)"
: > "$log"
start
# The app or the server it starts first, whichever comes first, points the launcher back at the app's own Node.
wait_for "launcher: " 10 && grep -q "exec '$app/Contents/MacOS/node'" "$launcher" && pb agent list --json | grep -q '"inPlace": true' && ! pb agent list | grep -q "不在了" && ok "launching the app again repairs it: every connection in use" || fail "repaired: $(tail -1 "$launcher") $(pb agent list)"
stop
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
