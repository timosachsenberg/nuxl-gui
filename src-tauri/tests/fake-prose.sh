#!/bin/bash
# A stand-in for the ProSE tool in the shim's tests. It reads the same arguments, prints progress
# lines in ProSE's format and writes a few outputs. What it does is chosen by the stem of the first
# input (after the shim's "<n>__"), so that tests running side by side need no shared state:
#
#   hang      prints the first step, starts two child processes and waits for a signal
#   stubborn  as hang, but ignores SIGTERM (children too): only SIGKILL ends it
#   crash     prints two steps, writes a message to stderr and exits with code 3
#   segv      prints a step and a line to stderr, then ends with SIGSEGV
#   diskfull  writes ProSE's lines of a full disk (outputs in the search folder) and exits with code 12
#   <other>   searches every input and exits 0
#
# Next to the -out_qpx folder it leaves argv.txt (one argument per line), inputs.txt (every -in path with
# the file it resolves to), prose.pid and, for hang and stubborn, children.pid; in it, a psm file per input
# (in runs/) and quantms.psm.parquet (stand-ins: not Parquet).
set -u

inputs=()
qpx=""
args=("$@")
n=${#args[@]}
i=0
while [ "$i" -lt "$n" ]; do
  case "${args[$i]}" in
    -in)
      i=$((i + 1))
      while [ "$i" -lt "$n" ] && [[ "${args[$i]}" != -* ]]; do
        inputs+=("${args[$i]}")
        i=$((i + 1))
      done
      continue
      ;;
    -out_qpx) qpx="${args[$((i + 1))]}" ;;
  esac
  i=$((i + 1))
done

[ -n "$qpx" ] || { echo "fake-prose: no -out_qpx" >&2; exit 2; }
out=$(dirname "$qpx")
mkdir -p "$out"
printf '%s\n' "$@" > "$out/argv.txt"
echo $$ > "$out/prose.pid"
: > "$out/inputs.txt"
for f in "${inputs[@]}"; do
  [ -e "$f" ] || { echo "Error: the input $f does not exist" >&2; exit 6; }
  printf '%s -> %s\n' "$f" "$(readlink -f "$f")" >> "$out/inputs.txt"
done

first=$(basename "${inputs[0]}")
first=${first#*__}
stem=${first%%.*}
count=${#inputs[@]}

case "$stem" in
  hang | stubborn)
    [ "$stem" = stubborn ] && trap '' TERM
    echo "[ProSE] [1/$count] Searching ${inputs[0]}"
    sleep 300 &
    echo $! > "$out/children.pid"
    sleep 300 &
    echo $! >> "$out/children.pid"
    wait
    exit 0
    ;;
  crash)
    echo "[ProSE] [1/$count] Searching ${inputs[0]}"
    echo "[ProSE] Rescoring the PSMs with Percolator..."
    echo "Schema error: Trying to register schema with name Abs" >&2
    echo "Error: Unable to read file (the input broke ${inputs[0]})" >&2
    exit 3
    ;;
  diskfull)
    echo "[ProSE] [1/$count] Searching ${inputs[0]}"
    run=$(basename "${inputs[0]}")
    run=${run%.mzML}
    echo "ArrowIOHelpers: Failed to write $qpx/runs/$run.psm.parquet: IOError: Error writing bytes to file. Detail: [errno 28] No space left on device" >&2
    echo "Failed to write the QPX psm view -> $qpx/runs/$run.psm.parquet" >&2
    echo "ProSE finished with 1 file(s) failing out of 1." >&2
    exit 12
    ;;
  segv)
    echo "[ProSE] [1/$count] Searching ${inputs[0]}"
    echo "Reading ${inputs[0]} ..." >&2
    trap - SEGV
    kill -SEGV $$
    ;;
esac

mkdir -p "$qpx/runs"
k=0
for f in "${inputs[@]}"; do
  k=$((k + 1))
  echo "[ProSE] [$k/$count] Searching $f"
  echo "[ProSE] Rescoring the PSMs with Percolator..."
  name=$(basename "$f")
  name=${name%.gz}
  name=${name%.mzML}
  echo psm > "$qpx/runs/$name.psm.parquet"
done
echo psm > "$qpx/quantms.psm.parquet"
echo "[ProSE] ===================== Search Report ====================="
exit 0
