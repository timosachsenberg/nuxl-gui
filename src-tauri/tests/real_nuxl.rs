//! The shim against the real OpenNuXL, on the app's example (OpenMS' OpenNuXL test data).
//!
//! Gated: set `NUXL_TOOL` to the tool to run these tests: the bundled pin (`src-tauri/resources/nuxl/bin/OpenNuXL`,
//! made by `native/scripts/bundle-nuxl.sh`) or the pin in its build tree (`<build>/bin/OpenNuXL`, with
//! `PercolatorAdapter` beside it); without it each test prints a skip message (shown with `--nocapture`) and
//! passes. `NUXL_EXAMPLE_DIR` names the folder with `OpenNuXL_1_input.mzML` and `OpenNuXL_1_input.fasta` (default:
//! the app's `resources/example`); a missing folder skips as well.
//!
//! Vendor data, each gated by a variable of its own (and `NUXL_TOOL`), searched through the shim with the bundled
//! OpenNuXL and the FileConverter beside it (which these tests require): `NUXL_RAW_EXAMPLE` names a Thermo `.raw`
//! file, `NUXL_D_EXAMPLE` a Bruker timsTOF `.d` folder (CI: `desktop.yml` downloads OpenMS' test files
//! `Angiotensin_AllScans.raw` and `DDA_HeLa_50ng_5_6min.d`). Their database is `NUXL_VENDOR_FASTA` if set, else the
//! example's FASTA (few or no PSMs: what is checked is that the search ends and that the spectra the shim converted
//! are the ones OpenNuXL searched).

mod common;

use common::*;
use nuxl_desktop_lib::args::SearchRequest;
use nuxl_desktop_lib::run::{SearchEvent, Searches};
use nuxl_desktop_lib::tool;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
        // an mzML is read where it is
        assert_eq!(outputs["spectra"], Value::Null, "{outputs}");
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
    // (longer adducts and several runs: long enough to be cancelled, also on a runner busy with the other
    // real-data tests)
    let request = example_request_with(&real, &work, 8, json!({ "NuXL:length": 4 }));
    let searches = Arc::new(Searches::default());
    let (sink, rx) = channel_sink();
    let crap = tool::bundled_crap(None).unwrap();
    let searches_dir = work.path().join("searches");
    let id = searches
        .start(&real.bin, &searches_dir, Some(&crap), request, sink)
        .unwrap();
    first_progress(&rx, Duration::from_secs(60));
    let folder = searches_dir.to_string_lossy().into_owned();
    // a single look can fall between two runs, or come late on a busy runner (listing the processes takes a
    // while on Windows): look until a process of the search shows
    let deadline = Instant::now() + Duration::from_secs(30);
    while processes_with(&folder) == 0 {
        assert!(Instant::now() < deadline, "the tool runs");
        std::thread::sleep(Duration::from_millis(100));
    }

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

/// The vendor data a variable names (`NUXL_RAW_EXAMPLE`, `NUXL_D_EXAMPLE`), the tool and the database to search
/// it with; None (skipped) without them.
fn vendor(variable: &str) -> Option<(Real, PathBuf, PathBuf)> {
    // (the path without a trailing separator, as the shim records it)
    let Some(input) = std::env::var_os(variable)
        .map(|v| PathBuf::from(nuxl_desktop_lib::args::input_path(&v.to_string_lossy())))
    else {
        eprintln!(
            "skipped: set {variable} (and NUXL_TOOL) to search vendor data with the real tool"
        );
        return None;
    };
    let real = real()?;
    assert!(
        input.exists(),
        "{variable} names {}, which is not there",
        input.display()
    );
    assert!(
        tool::file_converter(&real.bin).is_some(),
        "{} has no FileConverter beside it: the spectra of vendor data cannot be converted",
        real.bin.display()
    );
    let fasta = std::env::var_os("NUXL_VENDOR_FASTA")
        .map(PathBuf::from)
        .unwrap_or_else(|| real.example.join(FASTA));
    Some((real, input, fasta))
}

/// The `id` of every `<spectrum>` of an mzML.
fn spectrum_ids(mzml: &str) -> Vec<String> {
    mzml.split("<spectrum ")
        .skip(1)
        .filter_map(|tag| {
            let tag = &tag[..tag.find('>').unwrap_or(tag.len())];
            let at = tag
                .find(" id=\"")
                .map(|a| a + 5)
                .or_else(|| tag.starts_with("id=\"").then_some(4))?;
            tag[at..].split('"').next().map(str::to_string)
        })
        .collect()
}

/// Every `spectrum_reference` of an idXML.
fn spectrum_references(idxml: &str) -> Vec<String> {
    idxml
        .split("spectrum_reference=\"")
        .skip(1)
        .filter_map(|rest| rest.split('"').next().map(str::to_string))
        .collect()
}

