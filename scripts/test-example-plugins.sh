#!/bin/sh
# Installs and tests each plugin under plugins/ against the package files in dist-packages/.
# They were written outside this repository against the contract alone, so a failure here means
# the contract broke for third parties. Needs `pnpm build && pnpm pack:dist` first, and the npm
# registry for each plugin's own dev dependencies.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/dist-packages/pneuma-base-0.9.0.tgz" ] || { echo "run pnpm pack:dist first"; exit 1; }
unset CLAUDECODE CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID PNEUMA_BASE_SESSION ANTIGRAVITY_CONVERSATION_ID ANTIGRAVITY_AGENT
STATUS=0
for dir in "$ROOT"/plugins/*/; do
  name=$(basename "$dir")
  echo "== $name"
  ( cd "$dir" && npm install --no-audit --no-fund --no-package-lock < /dev/null > /dev/null 2>&1 && npm test < /dev/null ) || { echo "== $name FAILED"; STATUS=1; }
done
exit $STATUS
