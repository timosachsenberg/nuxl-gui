//! The shim against the real ProSE tool, on the app's example.
//!
//! Gated: set `PROSE_BIN` to the tool to run these tests: the bundled pin
//! (`src-tauri/resources/prose/bin/ProSE`, made by `native/scripts/bundle-prose.sh`; with PeptDeep) or the
//! pin in its build tree (for example `/scratch/sachsenb/openms-desktop-next/build/bin/ProSE`; it has no build
//! manifest, so it counts as without ONNX and the searches run without PeptDeep); without it each test prints
//! a skip message (shown with `--nocapture`) and passes. `PROSE_EXAMPLE_DIR` names the folder with
//! `Ecoli_MS2_small.mzML` and `Ecoli_K12_proteome.fasta` (default: the app's `resources/example`); a missing
//! folder skips as well.

mod common;

use common::*;
use prose_desktop_lib::args::SearchRequest;
use prose_desktop_lib::run::{SearchEvent, Searches};
use prose_desktop_lib::tool;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

struct Real {
    bin: PathBuf,
    example: PathBuf,
}

fn real() -> Option<Real> {
    let Some(bin) = std::env::var_os("PROSE_BIN").map(PathBuf::from) else {
        eprintln!("skipped: set PROSE_BIN to the ProSE tool to run the test against the real tool");
        return None;
    };
    let example = std::env::var_os("PROSE_EXAMPLE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/example"));
    if !example.join(MZML).is_file() || !example.join(FASTA).is_file() {
        eprintln!(
            "skipped: {} has no {MZML} and {FASTA} (set PROSE_EXAMPLE_DIR)",
            example.display()
        );
        return None;
    }
    Some(Real { bin, example })
}

/// The example's run and FASTA (src/lib/search/form.svelte.ts `EXAMPLE`).
const MZML: &str = "Ecoli_MS2_small.mzML";
const FASTA: &str = "Ecoli_K12_proteome.fasta";

/// The app's example: the same mzML twice (here from two folders, under one name), the orbitrap preset with
/// the example's fragment tolerance of 0.5 Da, contaminants, Percolator and PeptDeep, with `extra` parameters on top of
/// the preset.
fn example_request_with(
    real: &Real,
    work: &TempDir,
    peptdeep: bool,
    extra: serde_json::Value,
) -> SearchRequest {
    let mzml = real.example.join(MZML);
    let mut files = Vec::new();
    for folder in ["replicate-a", "replicate-b"] {
        let path = work.path().join("data").join(folder).join(MZML);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::copy(&mzml, &path).unwrap();
        files.push(json!({ "id": folder, "path": path }));
    }
    let mut request = json!({
        "files": files,
        "database": real.example.join(FASTA),
        "contaminants": true,
        "settings": {
            "parameters": {
                "enzyme": "Trypsin/P",
                "peptide:enzyme_specificity": "full",
                "peptide:missed_cleavages": 2,
                "modifications:fixed": ["Carbamidomethyl (C)"],
                "modifications:variable": ["Oxidation (M)", "Acetyl (Protein N-term)"],
                "FDR:PSM": 0.01,
                "FDR:protein": 0.01,
                "precursor:mass_tolerance_lower": 10,
                "precursor:mass_tolerance_upper": 10,
                "precursor:mass_tolerance_unit": "ppm",
                "fragment:mass_tolerance": 0.5,
                "fragment:mass_tolerance_unit": "Da",
                "peptdeep:instrument": "QE",
            },
            "rescore": true,
            "peptdeep": peptdeep,
            "threads": 4,
        },
    });
    for (name, value) in extra.as_object().unwrap() {
        request["settings"]["parameters"][name] = value.clone();
    }
    serde_json::from_value(request).unwrap()
}

fn parquet(path: &Path) -> bool {
    let bytes = fs::read(path).unwrap_or_default();
    bytes.len() > 8 && bytes.starts_with(b"PAR1") && bytes.ends_with(b"PAR1")
}

#[test]
fn the_real_tool_reports_its_version() {
    let Some(real) = real() else { return };
    let info = tool::probe(&real.bin).unwrap();
    assert!(!info.version.is_empty());
    assert_eq!(info.path, real.bin.to_string_lossy());
    // ONNX support is read from the bundle's manifest (bundle-prose.sh): the bundled pin has it, the
    // same tool in its build tree has no manifest and counts as without
    let bundled = real
        .bin
        .parent()
        .and_then(Path::parent)
        .is_some_and(|root| root.join(tool::MANIFEST).is_file());
    assert_eq!(info.onnx, bundled, "onnx follows the bundle's manifest");
}

