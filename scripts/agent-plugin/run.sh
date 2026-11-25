#!/bin/sh
# Two real agents with no project context are each handed the two package files and asked, in a
# sentence or two, to make a plugin. Their only documentation is the standard that ships in the
# command line's package. Each leaves the plugin and a NOTES.md saying where the standard failed it.
# This calls real models on the owner's accounts, so it is not part of `pnpm test`.
#   sh scripts/agent-plugin/run.sh [codex|claude|both] [directory]
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${PNEUMA_BASE_REPO:-$(cd "$HERE/../.." && pwd)}
WHO=${1:-both}
ROOT=${2:-$(mktemp -d "${TMPDIR:-/tmp}/pneuma-plugin-XXXXXX")}
MODEL_CLAUDE=${PLUGIN_CLAUDE_MODEL:-opus}
MODEL_CODEX=${PLUGIN_CODEX_MODEL:-gpt-6.2-astra}
LIMIT=${PLUGIN_TIMEOUT_SECONDS:-2700}
PACKAGES="$REPO/dist-packages"
[ -f "$PACKAGES/pneuma-base-0.9.0.tgz" ] && [ -f "$PACKAGES/pneuma-base-sdk-0.9.0.tgz" ] || { echo "先在仓库里跑 pnpm pack:dist"; exit 1; }
unset CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID PNEUMA_BASE_SESSION CLAUDECODE ANTIGRAVITY_CONVERSATION_ID ANTIGRAVITY_AGENT

RULES='插件的规范在装好命令行之后的 node_modules/pneuma-base/PLUGINS.md，照它做；不要去找或阅读 Pneuma Base 的源码仓库，这台机器上别处的同名目录也不要看。做到这个项目的 npm test 通过，并且真的把插件装进一个临时的库里试过（临时的库和 PNEUMA_BASE_HOME 都放在当前目录下面，不要动我家目录里的东西）。最后在当前目录写一份 NOTES.md：你卡在哪里、规范哪里没写清楚或写错了、哪些地方你只能猜、你为了弄明白看了哪些不是规范的文件。照实写，这份记录比插件本身更重要。'
PROMPT_CODEX="这个目录里有两个包文件：pneuma-base-0.9.0.tgz 是一个命令行工具，pneuma-base-sdk-0.9.0.tgz 是给它写插件用的开发包。请用它们给 Pneuma Base 做一个插件，名字叫 links，做链接检查：库里的 Markdown 和 HTML 文件里，凡是指向库内另一个文件的相对链接，目标不存在的就算坏链接。我要的是：agent 运行 check 时能看到有哪些坏链接；管理界面里有一页列出全部坏链接，点一行能打开那个文件的面板；一个文件的面板里有它自己的坏链接；主人有一条命令列出它们。${RULES}"
PROMPT_CLAUDE="这个目录里有两个包文件：pneuma-base-0.9.0.tgz 是一个命令行工具，pneuma-base-sdk-0.9.0.tgz 是给它写插件用的开发包。请用它们给 Pneuma Base 做一个插件，名字叫 pulse，记录库的活动热度：每次有东西被放进库或被归档，记一笔（谁、什么时候、哪样东西）。我要的是：管理界面里有一页，用你自己画的图显示最近 30 天每天的活动量，像代码仓库的贡献格子那样，跟着界面的深浅色走，下面按 agent 列出各自的次数；主人有一条命令清空这些记录，这是会丢数据的操作，要按规范走确认。${RULES}"

prepare() { # $1 = agent
  W="$ROOT/$1/work"
  mkdir -p "$W" "$ROOT/$1/home" "$ROOT/$1/tmp" "$ROOT/$1/npm-cache"
  cp "$PACKAGES"/pneuma-base-0.9.0.tgz "$PACKAGES"/pneuma-base-sdk-0.9.0.tgz "$W/"
}

run_codex() {
  prepare codex; W="$ROOT/codex/work"
  printf '%s' "$PROMPT_CODEX" > "$ROOT/codex/prompt.txt"
  echo "== Codex（${MODEL_CODEX}）在 ${W}"
  ( cd "$W" && PNEUMA_BASE_HOME="$ROOT/codex/home" TMPDIR="$ROOT/codex/tmp" npm_config_cache="$ROOT/codex/npm-cache" \
      perl -e 'alarm shift; exec @ARGV' "$LIMIT" codex exec -m "$MODEL_CODEX" -s workspace-write --skip-git-repo-check \
      --add-dir "$ROOT/codex" -c sandbox_workspace_write.network_access=true -c shell_environment_policy.inherit=all \
      -o "$ROOT/codex/reply.md" "$PROMPT_CODEX" < /dev/null > "$ROOT/codex/log.txt" 2>&1 )
  echo "   Codex 退出码 $?"
}

run_claude() {
  prepare claude; W="$ROOT/claude/work"
  printf '%s' "$PROMPT_CLAUDE" > "$ROOT/claude/prompt.txt"
  echo "== Claude（${MODEL_CLAUDE}）在 ${W}"
  ( cd "$W" && PNEUMA_BASE_HOME="$ROOT/claude/home" TMPDIR="$ROOT/claude/tmp" npm_config_cache="$ROOT/claude/npm-cache" \
      perl -e 'alarm shift; exec @ARGV' "$LIMIT" claude -p --model "$MODEL_CLAUDE" --setting-sources project \
      --add-dir "$ROOT/claude" --allowedTools "Bash,Read,Write,Edit,Glob,Grep" \
      < "$ROOT/claude/prompt.txt" > "$ROOT/claude/reply.md" 2> "$ROOT/claude/log.txt" )
  echo "   Claude 退出码 $?"
}

case "$WHO" in
  codex) run_codex ;;
  claude) run_claude ;;
  both) run_codex & run_claude & wait ;;
  *) echo "用法：run.sh [codex|claude|both] [目录]"; exit 1 ;;
esac
echo "现场留在 ${ROOT}"
