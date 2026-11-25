#!/bin/sh
# Two real agents with no project context, a library with every plugin installed:
# Claude builds a small site and puts it in the library; the owner turns it on;
# Codex, in an unrelated directory, is told only that the date changed.
# check.mjs then reads the library, the plugins' records and the deploy target.
# This calls real models on the owner's accounts, so it is not part of `pnpm test`.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${PNEUMA_BASE_REPO:-$(cd "$HERE/../.." && pwd)}
ROOT=${1:-$(mktemp -d "${TMPDIR:-/tmp}/pneuma-site-XXXXXX")}
MODEL_A=${RELAY_CLAUDE_MODEL:-opus}
MODEL_B=${RELAY_CODEX_MODEL:-gpt-6.2-astra}
LIMIT=${RELAY_TIMEOUT_SECONDS:-900}
DIR_A=$(mktemp -d "${TMPDIR:-/tmp}/reading-club-XXXXXX")
DIR_B=$(mktemp -d "${TMPDIR:-/tmp}/quick-fix-XXXXXX")
mkdir -p "$ROOT/bin" "$ROOT/home" "$ROOT/online"
printf '%s\n%s\n' "$DIR_A" "$DIR_B" > "$ROOT/dirs.txt"
printf '#!/bin/sh\nexec node "%s/packages/cli/dist/bin.js" "$@"\n' "$REPO" > "$ROOT/bin/pneuma-base"
chmod +x "$ROOT/bin/pneuma-base"
export PNEUMA_BASE_HOME="$ROOT/home"
export PATH="$ROOT/bin:$PATH"
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID PNEUMA_BASE_SESSION
LIB="$ROOT/lib"

# Runs a command with stdin closed and a hard time limit, so a hung agent cannot stall the run.
limited() { perl -e 'alarm shift; exec @ARGV' "$LIMIT" "$@" < /dev/null; }

pneuma-base init "$LIB" || exit 1
for p in version deploy search; do pneuma-base plugin add $p --library "$LIB" || exit 1; done
pneuma-base deploy target set --kind dir --to "$ROOT/online" --library "$LIB" || exit 1
pneuma-base grant issue studio-claude --library "$LIB" --agent claude || exit 1
pneuma-base grant issue studio-codex --library "$LIB" --agent codex || exit 1
pneuma-base skill install studio-claude --agent claude --dir "$DIR_A/.claude/skills" || exit 1
pneuma-base skill install studio-codex --agent codex --dir "$DIR_B/.agents/skills" || exit 1

echo "== 会话甲：Claude（${MODEL_A}）在 ${DIR_A}"
( cd "$DIR_A" && printf '%s' "帮我做一个单页的小网站，介绍我们周六的社区读书会：下午两点，在街角咖啡馆，这次读《长安的荔枝》。纯 HTML 和 CSS 就行，做好之后我会把它放上线。" > "$ROOT/a.prompt.txt" && \
    perl -e 'alarm shift; exec @ARGV' "$LIMIT" claude -p --model "$MODEL_A" --setting-sources project \
    --add-dir "$LIB" \
    --allowedTools "Bash(pneuma-base:*),Bash(ls:*),Bash(cat:*),Bash(mkdir:*),Bash(cp:*),Read,Write,Edit,Glob,Grep" \
    < "$ROOT/a.prompt.txt" > "$ROOT/a.reply.md" 2> "$ROOT/a.log" )
echo "   退出码 ${?}，回复 $(wc -c < "$ROOT/a.reply.md") 字节"

echo "== 主人：把库里声明了可部署的东西打开"
node "$HERE/check.mjs" declared "$LIB" > "$ROOT/declared.txt" || { echo "甲没有声明任何可部署的东西"; cat "$ROOT/declared.txt"; }
while IFS= read -r site; do
  [ -n "$site" ] && pneuma-base deploy on "$site" --library "$LIB"
done < "$ROOT/declared.txt"

echo "== 会话乙：Codex（${MODEL_B}）在 ${DIR_B}"
( cd "$DIR_B" && limited codex exec -m "$MODEL_B" -s workspace-write --skip-git-repo-check \
    --add-dir "$LIB" --add-dir "$ROOT/home" --add-dir "$ROOT/online" -c shell_environment_policy.inherit=all \
    -o "$ROOT/b.reply.md" \
    "读书会改到周日下午三点了，把网站上的时间改一下。" \
    > "$ROOT/b.log" 2>&1 )
echo "   退出码 ${?}，回复 $(wc -c < "$ROOT/b.reply.md" 2>/dev/null || echo 0) 字节"

echo "== 从库、记录和线上目录里核"
node "$HERE/check.mjs" verdict "$LIB" "$ROOT/online"
STATUS=$?
echo "现场留在 ${ROOT}"
exit $STATUS
