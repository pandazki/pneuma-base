#!/bin/sh
# Install the native icon resources, or refresh the checked-in compilation with Xcode.
set -eu
case "${1:-}" in
  --refresh) refresh=yes ;;
  "") echo "usage: $0 <bundle resources directory> | --refresh" >&2; exit 2 ;;
  *) refresh=no; resources=$(cd "$1" && pwd) ;;
esac
cd "$(dirname "$0")"
export LC_ALL=C

mkdir -p ../.build
stage=$(mktemp -d ../.build/icon.XXXXXX)
trap 'rm -rf "$stage"' EXIT
find -L AppIcon.icon Return.xcassets MenuBar.xcassets -type f ! -name .DS_Store -print0 \
  | sort -z | xargs -0 shasum -a 256 > "$stage/sources.sha256"
if [ "$refresh" = no ] && cmp -s "$stage/sources.sha256" sources.sha256; then
  tar -xf Compiled.tar.xz -C "$resources" Assets.car AppIcon.icns
  exit 0
fi

compile() {
  xcrun actool "$1" MenuBar.xcassets --compile "$stage" --platform macosx --target-device mac \
    --minimum-deployment-target 14.0 --app-icon AppIcon --standalone-icon-behavior all \
    --output-partial-info-plist "$stage/icon.plist" --output-format human-readable-text --warnings --errors
}
if ! compile AppIcon.icon; then
  compile Return.xcassets
fi
if [ "$refresh" = yes ]; then
  COPYFILE_DISABLE=1 tar -cJf "$stage/Compiled.tar.xz" --format ustar --no-xattrs \
    --uid 0 --gid 0 --uname root --gname wheel -C "$stage" Assets.car AppIcon.icns
  mv "$stage/Compiled.tar.xz" "$stage/sources.sha256" .
else
  cp "$stage/Assets.car" "$stage/AppIcon.icns" "$resources/"
fi
