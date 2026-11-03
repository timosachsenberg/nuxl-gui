//! The shim against the real OpenNuXL, on the app's example (OpenMS' OpenNuXL test data).
//!
//! Gated: set `NUXL_TOOL` to the tool to run these tests: the bundled pin (`src-tauri/resources/nuxl/bin/OpenNuXL`,
//! made by `native/scripts/bundle-nuxl.sh`) or the pin in its build tree (`<build>/bin/OpenNuXL`, with
//! `PercolatorAdapter` beside it); without it each test prints a skip message (shown with `--nocapture`) and
//! passes. `NUXL_EXAMPLE_DIR` names the folder with `OpenNuXL_1_input.mzML` and `OpenNuXL_1_input.fasta` (default:
//! the app's `resources/example`); a missing folder skips as well.

mod common;

use common::*;
use nuxl_desktop_lib::args::SearchRequest;
use nuxl_desktop_lib::run::{SearchEvent, Searches};
use nuxl_desktop_lib::tool;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

struct Real {
    bin: PathBuf,
    example: PathBuf,
}

fn real() -> Option<Real> {
    let Some(bin) = std::env::var_os(tool::TOOL_VARIABLE).map(PathBuf::from) else {
        eprintln!("skipped: set NUXL_TOOL to OpenNuXL to run the test against the real tool");
        return None;
    };
    let example = std::env::var_os("NUXL_EXAMPLE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/example"));
    if !example.join(MZML).is_file() || !example.join(FASTA).is_file() {
        eprintln!(
            "skipped: {} has no {MZML} and {FASTA} (set NUXL_EXAMPLE_DIR)",
            example.display()
        );
        return None;
    }
    Some(Real { bin, example })
}

/// The example's run and FASTA (`files::EXAMPLE_RUN`, `files::EXAMPLE_FASTA`).
const MZML: &str = "OpenNuXL_1_input.mzML";
const FASTA: &str = "OpenNuXL_1_input.fasta";

/// The example run `copies` times (from folders of their own, under one name), with the settings of OpenMS' test
/// TOPP_OpenNuXL_1 (a precursor tolerance of 10 ppm) and `extra` on top, contaminants and Percolator.
fn example_request_with(real: &Real, work: &TempDir, copies: usize, extra: Value) -> SearchRequest {
    let mzml = real.example.join(MZML);
    let mut files = Vec::new();
    for k in 0..copies {
        let path = work.path().join(format!("data/run-{k}")).join(MZML);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::copy(&mzml, &path).unwrap();
        files.push(json!({ "id": format!("run-{k}"), "path": path }));
    }
    let mut request = json!({
        "files": files,
        "database": real.example.join(FASTA),
        "contaminants": true,
        "settings": {
            "parameters": { "precursor:mass_tolerance": 10.0, "NuXL:presets": "RNA-UV (U)" },
            "rescore": true,
            "threads": 2,
            "peptideFdr": 0.01,
            "xlFdr": 0.01,
        },
    });
    for (name, value) in extra.as_object().unwrap() {
        request["settings"]["parameters"][name] = value.clone();
    }
    serde_json::from_value(request).unwrap()
}

#[test]
fn the_real_tool_reports_its_version_and_has_percolator_adapter_beside_it() {
    let Some(real) = real() else { return };
    let info = tool::probe(&real.bin).unwrap();
    assert!(!info.version.is_empty());
    assert_eq!(info.path, real.bin.to_string_lossy());
    assert!(
        tool::has_percolator_adapter(&real.bin),
        "OpenNuXL rescores through the PercolatorAdapter beside it"
    );
}

#[test]
fn the_example_is_searched_run_by_run_through_start_search() {
    let Some(real) = real() else { return };
    let work = TempDir::new("real");
    let request = example_request_with(&real, &work, 2, json!({}));
    let originals: Vec<String> = request.files.iter().map(|f| f.path.clone()).collect();
    let searches = Arc::new(Searches::default());
    let (sink, rx) = channel_sink();
    let crap = tool::bundled_crap(None).expect("resources/fasta/crap.fasta");
    let searches_dir = work.path().join("searches");
    searches
        .start(&real.bin, &searches_dir, Some(&crap), request, sink)
        .unwrap();
    let events = until_terminal(&rx, Duration::from_secs(900));
    let folder = match events.last() {
        Some(SearchEvent::Done(d)) => PathBuf::from(&d.folder),
        other => panic!("{other:?}"),
    };
    // the progress went through each run's scoring, in order, and never back
    let progress: Vec<(String, i32, f64)> = events
        .iter()
        .filter_map(|e| match e {
            SearchEvent::Progress(p) => Some((p.label.clone(), p.file, p.fraction)),
            _ => None,
        })
        .collect();
    for pair in progress.windows(2) {
        assert!(pair[1].2 >= pair[0].2, "{pair:?}");
    }
    for k in 1..=2 {
        let scoring = format!("Scoring {MZML} ({k} of 2)...");
        assert!(
            progress.iter().any(|p| p.0.starts_with(&scoring)),
            "{scoring} in {progress:?}"
        );
    }
    // each input's record names files that are there, OpenNuXL's idXML
    let records: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("inputs.json")).unwrap()).unwrap();
    for (k, record) in records.as_array().unwrap().iter().enumerate() {
        let stem = record["stem"].as_str().unwrap();
        let outputs: Value = serde_json::from_str(
            &fs::read_to_string(folder.join(format!("nuxl/{stem}.outputs.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(outputs["input"], k);
        for key in ["all", "xls", "peptides"] {
            let path = folder.join(
                outputs[key]
                    .as_str()
                    .unwrap_or_else(|| panic!("{key}: {outputs}")),
            );
            let text = fs::read_to_string(&path).unwrap();
            assert!(text.contains("<IdXML"), "{}", path.display());
        }
        let percolator = outputs["percolator"].as_bool().unwrap();
        assert_eq!(
            outputs["xls"].as_str().unwrap().contains("_perc_"),
            percolator,
            "{outputs}"
        );
        // the example has far fewer than the 1000 PSMs OpenNuXL rescores
        if !percolator {
            assert!(
                outputs["notes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|n| n.as_str().unwrap().starts_with("Too few PSMs")),
                "{outputs}"
            );
        }
        assert_eq!(record["path"], originals[k].as_str());
    }
    let log = fs::read_to_string(folder.join("nuxl.log")).unwrap();
    assert_eq!(
        log.lines().filter(|l| l.starts_with("$ ")).count(),
        2,
        "{log}"
    );
}

#[test]
fn cancelling_the_real_tool_leaves_no_process_and_no_folder() {
    let Some(real) = real() else { return };
    let work = TempDir::new("real-cancel");
    // (longer adducts and several runs: long enough to be cancelled)
    let request = example_request_with(&real, &work, 3, json!({ "NuXL:length": 4 }));
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
        .filter(|l| l.contains(needle) && !l.contains("real_nuxl") && !l.contains("CimInstance"))
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
                        && !String::from_utf8_lossy(&b).contains("real_nuxl")
                })
                .unwrap_or(false)
        })
        .count()
}