/// Searches the vendor input `input` (as `given`: its path, maybe with a trailing separator) through the shim with
/// the real tools and checks what the PSM view relies on: the run ended, the spectra were converted into the
/// search folder as an indexed mzML (no Numpress) whose native IDs begin with `id_prefix` or have `id_part`, and
/// every PSM's spectrum is one of them.
fn search_vendor(real: &Real, given: &str, input: &Path, fasta: &Path, id_part: &str) {
    let work = TempDir::new("real-vendor");
    let request: SearchRequest = serde_json::from_value(json!({
        "files": [{ "id": "vendor", "path": given }],
        "database": fasta,
        "contaminants": true,
        "settings": {
            "parameters": { "precursor:mass_tolerance": 10.0, "NuXL:presets": "RNA-UV (U)" },
            "rescore": true,
            "threads": 0,
            "peptideFdr": 0.01,
            "xlFdr": 0.01,
        },
    }))
    .unwrap();
    let name = input.file_name().unwrap().to_string_lossy().into_owned();
    let beside_before: Vec<String> = fs::read_dir(input.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let searches = Arc::new(Searches::default());
    let (sink, rx) = channel_sink();
    let crap = tool::bundled_crap(None).unwrap();
    let searches_dir = work.path().join("searches");
    searches
        .start(&real.bin, &searches_dir, Some(&crap), request, sink)
        .unwrap();
    let events = until_terminal(&rx, Duration::from_secs(3600));
    let folder = match events.last() {
        Some(SearchEvent::Done(d)) => PathBuf::from(&d.folder),
        other => panic!("{other:?}"),
    };
    let labels: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            SearchEvent::Progress(p) => Some(p.label.clone()),
            _ => None,
        })
        .collect();
    for label in [
        format!("Reading the spectra of {name} (1 of 1)..."),
        format!("Preparing the spectra of {name} for the PSM view (1 of 1)..."),
    ] {
        assert!(labels.contains(&label), "{label} in {labels:?}");
    }
    let records: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("inputs.json")).unwrap()).unwrap();
    let stem = records[0]["stem"].as_str().unwrap();
    assert_eq!(records[0]["path"], input.to_string_lossy().as_ref());
    let outputs: Value = serde_json::from_str(
        &fs::read_to_string(folder.join(format!("nuxl/{stem}.outputs.json"))).unwrap(),
    )
    .unwrap();
    let spectra = outputs["spectra"]
        .as_str()
        .unwrap_or_else(|| panic!("no spectra: {outputs}"));
    assert_eq!(spectra, format!("nuxl/{stem}.spectra.mzML"));
    let mzml = fs::read_to_string(folder.join(spectra)).unwrap();
    assert!(
        mzml[..mzml.len().min(4096)].contains("<indexedmzML"),
        "not an indexed mzML"
    );
    assert!(
        mzml[mzml.len().saturating_sub(4096)..].contains("<indexListOffset>"),
        "no index offset"
    );
    for numpress in ["MS:1002312", "MS:1002313", "MS:1002314"] {
        assert!(
            !mzml.contains(numpress),
            "Numpress ({numpress}) in the converted spectra"
        );
    }
    let ids: std::collections::HashSet<String> = spectrum_ids(&mzml).into_iter().collect();
    assert!(!ids.is_empty(), "no spectra converted");
    assert!(
        ids.iter().all(|id| id.contains(id_part)),
        "native IDs without {id_part}: {:?}",
        ids.iter().find(|id| !id.contains(id_part))
    );
    let all = fs::read_to_string(folder.join(outputs["all"].as_str().unwrap())).unwrap();
    let references = spectrum_references(&all);
    eprintln!(
        "{name}: {} spectra converted, {} PSMs, notes {}",
        ids.len(),
        references.len(),
        outputs["notes"]
    );
    for reference in &references {
        assert!(
            ids.contains(reference),
            "the PSM's spectrum {reference} is not in the converted spectra"
        );
    }
    // nothing beside the user's input: no ThermoRawFileParser mzML (`<input>.mzML`), no debug table
    let mut beside: Vec<String> = fs::read_dir(input.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    beside.retain(|n| !beside_before.contains(n));
    assert!(beside.is_empty(), "left beside the input: {beside:?}");
}

#[test]
fn a_thermo_raw_file_is_searched_and_its_spectra_converted_for_the_psm_view() {
    let Some((real, raw, fasta)) = vendor("NUXL_RAW_EXAMPLE") else {
        return;
    };
    search_vendor(
        &real,
        &raw.to_string_lossy(),
        &raw,
        &fasta,
        "controllerType=0 controllerNumber=1 scan=",
    );
}

#[test]
fn a_bruker_d_folder_is_searched_and_its_spectra_converted_for_the_psm_view() {
    let Some((real, d, fasta)) = vendor("NUXL_D_EXAMPLE") else {
        return;
    };
    // (as shell completion gives a folder: with a trailing separator)
    let given = format!("{}{}", d.display(), std::path::MAIN_SEPARATOR);
    search_vendor(&real, &given, &d, &fasta, "frame=");
}
