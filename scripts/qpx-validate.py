# Validates ProSE's QPX output folders with bigbio/qpx's own validator, as its `qpxc validate` does
# (load_schema(view).validate_full(table, strict=True)): every <prefix>.<view>.parquet of a view qpx knows (psm, pg,
# mz, run, sample, provenance), in the folder and in its runs/ subfolder (the per-input files). Prints each file's errors and warnings; exits 1 if any file has an error.
#
#   python -I scripts/qpx-validate.py <qpx folder>...
#
# Needs qpx (pip install "qpx @ git+https://github.com/bigbio/qpx@<commit>", as .github/workflows/desktop.yml) and
# pyarrow. (The `qpxc validate` CLI itself crashes with DuckDB 2.0: bigbio/qpx#356.)
import sys
from pathlib import Path

import pyarrow.parquet as pq
from qpx.core.data.loader import load_schema

VIEWS = ['psm', 'pg', 'mz', 'run', 'sample', 'provenance']

failed = False
checked = 0
for folder in sys.argv[1:]:
    for path in sorted([*Path(folder).glob('*.parquet'), *Path(folder).glob('runs/*.parquet')]):
        view = path.name.split('.')[-2]
        if view not in VIEWS:
            continue
        result = load_schema(view).validate_full(pq.read_table(path), strict=True)
        errors = [i for i in result.issues if i.severity == 'error']
        warnings = [i for i in result.issues if i.severity != 'error']
        print(f"{'FAIL' if errors else 'ok  '} {path} ({len(errors)} errors, {len(warnings)} warnings)")
        for issue in errors + warnings:
            print(f'     {issue.severity}: {issue.message}')
        failed = failed or bool(errors)
        checked += 1
if checked == 0:
    print('no QPX file found')
    failed = True
sys.exit(1 if failed else 0)
