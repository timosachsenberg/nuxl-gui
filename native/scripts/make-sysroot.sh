#!/bin/bash
# Build a user-space sysroot with what Tauri 2 needs on Linux (WebKitGTK 4.1, GTK 3 and
# AppIndicator development files, WebKitWebDriver, patchelf) without root.
#
#   make-sysroot.sh [sysroot-dir] [deb-cache-dir]
#
# Defaults: /scratch/sachsenb/tools/tauri-sysroot and /scratch/sachsenb/tools/tauri-sysroot-debs.
# The host (Ubuntu 24.04) supplies every package it already has; the sysroot holds only the
# missing ones (and the few that apt must upgrade to satisfy their versioned dependencies),
# unpacked with `dpkg -x`. Re-running is safe: debs already in the cache are not fetched again
# and every package is unpacked again from its pristine .deb before the fix-ups run. Remove the
# sysroot directory first for a clean slate. native/scripts/in-env.sh makes it usable.
# SYSROOT_PACKAGES overrides the top-level package list (a space-separated string).
set -euo pipefail

SYSROOT=$(realpath -m "${1:-/scratch/sachsenb/tools/tauri-sysroot}")
CACHE=$(realpath -m "${2:-/scratch/sachsenb/tools/tauri-sysroot-debs}")
TOP=${SYSROOT_PACKAGES:-"libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev webkit2gtk-driver xvfb xauth patchelf file"}

# Host tools only (not linuxbrew's), in particular the host's dpkg and apt.
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'linuxbrew' | paste -sd: -)
export PATH

mkdir -p "$SYSROOT" "$CACHE"

host_has() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)" = "install ok installed" ]; }

# 1. Resolve. `apt-cache depends --recurse ...` was tried, but it expands every
# alternative of every OR dependency (all aspell dictionaries, i386 packages, 530 packages in
# all). Simulating the install on top of the host's dpkg state gives the exact missing set,
# already skipping what the host has.
need=()
for p in $TOP; do host_has "$p" || need+=("$p"); done
echo "top-level packages missing on the host: ${need[*]:-none}"
# The output is captured first and parsed afterwards: a failure of apt-get inside a process
# substitution would not stop the script, and a failed resolve would read as "nothing to do".
if ! sim=$(apt-get -s -o Debug::NoLocking=1 install --no-install-recommends "${need[@]}"); then
  echo "error: apt-get could not resolve: ${need[*]} (unknown package, unresolvable dependency or stale package lists)" >&2
  exit 1
fi
mapfile -t resolved < <(awk '/^Inst /{print $2}' <<<"$sim")
# The C library and the compiler runtime are never unpacked into the sysroot: its directories lead
# LD_LIBRARY_PATH, and a libc.so.6 there would replace the host's for every host binary (bash,
# node, cargo, ...), which are linked against the host's libc. Should apt ask for an upgrade of
# one of them, the host's copy is used and a sysroot library that needs a newer one fails at
# run time with a clear symbol-version error.
pkgs=()
for p in "${resolved[@]}"; do
  case "$p" in
    libc6|libgcc-s1|libstdc++6) echo "warning: not unpacking $p into the sysroot (the host's copy is used)" >&2 ;;
    *) pkgs+=("$p") ;;
  esac
done
echo "${#pkgs[@]} packages go into the sysroot"
[ "${#pkgs[@]}" -gt 0 ] || { echo "nothing to do"; exit 0; }

# 2. Fetch. apt-get download needs no root, writes to the cwd and skips files that it already
# finds there. --print-uris leaves out those cached files too, so it runs in an empty directory
# to get the full list of .deb names for the unpack step.
empty=$(mktemp -d)
if ! uris=$(cd "$empty" && apt-get download --print-uris "${pkgs[@]}"); then
  rmdir "$empty"
  echo "error: apt-get could not list the downloads for ${#pkgs[@]} packages" >&2
  exit 1
fi
rmdir "$empty"
mapfile -t debs < <(sed -E "s/^'[^']*' //" <<<"$uris" | awk '{print $1}')
[ "${#debs[@]}" -eq "${#pkgs[@]}" ] || { echo "error: ${#pkgs[@]} packages but ${#debs[@]} .deb names" >&2; exit 1; }
(cd "$CACHE" && apt-get download "${pkgs[@]}")

# 3. Unpack. Make everything writable first so that a re-run can overwrite read-only files.
chmod -R u+rwX "$SYSROOT"
for deb in "${debs[@]}"; do
  dpkg -x "$CACHE/$deb" "$SYSROOT"
done