#[test]
fn the_example_is_searched_through_start_search() {
    let Some(real) = real() else { return };
    let work = TempDir::new("real");
    let onnx = tool::probe(&real.bin).unwrap().onnx;
    // as the app's example: a PSM FDR of 2 % (Percolator's q-values are (decoys + 1) / targets since OpenMS #10721, and
    // no PSM of this small run passes 1 %) and no protein FDR (since OpenMS #10707 ProSE applies the preset's 1 % to this
    // small run, no protein passes it, and a result without protein groups has no quantms.pg.parquet)
    let request = example_request_with(
        &real,
        &work,
        onnx,
        json!({ "FDR:PSM": 0.02, "FDR:protein": 0 }),
    );
    let originals: Vec<String> = request.files.iter().map(|f| f.path.clone()).collect();
    let searches = Arc::new(Searches::default());
    let (sink, rx) = channel_sink();
    let crap = tool::bundled_crap(None).expect("resources/fasta/crap.fasta");
    let searches_dir = work.path().join("searches");
    let id = searches
        .start(&real.bin, &searches_dir, Some(&crap), request, sink)
        .unwrap();
    let events = until_terminal(&rx, Duration::from_secs(300));

    let folder = match events.last() {
        Some(SearchEvent::Done(d)) => PathBuf::from(&d.folder),
        other => panic!("not done: {other:?}"),
    };
    assert_eq!(folder, searches_dir.join(&id));
    assert!(!searches_dir.join(format!("{id}.partial")).exists());

    // the outputs the app reads (docs/parity.md), for both inputs although they have one name
    for file in [
        "qpx/quantms.psm.parquet",
        "qpx/quantms.pg.parquet",
        "qpx/quantms.run.parquet",
        "qpx/quantms.provenance.parquet",
        "qpx/quantms.sample.parquet",
        "qpx/runs/1__Ecoli_MS2_small.psm.parquet",
        "qpx/runs/2__Ecoli_MS2_small.psm.parquet",
        "qpx/runs/1__Ecoli_MS2_small.mz.parquet",
        "qpx/runs/2__Ecoli_MS2_small.mz.parquet",
    ] {
        assert!(parquet(&folder.join(file)), "{file} is a Parquet file");
    }
    // only QPX: no OpenMS Parquet, no sidecar, no summary
    for gone in ["oms", "spectra", "summary.yaml"] {
        assert!(!folder.join(gone).exists(), "{gone}");
    }
    for file in ["merged.idXML", "inputs.json", "prose.log", "database.fasta"] {
        assert!(folder.join(file).is_file(), "{file}");
    }
    assert!(fs::read_to_string(folder.join("database.fasta"))
        .unwrap()
        .contains(">CON__sp|ALBU_BOVIN|"));
    // the footer of an input's QPX mz view has the peak filter (the Parquet footer is not compressed); the
    // statistics of the search are in the run and provenance views
    let mz = fs::read(folder.join("qpx/runs/1__Ecoli_MS2_small.mz.parquet")).unwrap();
    for key in ["prose_peak_top", "prose_peak_window"] {
        assert!(
            mz.windows(key.len()).any(|w| w == key.as_bytes()),
            "{key} in the footer"
        );
    }

    // progress: both files, the PeptDeep and Percolator steps, a fraction that only grows
    let progress: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            SearchEvent::Progress(p) => Some(p),
            _ => None,
        })
        .collect();
    let labels: Vec<&str> = progress.iter().map(|p| p.label.as_str()).collect();
    for p in &progress {
        eprintln!(
            "progress {:>6.3} file {:>2}  {}",
            p.fraction, p.file, p.label
        );
    }
    assert!(
        labels.contains(&"Searching Ecoli_MS2_small.mzML (1 of 2)..."),
        "{labels:?}"
    );
    assert!(
        labels.contains(&"Searching Ecoli_MS2_small.mzML (2 of 2)..."),
        "{labels:?}"
    );
    assert!(
        labels.contains(&"Rescoring with Percolator..."),
        "{labels:?}"
    );
    assert_eq!(
        labels.contains(&"Adding PeptDeep rescoring features..."),
        onnx,
        "{labels:?}"
    );
    assert!(labels.contains(&"Pooling the files..."), "{labels:?}");
    assert!(progress.windows(2).all(|w| w[1].fraction >= w[0].fraction));
    assert!(progress.iter().any(|p| p.file == 1) && progress.last().unwrap().fraction < 1.0);

    // the inputs are linked, not copied (on Windows hard links, gone once the search is done), and
    // nothing was written next to them
    for (n, original) in originals.iter().enumerate() {
        let link = folder.join(format!("{}__{MZML}", n + 1));
        if cfg!(windows) {
            assert!(!link.exists(), "{link:?} is gone");
        } else {
            assert_eq!(
                fs::read_link(&link).unwrap(),
                Path::new(original).canonicalize().unwrap()
            );
        }
        let mut names: Vec<_> = fs::read_dir(Path::new(original).parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        names.sort();
        assert_eq!(names, [MZML]);
    }
}

