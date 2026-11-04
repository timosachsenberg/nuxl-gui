#!/bin/bash
# Downloads the vendor test data of the real-data tests (src-tauri/tests/real_nuxl.rs, start-test.sh): a Thermo
# .raw file and a Bruker timsTOF .d folder, checked against pinned SHA-256s.
#
#   fetch-test-data.sh <dir>
#
#   <dir>/Angiotensin_AllScans.raw          PNNL's Thermo test file (BSD-2-Clause, (c) 2018 Battelle Memorial
#                                           Institute; PNNL-Comp-Mass-Spec/Thermo-Raw-File-Reader, commit 1d8ff309),
#                                           as OpenMS's Thermo RAW tests use it
#   <dir>/DDA_HeLa_50ng_5_6min.d/           a minute of DDA-PASEF (the timsrust_cpp_bridge test data, as OpenMS's
#                                           OpenTIMS tests use it), unpacked from its .zip
#
# Files already in <dir> with the right hash are kept (CI restores <dir> from its cache). The sources: OpenMS's
# file server, archive.openms.de (plain HTTP and HTTPS are tried: the server has answered on HTTP only; the hash
# makes either safe), and for the .raw also the file in PNNL's repository at that commit (looked up through the
# GitHub API; GH_TOKEN, when set, avoids its anonymous rate limit).
#
# A file that cannot be had is not an error: the tests that need it are skipped. It is said loudly instead (a
# ::warning:: for GitHub Actions and a line in $GITHUB_STEP_SUMMARY when they are set), and the script exits 0.
# For each file it has, it prints NUXL_RAW_EXAMPLE=<path> / NUXL_D_EXAMPLE=<path> and appends the line to
# $GITHUB_ENV when that is set (Windows: native paths), so the later steps run those tests; and it sets
# complete=true in $GITHUB_OUTPUT when it has both (CI saves <dir> to its cache only then).
# Needs curl and python3 (Windows: python).
set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <dir>" >&2
  exit 2
fi
mkdir -p "$1" || exit 1
DIR=$(cd "$1" && pwd -P)
PY=python3
"$PY" -c '' 2>/dev/null || PY=python
native() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }
pymath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }

RAW=Angiotensin_AllScans.raw
RAW_SHA256=3a0236f719e7c91e3c958f57f4e66ae422803ec3e6a997b9af4d2af395332b9f
RAW_REPO=PNNL-Comp-Mass-Spec/Thermo-Raw-File-Reader
RAW_COMMIT=1d8ff309
D=DDA_HeLa_50ng_5_6min.d
D_ZIP=$D.zip
D_SHA256=659d691e48d621edcd1fecb8448de5731147c009bda42ba6e7e5ed53e46dc15c
SERVER=archive.openms.de/openms/testfiles

