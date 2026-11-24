#!/bin/bash
# Installs or updates Swan's server on Linux (x86_64 or arm64, glibc), to run headless, for
# example in a cloud workspace that the Swan app on your Mac reaches over SSH:
#   curl -fsSL https://raw.githubusercontent.com/Anefu/swan/main/install-server.sh | bash
# A specific version (also to reinstall or go back): ... | bash -s -- 0.3.3
#
# No root needed. The release's swan-server-<version>-linux-<arch>.tar.gz is checked against its
# SHA256SUMS.txt and unpacked into ~/.local/share/swan-server/<version>; "current" points at it
# and ~/.local/bin/swan-server at its launcher. SWAN_SERVER_DIR and SWAN_BIN_DIR install
# somewhere else. The previous version is kept for going back; older ones are removed.
#
# Everything runs from main at the end, so a half-downloaded script does nothing. ASCII only.
set -euo pipefail

REPO="Anefu/swan"
tmp="" new=""

say() { printf '%s\n' "$*"; }
fail() { printf 'Swan server install: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$new" ] && [ -e "$new" ]; then rm -rf "$new"; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}

server_arch() {
  [ "$(uname -s)" = Linux ] || fail "this installs Swan's server for Linux. On a Mac, use install.sh."
  case "$(uname -m)" in
    x86_64 | amd64) say x64 ;;
    aarch64 | arm64) say arm64 ;;
    *) fail "Swan's server runs on x86_64 and arm64; this machine is $(uname -m)." ;;
  esac
}

check_tools() {
  local t
  for t in curl tar gzip; do
    command -v "$t" >/dev/null || fail "$t is required; install it and run this again."
  done
  command -v sha256sum >/dev/null || command -v shasum >/dev/null ||
    fail "sha256sum is required (coreutils); install it and run this again."
  if ldd --version 2>&1 | grep -qi musl; then
    fail "Swan's server needs glibc (Debian, Ubuntu, Fedora...); this system uses musl (Alpine?)."
  fi
}

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{ print $1 }'
  else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}

# The releases feed lists pre-releases too, newest first, and isn't rate-limited like the API.
latest_version() {
  local feed re='releases/tag/v([0-9]+\.[0-9]+\.[0-9]+)"'
  feed=$(curl -fsSL --retry 3 "https://github.com/$REPO/releases.atom") ||
    fail "couldn't reach github.com. Check your connection, or set https_proxy if you use a proxy."
  [[ $feed =~ $re ]] || fail "couldn't find a release of Swan on github.com/$REPO."
  say "${BASH_REMATCH[1]}"
}

# Downloads the release's tarball to $2 and checks it against the release's checksums.
download() {
  local version=$1 out=$2 base="https://github.com/$REPO/releases/download/v$1" name
  name=$(basename "$out")
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" ||
    fail "couldn't download the checksums for Swan $version. Is $version a release?"
  local expected actual
  expected=$(awk -v f="$name" '$2 == f { print $1 }' "$tmp/SHA256SUMS.txt")
  [ -n "$expected" ] || fail "Swan $version has no Linux server for this machine ($name); install a later version."
  say "Downloading Swan's server $version..."
  curl -fL --retry 3 --progress-bar -o "$out" "$base/$name" ||
    fail "couldn't download $base/$name. Check your connection, or set https_proxy if you use a proxy."
  actual=$(sha256 "$out")
  [ "$actual" = "$expected" ] ||
    fail "the download doesn't match the release's checksum; nothing was installed. Try again."
}

# Keeps the new and the previous version; removes older ones.
prune() {
  local root=$1 keep1=$2 keep2=$3 d v
  for d in "$root"/*; do
    if [ -L "$d" ] || [ ! -d "$d" ]; then continue; fi
    v=$(basename "$d")
    [[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    if [ "$v" != "$keep1" ] && [ "$v" != "$keep2" ]; then rm -rf "$d"; fi
  done
}

main() {
  local arch version=${1:-} root bindir current name
  arch=$(server_arch)
  check_tools
  version=${version#v}
  if [ -n "$version" ]; then
    [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "\"$1\" isn't a version; use one like 0.3.3."
  else
    version=$(latest_version)
  fi

  root=${SWAN_SERVER_DIR:-$HOME/.local/share/swan-server}
  bindir=${SWAN_BIN_DIR:-$HOME/.local/bin}
  mkdir -p "$root" "$bindir" || fail "couldn't create $root and $bindir."
  current=""
  if [ -L "$root/current" ]; then current=$(basename "$(readlink "$root/current")"); fi

  if [ "$current" = "$version" ] && [ -x "$root/$version/bin/swan-server" ]; then
    say "Swan's server $version is already installed in $root."
  else
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/swan-server-install.XXXXXX")
    trap cleanup EXIT
    trap 'exit 130' INT TERM
    name="swan-server-$version-linux-$arch"
    download "$version" "$tmp/$name.tar.gz"

    # Unpack next to the installed versions first, so a failed unpack changes nothing.
    new="$root/.$version.new-$$"
    mkdir "$new"
    tar -xzf "$tmp/$name.tar.gz" -C "$new" --strip-components=1 --no-same-owner ||
      fail "couldn't unpack the download; nothing was changed."
    if [ ! -x "$new/bin/swan-server" ] || [ ! -x "$new/node" ]; then
      fail "the download has no bin/swan-server; nothing was changed."
    fi
    "$new/node" --version >/dev/null 2>&1 ||
      fail "the bundled Node doesn't run here (it needs glibc 2.28 or later); nothing was changed."
    rm -rf "${root:?}/$version"
    mv "$new" "$root/$version"
    new=""
  fi

  # Switch "current" in one rename, so a running server never sees a half-switched link.
  ln -sfn "$version" "$root/.current-$$"
  mv -T "$root/.current-$$" "$root/current"
  ln -sfn "$root/current/bin/swan-server" "$bindir/swan-server"

  if [ -n "$current" ] && [ "$current" != "$version" ]; then
    prune "$root" "$version" "$current"
    say "Updated Swan's server from $current to $version in $root."
    say "A server that is running keeps the old version until you restart it."
  else
    say "Installed Swan's server $version in $root."
  fi
  case ":$PATH:" in
    *":$bindir:"*) ;;
    *) say "Add $bindir to your PATH (for example in ~/.profile): export PATH=\"$bindir:\$PATH\"" ;;
  esac
  cat <<EOF

Start it:
  swan-server                              # in the foreground; Ctrl-C stops it
  tmux new-session -d -s swan swan-server  # or in the background, in tmux

It keeps its data in ~/.swan (set PH_HOME for another folder) and listens on 127.0.0.1 only
(port 4317, set in ~/.swan/config.yaml).

Connect from the Swan app on your Mac: add this machine by the SSH host you use for it (as in
"ssh <host>"). The app reads ~/.swan/api-token over SSH and reaches the server through an SSH
tunnel; nothing is exposed on the network.
EOF
}

main "$@"
