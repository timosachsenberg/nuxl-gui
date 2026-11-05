#!/bin/bash
# A stand-in for OpenNuXL in the shim's tests. It reads the same arguments (-in, -out, -out_tsv,
# -report:xlFDR, -percolator_backend), prints progress lines in the format of OpenMS' ProgressLogger (the
# percentages after \r, without a line end) and OpenNuXL's log lines, and writes the outputs OpenNuXL writes:
# <out>, <out_tsv>, and from <base> = <out> without .idXML, then "_": <base>0.0000_peptides.idXML,
# <base><q>_XLs.idXML for each -report:xlFDR threshold and <base>proteins<q>_XLs.tsv for those up to 0.1; after
# Percolator (-percolator_backend builtin) the same with _perc_, <out without .idXML>_perc.idXML and
# <out_tsv without .tsv>_perc.tsv. What it does is chosen by the stem of the input (after the shim's "<n>__"),
# so that tests running side by side need no shared state:
#
#   hang      prints the first step, starts two child processes and waits for a signal
#   stubborn  as hang, but ignores SIGTERM (children too): only SIGKILL ends it
#   crash     prints two steps, writes OpenMS' error of a file it cannot read to stderr, exits with code 3
#   segv      prints a step and a line to stderr, then ends with SIGSEGV
#   diskfull  writes OpenMS' error of an output it cannot write (in nuxl/ of the search folder), exit code 12
#   fewpsms   as a search, but "Too few PSMs for score recalibration. Skipped." (stderr, also with
#             -percolator_backend none, as OpenNuXL prints it), no _perc_ files
#   qpxfail   as a search, but with -out_qpx its warning that the spectra cannot be read again (stderr, as OpenNuXL's
#             "-out_qpx: ..." warning), and no mz view (also for any input with FAKE_NUXL_QPX_FAIL=1)
#   <other>   searches the input and exits 0
#
# With -out_qpx <dir> a search ends as OpenNuXL's: "-out_qpx: reading spectra", the reader's progress label,
# "-out_qpx: writing <dir>/runs/<basename of -in>.mz.parquet", the file, "-out_qpx: wrote <file> (...)". The file is a
# placeholder (PAR1 ... PAR1), or with FAKE_NUXL_RESULTS that folder's mz view of the input (<n>__<name>.mz.parquet,
# else the first of the folder): a real QPX mz view, so that the PSM view has peaks.
#
# An input may be an mzML, a Thermo .raw (a file) or a Bruker .d (a folder): its spectra are read as OpenNuXL reads
# them, with the reader's progress label ('loading mzML', 'Loading Thermo RAW file', 'Loading DDA-PASEF data').
# Beside -in it writes OpenNuXL's debug table <in>.ambiguous_masses.csv (every run that gets to the nucleotide
# tags). In the search folder (the parent of <out>'s folder) it appends a line to inputs.txt (the -in path and the file
# it resolves to) and leaves tool.pid (its pid) and, for hang and stubborn, children.pid; beside <out> it leaves
# <stem>.argv.txt (one argument per line) and <stem>.env.txt (its DOTNET_* and OPENMS_* variables, sorted).
# `--help` prints OpenMS' version line (to stderr, as TOPPBase does).
#
# Started as FileConverter (a link or copy of this script of that name, beside the fake OpenNuXL: the shim runs the
# FileConverter beside its tool; e2e/fake/FileConverter) it is a stand-in for OpenMS' FileConverter, as the shim runs it
# after the search of a .raw or .d input: it reads -in and -out, leaves <stem>.FileConverter.argv.txt and
# <stem>.FileConverter.env.txt beside -out (<stem>: the name of -out without .spectra.tmp.mzML) and converter.pid in the
# search folder, prints the reader's progress label, and writes a small indexed mzML to -out: a copy of OpenMS'
# OpenNuXL test run (src/lib/results/fixtures/spectra/OpenNuXL_1_input.indexed.mzML of this repository), so that the
# PSM view has peaks. By the input's stem (after "<n>__", up to the first "."):
#
#   convfail  writes OpenMS' error of a file it cannot read to stderr and exits with code 6 (also for any input
#             with FAKE_FILECONVERTER_FAIL=1)
#   convhang  waits for a signal (its child's pid in converter-children.pid of the search folder)
#   convnone  exits 0 without writing -out
#
# With FAKE_NUXL_RESULTS set to a folder of OpenNuXL outputs (the e2e specs' fake: e2e/fake/OpenNuXL, with
# src/lib/results/fixtures/example/nuxl) a search writes real ones: <dir>/<n>__<name>_1.0000_XLs.idXML and
# <dir>/<n>__<name>_0.0000_peptides.idXML of the input's name (without .mzML, .raw or .d; else the first such pair of the
# folder) become every XLs file, the peptides file and <out>; Percolator is skipped as OpenNuXL skips it for a run
# of fewer than 1000 PSMs ("Too few PSMs ..."). A file fake-nuxl.delay in the app's data folder (two folders above
# the search folder) holds the seconds that each step of the scoring takes (a search that runs long enough to be
# seen, cancelled or closed). FAKE_NUXL_RESULTS can also name a case of the results reader's fixtures in place of a
# folder (a name without "/": example, screens, ...): src/lib/results/fixtures/<name>/nuxl of this repository (the
# screenshots of e2e/screens.shot.ts take `screens`, OpenNuXL's test 3 with realistic precursor errors).
set -u

