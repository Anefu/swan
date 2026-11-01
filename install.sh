#!/bin/bash
# Installs or updates Swan from its GitHub releases:
#   curl -fsSL https://raw.githubusercontent.com/Anefu/swan/main/install.sh | bash
# A specific version (also to reinstall or go back): ... | bash -s -- 0.1.3
#
# Builds are not signed by Apple yet. Files curl downloads are not marked as coming from the
# internet, so macOS opens Swan without blocking it; the DMG is checked against the release's
# SHA256SUMS.txt first. SWAN_APP_DIR installs somewhere other than /Applications.
#
# Everything runs from main at the end, so a half-downloaded script does nothing. ASCII only: in a
# UTF-8 locale, macOS's bash 3.2 reads the bytes of a character like an ellipsis after $name as
# part of the name (CI checks).
set -euo pipefail

REPO="Anefu/swan"
tmp="" mnt="" new="" old=""

say() { printf '%s\n' "$*"; }
fail() { printf 'Swan install: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$mnt" ]; then hdiutil detach -quiet "$mnt" 2>/dev/null || true; fi
  if [ -n "$new" ] && [ -e "$new" ]; then rm -rf "$new"; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}

check_mac() {
  [ "$(uname -s)" = Darwin ] || fail "Swan runs on macOS only."
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] ||
    fail "Swan needs a Mac with Apple silicon (M1 or later)."
  local os
  os=$(sw_vers -productVersion)
  [ "${os%%.*}" -ge 13 ] || fail "Swan needs macOS 13 or later; this Mac has $os."
}

# The releases feed lists pre-releases too, newest first, and isn't rate-limited like the API.
latest_version() {
  local feed re='releases/tag/v([0-9]+\.[0-9]+\.[0-9]+)"'
  feed=$(curl -fsSL --retry 3 "https://github.com/$REPO/releases.atom") ||
    fail "couldn't reach github.com. Check your connection, or set https_proxy if you use a proxy."
  [[ $feed =~ $re ]] || fail "couldn't find a release of Swan on github.com/$REPO."
  say "${BASH_REMATCH[1]}"
}

# Where Swan is now, else /Applications, else ~/Applications for users who can't write there.
app_dir() {
  if [ -n "${SWAN_APP_DIR:-}" ]; then say "$SWAN_APP_DIR"
  elif [ -d /Applications/Swan.app ]; then say /Applications
  elif [ -d "$HOME/Applications/Swan.app" ]; then say "$HOME/Applications"
  elif [ -w /Applications ]; then say /Applications
  else say "$HOME/Applications"; fi
}

installed_version() {
  local plist="$1/Contents/Info.plist"
  if [ -f "$plist" ]; then
    /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || true
  fi
}

# Downloads the release's DMG to $2 and checks it against the release's checksums.
download() {
  local version=$1 out=$2 base="https://github.com/$REPO/releases/download/v$1" name
  name=$(basename "$out")
  say "Downloading Swan $version..."
  curl -fL --retry 3 --progress-bar -o "$out" "$base/$name" ||
    fail "couldn't download $base/$name. Check your connection, or set https_proxy if you use a proxy."
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" ||
    fail "couldn't download the checksums for Swan $version."
  local expected actual
  expected=$(awk -v f="$name" '$2 == f { print $1 }' "$tmp/SHA256SUMS.txt")
  [ -n "$expected" ] || fail "the release has no checksum for $name; nothing was installed."
  actual=$(shasum -a 256 "$out" | awk '{ print $1 }')
  [ "$actual" = "$expected" ] ||
    fail "the download doesn't match the release's checksum; nothing was installed. Try again."
}

main() {
  check_mac
  local version=${1:-} dir dest current dmg
  version=${version#v}
  if [ -n "$version" ]; then
    [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "\"$1\" isn't a version; use one like 0.1.3."
  fi

  dir=$(app_dir)
  dest="$dir/Swan.app"
  current=$(installed_version "$dest")
  if [ -z "$version" ]; then
    version=$(latest_version)
    if [ "$current" = "$version" ]; then
      say "Swan $version, the latest, is already installed in $dir."
      return
    fi
  fi
  if pgrep -f "$dest/Contents/MacOS/Swan" >/dev/null; then
    fail "Swan is running. Quit it (Swan > Quit Swan), then run this again."
  fi
  if ! { mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; }; then
    fail "can't write to $dir. Ask an administrator, or set SWAN_APP_DIR=~/Applications."
  fi

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/swan-install.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  dmg="$tmp/Swan-$version-arm64.dmg"
  download "$version" "$dmg"

  mnt="$tmp/mnt"
  mkdir "$mnt"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null </dev/null ||
    fail "couldn't open the downloaded disk image."
  [ -d "$mnt/Swan.app" ] || fail "the disk image has no Swan.app; nothing was installed."

  # Copy next to the old app first, so a failed copy leaves the old one untouched.
  new="$dir/.Swan.app.new-$$"
  old="$dir/.Swan.app.old-$$"
  ditto "$mnt/Swan.app" "$new" || fail "couldn't copy Swan into $dir; nothing was changed."
  codesign --verify --strict "$new" 2>/dev/null ||
    fail "the copied app is damaged; nothing was changed. Try again."
  if [ -e "$dest" ]; then mv "$dest" "$old"; fi
  if ! mv "$new" "$dest"; then
    if [ -e "$old" ]; then mv "$old" "$dest"; fi
    fail "couldn't put Swan in $dir; the old version is still there."
  fi
  new=""
  if [ -e "$old" ]; then rm -rf "$old" 2>/dev/null || say "Couldn't remove the old copy at $old; delete it yourself."; fi

  if [ -n "$current" ]; then say "Updated Swan from $current to $version in $dir."
  else say "Installed Swan $version in $dir."; fi
  command -v podman >/dev/null ||
    say "Swan needs Podman: brew install podman (or Podman Desktop from podman-desktop.io)."
  say "Open Swan from $dir, or run: open \"$dest\""
}

main "$@"