#[test]
fn a_chunked_search_of_two_files_reports_progress() {
    let Some(real) = real() else { return };
    let work = TempDir::new("real-chunked");
    let onnx = tool::probe(&real.bin).unwrap().onnx;
    // `database:chunk_size` makes ProSE search chunk-major: it prints no "Searching <file>" line. (At a PSM FDR of
    // 5 % decoys pass, so ProSE runs the pooled protein FDR and says so: "Pooling the files"; at 1 % the example
    // has no decoy PSM, and ProSE skips it.)
    let request = example_request_with(
        &real,
        &work,
        onnx,
        json!({ "database:chunk_size": 1000, "FDR:PSM": 0.05 }),
    );
    let searches = Arc::new(Searches::default());
    let (sink, rx) = channel_sink();
    let crap = tool::bundled_crap(None).unwrap();
    let searches_dir = work.path().join("searches");
    searches
        .start(&real.bin, &searches_dir, Some(&crap), request, sink)
        .unwrap();
    let events = until_terminal(&rx, Duration::from_secs(300));
    assert!(
        matches!(events.last(), Some(SearchEvent::Done(_))),
        "{:?}",
        events.last()
    );

    let progress: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            SearchEvent::Progress(p) => Some(p),
            _ => None,
        })
        .collect();
    for p in &progress {
        eprintln!(
            "progress {:>6.3} file {:>2}  {}",
            p.fraction, p.file, p.label
        );
    }
    // 4,136 target proteins and the same of decoys, plus the 116 cRAP entries: several chunks, each reported
    let chunks = progress
        .iter()
        .filter(|p| p.label.starts_with("Searching database chunk"))
        .count();
    assert!(chunks >= 5, "{chunks} chunks reported");
    assert!(progress
        .iter()
        .any(|p| p.label.starts_with("Searching database chunk 1 of")));
    assert!(progress
        .iter()
        .any(|p| p.label == "Rescoring with Percolator..." && p.file == 0));
    assert!(progress
        .iter()
        .any(|p| p.label == "Rescoring with Percolator..." && p.file == 1));
    assert!(progress
        .iter()
        .any(|p| p.label == "Pooling the files..." && p.file == -1));
    assert!(progress.windows(2).all(|w| w[1].fraction >= w[0].fraction));
    let before_report = progress.iter().filter(|p| p.fraction < 0.9).count();
    assert!(
        before_report >= chunks,
        "progress moves before the end: {before_report} steps below 90 %"
    );
    assert!(progress.last().unwrap().fraction < 1.0);
}

#[test]
fn cancelling_the_real_tool_leaves_no_process_and_no_folder() {
    let Some(real) = real() else { return };
    let work = TempDir::new("real-cancel");
    // (the example takes a few seconds; in chunks of 20 proteins it runs long enough to be cancelled)
    let request = example_request_with(&real, &work, false, json!({ "database:chunk_size": 20 }));
    let searches = Arc::new(Searches::default());
    let (sink, rx) = channel_sink();
    let crap = tool::bundled_crap(None).unwrap();
    let searches_dir = work.path().join("searches");
    let id = searches
        .start(&real.bin, &searches_dir, Some(&crap), request, sink)
        .unwrap();
    first_progress(&rx, Duration::from_secs(60));
    let folder = searches_dir.to_string_lossy().into_owned();
    assert!(processes_with(&folder) >= 1, "the tool runs");

    searches.cancel(&id).unwrap();
    assert_eq!(
        processes_with(&folder),
        0,
        "no process of the search is left"
    );
    assert!(
        fs::read_dir(&searches_dir).unwrap().next().is_none(),
        "the partial folder is removed"
    );
}

/// The number of live processes whose command line mentions `needle`.
#[cfg(not(target_os = "linux"))]
fn processes_with(needle: &str) -> usize {
    #[cfg(windows)]
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
        ])
        .output()
        .unwrap();
    #[cfg(not(windows))]
    let output = std::process::Command::new("ps")
        .args(["-axww", "-o", "stat=,command="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.trim_start().starts_with('Z'))
        .filter(|l| l.contains(needle) && !l.contains("real_prose") && !l.contains("CimInstance"))
        .count()
}

/// The number of live processes whose command line mentions `needle`.
#[cfg(target_os = "linux")]
fn processes_with(needle: &str) -> usize {
    fs::read_dir("/proc")
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .chars()
                .all(|c| c.is_ascii_digit())
        })
        .filter(|e| process_alive(e.file_name().to_string_lossy().parse().unwrap()))
        .filter(|e| {
            fs::read(e.path().join("cmdline"))
                .map(|b| {
                    String::from_utf8_lossy(&b).contains(needle)
                        && !String::from_utf8_lossy(&b).contains("real_prose")
                })
                .unwrap_or(false)
        })
        .count()
}