progress() { printf "Progress of '%s':\n" "$1"; }
done_line() { printf '\r-- done [took 0.01 s (CPU), 0.01 s (Wall)] -- \n'; }

# the label of the progress of reading the spectra of the input $1, as OpenMS' reader of its kind prints it
loading_label() {
  # (the extensions in either case; no ${1,,}: macOS has bash 3.2)
  case "$1" in
    *.[rR][aA][wW]) echo "Loading Thermo RAW file" ;;
    *.[dD]) echo "Loading DDA-PASEF data" ;;
    *) echo "loading mzML" ;;
  esac
}

# the variables of .NET and OpenMS of this process, sorted
tool_env() { env | grep -E '^(DOTNET_|OPENMS_)' | LC_ALL=C sort; }

file_converter() {
  local input="" out="" k=0 count=$#
  local args=("$@")
  while [ "$k" -lt "$count" ]; do
    case "${args[$k]}" in
      -in) input="${args[$((k + 1))]}" ;;
      -out) out="${args[$((k + 1))]}" ;;
    esac
    k=$((k + 1))
  done
  [ -n "$out" ] || { echo "Error: The required parameter '-out' was not given or is empty!" >&2; exit 2; }
  local dir stem name mode here spectra
  dir=$(dirname "$out")
  stem=$(basename "$out")
  stem=${stem%.mzML}
  stem=${stem%.spectra.tmp}
  printf '%s\n' "$@" > "$dir/$stem.FileConverter.argv.txt"
  tool_env > "$dir/$stem.FileConverter.env.txt"
  echo $$ > "$(dirname "$dir")/converter.pid"
  [ -e "$input" ] || { echo "Error: File not found (the file '$input' could not be found)" >&2; exit 6; }
  name=$(basename "$input")
  name=${name#*__}
  mode=${name%%.*}
  progress "$(loading_label "$input")"
  if [ "${FAKE_FILECONVERTER_FAIL:-}" = 1 ] || [ "$mode" = convfail ]; then
    echo "Error: Unable to read file (the fake FileConverter cannot read $input)" >&2
    exit 6
  fi
  case "$mode" in
    convhang)
      sleep 300 &
      echo $! > "$(dirname "$dir")/converter-children.pid"
      wait
      exit 0
      ;;
    convnone) exit 0 ;;
  esac
  here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
  spectra="$here/../../src/lib/results/fixtures/spectra/OpenNuXL_1_input.indexed.mzML"
  [ -f "$spectra" ] || spectra="$here/../resources/example/OpenNuXL_1_input.mzML"
  cp "$spectra" "$out" || { echo "Error: Unable to write file (the file '$out' could not be created)" >&2; exit 12; }
  done_line
  exit 0
}

if [ "$(basename "$0")" = FileConverter ]; then
  file_converter "$@"
fi

