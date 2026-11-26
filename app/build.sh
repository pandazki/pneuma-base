#!/bin/sh
# Builds app/dist/Pneuma Base.app from this checkout, signed ad hoc. One command, no Xcode project.
set -eu
cd "$(dirname "$0")"
repo=$(cd .. && pwd)
cli="$repo/packages/cli/dist/bin.js"

if [ ! -f "$cli" ]; then
  echo "building the command line first"
  (cd .. && { [ -d node_modules ] || pnpm install --frozen-lockfile; } && pnpm build)
fi

swift build -c release --product PneumaBase
bin="$(swift build -c release --show-bin-path)/PneumaBase"

rm -rf "dist/Pneuma Base.app"
mkdir -p "dist/Pneuma Base.app/Contents/MacOS" "dist/Pneuma Base.app/Contents/Resources"
contents="dist/Pneuma Base.app/Contents"
cp "$bin" "$contents/MacOS/Pneuma Base"
cp Resources/shell.js Resources/parent-watch.mjs "$contents/Resources/"
sed -e "s|@CLI@|$cli|" -e "s|@HOME@|$(pwd)/.spike-home|" Resources/Info.plist > "$contents/Info.plist"
swift Tools/icon.swift "$contents/Resources/AppIcon.icns"
codesign --force --sign - --timestamp=none "dist/Pneuma Base.app"
echo "built $(pwd)/dist/Pneuma Base.app"
