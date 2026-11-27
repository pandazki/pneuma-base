#!/bin/sh
# Checks the built app without a person, along the path a new owner walks, with a temporary HOME
# and a temporary PNEUMA_BASE_HOME, so no real agent configuration or library is read or written.
# Build it first: app/build.sh. Everything runs on the app's own Node and command line, with nothing
# on PATH but system tools. The app carries the local folder's storage provider and the contract
# suite's program for darwin-arm64. The first launch points the machine's launcher at the app's Node and
# command line and shows the welcome window, which offers where to keep the library: with the one
# provider, a folder; choosing a folder (the same code, by a test hook) makes it a library and opens
# the window on home with 「开始」; the watcher is the provider's own subscription, a child of the app;
# a file dropped on the window (the drop code, by a test hook) is put as brought by the owner, into
# inbox/ or the folder the library page shows, named as Finder names a copy when the name is taken; a
# file written straight into the library is heard through the subscription and registered as the
# owner's and seen, a direct change recorded as seen; files of the library behave as in Finder,
# driven by the page's messages to the shell (posted by a test hook; the shell's acts outside the app
# only logged, so nothing launches): Quick Look is asked for the right files and closes, open, reveal
# and copy-path name the right files, thumbnails stop at 50, draw a placeholder as its type's icon
# and come from the cache the second time, a drag offers the file as a copy, the context menu has the
# system's entries then the page's, and a conversation is opened again by its URL, by a .command file
# that resumes it in its directory, or by revealing its transcript; the page's own rows and tiles,
# clicked, keyed, dragged and right-clicked, send those messages, the icons get the system's
# thumbnails, a scene's conversation opens by its product's rule or offers nothing, a change made
# outside shows in the list and on the tile, and a frame of the page is not heard; a
# small plain folder written in is registered as one thing, a project folder of 80,000 files is the
# ledger's question and nothing in it is registered; an agent's puts stay the
# agent's; connecting the fake Claude Code folds the first step; with env -i and system tools only,
# the exact command lines the installed skill names and the command the fake Claude Desktop's MCP
# entry names work, and what they do is the agent's; an ask puts the dot on the icon and shows in the
# menu bar panel; the local endpoint's address is in machine state and its sentence on the agents page,
# its guide names the launcher, a foreign Host or Origin is refused, a pairing asked over HTTP shows on
# home with its code and, allowed, lets the application put by MCP over HTTP under its own name;
# 在终端里用 pneuma-base puts a link in a folder on PATH and takes it out; a moved copy
# of the app repoints the launcher and the agents keep working; quitting and killing the app leave no
# process behind: no app, no server, no storage provider.
#
# Only the copy of the app this script starts is driven or stopped: it has its own hook name and is
# found by it, never by the app's name. With PNEUMA_BASE_SHOTS set to a folder, it saves pictures of
# the first-launch window, the panel and the files page as a list and as icons there, light and dark.
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
# The log from here on: `logged <text> [seconds]` waits (default 5 s) for a line holding the text after the last `mark`.
mark() { mark=$(wc -l < "$log" | tr -d ' '); }
since_mark() { tail -n +$((mark + 1)) "$log"; }
logged() { i=0; while ! since_mark | grep -qF -- "$1" && [ $i -lt $((${2:-5} * 10)) ]; do sleep 0.1; i=$((i+1)); done; since_mark | grep -qF -- "$1"; }
# Runs the JavaScript $1 in the window's page and prints what it evaluated to, as the eval: hook logs
# it. The hook carries $1 in a quoted string: no single quotes or backslashes in it.
page_eval() {
  n=$(grep -c " eval: " "$log" || true)
  hook "eval:$1"
  i=0; while [ "$(grep -c " eval: " "$log" || true)" -le "$n" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  grep " eval: " "$log" | tail -1 | sed 's/^.* eval: //'
}
# Posts the page message $1, a JavaScript object, to the shell as the page does.
shell_post() { page_eval "window.webkit.messageHandlers.shell.postMessage($1), \"posted\"" >/dev/null; }
# From now on the page keeps the pneuma-shell events it hears in window.__heard, emptied here; `heard <js>` evaluates an expression over them.
listen() { page_eval 'window.__heard = []; if (!window.__listening) { window.__listening = true; window.addEventListener("pneuma-shell", (e) => window.__heard.push(e.detail)) }; "listening"' >/dev/null; }
heard() { page_eval "$1"; }
ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; status=1; }
status=0

