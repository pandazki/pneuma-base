#!/bin/sh
# The proof: build the plugin, install it with the packaged command line into a temp PNEUMA_BASE_HOME,
# and on a temp library walk an agent's put and declaration, the owner's switch, a republish, an app
# removed behind the plugin's back, an archive and an idempotent sync against a real PneumaSpace,
# checking the served page with curl at each step. Then the test suite: conformance, the lifecycle
# (with a publish cut halfway) and the viewer. Removes and purges every pbs-proof-* app, also on failure.
# usage: sh scripts/proof.sh   (env: SPACE_ADMIN, default the acceptance stack http://127.0.0.1:18081)
set -u
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID PNEUMA_BASE_SESSION ANTIGRAVITY_CONVERSATION_ID ANTIGRAVITY_AGENT
ADMIN=${SPACE_ADMIN:-http://127.0.0.1:18081}
PREFIX=pbs-proof
here=$(cd "$(dirname "$0")/.." && pwd)
CLI="$here/node_modules/.bin/pneuma-base"
work=$(mktemp -d "${TMPDIR:-/tmp}/space-proof.XXXXXX")
export PNEUMA_BASE_HOME="$work/home"
lib="$work/lib"
failures=0

purge_prefix() {
  for app in $(curl -s --max-time 10 "$ADMIN/api/apps" </dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const a of JSON.parse(s||"[]"))if(a.name.startsWith(process.argv[1]+"-"))console.log(a.name)})' "$PREFIX"); do
    for step in remove purge; do curl -s --max-time 10 -X POST -H 'x-pneuma-space-manager: pneuma-base' "$ADMIN/api/apps/$app/$step" -o /dev/null </dev/null; done
  done
}
cleanup() {
  status=$?
  purge_prefix
  echo "== cleanup: GET /api/apps -> $(curl -s --max-time 10 "$ADMIN/api/apps" </dev/null); temp files left in $work"
  if [ "$status" -eq 0 ] && [ "$failures" -eq 0 ]; then echo "== PROOF PASSED"; else echo "== PROOF FAILED: exit $status, $failures failed check(s)"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP ALRM

# Every run: stdin closed and a time limit (macOS has no timeout(1)).
limit() { secs=$1; shift; perl -e 'alarm shift; exec @ARGV' "$secs" "$@" </dev/null; }
pb() { limit 60 "$CLI" "$@"; }
agent() { pb --library "$lib" --as claude-code --session s1 "$@"; }
owner() { pb "$@" --library "$lib"; }
fetch() { curl -s --max-time 10 -o "$work/body" -w '%{http_code}' "$1" </dev/null; printf ' %s' "$(head -c 60 "$work/body" 2>/dev/null)"; }
release() { curl -s --max-time 10 "$ADMIN/api/apps/$1" </dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).app;console.log(a?a.status+" "+a.current:"none")})'; }
field() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(process.argv[2].split(".").reduce((v,k)=>v?.[k],j))' "$work/$1.json" "$2"; }
check() { # label actual expected-substring
  case "$2" in *"$3"*) echo "ok   $1: $2" ;; *) echo "FAIL $1: got [$2], wanted [$3]"; failures=$((failures + 1)) ;; esac
}
step() { echo; echo "== $*"; }

step "build, install into a temp PNEUMA_BASE_HOME with the packaged command line, add to a new library"
(cd "$here" && limit 120 npm run --silent build) || exit 1
pb plugin install "$here/dist" | tail -1
pb init "$lib" >/dev/null
owner plugin add space | head -1
owner space target set --admin "$ADMIN" --prefix "$PREFIX"
app="$PREFIX-sites-demo"

step "agent: put a site and declare it deployable"
mkdir -p "$work/v1" "$work/v2"
printf '<h1>hello from version one</h1>\n' > "$work/v1/index.html"
printf '<h1>hello from version two</h1>\n' > "$work/v2/index.html"
agent put "$work/v1" --to sites/demo --made --note "first version of the demo site" | head -1
agent say deployable sites/demo
check "agent cannot switch it on" "$(agent space on sites/demo >/dev/null; echo "exit $?")" "exit 2"

step "owner: switch on"
owner space on sites/demo --json > "$work/on.json"; check "space on" "exit $?" "exit 0"
url=$(field on data.url)
echo "url: $url"
check "curl after on" "$(fetch "$url")" "200 <h1>hello from version one"
check "release after on" "$(release "$app")" "registered 1"

step "agent: put changed content over it"
agent put "$work/v2" --to sites/demo --made --note "second version" | head -1
check "curl after republish" "$(fetch "$url")" "200 <h1>hello from version two"
check "release after republish" "$(release "$app")" "registered 2"

step "sync twice: nothing to change"
owner space sync --json > "$work/sync1.json"; owner space sync --json > "$work/sync2.json"
for f in sync1 sync2; do check "$f changed" "changed=$(field "$f" data.changed)" "changed=0"; done

step "owner: switch off, then on again"
owner space off sites/demo
check "curl after off" "$(fetch "$url")" "404"
owner space on sites/demo
check "curl after on again" "$(fetch "$url")" "200 <h1>hello from version two"
check "release after on again" "$(release "$app")" "registered 2"

step "someone removes the app on PneumaSpace; an agent runs space sync"
curl -s --max-time 10 -X POST -H 'x-pneuma-space-manager: pneuma-base' "$ADMIN/api/apps/$app/remove" </dev/null; echo
check "curl after the removal" "$(fetch "$url")" "404"
agent inspect sites/demo | grep -A1 '## PneumaSpace'
agent space sync --json > "$work/sync3.json"; check "sync brings it back" "changed=$(field sync3 data.changed)" "changed=1"
check "curl after sync" "$(fetch "$url")" "200 <h1>hello from version two"
check "release after sync" "$(release "$app")" "registered 2"

step "agent: archive it"
agent archive sites/demo | head -1
check "curl after archive" "$(fetch "$url")" "404"
check "removed, never purged" "$(release "$app")" "removed 2"

step "the test suite: conformance, the lifecycle with a publish cut halfway, the viewer"
(cd "$here" && limit 400 node --test "test/*.test.ts" > "$work/tests.txt" 2>&1); tests=$?
grep -E '^ *(✔|✖)|^ℹ (pass|fail|skipped)' "$work/tests.txt"
check "test suite" "exit $tests" "exit 0"

[ "$failures" -eq 0 ]