loud() {
  echo "::warning::$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf -- '- **warning**: %s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}
sha256() { "$PY" -I -c 'import hashlib, sys
h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for block in iter(lambda: f.read(1 << 20), b""):
        h.update(block)
print(h.hexdigest())' "$(pymath "$1")"; }
# <url> <file> <sha256>: downloads to <file>.part and moves it into place when the hash is right
fetch() {
  local url=$1 file=$2 want=$3 got
  echo "downloading $url"
  if ! curl --fail --location --silent --show-error --retry 4 --retry-delay 5 --connect-timeout 30 --max-time 1800 \
    --output "$file.part" "$url"; then
    rm -f "$file.part"
    return 1
  fi
  got=$(sha256 "$file.part")
  if [ "$got" != "$want" ]; then
    echo "  $url: SHA-256 $got, not $want" >&2
    rm -f "$file.part"
    return 1
  fi
  mv "$file.part" "$file"
}
have() { [ -f "$1" ] && [ "$(sha256 "$1")" = "$2" ]; }
export_path() { # <variable> <path>
  local line
  line="$1=$(native "$2")"
  echo "$line"
  if [ -n "${GITHUB_ENV:-}" ]; then echo "$line" >> "$GITHUB_ENV"; fi
}
# the file's path in PNNL's repository at RAW_COMMIT, through the GitHub API (the name is all that is pinned there)
pnnl_url() {
  local auth=()
  if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi
  local commit
  commit=$(curl --fail --location --silent --show-error --retry 3 --connect-timeout 30 --max-time 120 ${auth[@]+"${auth[@]}"} \
    "https://api.github.com/repos/$RAW_REPO/commits/$RAW_COMMIT" \
    | "$PY" -I -c 'import json, sys; print(json.load(sys.stdin)["sha"])' 2>/dev/null) && [ -n "$commit" ] || return 1
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 30 --max-time 120 ${auth[@]+"${auth[@]}"} \
    "https://api.github.com/repos/$RAW_REPO/git/trees/$commit?recursive=1" \
    | "$PY" -I -c 'import json, sys
name, repo, commit = sys.argv[1:]
paths = [e["path"] for e in json.load(sys.stdin)["tree"] if e["type"] == "blob" and e["path"].rsplit("/", 1)[-1] == name]
if not paths:
    sys.exit(1)
print(f"https://raw.githubusercontent.com/{repo}/{commit}/{paths[0]}")' "$RAW" "$RAW_REPO" "$commit"
}

complete=true

# --- Thermo .raw ---------------------------------------------------------------------------------------
if have "$DIR/$RAW" "$RAW_SHA256"; then
  echo "$RAW: already there"
elif fetch "http://$SERVER/$RAW" "$DIR/$RAW" "$RAW_SHA256" || fetch "https://$SERVER/$RAW" "$DIR/$RAW" "$RAW_SHA256"; then
  :
elif url=$(pnnl_url) && fetch "$url" "$DIR/$RAW" "$RAW_SHA256"; then
  :
fi
if have "$DIR/$RAW" "$RAW_SHA256"; then
  export_path NUXL_RAW_EXAMPLE "$DIR/$RAW"
else
  complete=false
  loud "The Thermo test file $RAW could not be downloaded (archive.openms.de, $RAW_REPO): the real-data .raw tests are SKIPPED, the bundled .NET runtime and Thermo bridge are not exercised in this run."
fi

# --- Bruker .d -----------------------------------------------------------------------------------------
if [ -f "$DIR/$D/analysis.tdf" ] && [ -f "$DIR/$D/analysis.tdf_bin" ]; then
  echo "$D: already there"
else
  rm -rf "${DIR:?}/$D" "${DIR:?}/$D.unpacking"
  if have "$DIR/$D_ZIP" "$D_SHA256" \
    || fetch "http://$SERVER/$D_ZIP" "$DIR/$D_ZIP" "$D_SHA256" || fetch "https://$SERVER/$D_ZIP" "$DIR/$D_ZIP" "$D_SHA256"; then
    # unpacked into a folder of its own first, whatever the zip's top level is (the .d itself or its contents)
    if "$PY" -I - "$(pymath "$DIR/$D_ZIP")" "$(pymath "$DIR/$D.unpacking")" "$D" <<'PY'
import pathlib, shutil, sys, zipfile
archive, dest, name = sys.argv[1:]
dest = pathlib.Path(dest)
with zipfile.ZipFile(archive) as z:
    for member in z.namelist():
        if member.startswith(("/", "\\")) or ".." in member.replace("\\", "/").split("/"):
            sys.exit(f"{archive}: unsafe member {member}")
    z.extractall(dest)
found = [p.parent for p in dest.rglob("analysis.tdf")]
if len(found) != 1 or not (found[0] / "analysis.tdf_bin").is_file():
    sys.exit(f"{archive}: expected one folder with analysis.tdf and analysis.tdf_bin, found {found}")
shutil.move(str(found[0]), str(dest.parent / name))
shutil.rmtree(dest, ignore_errors=True)
PY
    then
      rm -f "$DIR/$D_ZIP"
    else
      rm -rf "${DIR:?}/$D" "${DIR:?}/$D.unpacking"
    fi
  fi
fi
if [ -f "$DIR/$D/analysis.tdf" ] && [ -f "$DIR/$D/analysis.tdf_bin" ]; then
  export_path NUXL_D_EXAMPLE "$DIR/$D"
else
  complete=false
  loud "The Bruker test data $D_ZIP could not be downloaded or unpacked (archive.openms.de): the real-data .d tests are SKIPPED in this run."
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "complete=$complete" >> "$GITHUB_OUTPUT"; fi
exit 0