if [ "${1:-}" = --help ]; then
  # 9.9.9; with FAKE_NUXL_RESULTS the version of the OpenNuXL that wrote those outputs (their search_engine_version,
  # "3.5.0-pre-..." is 3.5.0), so that the screenshots name a real one
  version=9.9.9
  if [ -n "${FAKE_NUXL_RESULTS:-}" ]; then
    dir=$FAKE_NUXL_RESULTS
    [[ "$dir" == */* ]] || dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../src/lib/results/fixtures/$dir/nuxl"
    v=$(cat "$dir"/*.idXML 2>/dev/null | grep -o -m1 'search_engine_version="[0-9][0-9.]*' | sed 's/.*"//')
    [ -n "$v" ] && version=$v
  fi
  echo "OpenNuXL -- a stand-in for the shim's tests" >&2
  echo "Version: $version Oct 20 2026, 12:00:00" >&2
  exit 0
fi

input=""
out=""
out_tsv=""
out_qpx=""
backend=builtin
xl_fdr=()
args=("$@")
n=${#args[@]}
i=0
while [ "$i" -lt "$n" ]; do
  case "${args[$i]}" in
    -in) input="${args[$((i + 1))]}" ;;
    -out) out="${args[$((i + 1))]}" ;;
    -out_tsv) out_tsv="${args[$((i + 1))]}" ;;
    -out_qpx) out_qpx="${args[$((i + 1))]}" ;;
    -percolator_backend) backend="${args[$((i + 1))]}" ;;
    -report:xlFDR)
      i=$((i + 1))
      while [ "$i" -lt "$n" ] && [[ "${args[$i]}" != -[a-zA-Z]* ]]; do
        xl_fdr+=("${args[$i]}")
        i=$((i + 1))
      done
      continue
      ;;
  esac
  i=$((i + 1))
done

[ -n "$out" ] || { echo "Error: The required parameter '-out' was not given or is empty!" >&2; exit 2; }
outputs=$(dirname "$out")
folder=$(dirname "$outputs")
[ -d "$outputs" ] || { echo "Error: Unable to write file (the folder $outputs does not exist)" >&2; exit 2; }
base=${out%.idXML}
stem=$(basename "$base")
printf '%s\n' "$@" > "$outputs/$stem.argv.txt"
tool_env > "$outputs/$stem.env.txt"
echo $$ > "$folder/tool.pid"
[ -e "$input" ] || { echo "Error: File not found (the file '$input' could not be found)" >&2; exit 6; }
printf '%s -> %s\n' "$input" "$(readlink -f "$input")" >> "$folder/inputs.txt"

name=$(basename "$input")
name=${name#*__}
mode=${name%%.*}
loading=$(loading_label "$input")

# -out_qpx: the QPX mz view of the run's PSMs' spectra, after the other outputs ($1: the folder of real outputs, if any)
write_mz_view() {
  [ -n "$out_qpx" ] || return 0
  echo "-out_qpx: reading spectra"
  progress "$loading"
  done_line
  if [ "${FAKE_NUXL_QPX_FAIL:-}" = 1 ] || [ "$mode" = qpxfail ]; then
    echo "-out_qpx: the spectra of $input cannot be read again (the fake cannot); no mz view is written" >&2
    return 0
  fi
  local in base view source=""
  in=${input%/}
  base=$(basename "$in")
  base=${base%.[mM][zZ][mM][lL]}
  base=${base%.[rR][aA][wW]}
  base=${base%.[dD]}
  view="$out_qpx/runs/$base.mz.parquet"
  mkdir -p "$out_qpx/runs" || { echo "-out_qpx: $out_qpx/runs cannot be made" >&2; return 0; }
  echo "-out_qpx: writing $view"
  if [ -n "${1:-}" ]; then
    source=$(ls "$1"/*__"$2".mz.parquet 2>/dev/null | head -n 1)
    [ -n "$source" ] || source=$(ls "$1"/*.mz.parquet 2>/dev/null | head -n 1)
  fi
  if [ -n "$source" ]; then
    cp "$source" "$view"
  else
    printf 'PAR1 the fake mz view of %s PAR1' "$in" > "$view"
  fi
  echo "-out_qpx: wrote $view (20 spectra, 1500 of 1500 peaks)"
}

case "$mode" in
  hang | stubborn)
    [ "$mode" = stubborn ] && trap '' TERM
    progress "$loading"
    sleep 300 &
    echo $! > "$folder/children.pid"
    sleep 300 &
    echo $! >> "$folder/children.pid"
    wait
    exit 0
    ;;
  crash)
    echo "Running autotune..."
    echo "IDFilter excludes 0 spectra."
    progress "$loading"
    echo "Schema error: Trying to register schema with name Abs" >&2
    echo "Error: Unable to read file (the input broke $input)" >&2
    exit 3
    ;;
  diskfull)
    progress "Scoring peptide models against spectra..."
    done_line
    echo "Error: Unable to write file (the file '${base}_1.0000_XLs.idXML' could not be created. writing the file failed (e.g. disk full or I/O error))" >&2
    exit 12
    ;;
  segv)
    progress "$loading"
    echo "Reading $input ..." >&2
    trap - SEGV
    kill -SEGV $$
    ;;
esac

echo "Running autotune..."
echo "autotune: too few non-cross-linked peptides found. Will keep parameters as-is."
echo "IDFilter excludes 0 spectra."
progress "$loading"
done_line
for step in "Filtering spectra..." "Calculate Nucleotide Tags..." "Calculate intensity ranks..." \
  "Calculate AA Tags..." "Mapping precursors to scan..." "Indexing spectra..." \
  "Load database from FASTA file..." "Generating decoys..."; do
  progress "$step"
  done_line
  # (OpenNuXL's debug table, beside -in: File::path(in) + '/' + File::basename(in) + ".ambiguous_masses.csv")
  if [ "$step" = "Calculate Nucleotide Tags..." ]; then
    printf 'Ambiguous residues (+adduct) masses that exactly match to other masses.\nTotal\tResidue\tAdduct\n' \
      > "$(dirname "$input")/$(basename "$input").ambiguous_masses.csv"
  fi
done
results=${FAKE_NUXL_RESULTS:-}
if [ -n "$results" ] && [[ "$results" != */* ]]; then
  # (a fixture's name: beside this script's real path, tests/ of src-tauri)
  here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
  results="$here/../../src/lib/results/fixtures/$results/nuxl"
  [ -d "$results" ] || { echo "Error: no fixture $FAKE_NUXL_RESULTS ($results)" >&2; exit 2; }
