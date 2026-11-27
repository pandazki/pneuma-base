#!/bin/sh
# Builds app/dist/Pneuma Base.app from this checkout: self-contained, signed ad hoc. Inside are a Node
# program and the command line (with the management pages, the five built-in plugins, the local folder's
# storage provider and the contract suite's program); the app runs only those. One command, no Xcode project.
#   app/build.sh [--node <path>] [--dist]
# The Node is --node, else $PNEUMA_BASE_NODE, else the `node` on PATH. It must meet the command line's
# Node floor and depend on nothing outside macOS itself, as the builds from nodejs.org do; Homebrew's
# does not. --dist also zips the app into app/dist/ for someone to download.
set -eu
cd "$(dirname "$0")"
repo=$(cd .. && pwd)

node=${PNEUMA_BASE_NODE:-}
dist=no
while [ $# -gt 0 ]; do
  case $1 in
    --node) node=$2; shift 2 ;;
    --dist) dist=yes; shift ;;
    *) echo "usage: app/build.sh [--node <path>] [--dist]" >&2; exit 1 ;;
  esac
done
[ -n "$node" ] || node=$(command -v node || true)
[ -n "$node" ] && [ -x "$node" ] || { echo "no Node found: give one with --node <path>" >&2; exit 1; }
node=$(realpath "$node")

# What the node links outside /usr/lib and /System: none, or it will not run on a machine without them.
outside=$(otool -L "$node" | tail -n +2 | awk '{ print $1 }' | grep -v -e '^/usr/lib/' -e '^/System/Library/' || true)
if [ -n "$outside" ]; then
  version=$("$node" -p process.version)
  echo "$node is not a Node that stands alone: it needs" >&2
  echo "$outside" | sed 's/^/  /' >&2
  echo "Use a build from nodejs.org, e.g. https://nodejs.org/dist/$version/node-$version-darwin-$(uname -m | sed 's/x86_64/x64/').tar.xz, with --node <its bin/node>." >&2
  exit 1
fi

(cd .. && { [ -d node_modules ] || pnpm install --frozen-lockfile; } && pnpm build)
"$node" --input-type=module -e "
  const { meetsNodeFloor, NODE_FLOOR } = await import('$repo/packages/cli/dist/node-floor.js')
  if (!meetsNodeFloor(process.versions.node)) { console.error('$node is Node ' + process.versions.node + '; the command line needs ' + NODE_FLOOR + ' or later.'); process.exit(1) }"
version=$("$node" --input-type=module -e "console.log((await import('$repo/packages/sdk/dist/index.js')).PNEUMA_BASE_VERSION)")

swift build -c release --product PneumaBase
bin="$(swift build -c release --show-bin-path)/PneumaBase"

# The command line as its package file carries it: dist/, the bundled workspace packages, PLUGINS.md, LICENSE.
rm -rf .build/app-stage
mkdir -p .build/app-stage
"$node" "$repo/scripts/pack-dist.mjs" --out .build/app-stage >/dev/null
tar -xzf ".build/app-stage/pneuma-base-$version.tgz" -C .build/app-stage

app="dist/Pneuma Base.app"
contents="$app/Contents"
rm -rf "dist/Pneuma Base.app"
mkdir -p "$contents/MacOS" "$contents/Resources"
cp "$bin" "$contents/MacOS/Pneuma Base"
cp "$node" "$contents/MacOS/node"
mv .build/app-stage/package "$contents/Resources/cli"
# Storage's programs come inside the command line's package: the local folder's provider and the contract
# suite's program, built on this Mac. The product is for Apple-silicon Macs only.
kbin="$contents/Resources/cli/node_modules/@pneuma-base/kernel/bin"
for program in pneuma-base-core pneuma-base-contract; do [ -x "$kbin/$program" ] || { echo "$kbin/$program is missing" >&2; exit 1; }; done
[ "$(cat "$kbin/platform")" = darwin-arm64 ] || { echo "storage's programs are built for $(cat "$kbin/platform"); the app is for darwin-arm64: build it on an Apple-silicon Mac" >&2; exit 1; }
cp Resources/shell.js Resources/parent-watch.mjs "$contents/Resources/"
sed -e "s|@VERSION@|$version|" Resources/Info.plist > "$contents/Info.plist"
sh Icon/compile.sh "$contents/Resources"
# A node signed by its maker keeps that signature; one that is not gets an ad hoc one, as the app does.
codesign --verify "$contents/MacOS/node" 2>/dev/null || codesign --force --sign - --timestamp=none "$contents/MacOS/node"
codesign --force --sign - --timestamp=none "$app"
echo "built $(pwd)/$app: Node $("$node" -p process.versions.node) ($(lipo -archs "$node")), command line $version, $(du -sh "$app" | cut -f1)"

if [ $dist = yes ]; then
  zip="dist/Pneuma-Base-$version-$(lipo -archs "$node" | tr ' ' '-').zip"
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  echo "zipped $(pwd)/$zip: $(du -h "$zip" | cut -f1)"
fi
