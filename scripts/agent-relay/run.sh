#!/bin/sh
# Runs the relay with two real agents that know nothing about this project:
# Claude in one directory compares three quotes; Codex in another directory is
# asked, with no context, to write the order email. Then check.mjs reads the ledger.
# This calls real models on the owner's accounts, so it is not part of `pnpm test`.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ROOT=${1:-$(mktemp -d "${TMPDIR:-/tmp}/pneuma-relay-XXXXXX")}
MODEL_A=${RELAY_CLAUDE_MODEL:-opus}
MODEL_B=${RELAY_CODEX_MODEL:-gpt-6.2-astra}
# The two working directories share no parent, so the second agent cannot
# stumble on the first one's files by looking around; only the library links them.
DIR_A=$(mktemp -d "${TMPDIR:-/tmp}/print-job-XXXXXX")
DIR_B=$(mktemp -d "${TMPDIR:-/tmp}/mail-draft-XXXXXX")
mkdir -p "$ROOT/bin" "$ROOT/home" "$DIR_A/quotes"
printf '%s\n%s\n' "$DIR_A" "$DIR_B" > "$ROOT/dirs.txt"
printf '#!/bin/sh\nexec node "%s/packages/cli/dist/bin.js" "$@"\n' "$REPO" > "$ROOT/bin/pneuma-base"
chmod +x "$ROOT/bin/pneuma-base"
export PNEUMA_BASE_HOME="$ROOT/home"
export PATH="$ROOT/bin:$PATH"
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID PNEUMA_BASE_SESSION

pneuma-base init "$ROOT/lib" || exit 1
pneuma-base grant create studio-claude --library "$ROOT/lib" --agent claude || exit 1
pneuma-base grant create studio-codex --library "$ROOT/lib" --agent codex || exit 1
pneuma-base skill install studio-claude --agent claude --dir "$DIR_A/.claude/skills" || exit 1
pneuma-base skill install studio-codex --agent codex --dir "$DIR_B/.agents/skills" || exit 1
cp "$HERE"/quotes/*.txt "$DIR_A/quotes/"

echo "== 会话甲：Claude（${MODEL_A}）在 ${DIR_A}"
( cd "$DIR_A" && printf '%s' "quotes/ 里是三家印刷厂给的画册报价。帮我比较一下，我想要交期短、质量又有保证的。给我一份比较和建议，我基本就按你的建议定了。" | \
    claude -p --model "$MODEL_A" --setting-sources project \
    --add-dir "$ROOT/lib" \
    --allowedTools "Bash(pneuma-base:*),Bash(ls:*),Bash(cat:*),Read,Write,Edit,Glob,Grep" \
    > "$ROOT/a.reply.md" 2> "$ROOT/a.log" )
echo "   退出码 ${?}，回复 $(wc -c < "$ROOT/a.reply.md") 字节"

echo "== 会话乙：Codex（${MODEL_B}）在 ${DIR_B}"
( cd "$DIR_B" && codex exec -m "$MODEL_B" -s workspace-write --skip-git-repo-check \
    --add-dir "$ROOT/lib" --add-dir "$ROOT/home" -c shell_environment_policy.inherit=all \
    -o "$ROOT/b.reply.md" \
    "给上次选定的那家印刷厂写一封下单邮件的草稿。" \
    < /dev/null > "$ROOT/b.log" 2>&1 )
echo "   退出码 ${?}，回复 $(wc -c < "$ROOT/b.reply.md" 2>/dev/null || echo 0) 字节"

echo "== 从账里核"
node "$HERE/check.mjs" "$ROOT/lib" claude codex
STATUS=$?
echo "现场留在 ${ROOT}"
exit $STATUS