fi
delay=0
[ -n "$results" ] && [ -f "$folder/../../fake-nuxl.delay" ] && delay=$(cat "$folder/../../fake-nuxl.delay")
progress "Scoring peptide models against spectra..."
for pct in 0.00 33.33 66.67 99.99; do
  printf '\r%s %%               ' "$pct"
  [ "$delay" = 0 ] || sleep "$delay"
done
done_line
for step in "Post-processing PSMs... (spectra filtering)" "Post-processing PSMs... (localization of cross-links)" \
  "Post-processing PSMs... (annotation)"; do
  progress "$step"
  done_line
done

if [ -n "$results" ]; then
  key=${name%.[mM][zZ][mM][lL]}
  key=${key%.[rR][aA][wW]}
  key=${key%.[dD]}
  xls=$(ls "$results"/*__"$key"_1.0000_XLs.idXML 2>/dev/null | head -n 1)
  [ -n "$xls" ] || xls=$(ls "$results"/*_1.0000_XLs.idXML | head -n 1)
  peptides=${xls%_1.0000_XLs.idXML}_0.0000_peptides.idXML
  echo "Calculating peptide and XL q-values."
  cp "$xls" "$out"
  cp "$peptides" "${base}_0.0000_peptides.idXML"
  for q in "${xl_fdr[@]}"; do
    q=$(printf '%.4f' "$q")
    cp "$xls" "${base}_${q}_XLs.idXML"
    if awk "BEGIN { exit !($q <= 0.1) }"; then
      printf 'protein\tXLs\n' > "${base}_proteins${q}_XLs.tsv"
    fi
  done
  echo "done."
  # (also with -percolator_backend none, as OpenNuXL)
  echo "Too few PSMs for score recalibration. Skipped." >&2
  [ -n "$out_tsv" ] && printf 'report\n' > "$out_tsv"
  write_mz_view "$results" "$key"
  echo "OpenNuXL took 0.10 s (wall), 0.10 s (CPU), 0.00 s (system), 0.10 s (user); Peak Memory Usage: 10 MB."
  exit 0
fi

idxml() { printf '<?xml version="1.0" encoding="UTF-8"?>\n<IdXML version="1.5"><!-- %s --></IdXML>\n' "$1" > "$2"; }
write_fdr_outputs() { # <prefix>
  idxml peptides "${1}0.0000_peptides.idXML"
  local q
  for q in "${xl_fdr[@]}"; do
    q=$(printf '%.4f' "$q")
    idxml "XLs $q" "${1}${q}_XLs.idXML"
    if awk "BEGIN { exit !($q <= 0.1) }"; then
      printf 'protein\tXLs\n' > "${1}proteins${q}_XLs.tsv"
    fi
  done
}

echo "Calculating peptide and XL q-values."
idxml all "$out"
write_fdr_outputs "${base}_"
echo "done."
# (OpenNuXL warns of too few PSMs also when the rescoring is off)
[ "$mode" = fewpsms ] && echo "Too few PSMs for score recalibration. Skipped." >&2
if [ "$backend" != none ]; then
  if [ "$mode" != fewpsms ]; then
    echo "Running percolator."
    echo "done."
    idxml percolator "${base}_perc.idXML"
    [ -n "$out_tsv" ] && printf 'report\tperc\n' > "${out_tsv%.tsv}_perc.tsv"
    echo "Calculating peptide and XL q-values for percolator results."
    write_fdr_outputs "${base}_perc_"
    echo "done."
  fi
fi
[ -n "$out_tsv" ] && printf 'report\n' > "$out_tsv"
write_mz_view
echo "OpenNuXL took 0.10 s (wall), 0.10 s (CPU), 0.00 s (system), 0.10 s (user); Peak Memory Usage: 10 MB."
exit 0