# 4. Symlinks. Debian -dev packages link `libfoo.so -> libfoo.so.N` where the real library
# often comes from a package the host already has, and some links are absolute.
#   - a target present in the sysroot becomes a relative link inside the sysroot;
#   - a target missing there but present on the host becomes an absolute link to the host path.
find "$SYSROOT" -type l -printf '%p\t%l\n' | while IFS=$'\t' read -r link target; do
  dir=$(dirname "${link#"$SYSROOT"}")
  case "$target" in
    /*) virt=$target ;;
    *) virt=$(realpath -m -s "$dir/$target") ;;
  esac
  if [ -e "$SYSROOT$virt" ] || [ -L "$SYSROOT$virt" ]; then
    want=$(realpath -m -s --relative-to="$(dirname "$link")" "$SYSROOT$virt")
  elif [ -e "$virt" ]; then
    want=$virt
  else
    continue
  fi
  [ "$want" = "$target" ] || ln -sfn "$want" "$link"
done

# 5. WebKit's helper processes. libwebkit2gtk starts WebKitWebProcess and WebKitNetworkProcess from
# the compiled-in directory /usr/lib/x86_64-linux-gnu/webkit2gtk-4.1 and, in the Ubuntu build,
# honours no environment variable that redirects it (WEBKIT_EXEC_PATH exists only in developer
# builds). So the sysroot copy of the library (and of WebKitWebDriver, which embeds the same
# path) is patched in place: the 40-byte directory string is replaced, same length, by a short
# symlink to the sysroot's directory, padded with extra slashes (a/b///// is the path a/b).
WK_REAL="$SYSROOT/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"
WK_LINK="$(dirname "$SYSROOT")/webkit2gtk-4.1"
if [ "${#WK_LINK}" -gt 40 ]; then
  echo "error: $WK_LINK is longer than the 40 bytes of the path it replaces; use a shorter sysroot location" >&2
  exit 1
fi
ln -sfn "$WK_REAL" "$WK_LINK"
# WebKitWebDriver is in the sysroot only when the host lacks webkit2gtk-driver (a host that has it
# runs the host's copy, which finds its helpers in the real directory).
patch_targets=()
for f in "$SYSROOT/usr/lib/x86_64-linux-gnu"/libwebkit2gtk-4.1.so.0.* "$SYSROOT/usr/bin/WebKitWebDriver"; do
  [ -f "$f" ] && patch_targets+=("$f")
done
[ "${#patch_targets[@]}" -gt 0 ] || { echo "error: neither libwebkit2gtk-4.1 nor WebKitWebDriver in the sysroot" >&2; exit 1; }
python3 -I - "$WK_LINK" "${patch_targets[@]}" <<'PY'
import sys
old = b"/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"
new = sys.argv[1].encode().ljust(len(old), b"/")
for path in sys.argv[2:]:
    with open(path, "rb") as f:
        data = f.read()
    n = data.count(old)
    if n == 0:
        sys.exit("error: compiled-in WebKit path not found in " + path)
    with open(path, "wb") as f:
        f.write(data.replace(old, new))
    print("patched %d occurrence(s) of the WebKit helper path in %s" % (n, path))
PY

# 6. pkg-config files: point prefix/libdir/includedir and -I/-L flags that name /usr at the
# sysroot. (PKG_CONFIG_SYSROOT_DIR would also prefix the host's own .pc files, whose files are
# not in the sysroot.)
find "$SYSROOT" -name '*.pc' -type f -print0 | xargs -0 -r sed -i -E \
  "s#^([A-Za-z_][A-Za-z0-9_]*=)/usr#\\1$SYSROOT/usr#; s#(-[IL])/usr([/ ]|\$)#\\1$SYSROOT/usr\\2#g"

# 7. Module caches of the sysroot's own GLib/GIO/GdkPixbuf modules and schemas.
LIBDIR="$SYSROOT/usr/lib/x86_64-linux-gnu"
export LD_LIBRARY_PATH="$LIBDIR:$SYSROOT/lib/x86_64-linux-gnu"
SCHEMAS="$SYSROOT/usr/share/glib-2.0/schemas"
if [ -d "$SCHEMAS" ]; then
  glib-compile-schemas "$SCHEMAS"
fi
if [ -d "$LIBDIR/gio/modules" ]; then
  gio-querymodules "$LIBDIR/gio/modules"
fi
PIXBUF_DIR="$LIBDIR/gdk-pixbuf-2.0/2.10.0"
if [ -d "$PIXBUF_DIR/loaders" ]; then
  QUERY=$LIBDIR/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders
  [ -x "$QUERY" ] || QUERY=/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/gdk-pixbuf-query-loaders
  GDK_PIXBUF_MODULEDIR="$PIXBUF_DIR/loaders" "$QUERY" > "$PIXBUF_DIR/loaders.cache"
fi

echo "sysroot ready: $SYSROOT ($(du -sh "$SYSROOT" | cut -f1), ${#debs[@]} packages)"