start
wait_for "welcome: shown" 10 && ok "first launch with no library: the welcome window" || fail "first launch: the welcome window"
hook "text-welcome:$work/welcome.txt"; sleep 1
grep -q "^places: 本机文件夹（local-folder）$" "$work/welcome.txt" && grep -q "^picker: hidden$" "$work/welcome.txt" && grep -q "^button: 选一个文件夹…$" "$work/welcome.txt" && grep -q "^other: 安装别的存储…$" "$work/welcome.txt" \
  && ok "where to keep the library: with the one provider, choosing a folder; 安装别的存储… beside it" || fail "the welcome window offers: $(cat "$work/welcome.txt" 2>&1)"
kbin="$app/Contents/Resources/cli/node_modules/@pneuma-base/kernel/bin"
[ -x "$kbin/pneuma-base-core" ] && [ -x "$kbin/pneuma-base-contract" ] && [ "$(cat "$kbin/platform")" = darwin-arm64 ] && ok "the app carries the provider and the contract suite's program, for darwin-arm64" || fail "the app's storage programs: $(ls "$kbin" 2>&1)"
pb storage list | grep -q "^    程序：$kbin/pneuma-base-core$" && ok "storage list: the local folder, built in, runs from the app" || fail "storage list: $(pb storage list 2>&1)"
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
wait_for "watcher: subscribed to 我的库" 15 || true
storage=$(pgrep -P "$pid" -f "pneuma-base-core serve" || true)
[ -n "$storage" ] && ps -o command= -p "$storage" | grep -q "^$kbin/pneuma-base-core serve --root $lib$" && ok "the watcher is the provider's subscription: $kbin/pneuma-base-core serve, a child of the app (pid $storage)" || fail "the watcher's provider: $(grep 'watcher:' "$log" | head -3) $(ps -o command= -p "${storage:-0}" 2>&1)"
page_shows home-0.txt "接上你的 agent" 10 && page_text home-0.txt | grep -qx "0 / 3" && ok "home opens with 开始, 0 of 3 done" || fail "home opens with 开始: $(head -c 300 "$work/home-0.txt")"

echo "dropped" > "$work/Downloads/dropped.txt"
hook "drop-window:$work/Downloads/dropped.txt"
wait_for "drop (窗口): placed" 10 && ok "drop on the window: placed" || fail "drop on the window: placed"
pb --library "$lib" inspect inbox/dropped.txt | grep -q "带进来的，主人给的 · 主人" && ok "drop: inbox/dropped.txt, brought by the owner" || fail "drop: brought by the owner: $(pb --library "$lib" inspect inbox/dropped.txt | head -3)"
pb --library "$lib" inspect inbox/dropped.txt | grep -q "出处：Downloads" && ok "drop: its source is the folder it came from" || fail "drop: source"
page_shows home-1.txt "库的根目录里有 1 样东西" 10 && ok "the second step folds: 库的根目录里有 1 样东西" || fail "the second step folds"
hook "route:view=ledger.items&view.dir=docs"
sleep 1
echo "into the folder shown" > "$work/Downloads/shown.txt"
hook "drop-window:$work/Downloads/shown.txt"
wait_for 'drop (窗口): placed \["docs/shown.txt"\]' 10 && ok "with the library page on docs/, a drop goes into docs/" || fail "a drop goes into the folder shown: $(grep 'drop (窗口)' "$log" | tail -1)"
hook "drop-window:$work/Downloads/shown.txt"
wait_for 'drop (窗口): placed \["docs/shown 2.txt"\]' 10 && ok "the name taken there: the drop is named as Finder names a copy, storage saying what is free" || fail "a drop onto a taken name: $(grep 'drop (窗口)' "$log" | tail -1)"
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
grep -q "watcher: heard .*direct.txt" "$log" && ok "heard through storage's subscription" || fail "heard through the subscription: $(grep 'watcher: heard' "$log" | head -3)"
pb --library "$lib" inspect direct.txt | grep -q "带进来的，主人给的（自动登记） · 主人" && ok "it is the owner's, seen: 带进来的，主人给的（自动登记）" || fail "it is the owner's, seen: $(pb --library "$lib" inspect direct.txt | head -3)"
pb --library "$lib" inspect report.pdf | grep -q "出处：https://example.com/files/report.pdf" && ok "xattr: the download address is the source" || fail "xattr: the download address is the source"

echo "changed in place" >> "$lib/inbox/dropped.txt"
wait_for "watcher: registered \[\] seen \[\"inbox/dropped.txt\"\]" 20 && ok "a direct change: recorded" || fail "a direct change: recorded"
pb --library "$lib" inspect inbox/dropped.txt | grep -q "直接改的，自动登记" && ok "it is recorded as seen: 直接改的，自动登记" || fail "the change is recorded as seen"

# Files of the library as in Finder, driven by the page's messages to the shell (posted with eval:);
# with hooks the shell's acts outside the app are only logged (opener: …), so nothing launches.
/usr/bin/python3 -c "
import struct, sys, zlib
w, h = 96, 64
rows = b''.join(b'\x00' + bytes(v for x in range(w) for v in (x * 255 // w, y * 255 // h, 160)) for y in range(h))
chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
" "$work/pic.png"
sips -s format pdf "$work/pic.png" --out "$work/doc.pdf" >/dev/null
mkdir -p "$work/many" && for i in $(seq -w 1 53); do echo "note $i" > "$work/many/n$i.txt"; done
for f in pic.png doc.pdf many; do pb --library "$lib" put "$work/$f" --to "$f" --brought --by owner >/dev/null; done
listen
mark; shell_post '{ type: "preview", paths: ["inbox/dropped.txt"], at: 0 }'
logged "preview: $lib/inbox/dropped.txt at 0" && ok "preview: Quick Look on the file at its path on this machine" || fail "preview of one: $(since_mark | grep 'preview:\|files:')"
mark; shell_post '{ type: "preview", paths: ["pic.png", "doc.pdf"], at: 1 }'
logged "preview: $lib/pic.png | $lib/doc.pdf at 1" && ok "preview of two: both, showing the second" || fail "preview of two: $(since_mark | grep 'preview:\|files:')"
mark; shell_post '{ type: "preview", paths: [], at: 0 }'
logged "preview: close" && [ "$(heard 'JSON.stringify(window.__heard.filter((d) => "previewing" in d))')" = '[{"previewing":true},{"previewing":false}]' ] \
  && ok "an empty preview closes the panel; the page heard previewing true, then false" || fail "closing the preview: heard $(heard 'JSON.stringify(window.__heard.filter((d) => "previewing" in d))'), $(since_mark | grep 'preview:')"
mark; shell_post '{ type: "launch", paths: ["inbox/dropped.txt", "docs"] }'
logged "opener: open $lib/inbox/dropped.txt | $lib/docs" && ok "launch: each opened with its default application, a directory as itself (stubbed)" || fail "launch: $(since_mark | grep 'opener:\|files:')"
mark; shell_post '{ type: "reveal", paths: ["report.pdf"] }'
logged "opener: reveal $lib/report.pdf" && ok "reveal: shown in Finder (stubbed)" || fail "reveal: $(since_mark | grep 'opener:\|files:')"
mark; shell_post '{ type: "copy-path", paths: ["pic.png", "doc.pdf"] }'
logged "opener: copy $lib/pic.png" && since_mark | grep -qxF "$lib/doc.pdf" && ok "copy-path: the absolute paths, one per line (stubbed)" || fail "copy-path: $(since_mark | tail -3)"

hook "fake-placeholder:inbox/on-icon.txt"
thumbs='{ type: "thumbnails", px: 128, items: ["pic.png", "doc.pdf", "report.pdf", "docs", "inbox/on-icon.txt", "inbox/dropped.txt", "docs/shown.txt"].concat(Array.from({ length: 53 }, (_, i) => "many/n" + String(i + 1).padStart(2, "0") + ".txt")).map((path, i) => ({ path, token: "t" + i })) }'
mark; shell_post "$thumbs"
logged "thumbnails: asked 60, kept 50, " 60 && since_mark | grep -qF 'placeholders ["inbox/on-icon.txt"]' \
  && ok "thumbnails: 60 asked, 50 kept; the placeholder gets the icon of its type, its content untouched: $(since_mark | sed -n 's/.*thumbnails: \(asked\)/\1/p')" || fail "thumbnails: $(since_mark | grep 'thumbnails:\|files:' | head -5)"
answers=$(heard 'new Set(window.__heard.filter((d) => d.thumbnail && d.thumbnail.src.startsWith("data:image/png;base64,")).map((d) => d.thumbnail.token)).size')
[ "$answers" = 50 ] && ok "the page heard 50 thumbnails, each by itself with its token, as data:image/png" || fail "thumbnails heard: $answers"
mark; shell_post "$thumbs"
logged "thumbnails: asked 60, kept 50, cached 48, made 0, icons 2, " 30 && ok "asked again: from the cache, the folder and the placeholder drawn as icons" || fail "thumbnails again: $(since_mark | grep 'thumbnails:')"
cached=$(ls "$pb_home/app/cache/thumbnails/"*/*.png 2>/dev/null | wc -l | tr -d ' ')
[ "$cached" = 48 ] && ok "kept in the app's cache: $cached files" || fail "thumbnails in $pb_home/app/cache/thumbnails: $cached"
# An entry not touched for 30 days, removed at the next launch.
stale="$(dirname "$(ls "$pb_home/app/cache/thumbnails/"*/*.png | head -1)")/stale.png"
cp "$(ls "$pb_home/app/cache/thumbnails/"*/*.png | head -1)" "$stale" && touch -t "$(date -v-31d +%Y%m%d%H%M)" "$stale"

mark; shell_post '{ type: "drag", paths: ["report.pdf"] }'
logged "drag: offers $(/usr/bin/python3 -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).as_uri())' "$lib/report.pdf") as copy" && ok "drag: the file offered as a copy" || fail "drag: $(since_mark | grep 'drag:\|files:')"

menu='{ type: "menu", paths: ["report.pdf"], x: 240, y: 180, items: [{ id: "move", label: "挪到…" }, { id: "archive", label: "归档" }, { id: "remove", label: "丢掉", danger: true }] }'
mark; shell_post "$menu"
logged "menu: 打开 | 打开方式 | — | 快速查看 | 在访达中显示 | 拷贝路径 | — | 挪到… | 归档 | — | 丢掉" && ok "menu: the system's entries, then the page's, the destructive one last after a separator" || fail "menu: $(since_mark | grep 'menu:')"
mark; hook "menu-pick:在访达中显示"
logged "opener: reveal $lib/report.pdf" && ok "menu: 在访达中显示 reveals (stubbed)" || fail "menu-pick 在访达中显示: $(since_mark | tail -2)"
mark; shell_post "$menu"; logged "menu: 打开 |"; hook "menu-pick:归档"
i=0; while [ "$(heard 'window.__heard.some((d) => d.menu === "archive")')" != true ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done
[ "$(heard 'window.__heard.some((d) => d.menu === "archive")')" = true ] && ok "menu: the page's entry comes back to the page as { menu: id }" || fail "menu-pick 归档: heard $(heard 'JSON.stringify(window.__heard.filter((d) => "menu" in d))')"

mark; shell_post '{ type: "reopen", url: "https://example.com/session/1", run: null, reveal: "" }'
logged "opener: url https://example.com/session/1" && ok "reopen: a URL an application handles is opened (stubbed)" || fail "reopen by URL: $(since_mark | grep 'reopen:\|opener:')"
mark; shell_post "{ type: \"reopen\", url: \"pneuma-verify-nothing://session/1\", run: { command: \"echo resumed\", cwd: \"$work\" }, reveal: \"$lib/report.pdf\" }"
logged "reopen: run echo resumed in $work" && command_file=$(since_mark | sed -n 's/.* opener: run //p' | head -1) && [ -x "$command_file" ] \
  && [ "$(cat "$command_file")" = "$(printf '#!/bin/sh\ncd '"'"'%s'"'"' || exit 1\nexec echo resumed' "$work")" ] \
  && ok "reopen: no handler for the URL, so a .command file that cds into the directory and execs the command (not opened)" || fail "reopen by command: $(since_mark | tail -4)"
mark; shell_post "{ type: \"reopen\", url: null, run: null, reveal: \"$lib/report.pdf\" }"
logged "reopen: reveal $lib/report.pdf" && logged "opener: reveal $lib/report.pdf" && ok "reopen: with neither, the transcript is revealed (stubbed)" || fail "reopen by reveal: $(since_mark | grep 'reopen:\|opener:')"
hook owner-files:off; wait_for "app: owner files off" 5 && hook owner-files:on && wait_for "app: owner files on" 5 && ok "owner-files:off and :on switch 直接放进来的文件算主人的" || fail "owner-files hooks: $(grep 'owner files' "$log")"

# A small plain folder written in is registered as one thing; a project folder of 80,000 files is the ledger's question.
mkdir -p "$lib/photos" && for i in 1 2 3; do echo "photo $i" > "$lib/photos/p$i.jpg"; done
wait_for "watcher: registered.*photos" 20 && pb --library "$lib" inspect photos | grep -q "带进来的，主人给的（自动登记）" && ok "a small plain folder written in: registered as one thing, the owner's, seen" || fail "the small folder: $(grep 'watcher:' "$log" | tail -3) $(pb --library "$lib" inspect photos | head -3)"
/usr/bin/python3 -c "
import os, sys
root = sys.argv[1]
os.makedirs(root)
open(os.path.join(root, 'package.json'), 'w').write('{\"name\": \"proj\"}\n')
for d in range(400):
    os.makedirs(os.path.join(root, 'src', 'd%03d' % d))
    for f in range(200):
        open(os.path.join(root, 'src', 'd%03d' % d, 'f%03d.ts' % f), 'w').write('export {}\n')
" "$lib/proj"
found=$(find "$lib/proj" -type f | wc -l | tr -d ' ')
page_shows home-proj.txt "proj/ 没登记" 60 && ok "a project folder of $found files written in: the ledger's question on home, proj/ 没登记" || fail "the project folder's question: $(grep -n 'proj' "$work/home-proj.txt" | head -3)"
wait_for "watcher: proj/ is a question" 30 && ok "the watcher's probe: $(grep -o 'watcher: proj/ is a question.*' "$log" | head -1 | sed 's/watcher: //')" || fail "the watcher on proj/: $(grep 'watcher: storage cannot say\|watcher: looked\|watcher: heard' "$log" | tail -3)"
pb --library "$lib" inspect proj | grep -q "^proj/ · 目录，没有登记，至少 [0-9]* 个文件，顶上有 package.json$" && ok "proj/ is not a thing: $(pb --library "$lib" inspect proj | head -1)" || fail "proj/: $(pb --library "$lib" inspect proj | head -5)"
! grep -q "watcher: registered.*proj" "$log" && ! pb --library "$lib" find f000 | grep -q "proj/" && ok "nothing in it is registered" || fail "registered from proj/: $(grep 'watcher: registered' "$log" | tail -2) $(pb --library "$lib" find f000 | head -3)"

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
find_line=$(line find | sed 's/<文字>/books/')
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

# Files on the page as in Finder: the page's own rows and tiles, clicked, keyed, dragged and
# right-clicked (events dispatched with eval:), send the shell the messages checked above; the icons
# from the 显示 menu's command, with the system's thumbnails for the tiles in view; a scene's
# conversation opens again by its product's rule and offers nothing where none can; a change made
# outside shows in both views; a frame of the page is not heard.
# Polls until the page's JavaScript $1 is true, for up to $2 seconds (default 10).
page_until() { i=0; while [ "$(page_eval "$1")" != true ] && [ $i -lt "${2:-10}" ]; do sleep 1; i=$((i+1)); done; [ "$(page_eval "$1")" = true ]; }
# Runs $2 on `el`, the first row or tile of the page's files for which the JavaScript predicate $1 on `e` holds.
on_row() { page_eval "(() => { const el = [...document.querySelectorAll(\"[data-files] [data-key]\")].find((e) => $1); if (!el) return \"no row\"; $2; return \"done\" })()"; }
key() { echo "e.dataset.key === \"$1\""; }
space='el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))'
double='el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))'
right='const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.top + 8 }))'
look() { page_eval "window.dispatchEvent(new CustomEvent(\"pneuma-shell\", { detail: { command: \"$1\" } })), \"$1\"" >/dev/null; }
reopen_buttons='document.querySelectorAll("[aria-label=详情] button[aria-label=打开那次对话]").length'

hook "route:view=files"
page_until 'document.querySelectorAll("[data-files] [data-key]").length > 5' 15 || fail "the files page: $(page_eval 'document.body.innerText.slice(0, 300)')"
mark; on_row "$(key direct.txt)" 'el.click()' >/dev/null; on_row "$(key direct.txt)" "$space" >/dev/null
logged "preview: $lib/direct.txt at 0" && ok "page: a row clicked, then Space: Quick Look on that file" || fail "page: Space on a row: $(since_mark | grep 'preview:\|files:\|eval:' | head -3)"
logged "preview: shown" && mark && page_eval 'window.dispatchEvent(new CustomEvent("pneuma-shell", { detail: { key: "ArrowDown", shift: false } })), "arrow"' >/dev/null
logged "preview: $lib/doc.pdf at 0" && ok "page: an arrow Quick Look passes on moves the selection, and the panel follows it" || fail "page: the panel following: $(since_mark | grep 'preview:\|eval:' | head -3)"
mark; on_row "$(key doc.pdf)" "$space" >/dev/null
logged "preview: close" && ok "page: Space again closes it" || fail "page: Space to close: $(since_mark | grep 'preview:\|eval:' | head -3)"
mark; on_row "$(key report.pdf)" "$double" >/dev/null
logged "opener: open $lib/report.pdf" && ok "page: a double-click opens the file with its application (stubbed)" || fail "page: double-click: $(since_mark | grep 'opener:\|files:\|eval:' | head -3)"
on_row "$(key docs)" "$double" >/dev/null
page_until 'location.hash.includes("view.dir=docs")' && ok "page: a double-click on a folder opens it in the page" || fail "page: double-click on a folder: $(page_eval 'location.hash')"
hook "route:view=files"; page_until 'document.querySelectorAll("[data-files] [data-key]").length > 5'
mark; on_row "$(key report.pdf)" 'el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }))' >/dev/null
logged "drag: offers $(/usr/bin/python3 -c 'import pathlib, sys; print(pathlib.Path(sys.argv[1]).as_uri())' "$lib/report.pdf") as copy" && ok "page: dragging a row offers the file as a copy" || fail "page: drag: $(since_mark | grep 'drag:\|eval:' | head -3)"

mark; on_row "$(key doc.pdf)" "$right" >/dev/null
logged "menu: 打开 | 打开方式 | — | 快速查看 | 在访达中显示 | 拷贝路径 | — | 归档 | 挪到… | 重新命名" && ok "page: the context menu: the system's entries, then the library's archive, move and rename" || fail "page: the context menu: $(since_mark | grep 'menu:\|eval:' | head -3)"
hook "menu-pick:归档"
i=0; while [ ! -f "$lib/_archive/doc.pdf" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
[ -f "$lib/_archive/doc.pdf" ] && [ ! -e "$lib/doc.pdf" ] && ok "page: 归档 from the menu archives it through the library" || fail "page: 归档 from the menu: $(ls "$lib" "$lib/_archive" 2>&1 | tr '\n' ' ')"
page_until '![...document.querySelectorAll("[data-files] [data-key]")].some((e) => e.dataset.key === "doc.pdf")' || true
mark; on_row "$(key direct.txt)" "$right" >/dev/null; logged "menu: 打开 |"; hook "menu-pick:重新命名"
page_until 'document.querySelector(".rename-field") !== null' && page_eval '(() => { const f = document.querySelector(".rename-field"); f.value = "direct-renamed.txt"; f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return "typed" })()' >/dev/null
i=0; while [ ! -f "$lib/direct-renamed.txt" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
[ -f "$lib/direct-renamed.txt" ] && [ ! -e "$lib/direct.txt" ] && pb --library "$lib" inspect direct-renamed.txt | grep -q "带进来的，主人给的（自动登记）" && ok "page: 重新命名 in place: the library moves it, and it keeps where it came from" || fail "page: rename in place: $(ls "$lib" | tr '\n' ' ') $(pb --library "$lib" inspect direct-renamed.txt 2>&1 | head -2)"

# The icons, from the 显示 menu's command: each tile in view gets the system's thumbnail or its type's icon.
mkdir -p "$work/day" && echo "# 日报" > "$work/day/index.md" && echo "<h1>日报</h1>" > "$work/day/index.html"
for d in 2026-11-25 2026-11-26 2026-11-27; do pb --library "$lib" --as grok-bot put "$work/day" --to "daily/$d" --made >/dev/null; done
# A window the system counts as hidden runs no transitions: the pictures are taken without them, so they show where each one ends.
[ -z "$shots" ] || page_eval '(() => { const s = document.createElement("style"); s.textContent = "*, *::before, *::after { transition: none !important }"; document.head.append(s); return "still" })()' >/dev/null
mark; look icons
page_until 'document.querySelectorAll(".tile[data-key]").length > 5' 10 && logged "thumbnails: asked" 30 \
  && page_until '[...document.querySelectorAll(".tile[data-key]")].filter((t) => t.getBoundingClientRect().top < innerHeight).every((t) => t.querySelector("img") || t.querySelector(".tile-art[data-kind=bundle]"))' 20 \
  && ok "page: the icons: every tile in view has its art from the shell: $(since_mark | sed -n 's/.*thumbnails: \(asked.*\)/\1/p' | head -1)" || fail "page: the icons' thumbnails: $(since_mark | grep 'thumbnails:\|files:' | head -3) $(page_eval 'document.querySelectorAll(".tile img").length')"
! since_mark | grep -q "beyond the first" && ok "page: the page asks at most 50 at a time" || fail "page: more than 50 asked at once: $(since_mark | grep 'beyond the first')"
[ "$(page_eval 'document.querySelector("[role=radio][aria-checked=true]")?.getAttribute("aria-label")')" = 图标 ] && ok "page: the 显示 menu's 图标 shows the icons, and the head's switch says so" || fail "page: the switch after 图标: $(page_eval 'document.querySelector("[role=radio][aria-checked=true]")?.getAttribute("aria-label")')"
snap snap files-icons
look list; page_until 'document.querySelector("table [data-files]") !== null' && snap snap files-list
hook "route:view=files&view.dir=daily"; look icons; page_until 'document.querySelectorAll(".tile[data-key]").length === 3' && snap snap daily-icons
mark; hook "route:view=files&view.dir=inbox"
logged 'placeholders ["inbox/on-icon.txt"]' 20 && ok "page: in the icons a placeholder is drawn from its type, its content not read" || fail "page: the placeholder's tile: $(since_mark | grep 'thumbnails:' | head -2)"
look list

# A scene's conversation, opened again by its product's rule: Claude Code by its resume command in the
# directory it ran in, Codex by its link or, with nothing to handle it, its resume command; a product
# with no rule, or a conversation whose file is gone, offers nothing.
# Puts a made thing at $2 from the directory $1 as an agent product runs, its session in the variable $3.
as_product() { (cd "$1" && printf '# 对话里做的\n' | env -i HOME="$fake_home" PATH=/usr/bin:/bin PNEUMA_BASE_HOME="$pb_home" "$3" "$app/Contents/MacOS/node" "$app/Contents/Resources/cli/dist/bin.js" --library "$lib" put - --to "$2" --made >/dev/null); }
claude_id=11111111-2222-4333-8444-555555555555; codex_id=01a2106d-fcb1-72c3-9aef-583c6bd555a2; gone_id=22222222-3333-4444-8555-666666666666
mkdir -p "$work/proj-claude" "$work/proj-codex"
folder=$(echo "$work/proj-claude" | sed 's/[^a-zA-Z0-9]/-/g')
mkdir -p "$fake_home/.claude/projects/$folder" "$fake_home/.codex/sessions/2026/11/27"
: > "$fake_home/.claude/projects/$folder/$claude_id.jsonl"; : > "$fake_home/.claude/projects/$folder/$gone_id.jsonl"
: > "$fake_home/.codex/sessions/2026/11/27/rollout-2026-11-27T10-00-00-$codex_id.jsonl"
as_product "$work/proj-claude" talk/claude.md CLAUDE_CODE_SESSION_ID=$claude_id
as_product "$work/proj-codex" talk/codex.md CODEX_THREAD_ID=$codex_id
as_product "$work/proj-codex" talk/antigravity.md ANTIGRAVITY_CONVERSATION_ID=ag-1
as_product "$work/proj-claude" talk/gone.md CLAUDE_CODE_SESSION_ID=$gone_id
rm "$fake_home/.claude/projects/$folder/$gone_id.jsonl"
# Opens the item panel of $1 and waits for its provenance.
panel_of() { hook "route:view=files&view.dir=talk&panel=item&panel.path=$1"; page_until "document.querySelector(\"[aria-label=详情]\")?.innerText.includes(\"来历\") === true" 15; }
panel_of talk/claude.md; mark; page_eval "document.querySelector(\"[aria-label=详情] button[aria-label=打开那次对话]\")?.click(), \"clicked\"" >/dev/null
logged "reopen: run claude --resume $claude_id in $work/proj-claude" && logged "exec claude --resume $claude_id" && ok "reopen, Claude Code: its resume command, in a terminal, in the directory it ran in (stubbed)" || fail "reopen Claude Code: $(since_mark | grep 'reopen:\|opener:' | head -3)"
panel_of talk/codex.md; mark; page_eval "document.querySelector(\"[aria-label=详情] button[aria-label=打开那次对话]\")?.click(), \"clicked\"" >/dev/null
if logged "reopen: url codex://threads/$codex_id"; then ok "reopen, Codex: its link, an application here handles codex:// (stubbed)"
elif logged "reopen: run codex resume $codex_id in $work/proj-codex"; then ok "reopen, Codex: nothing here handles codex://, so its resume command in its directory (stubbed)"
else fail "reopen Codex: $(since_mark | grep 'reopen:\|opener:' | head -3)"; fi
panel_of talk/antigravity.md && [ "$(page_eval "$reopen_buttons")" = 0 ] && ok "reopen: a product with no rule offers nothing" || fail "reopen, no rule: $(page_eval "$reopen_buttons") buttons"
panel_of talk/gone.md && [ "$(page_eval "$reopen_buttons")" = 0 ] && ok "reopen: a conversation whose file is gone offers nothing" || fail "reopen, gone: $(page_eval "$reopen_buttons") buttons"
hook "route:view=files"

# A change made straight in the library while those are not taken as the owner's: 已变, in the list and on the tile.
hook owner-files:off; wait_for "app: owner files off" 5
echo "改在外面" >> "$lib/notes/books.md"
hook "route:view=ledger.items&view.dir=notes"
page_until "[...document.querySelectorAll(\"[data-files] [data-key]\")].some((e) => e.innerText.includes(\"books.md\") && e.innerText.includes(\"已变\"))" 20 && ok "page: changed outside, in the list: 已变 on its row" || fail "page: changed outside in the list: $(page_eval 'document.querySelector("[data-files]")?.innerText.slice(0, 300)')"
look icons
page_until "[...document.querySelectorAll(\".tile[data-key]\")].some((t) => t.innerText.includes(\"books.md\") && t.querySelector(\".tile-badge[data-tone=warn]\")?.getAttribute(\"aria-label\") === \"已变\")" 10 && ok "page: changed outside, in the icons: a badge on its tile" || fail "page: changed outside in the icons: $(page_eval 'document.querySelectorAll(".tile-badge").length') badges"
look list; hook owner-files:on; wait_for "app: owner files on" 5

# Only the app's own page speaks to the shell: a frame of it that tries is not heard.
mark; page_eval '(() => { window.__frameSaw = "nothing"; window.addEventListener("message", (e) => { if (e.data && e.data.frameSaw) window.__frameSaw = e.data.frameSaw }); const f = document.createElement("iframe"); f.style.display = "none"; f.srcdoc = "<scr" + "ipt>parent.postMessage({ frameSaw: typeof webkit }, `*`); if (typeof webkit === `object`) webkit.messageHandlers.shell.postMessage({ type: `reveal`, paths: [`report.pdf`] })</scr" + "ipt>"; document.body.appendChild(f); return "framed" })()' >/dev/null
sleep 2
saw=$(page_eval 'window.__frameSaw')
! since_mark | grep -q "opener: reveal" && ok "a frame of the page (it saw webkit: $saw) is not heard: nothing revealed" || fail "a frame was heard: $(since_mark | grep 'opener:')"

hook settings
wait_for "settings: PATH folders" 10
hook "text-settings:$work/settings.txt"; sleep 1
grep -q "在终端里用 pneuma-base：关着" "$work/settings.txt" && grep -q "登录时打开：关着" "$work/settings.txt" && ok "settings: both conveniences start off" || fail "settings: $(cat "$work/settings.txt")"
grep -q "PATH 上能放的文件夹：.*$work/bin" "$work/settings.txt" && ok "settings: a folder on the owner's PATH they can write is offered" || fail "settings: the PATH folders: $(cat "$work/settings.txt")"
snap snap-settings settings
hook "path-link:$work/bin"; sleep 1
[ "$(readlink "$work/bin/pneuma-base")" = "$launcher" ] && env -i HOME="$fake_home" PATH="$work/bin:/usr/bin:/bin" pneuma-base --library "$lib" find books | grep -q "notes/books.md" && ok "在终端里用 pneuma-base: a link on PATH, and pneuma-base runs in a terminal" || fail "the link on PATH: $(ls -l "$work/bin")"
hook path-unlink; sleep 1
[ ! -e "$work/bin/pneuma-base" ] && [ ! -L "$work/bin/pneuma-base" ] && ok "turned off: the link is gone" || fail "the link is left"

thumbs_kept=$(ls "$pb_home/app/cache/thumbnails/"*/*.png | wc -l | tr -d ' ')
hook quit
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
sleep 1
kill -0 "$pid" 2>/dev/null && fail "quit: the app is still running" || ok "quit: the app ended"
kill -0 "$child" 2>/dev/null && fail "quit: the server $child is left" || ok "quit: no server left"
left=$(pgrep -f "pneuma-base-core serve --root $lib" || true)
[ -z "$left" ] && ok "quit: no storage provider left" || fail "quit: storage providers left: $(ps -o pid=,command= -p "$(echo $left | tr ' ' ',')")"

# The app moves: a copy elsewhere repoints the launcher at its own Node and command line, and the
# agents' entries, untouched, keep working. Moved away, the launcher dangles and agent list says so;
# the next launch of an app repairs it.
mkdir -p "$work/moved"
ditto "$app" "$work/moved/Pneuma Base.app"
desktop_before=$(cat "$desktop"); skill_before=$(cat "$skill")
: > "$log"
start "$work/moved/Pneuma Base.app"
wait_for "launcher: written" 10 && grep -q "exec '$work/moved/Pneuma Base.app/Contents/MacOS/node'" "$launcher" && ok "moved: the launcher now runs the moved app's Node" || fail "moved: $(grep 'launcher:' "$log") $(tail -1 "$launcher")"
wait_for "thumbnails: removed 1 not used for 30 days" 10 && [ ! -e "$stale" ] && [ "$(ls "$pb_home/app/cache/thumbnails/"*/*.png | wc -l | tr -d ' ')" = $((thumbs_kept - 1)) ] && ok "launched again: the thumbnail not used for 30 days is removed, the others stay" || fail "thumbnail cache at launch: $(grep 'thumbnails:' "$log"), $(ls "$pb_home/app/cache/thumbnails/"*/*.png | wc -l | tr -d ' ') of $thumbs_kept left"
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
left=$(pgrep -f "pneuma-base-core serve --root $lib" || true)
[ -z "$left" ] && ok "kill -9: no storage provider left" || fail "kill -9: storage providers left: $left"
echo "library left in $lib"
exit $status
