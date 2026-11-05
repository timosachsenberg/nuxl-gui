//! The shim against a fake OpenNuXL (tests/fake-nuxl.sh; on Windows examples/fake_nuxl.rs).

mod common;

use common::*;
use nuxl_desktop_lib::args::{
    build_runs, build_runs_with, build_search_with, database_decoys, humanize, input_placements,
    input_records_with, input_stem, is_converted_spectra, is_input_link, link_name, max_stem,
    mz_view_output, plan_database, stems_clash, write_database, DatabasePlan, InputLinks,
    Placement, SearchRequest, FILTER_STEPS, MAX_STEM,
};
use nuxl_desktop_lib::decoys::Marker;
use nuxl_desktop_lib::run::{SearchEvent, Searches};
use nuxl_desktop_lib::tool;
use serde_json::{json, Value};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(20);

/// A request as the front end sends it (camelCase JSON).
fn request(
    files: &[&Path],
    database: &Path,
    contaminants: bool,
    parameters: Value,
) -> SearchRequest {
    serde_json::from_value(json!({
        "files": files.iter().enumerate().map(|(i, p)| json!({ "id": format!("f{i}"), "path": p })).collect::<Vec<_>>(),
        "database": database,
        "contaminants": contaminants,
        "settings": { "parameters": parameters, "rescore": true, "threads": 2, "peptideFdr": 0.01, "xlFdr": 0.01 },
    }))
    .unwrap()
}

/// The runs' arguments with every input as a link `<n>__<name>` (Linux, macOS; Windows below).
fn runs_of(req: &SearchRequest, out: &Path) -> Vec<Vec<OsString>> {
    let plan = plan_database(req).unwrap();
    build_runs_with(req, out, InputLinks::Symlinks, &plan).unwrap()
}

/// The arguments of the first run.
fn args_of(req: &SearchRequest, out: &Path) -> Vec<OsString> {
    runs_of(req, out).remove(0)
}

/// The values after `flag` up to the next option (`-` and a letter, as TOPPBase reads it).
fn values_of(args: &[OsString], flag: &str) -> Vec<OsString> {
    let at = args
        .iter()
        .position(|a| a == flag)
        .unwrap_or_else(|| panic!("{flag} is not in {args:?}"));
    args[at + 1..]
        .iter()
        .take_while(|a| {
            let a = a.to_string_lossy();
            !(a.starts_with('-') && a.chars().nth(1).is_some_and(|c| c.is_ascii_alphabetic()))
        })
        .cloned()
        .collect()
}

fn has(args: &[OsString], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn strings(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

/// A folder with an mzML (empty contents are enough: the shim reads nothing of it) and a FASTA.
struct Inputs {
    dir: TempDir,
    mzml: PathBuf,
    fasta: PathBuf,
}

fn inputs() -> Inputs {
    let dir = TempDir::new("inputs");
    let mzml = dir.write("data/a.mzML", "<mzML/>");
    let fasta = dir.write("data/db.fasta", ">sp|P1|ONE\nMKWVTFISLLK\n");
    Inputs { dir, mzml, fasta }
}

// ---- arguments ------------------------------------------------------------------------------

#[test]
fn arguments_keep_paths_with_spaces_and_umlauts_intact() {
    let dir = TempDir::new("umlauts");
    let mzml = dir.write("Mäß daten/ünï cøde 1.mzML", "<mzML/>");
    let other = dir.write("two words/Probe ä.mzML", "<mzML/>");
    let fasta = dir.write("Datenbank ö/prot ein.fasta", ">a\nMK\n");
    let out = dir.path().join("out dir ü/s.partial");
    let runs = runs_of(&request(&[&mzml, &other], &fasta, false, json!({})), &out);
    assert_eq!(runs.len(), 2, "one run per input");
    assert_eq!(
        values_of(&runs[0], "-in"),
        vec![out.join("1__ünï cøde 1.mzML").into_os_string()],
        "the input is the link of the search folder, one argument"
    );
    assert_eq!(
        values_of(&runs[1], "-in"),
        vec![out.join("2__Probe ä.mzML").into_os_string()]
    );
    assert_eq!(
        values_of(&runs[1], "-out"),
        vec![out.join("nuxl/2__Probe ä.idXML").into_os_string()]
    );
    assert_eq!(
        values_of(&runs[0], "-database"),
        vec![fasta.clone().into_os_string()]
    );
}

#[test]
fn the_command_line_of_a_run_is_the_designs() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let args = args_of(&request(&[&i.mzml], &i.fasta, false, json!({})), &out);
    let path = |p: &str| out.join(p).into_os_string();
    let mut expected = vec![
        OsString::from("-in"),
        path("1__a.mzML"),
        "-database".into(),
        i.fasta.clone().into_os_string(),
        "-out".into(),
        path("nuxl/1__a.idXML"),
        "-out_tsv".into(),
        path("nuxl/1__a.tsv"),
    ];
    expected.extend(strings(&[
        "-threads",
        "2",
        "-report:peptideFDR",
        "0",
        "-report:xlFDR",
        "1.0",
        "0.01",
        "-report:xl_peptidelevel_FDR",
        "1.0",
        "1.0",
        "-percolator_backend",
        "builtin",
    ]));
    // the QPX mz view of the PSMs' spectra, for the PSM view
    expected.extend(["-out_qpx".into(), path("nuxl")]);
    assert_eq!(args, expected);
    // the shim's own options never come otherwise: no executable of Percolator (an empty one would turn the
    // rescoring off), no decoys switch (OpenNuXL writes its FDR outputs only with its own decoys)
    for flag in [
        "-percolator_executable",
        "-NuXL:decoys",
        "-out_xls",
        "-output_folder",
        "-ini",
    ] {
        assert!(!has(&args, flag), "{flag}");
    }
    // rescoring off
    let mut req = request(&[&i.mzml], &i.fasta, false, json!({}));
    req.settings.rescore = false;
    assert_eq!(
        values_of(&args_of(&req, &out), "-percolator_backend"),
        strings(&["none"])
    );
}

#[test]
fn the_cross_link_fdr_is_a_threshold_when_opennuxl_writes_its_protein_report_at_it() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let with = |xl: f64, peptide: f64| {
        let mut req = request(&[&i.mzml], &i.fasta, false, json!({}));
        req.settings.xl_fdr = xl;
        req.settings.peptide_fdr = peptide;
        let args = args_of(&req, &out);
        (
            values_of(&args, "-report:xlFDR"),
            values_of(&args, "-report:xl_peptidelevel_FDR"),
            values_of(&args, "-report:peptideFDR"),
        )
    };
    // up to 10 %: OpenNuXL writes the protein report at it
    assert_eq!(
        with(0.05, 0.01),
        (
            strings(&["1.0", "0.05"]),
            strings(&["1.0", "1.0"]),
            strings(&["0"])
        )
    );
    assert_eq!(with(0.1, 0.01).0, strings(&["1.0", "0.1"]));
    // above: no protein report anyway; 1: no filter at all
    for xl in [0.2, 1.0] {
        assert_eq!(
            with(xl, 0.05),
            (strings(&["1.0"]), strings(&["1.0"]), strings(&["0"])),
            "{xl}"
        );
    }
    // out of (0, 1]: refused
    for (xl, peptide) in [
        (0.0, 0.01),
        (-0.1, 0.01),
        (1.5, 0.01),
        (0.01, 0.0),
        (0.01, 2.0),
    ] {
        let mut req = request(&[&i.mzml], &i.fasta, false, json!({}));
        req.settings.xl_fdr = xl;
        req.settings.peptide_fdr = peptide;
        let err = build_runs(&req, &out).unwrap_err();
        assert!(
            err.contains("FDR") && err.contains("fraction"),
            "{xl} {peptide}: {err}"
        );
    }
}

#[test]
fn parameters_are_typed_and_named_as_opennuxl_names_them() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let params = json!({
        "precursor:mass_tolerance": 10,
        "precursor:mass_tolerance_unit": "ppm",
        "precursor:isotopes": [0, 1, -1],
        "fragment:mass_tolerance": 0.02,
        "peptide:enzyme": "Trypsin/P",
        "peptide:missed_cleavages": 2,
        "peptide:clip_nterm_methionine": false,
        "modifications:fixed": ["Carbamidomethyl (C)"],
        "modifications:variable": ["Oxidation (M)", "Phospho (S)"],
        "NuXL:presets": "RNA-UV (U)",
        "NuXL:length": 3,
        "NuXL:sequence": "",
        "NuXL:scoring": "fast",
        "NuXL:CysteineAdduct": true,
        "NuXL:only_xl": false,
        "filter": ["filter_pc_mass_error", "autotune"],
        "window_size": 75.5,
    });
    let args = args_of(&request(&[&i.mzml], &i.fasta, false, params), &out);
    let one = |flag: &str| values_of(&args, flag);
    assert_eq!(one("-precursor:mass_tolerance"), strings(&["10"]));
    assert_eq!(one("-precursor:mass_tolerance_unit"), strings(&["ppm"]));
    assert_eq!(
        one("-precursor:isotopes"),
        strings(&["0", "1", "-1"]),
        "an integer list, a negative one no option to TOPPBase"
    );
    assert_eq!(one("-fragment:mass_tolerance"), strings(&["0.02"]));
    assert_eq!(one("-peptide:enzyme"), strings(&["Trypsin/P"]));
    assert_eq!(
        one("-peptide:clip_nterm_methionine"),
        strings(&["false"]),
        "a true/false choice takes its value"
    );
    assert_eq!(
        one("-modifications:fixed"),
        strings(&["Carbamidomethyl (C)"])
    );
    assert_eq!(
        one("-modifications:variable"),
        strings(&["Oxidation (M)", "Phospho (S)"]),
        "a list is one argument per item"
    );
    assert_eq!(one("-NuXL:presets"), strings(&["RNA-UV (U)"]));
    assert_eq!(one("-NuXL:length"), strings(&["3"]));
    assert!(
        !has(&args, "-NuXL:sequence"),
        "empty text keeps the default"
    );
    assert_eq!(one("-NuXL:scoring"), strings(&["fast"]));
    assert_eq!(
        one("-filter"),
        strings(&["filter_pc_mass_error", "autotune"])
    );
    assert_eq!(one("-window_size"), strings(&["75.5"]));
    // a flag: present when on (no value), absent when off
    let at = args
        .iter()
        .position(|a| a == "-NuXL:CysteineAdduct")
        .unwrap();
    assert!(
        args.get(at + 1)
            .is_none_or(|next| next.to_string_lossy().starts_with('-')),
        "{args:?}"
    );
    assert!(!has(&args, "-NuXL:only_xl"));
    // the form's parameters come after the shim's own
    let percolator = args
        .iter()
        .position(|a| a == "-percolator_backend")
        .unwrap();
    assert!(args.iter().position(|a| a == "-NuXL:presets").unwrap() > percolator);
}

#[test]
fn an_empty_list_clears_the_default() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let args = args_of(
        &request(
            &[&i.mzml],
            &i.fasta,
            false,
            json!({ "modifications:variable": [], "filter": [] }),
        ),
        &out,
    );
    for flag in ["-modifications:variable", "-filter"] {
        assert!(has(&args, flag), "{flag}");
        assert!(
            values_of(&args, flag).is_empty(),
            "no value follows {flag}: {args:?}"
        );
    }
}

#[test]
fn the_shims_own_options_and_unknown_ones_are_refused() {
    let i = inputs();
    let out = i.dir.path().join("o");
    for name in [
        "bogus",
        "in",
        "database",
        "out",
        "out_tsv",
        "out_xls",
        "output_folder",
        "ini",
        "report:peptideFDR",
        "report:xlFDR",
        "report:xl_peptidelevel_FDR",
        "percolator_backend",
        "percolator_executable",
        "NuXL:decoys",
        "NuXL:presets_file",
        "NET_executable",
        "ThermoRaw_executable",
        "presets:RNA-UV (U):mapping",
        "-NuXL:presets",
    ] {
        let err = build_runs(
            &request(&[&i.mzml], &i.fasta, false, json!({ name: "x" })),
            &out,
        )
        .unwrap_err();
        assert!(
            err.contains(name),
            "the error names the parameter {name}: {err}"
        );
    }
}

#[test]
fn filter_steps_that_write_beside_the_input_or_need_more_tools_are_refused() {
    let i = inputs();
    let out = i.dir.path().join("o");
    for step in ["pcrecalibration", "optimize", "RTpredict", "bogus"] {
        let err = build_runs(
            &request(
                &[&i.mzml],
                &i.fasta,
                false,
                json!({ "filter": ["autotune", step] }),
            ),
            &out,
        )
        .unwrap_err();
        assert!(
            err.contains(step) && err.contains("filter"),
            "{step}: {err}"
        );
    }
    let all: Vec<&str> = FILTER_STEPS.to_vec();
    let args = args_of(
        &request(&[&i.mzml], &i.fasta, false, json!({ "filter": all })),
        &out,
    );
    assert_eq!(values_of(&args, "-filter").len(), FILTER_STEPS.len());
}

#[test]
fn parameter_values_of_the_wrong_type_are_refused() {
    let i = inputs();
    let out = i.dir.path().join("o");
    for params in [
        json!({ "peptide:missed_cleavages": "two" }),
        json!({ "peptide:missed_cleavages": 1.5 }),
        json!({ "peptide:missed_cleavages": null }),
        json!({ "precursor:mass_tolerance": "10" }),
        json!({ "peptide:enzyme": 3 }),
        json!({ "peptide:enzyme": "-in" }),
        json!({ "peptide:enzyme": "" }),
        json!({ "NuXL:sequence": "-database" }),
        json!({ "modifications:fixed": "Carbamidomethyl (C)" }),
        json!({ "modifications:fixed": ["-database"] }),
        json!({ "modifications:fixed": [1] }),
        json!({ "precursor:isotopes": ["1"] }),
        json!({ "precursor:isotopes": [0.5] }),
        json!({ "precursor:isotopes": 1 }),
        json!({ "NuXL:CysteineAdduct": "yes" }),
        json!({ "NuXL:presets": "RNA\nUV" }),
    ] {
        assert!(
            build_runs(&request(&[&i.mzml], &i.fasta, false, params.clone()), &out).is_err(),
            "{params} is refused"
        );
    }
}

#[test]
fn integers_beyond_32_bits_and_absurd_threads_are_refused() {
    let i = inputs();
    let out = i.dir.path().join("o");
    // OpenNuXL reads its integers as 32-bit: a larger one makes it print its whole help and stop
    for (params, words) in [
        (
            json!({ "precursor:max_charge": 3_000_000_000_u64 }),
            "precursor:max_charge",
        ),
        (
            json!({ "precursor:isotopes": [-2_147_483_649_i64] }),
            "precursor:isotopes",
        ),
        (
            json!({ "peptide:missed_cleavages": 9.0e15 }),
            "peptide:missed_cleavages",
        ),
        (json!({ "threads": 4_294_967_295_u64 }), "threads"),
        (json!({ "threads": 1025 }), "threads"),
    ] {
        let err =
            build_runs(&request(&[&i.mzml], &i.fasta, false, params.clone()), &out).unwrap_err();
        assert!(err.contains(words), "{params}: {err}");
    }
    let err = build_runs(
        &request(
            &[&i.mzml],
            &i.fasta,
            false,
            json!({ "precursor:max_charge": 3_000_000_000_u64 }),
        ),
        &out,
    )
    .unwrap_err();
    assert!(
        err.contains("2147483647"),
        "the message names the range: {err}"
    );
    // the request's own field too
    let mut req = request(&[&i.mzml], &i.fasta, false, json!({}));
    req.settings.threads = 100_000;
    assert!(build_runs(&req, &out).unwrap_err().contains("1024"));
    // the bounds themselves pass; threads in the parameters is the request's threads
    let args = args_of(
        &request(
            &[&i.mzml],
            &i.fasta,
            false,
            json!({ "precursor:max_charge": 2_147_483_647_i64, "precursor:isotopes": [-2_147_483_648_i64], "threads": 1024 }),
        ),
        &out,
    );
    assert_eq!(
        values_of(&args, "-precursor:max_charge"),
        strings(&["2147483647"])
    );
    assert_eq!(
        values_of(&args, "-precursor:isotopes"),
        strings(&["-2147483648"])
    );
    assert_eq!(values_of(&args, "-threads"), strings(&["1024"]));
}

#[test]
fn input_paths_are_validated() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let missing = i.dir.path().join("data/missing.mzML");
    let folder = i.dir.path().join("data");
    let gz = i.dir.write("data/b.MZML.GZ", "gz");
    let text = i.dir.write("data/db.txt", ">a\nMK\n");
    assert!(
        build_runs(&request(&[&missing], &i.fasta, false, json!({})), &out)
            .unwrap_err()
            .contains("missing.mzML")
    );
    assert!(
        build_runs(&request(&[&folder], &i.fasta, false, json!({})), &out).is_err(),
        "a folder is not a file"
    );
    // OpenNuXL reads no compressed mzML: unpack it first
    let err = build_runs(&request(&[&i.mzml, &gz], &i.fasta, false, json!({})), &out).unwrap_err();
    assert!(err.contains("b.MZML.GZ") && err.contains("unpack"), "{err}");
    assert!(
        build_runs(&request(&[&i.mzml], &text, false, json!({})), &out)
            .unwrap_err()
            .contains("db.txt")
    );
    assert!(build_runs(
        &request(
            &[&i.mzml],
            &i.dir.path().join("none.fasta"),
            false,
            json!({})
        ),
        &out
    )
    .is_err());
    assert!(
        build_runs(&request(&[], &i.fasta, false, json!({})), &out).is_err(),
        "no input file"
    );
    // OpenNuXL replaces ".idXML" in its output paths: not in a stem
    let tricky = i.dir.write("data/run.idXML.mzML", "<mzML/>");
    let err = build_runs(&request(&[&tricky], &i.fasta, false, json!({})), &out).unwrap_err();
    assert!(err.contains(".idXML") && err.contains("rename"), "{err}");
    // the extensions the app takes
    let upper = i.dir.write("data/C.MZML", "<mzML/>");
    let fa = i.dir.write("data/db.fa", ">a\nMK\n");
    let faa = i.dir.write("data/db.faa", ">a\nMK\n");
    for db in [&fa, &faa] {
        assert!(build_runs(&request(&[&i.mzml, &upper], db, false, json!({})), &out).is_ok());
    }
}

/// Thermo .raw files and Bruker timsTOF .d folders are searched as they are; what is neither, or not what its
/// name says, is refused with what to do.
#[test]
fn raw_files_and_bruker_d_folders_are_inputs() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let raw = i.dir.write("data/a.raw", "x");
    let upper = i.dir.write("data/B.RAW", "x");
    let tdf = bruker_d(&i.dir, "data/c.d");
    i.dir.write("data/tsf.D/analysis.tsf", "");
    i.dir.write("data/tsf.D/analysis.tsf_bin", "");
    let tsf = i.dir.path().join("data/tsf.D");
    let runs = runs_of(
        &request(
            &[&i.mzml, &raw, &upper, &tdf, &tsf],
            &i.fasta,
            false,
            json!({}),
        ),
        &out,
    );
    let ins: Vec<OsString> = runs.iter().map(|r| values_of(r, "-in").remove(0)).collect();
    assert_eq!(
        ins,
        ["1__a.mzML", "2__a.raw", "3__B.RAW", "4__c.d", "5__tsf.D"]
            .map(|l| out.join(l).into_os_string())
    );
    let outs: Vec<OsString> = runs
        .iter()
        .map(|r| values_of(r, "-out").remove(0))
        .collect();
    assert_eq!(
        outs,
        ["1__a", "2__a", "3__B", "4__c", "5__tsf"]
            .map(|stem| out.join(format!("nuxl/{stem}.idXML")).into_os_string())
    );

    let refused =
        |path: &Path| build_runs(&request(&[path], &i.fasta, false, json!({})), &out).unwrap_err();
    // a folder named .raw (Waters)
    i.dir.write("data/waters.raw/_FUNC001.DAT", "");
    let err = refused(&i.dir.path().join("data/waters.raw"));
    assert!(
        err.contains("waters.raw") && err.contains("Waters"),
        "{err}"
    );
    // a .d without timsTOF data (Agilent), or with half of it
    i.dir.write("data/agilent.d/AcqData/MSScan.bin", "");
    let err = refused(&i.dir.path().join("data/agilent.d"));
    assert!(
        err.contains(
            "agilent.d is not a Bruker timsTOF .d folder (no analysis.tdf or analysis.tsf)"
        ),
        "{err}"
    );
    i.dir.write("data/half.d/analysis.tdf", "");
    let err = refused(&i.dir.path().join("data/half.d"));
    assert!(
        err.contains("half.d") && err.contains("analysis.tdf_bin"),
        "{err}"
    );
    // a file named .d, a zipped .d
    let err = refused(&i.dir.write("data/file.d", "x"));
    assert!(err.contains("file.d") && err.contains("folder"), "{err}");
    let err = refused(&i.dir.write("data/run.d.zip", "PK"));
    assert!(
        err.contains("run.d.zip") && err.contains("unzip it first"),
        "{err}"
    );
    // anything else
    let err = refused(&i.dir.write("data/run.wiff", "x"));
    assert!(
        err.contains("run.wiff")
            && err
                .contains("an mzML file (.mzML), a Thermo .raw file or a Bruker timsTOF .d folder"),
        "{err}"
    );
}

/// A folder given with a trailing separator (`run.d/`, as shell completion writes it) is the folder: its name, its
/// stem and the path OpenNuXL and inputs.json get are without the separator.
#[test]
fn a_d_folder_with_a_trailing_separator_is_the_folder() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let d = bruker_d(&i.dir, "data/run.d");
    let given = format!("{}{}", d.display(), std::path::MAIN_SEPARATOR);
    let req = request(&[Path::new(&given)], &i.fasta, false, json!({}));
    let records = input_records_with(&req, InputLinks::Symlinks, &out);
    assert_eq!(records[0].name, "run.d");
    assert_eq!(records[0].link, "1__run.d");
    assert_eq!(records[0].stem, "1__run");
    assert_eq!(records[0].path, d.to_string_lossy());
    let own = input_records_with(&req, InputLinks::PathsOrHardLinks, &out);
    assert_eq!(own[0].stem, "run");
    let plan = plan_database(&req).unwrap();
    let runs = build_runs_with(&req, &out, InputLinks::PathsOrHardLinks, &plan).unwrap();
    assert_eq!(values_of(&runs[0], "-in"), [d.clone().into_os_string()]);
    assert_eq!(nuxl_desktop_lib::args::input_path("/a/b.d//"), "/a/b.d");
    assert_eq!(
        nuxl_desktop_lib::args::input_path("C:\\a\\b.d\\"),
        "C:\\a\\b.d"
    );
    assert_eq!(nuxl_desktop_lib::args::input_path("/"), "/");
}

/// Every run writes the QPX mz view of its PSMs' spectra for the PSM view (`-out_qpx` into the search folder's nuxl/),
/// whatever its input; nothing else runs after it. The shim's name for it, and what it takes for spectra an earlier
/// version converted.
#[test]
fn every_run_writes_the_mz_view_of_its_psms() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let raw = i.dir.write("data/a.raw", "x");
    let d = bruker_d(&i.dir, "data/b.d");
    let req = request(
        &[&i.mzml, &raw, &d],
        &i.fasta,
        false,
        json!({ "threads": 3 }),
    );
    let plan = plan_database(&req).unwrap();
    let search = build_search_with(&req, &out, InputLinks::Symlinks, &plan).unwrap();
    assert_eq!(search.runs.len(), 3);
    for run in &search.runs {
        assert_eq!(
            values_of(run, "-out_qpx"),
            vec![out.join("nuxl").into_os_string()],
            "{run:?}"
        );
        assert!(!has(run, "-qpx_peak_top") && !has(run, "-qpx_peak_window"));
    }
    assert_eq!(mz_view_output("2__a"), "nuxl/2__a.mz.parquet");
    for name in ["nuxl/2__a.spectra.mzML", "nuxl/x.spectra.tmp.mzML"] {
        assert!(is_converted_spectra(name), "{name}");
    }
    for name in [
        "2__a.spectra.mzML",
        "nuxl/sub/a.spectra.mzML",
        "nuxl/a.mzML",
        "nuxlx/a.spectra.mzML",
        "nuxl/2__a.mz.parquet",
    ] {
        assert!(!is_converted_spectra(name), "{name}");
    }
}

/// Windows: a .d folder cannot be hard-linked, so it keeps its own path when its name clashes with a file's (the
/// file goes as a link), and one that would need a link (a second .d of its name, too long a name) is refused.
#[test]
fn on_windows_a_d_folder_goes_by_its_own_path_or_is_refused() {
    let dir = TempDir::new("placements-d");
    let fasta = dir.write("db.fasta", ">a\nMK\n");
    let d = bruker_d(&dir, "one/a.d");
    let other_d = bruker_d(&dir, "two/A.D");
    let mzml = dir.write("three/a.mzML", "<mzML/>");
    let raw = dir.write("four/a_perc.raw", "x");
    let out = dir.path().join("s.partial");
    let windows = InputLinks::PathsOrHardLinks;
    use Placement::*;
    let place = |files: &[&Path]| {
        input_placements(&request(files, &fasta, false, json!({})), windows, &out)
    };
    let build = |files: &[&Path]| {
        let req = request(files, &fasta, false, json!({}));
        build_runs_with(&req, &out, windows, &plan_database(&req).unwrap())
    };
    // a.d and a.mzML have one stem: the folder by its path, the file as a link; a_perc.raw clashes with both
    assert_eq!(place(&[&mzml, &d, &raw]), [HardLink, OwnPath, HardLink]);
    let runs = build(&[&mzml, &d, &raw]).unwrap();
    assert_eq!(values_of(&runs[1], "-in"), [d.clone().into_os_string()]);
    assert_eq!(
        values_of(&runs[0], "-in"),
        [out.join("1__a.mzML").into_os_string()]
    );
    // two folders of one name (ignoring case): the second would need a link
    assert_eq!(place(&[&d, &other_d]), [OwnPath, HardLink]);
    let err = build(&[&d, &other_d]).unwrap_err();
    assert!(
        err.contains("A.D") && err.contains("a.d") && err.contains("rename"),
        "{err}"
    );
    // a folder named like the link of a file (two a.mzML go as 1__a.mzML and 2__a.mzML): no other input's name
    // clashes with 1__a.d's, so the message names the link and asks to rename the folder
    let mzml_again = dir.write("six/a.mzML", "<mzML/>");
    let link_like = bruker_d(&dir, "seven/1__a.d");
    let err = build(&[&mzml, &mzml_again, &link_like]).unwrap_err();
    assert!(
        err.contains("1__a.d")
            && err.contains("linked into the search folder as 1__a.mzML")
            && err.contains("rename the folder")
            && !err.contains("another input"),
        "{err}"
    );
    // too long a name for the outputs within MAX_PATH
    let long = bruker_d(&dir, &format!("five/{}.d", "x".repeat(200)));
    let err = build(&[&long]).unwrap_err();
    assert!(
        err.contains("too long") && err.contains("rename the folder"),
        "{err}"
    );
    // elsewhere: links, also to folders
    let req = request(&[&d, &other_d], &fasta, false, json!({}));
    assert_eq!(
        input_placements(&req, InputLinks::Symlinks, &out),
        [Symlink, Symlink]
    );
}

#[test]
fn relative_paths_are_refused_so_none_can_pass_for_an_option() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let json = |files: Value, database: Value| -> SearchRequest {
        serde_json::from_value(json!({
            "files": files, "database": database, "contaminants": false,
            "settings": { "parameters": {}, "rescore": true, "threads": 1, "peptideFdr": 0.01, "xlFdr": 0.01 },
        }))
        .unwrap()
    };
    let good_file = json!([{ "id": "f", "path": i.mzml }]);
    let good_db = json!(i.fasta);
    for path in [
        "-in.mzML",
        "-out",
        "data/a.mzML",
        "a.mzML",
        "./a.mzML",
        "../a.mzML",
    ] {
        let err = build_runs(
            &json(json!([{ "id": "f", "path": path }]), good_db.clone()),
            &out,
        )
        .unwrap_err();
        assert!(
            err.contains("absolute") && err.contains(path),
            "{path}: {err}"
        );
    }
    for path in ["-database.fasta", "-ini", "db.fasta", "sub/db.fasta"] {
        let err = build_runs(&json(good_file.clone(), json!(path)), &out).unwrap_err();
        assert!(
            err.contains("absolute") && err.contains(path),
            "{path}: {err}"
        );
    }
    assert!(build_runs(&json(good_file, good_db), &out).is_ok());
}

// ---- the database ---------------------------------------------------------------------------

#[test]
fn contaminants_or_decoys_swap_the_database_for_the_search_folders_copy() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let with = args_of(&request(&[&i.mzml], &i.fasta, true, json!({})), &out);
    assert_eq!(
        values_of(&with, "-database"),
        vec![out.join("database.fasta").into_os_string()]
    );
    let without = args_of(&request(&[&i.mzml], &i.fasta, false, json!({})), &out);
    assert_eq!(
        values_of(&without, "-database"),
        vec![i.fasta.clone().into_os_string()]
    );
    // a database with decoys of its own: the copy without them, also without contaminants
    let decoys = i.dir.write(
        "data/td.fasta",
        ">P1\nMKWV\n>P2\nAAAK\n>rev_P1\nVWKM\n>rev_P2\nKAAA\n",
    );
    let req = request(&[&i.mzml], &decoys, false, json!({}));
    assert_eq!(
        plan_database(&req).unwrap(),
        DatabasePlan {
            copy: true,
            decoys: Some(Marker::Prefix("rev_".into()))
        }
    );
    let args = args_of(&req, &out);
    assert_eq!(
        values_of(&args, "-database"),
        vec![out.join("database.fasta").into_os_string()]
    );
    assert!(!has(&args, "-NuXL:decoys"), "OpenNuXL generates its decoys");
    assert_eq!(
        plan_database(&request(&[&i.mzml], &i.fasta, false, json!({}))).unwrap(),
        DatabasePlan {
            copy: false,
            decoys: None
        }
    );
}

fn bundled_crap() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/fasta/crap.fasta")
}

fn headers(text: &str) -> Vec<&str> {
    text.lines().filter(|l| l.starts_with('>')).collect()
}

#[test]
fn contaminants_are_appended_with_con_accessions() {
    let dir = TempDir::new("crap");
    // the user's FASTA has no final newline; one cRAP entry carries the prefix already
    let user = dir.write("user.fasta", ">sp|P1|ONE desc\nMKWV\nTFIS");
    let crap = dir.write(
        "crap.fasta",
        ">sp|ALBU_BOVIN|\nMKWVT\nFISL\n>CON__kept\nAAAA\n>gi|2|keratin\nGGGG\n",
    );
    let dest = dir.path().join("database.fasta");
    let copy = write_database(&user, Some(&crap), None, &dest).unwrap();
    assert_eq!(
        (copy.targets, copy.contaminants, copy.decoys_left_out),
        (1, 3, 0)
    );
    assert_eq!(
        fs::read_to_string(&dest).unwrap(),
        ">sp|P1|ONE desc\nMKWV\nTFIS\n>CON__sp|ALBU_BOVIN|\nMKWVT\nFISL\n>CON__kept\nAAAA\n>CON__gi|2|keratin\nGGGG\n"
    );
    // the user's file is untouched, and a final newline is not doubled
    assert_eq!(
        fs::read_to_string(&user).unwrap(),
        ">sp|P1|ONE desc\nMKWV\nTFIS"
    );
    let user2 = dir.write("user2.fasta", ">x\nMK\n");
    write_database(&user2, Some(&crap), None, &dest).unwrap();
    assert!(fs::read_to_string(&dest)
        .unwrap()
        .starts_with(">x\nMK\n>CON__sp|ALBU_BOVIN|\n"));
}

#[test]
fn the_bundled_crap_has_116_entries_and_gets_the_prefix() {
    let dir = TempDir::new("bundled-crap");
    let user = dir.write("user.fasta", ">a\nMK\n");
    let dest = dir.path().join("database.fasta");
    write_database(&user, Some(&bundled_crap()), None, &dest).unwrap();
    let text = fs::read_to_string(&dest).unwrap();
    let headers = headers(&text);
    assert_eq!(headers.len(), 117);
    assert_eq!(headers[0], ">a");
    assert!(headers[1..].iter().all(|h| h.starts_with(">CON__")));
}

#[test]
fn contaminants_the_database_has_already_are_not_appended_again() {
    let dir = TempDir::new("crap-twice");
    let crap = dir.write(
        "crap.fasta",
        ">sp|ALBU_BOVIN| serum albumin\nMKWVT\n>gi|2|keratin\nGGGG\n",
    );
    // one of them (with the prefix, and a description of its own) is in the user's FASTA
    let user = dir.write(
        "user.fasta",
        ">sp|P1|ONE\nMKWV\n>CON__sp|ALBU_BOVIN| own text\r\nMKWVT\r\n",
    );
    let dest = dir.path().join("database.fasta");
    write_database(&user, Some(&crap), None, &dest).unwrap();
    assert_eq!(
        fs::read_to_string(&dest).unwrap(),
        ">sp|P1|ONE\nMKWV\n>CON__sp|ALBU_BOVIN| own text\r\nMKWVT\r\n>CON__gi|2|keratin\nGGGG\n"
    );
    // the database.fasta of an earlier search, searched again with contaminants: nothing is added
    let first = dir.path().join("first.fasta");
    let again = dir.path().join("again.fasta");
    let plain = dir.write("plain.fasta", ">a\nMK\n");
    write_database(&plain, Some(&bundled_crap()), None, &first).unwrap();
    write_database(&first, Some(&bundled_crap()), None, &again).unwrap();
    assert_eq!(
        fs::read_to_string(&again).unwrap(),
        fs::read_to_string(&first).unwrap()
    );
    let text = fs::read_to_string(&again).unwrap();
    let all = headers(&text);
    let unique: std::collections::HashSet<&&str> = all.iter().collect();
    assert_eq!((all.len(), unique.len()), (117, 117));
}

#[test]
fn the_databases_own_decoys_are_left_out() {
    let dir = TempDir::new("decoys");
    let crap = dir.write("crap.fasta", ">sp|TRY|trypsin\nMABCKDE\n");
    let dest = dir.path().join("database.fasta");
    // a prefix as DecoyHelper knows it, spelled as the database spells it; a decoy's sequence over two lines
    let user = dir.write(
        "decoys.fasta",
        ">P1 one\nMKWV\n>REV_P1 one\nMV\nWK\n>P2\nAAAK\n>rev_P2\nAAAK\n",
    );
    let marker = database_decoys(&user).unwrap();
    assert_eq!(marker, Some(Marker::Prefix("rev_".into())));
    let copy = write_database(&user, Some(&crap), marker.as_ref(), &dest).unwrap();
    assert_eq!(
        (copy.targets, copy.decoys_left_out, copy.contaminants),
        (2, 2, 1)
    );
    assert_eq!(
        fs::read_to_string(&dest).unwrap(),
        ">P1 one\nMKWV\n>P2\nAAAK\n>CON__sp|TRY|trypsin\nMABCKDE\n",
        "no decoy, of either spelling, and none of the contaminants (OpenNuXL makes them all)"
    );
    // a suffix; and OpenNuXL's own prefix, of an earlier search's database that kept a few
    let suffixed = dir.write("suffixed.fasta", ">P1\nMK\n>P1_REVERSED\nKM\n");
    assert_eq!(
        database_decoys(&suffixed).unwrap(),
        Some(Marker::Suffix("_REVERSED".into()))
    );
    let own = dir.write("own.fasta", ">P1\nMK\n>P2\nMK\n>P3\nMK\n>DECOY_P1\nKM\n");
    let marker = database_decoys(&own).unwrap();
    assert_eq!(marker, Some(Marker::Prefix("DECOY_".into())));
    write_database(&own, None, marker.as_ref(), &dest).unwrap();
    assert_eq!(
        headers(&fs::read_to_string(&dest).unwrap()),
        [">P1", ">P2", ">P3"]
    );
    // a database of decoys only: refused, nothing left
    let only = dir.write("only.fasta", ">rev_P1\nMK\n>rev_P2\nKM\n");
    let marker = database_decoys(&only).unwrap();
    let err = write_database(&only, None, marker.as_ref(), &dest).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    assert!(
        err.to_string().contains("decoys only") && err.to_string().contains("rev_"),
        "{err}"
    );
    assert!(!dest.exists());
}

#[test]
fn a_database_without_proteins_is_refused() {
    let dir = TempDir::new("crap-empty");
    let dest = dir.path().join("database.fasta");
    for (name, contents) in [
        ("empty.fasta", ""),
        ("blank.fasta", "\n\n  \n"),
        ("nohdr.fasta", "MKWVTFISLLK\n"),
    ] {
        let user = dir.write(name, contents);
        let err = write_database(&user, Some(&bundled_crap()), None, &dest).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData, "{name}");
        assert!(err.to_string().contains("has no proteins"), "{name}: {err}");
        assert!(!dest.exists(), "{name}: no half-written copy is left");
    }
    // a byte order mark before the first header is no problem
    let bom = dir.write("bom.fasta", "\u{feff}>P1\nMK\n");
    write_database(&bom, Some(&bundled_crap()), None, &dest).unwrap();
    // through start_search: refused, and nothing is left
    let run = Run::new();
    let i = inputs();
    let empty = i.dir.write("data/empty.fasta", "");
    let (id, _rx) = run.start(
        request(&[&i.mzml], &empty, true, json!({})),
        Some(&bundled_crap()),
    );
    let err = id.unwrap_err();
    assert!(
        err.contains("has no proteins") && err.contains("empty.fasta"),
        "{err}"
    );
    assert!(run.listing().is_empty(), "{:?}", run.listing());
}

// ---- inputs and their names -----------------------------------------------------------------

#[test]
fn on_windows_inputs_go_by_their_own_paths_unless_their_names_clash() {
    let dir = TempDir::new("placements");
    let a = dir.write("one/a.mzML", "<mzML/>");
    let b = dir.write("one/b.mzML", "<mzML/>");
    let a_upper = dir.write("two/A.MZML", "<mzML/>");
    let a_perc = dir.write("three/a_perc.mzML", "<mzML/>");
    let fasta = dir.write("db.fasta", ">a\nMK\n");
    let out = dir.path().join("s.partial");
    let windows = InputLinks::PathsOrHardLinks;
    let plan = |files: &[&Path]| {
        let req = request(files, &fasta, false, json!({}));
        let runs = build_runs_with(&req, &out, windows, &plan_database(&req).unwrap()).unwrap();
        let records = input_records_with(&req, windows, &out);
        (
            input_placements(&req, windows, &out),
            runs.iter()
                .map(|r| values_of(r, "-in").remove(0))
                .collect::<Vec<_>>(),
            records
                .iter()
                .map(|r| (r.link.clone(), r.stem.clone()))
                .collect::<Vec<_>>(),
        )
    };

    // names that differ: the user's paths themselves, the outputs named after them
    let (placements, ins, records) = plan(&[&a, &b]);
    assert_eq!(placements, [Placement::OwnPath, Placement::OwnPath]);
    assert_eq!(
        ins,
        [a.clone().into_os_string(), b.clone().into_os_string()]
    );
    assert_eq!(
        records,
        [
            ("a.mzML".to_string(), "a".to_string()),
            ("b.mzML".to_string(), "b".to_string())
        ]
    );
    // one stem, ignoring case (NTFS), or one stem and another that begins with it and `_` (the outputs of
    // `a` after Percolator are named as those of `a_perc`): the clashing ones as hard links in the folder
    let (placements, ins, records) = plan(&[&a, &b, &a_upper, &a_perc]);
    use Placement::*;
    assert_eq!(placements, [HardLink, OwnPath, HardLink, HardLink]);
    assert_eq!(
        ins,
        [
            out.join("1__a.mzML").into_os_string(),
            b.clone().into_os_string(),
            out.join("3__A.MZML").into_os_string(),
            out.join("4__a_perc.mzML").into_os_string(),
        ]
    );
    assert_eq!(
        records
            .iter()
            .map(|(_, stem)| stem.as_str())
            .collect::<Vec<_>>(),
        ["1__a", "b", "3__A", "4__a_perc"]
    );
    let (placements, _, _) = plan(&[&a_perc, &b]);
    assert_eq!(placements, [OwnPath, OwnPath], "no clash, no link");
    // a file whose own name looks like a link beside the clash it would meet: all of them as links
    let tricky = dir.write("four/1__a.mzML", "<mzML/>");
    let (placements, _, records) = plan(&[&a, &a_upper, &tricky]);
    assert_eq!(placements, [HardLink, HardLink, HardLink]);
    assert_eq!(
        records
            .iter()
            .map(|(link, _)| link.as_str())
            .collect::<Vec<_>>(),
        ["1__a.mzML", "2__A.MZML", "3__1__a.mzML"]
    );
    // elsewhere every input is a symbolic link
    let req = request(&[&a, &b], &fasta, false, json!({}));
    assert_eq!(
        input_placements(&req, InputLinks::Symlinks, &out),
        [Symlink, Symlink]
    );
    assert_eq!(
        InputLinks::PLATFORM,
        if cfg!(windows) {
            windows
        } else {
            InputLinks::Symlinks
        }
    );
}

#[test]
fn stems_clash_when_one_names_the_others_outputs() {
    assert!(stems_clash("a", "a"));
    assert!(stems_clash("a", "a_perc") && stems_clash("a_perc", "a"));
    assert!(stems_clash("a", "a_sse_perc_in"));
    for (x, y) in [
        ("a", "ab"),
        ("a", "a.b"),
        ("1__a", "11__a"),
        ("a", "b_a"),
        ("A", "a"),
    ] {
        assert!(!stems_clash(x, y), "{x} {y}");
    }
    // (compared as given: the shim compares the lower-cased stems, as NTFS compares names)
    assert!(stems_clash("a", "a__x"), "on the safe side");
}

#[test]
fn input_links_are_known_by_their_names() {
    for name in [
        "1__a.mzML",
        "12__x y.mzML",
        "3__1__a.MZML",
        "4__a.raw",
        "5__b.RAW",
        "6__run.d",
        "7__RUN.D",
    ] {
        assert!(is_input_link(name), "{name}");
    }
    for name in [
        "a.mzML",
        "__a.mzML",
        "x__a.mzML",
        "1__a.fasta",
        "1__a.mzML.gz",
        "1__a.d.zip",
        "1__a.d.ambiguous_masses.csv",
        "1__a.raw.ambiguous_masses.csv",
        "1__",
        "search.json",
        "1_a.mzML",
    ] {
        assert!(!is_input_link(name), "{name}");
    }
}

#[test]
fn link_names_keep_the_name_and_its_suffix() {
    assert_eq!(link_name(0, "/data/x.mzML"), "1__x.mzML");
    assert_eq!(link_name(9, "/data/x.MZML"), "10__x.MZML");
    assert_eq!(link_name(0, "/Daten ä/ünï cøde.mzML"), "1__ünï cøde.mzML");
    assert_eq!(input_stem("1__x.mzML"), "1__x");
    assert_eq!(input_stem("10__x.MZML"), "10__x");
    assert_eq!(input_stem("2__a.b.mzml"), "2__a.b");
    // Thermo .raw files and Bruker .d folders: their suffix too
    assert_eq!(link_name(0, "/data/x.raw"), "1__x.raw");
    assert_eq!(link_name(1, "/data/run.d"), "2__run.d");
    assert_eq!(input_stem("1__x.raw"), "1__x");
    assert_eq!(input_stem("2__run.d"), "2__run");
    assert_eq!(input_stem("3__x.RAW"), "3__x");
    // a long .d name keeps its suffix, the stem shortened
    let long = link_name(0, &format!("/data/{}.d", "x".repeat(260)));
    assert!(
        long.ends_with("x.d") && input_stem(&long).len() == MAX_STEM,
        "{long}"
    );
}

#[test]
fn link_names_of_long_file_names_are_shortened_to_a_unique_stem_with_the_suffix() {
    // 255 bytes: the longest name a file can have, and `1__` makes the link too long for the file system
    let long = format!("{}.mzML", "x".repeat(250));
    let link = link_name(0, &format!("/data/{long}"));
    assert!(
        link.starts_with("1__xxx") && link.ends_with(".mzML"),
        "{link}"
    );
    assert_eq!(input_stem(&link).len(), MAX_STEM, "{link}");
    // OpenNuXL's longest output name fits
    assert_eq!(
        format!("{}_perc_proteins0.0100_XLs.tsv", input_stem(&link)).len(),
        255
    );
    assert!(is_input_link(&link));
    // `<n>__` keeps two such inputs apart, and the suffix stays as it is
    let upper = link_name(11, &format!("/data/{}.MZML", "x".repeat(250)));
    assert!(
        upper.starts_with("12__xxx") && upper.ends_with(".MZML"),
        "{upper}"
    );
    assert_ne!(
        input_stem(&link),
        input_stem(&link_name(1, &format!("/data/{long}")))
    );
    // shortened at a character, never inside one
    let umlauts = link_name(0, &format!("/data/{}.mzML", "ä".repeat(125)));
    assert!(
        input_stem(&umlauts).len() <= MAX_STEM && umlauts.ends_with(".mzML"),
        "{umlauts}"
    );
    assert!(umlauts
        .trim_start_matches("1__")
        .trim_end_matches(".mzML")
        .chars()
        .all(|c| c == 'ä'));
    // a name that fits stays as it is
    let fits = format!("{}.mzML", "y".repeat(MAX_STEM - 3));
    assert_eq!(link_name(0, &format!("/data/{fits}")), format!("1__{fits}"));
}

/// Names whose lower-cased form has another length in bytes: `İ` (2 bytes, lower case 3), `Ⱥ` (2 -> 3),
/// `ẞ` (3 -> 2) and the Kelvin sign (3 -> 1). The stem is the name without its ASCII suffix (ignoring its
/// case), and no name makes the shim panic.
#[test]
fn input_stems_of_names_whose_lower_case_has_another_length() {
    for (link, stem) in [
        ("1__İstanbul_run.mzML", "1__İstanbul_run"),
        ("1__Ⱥ.mzML", "1__Ⱥ"),
        ("2__ẞ.mzML", "2__ẞ"),
        ("2__ẞẞ.MzMl", "2__ẞẞ"),
        ("3__\u{212A}.mzML", "3__\u{212A}"),
        ("4__İ.mZmL", "4__İ"),
        ("5__a.mzML.mzML", "5__a.mzML"),
        ("6__Ⱥ.gz", "6__Ⱥ.gz"),
        (".mzML", ""),
        ("İ", "İ"),
        ("", ""),
    ] {
        assert_eq!(input_stem(link), stem, "{link}");
    }
    for name in ["İstanbul.mzML", "Ⱥ.MZML", "ẞ.mzml", "\u{212A}.mZmL"] {
        assert!(nuxl_desktop_lib::args::is_mzml_file(name), "{name}");
    }
    for name in ["Ⱥ.mzM", "x.mzML.gz", "x.gz", "ẞ", "x.raw", "x.d"] {
        assert!(!nuxl_desktop_lib::args::is_mzml_file(name), "{name}");
    }
    for (link, stem) in [
        ("1__İ.RAW", "1__İ"),
        ("2__ẞ.d", "2__ẞ"),
        ("3__Ⱥ.D", "3__Ⱥ"),
        ("4__a.raw.mzML", "4__a.raw"),
        ("5__a.mzML.d", "5__a.mzML"),
        ("6__a.d.zip", "6__a.d.zip"),
    ] {
        assert_eq!(input_stem(link), stem, "{link}");
    }
    // the records of a search with such inputs carry these stems (the outputs are named after them)
    let req = request(
        &[
            Path::new("/data/İstanbul_run.mzML"),
            Path::new("/data/Ⱥ.mzML"),
            Path::new("/data/ẞ.MZML"),
        ],
        Path::new("/db/x.fasta"),
        false,
        json!({}),
    );
    let folder = Path::new("/s/1-0.partial");
    let stems: Vec<String> = input_records_with(&req, InputLinks::Symlinks, folder)
        .into_iter()
        .map(|r| r.stem)
        .collect();
    assert_eq!(stems, ["1__İstanbul_run", "2__Ⱥ", "3__ẞ"]);
    let own: Vec<String> = input_records_with(&req, InputLinks::PathsOrHardLinks, folder)
        .into_iter()
        .map(|r| r.stem)
        .collect();
    assert_eq!(own, ["İstanbul_run", "Ⱥ", "ẞ"]);
}

// ---- tool resolution ------------------------------------------------------------------------

fn executable(dir: &TempDir, relative: &str) -> PathBuf {
    let path = dir.write(relative, "#!/bin/sh\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

#[test]
fn the_tool_is_found_through_nuxl_tool_then_the_bundle_then_path() {
    let dir = TempDir::new("resolve");
    let env_bin = executable(&dir, "env/OpenNuXL");
    let bundled = executable(&dir, &format!("res/resources/nuxl/bin/{}", tool::EXE));
    let on_path = executable(&dir, &format!("pathdir/{}", tool::EXE));
    let res = dir.path().join("res");
    let path_var = OsString::from(dir.path().join("pathdir"));

    let all = |bin: Option<&Path>| {
        tool::resolve_with(bin.map(Path::as_os_str), Some(&res), Some(&path_var))
    };
    assert_eq!(all(Some(&env_bin)).unwrap(), env_bin);
    assert_eq!(all(None).unwrap(), bundled);
    fs::remove_file(&bundled).unwrap();
    assert_eq!(all(None).unwrap(), on_path);
    fs::remove_file(&on_path).unwrap();
    let err = all(None).unwrap_err();
    assert!(
        err.contains("OpenNuXL") && err.contains("NUXL_TOOL"),
        "{err}"
    );

    // a NUXL_TOOL that does not exist is an error, not a reason to look elsewhere
    let err = tool::resolve_with(
        Some(OsStr::new("/nonexistent/OpenNuXL")),
        Some(&res),
        Some(&path_var),
    )
    .unwrap_err();
    assert!(
        err.contains("NUXL_TOOL") && err.contains("/nonexistent/OpenNuXL"),
        "{err}"
    );
}

#[test]
fn percolator_adapter_is_looked_for_beside_the_tool() {
    let dir = TempDir::new("adapter");
    let nuxl = executable(&dir, &format!("bin/{}", tool::EXE));
    assert!(!tool::has_percolator_adapter(&nuxl));
    executable(&dir, &format!("bin/{}", tool::PERCOLATOR_ADAPTER));
    assert!(tool::has_percolator_adapter(&nuxl));
}

/// macOS: Tauri names no resource folder when the app's path goes through a symbolic link; the app then
/// takes the Resources folder of the bundle its executable really is in.
#[cfg(unix)]
#[test]
fn the_resources_of_an_app_bundle_are_found_through_a_link() {
    let dir = TempDir::new("bundle");
    let exe = executable(&dir, "real/NuXL.app/Contents/MacOS/nuxl-desktop");
    dir.write(
        "real/NuXL.app/Contents/Resources/resources/nuxl/build.json",
        "{}",
    );
    let resources = dir
        .path()
        .join("real/NuXL.app/Contents/Resources")
        .canonicalize()
        .unwrap();
    assert_eq!(tool::bundle_resources(&exe), Some(resources.clone()));
    // the app through a linked folder, and as a linked bundle
    std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("linked")).unwrap();
    std::os::unix::fs::symlink(
        dir.path().join("real/NuXL.app"),
        dir.path().join("Linked.app"),
    )
    .unwrap();
    for through in [
        "linked/NuXL.app/Contents/MacOS/nuxl-desktop",
        "Linked.app/Contents/MacOS/nuxl-desktop",
    ] {
        assert_eq!(
            tool::bundle_resources(&dir.path().join(through)),
            Some(resources.clone()),
            "{through}"
        );
    }
    // not in a bundle: no Resources folder, none
    let loose = executable(&dir, "bin/nuxl-desktop");
    assert_eq!(tool::bundle_resources(&loose), None);
    assert_eq!(tool::bundle_resources(&dir.path().join("nothing")), None);
}

#[test]
fn the_tools_version_is_read_from_its_help() {
    let help = "OpenNuXL -- Annotate RNA/DNA-peptide cross-links in MS/MS spectra.\nFull documentation: http://x\nVersion: 3.7.0-pre-exported-20261020 Oct 20 2026, 22:16:02, Revision: 7b5d88c\nTo cite OpenMS:\n";
    assert_eq!(
        tool::parse_version(help).as_deref(),
        Some("3.7.0-pre-exported-20261020")
    );
    // as OpenMS' Colorizer writes it to a terminal: "Version: " bold
    assert_eq!(
        tool::parse_version("\u{1b}[1mVersion: \u{1b}[0m3.5.0 Jan 1 2026").as_deref(),
        Some("3.5.0")
    );
    assert_eq!(tool::parse_version("nothing"), None);
}

/// `tool::probe` of a script this test process has just written. Another test's child, forked while the script was
/// open for writing, holds that descriptor until its own exec; meanwhile exec of the script fails with ETXTBSY ("Text
/// file busy", os error 26). A test-only race (the app never runs a file it wrote): retried for up to 2 s.
fn probe_written_script(script: &Path) -> Result<tool::ToolInfo, String> {
    let mut result = tool::probe(script);
    for _ in 0..100 {
        match &result {
            Err(e) if e.contains("os error 26") => {
                std::thread::sleep(std::time::Duration::from_millis(20));
                result = tool::probe(script);
            }
            _ => break,
        }
    }
    result
}

#[test]
fn probing_a_tool_reports_its_version_and_path() {
    let dir = TempDir::new("probe");
    // a script on Unix (the help on stderr, as TOPPBase prints it); on Windows the fake tool
    #[cfg(unix)]
    let script = executable(&dir, "OpenNuXL");
    #[cfg(unix)]
    fs::write(
        &script,
        "#!/bin/sh\necho 'Version: 9.9.9 Oct 20 2026' >&2\n",
    )
    .unwrap();
    #[cfg(not(unix))]
    let script = fake_nuxl_exe();
    let info = probe_written_script(&script).unwrap();
    assert_eq!(info.version, "9.9.9");
    assert_eq!(info.path, script.to_string_lossy());
    assert_eq!(
        serde_json::to_value(&info).unwrap(),
        json!({ "version": "9.9.9", "path": script.to_string_lossy() })
    );
    assert!(tool::probe(&dir.path().join("none")).is_err());
    // the fake answers --help as OpenNuXL does
    assert_eq!(probe_written_script(&fake_nuxl()).unwrap().version, "9.9.9");
}

#[test]
fn the_tool_runs_with_one_blas_thread_unless_set() {
    let cmd = tool::command_with(Path::new("/x/OpenNuXL"), None);
    let env: Vec<_> = cmd.get_envs().collect();
    assert!(env.contains(&(OsStr::new("OPENBLAS_NUM_THREADS"), Some(OsStr::new("1")))));
    let cmd = tool::command_with(Path::new("/x/OpenNuXL"), Some(OsString::from("4")));
    assert!(
        cmd.get_envs().all(|(k, _)| k != "OPENBLAS_NUM_THREADS"),
        "the user's value stays"
    );
    // macOS: the loader's search variables never reach the bundled tool
    for name in tool::LOADER_VARIABLES {
        let removed = cmd.get_envs().any(|(k, v)| k == *name && v.is_none());
        assert_eq!(removed, cfg!(target_os = "macos"), "{name}");
    }
}

#[test]
fn the_tool_never_runs_the_update_check_of_openms() {
    for openblas in [None, Some(OsString::from("4"))] {
        let cmd = tool::command_with(Path::new("/x/OpenNuXL"), openblas);
        let set: Vec<_> = cmd
            .get_envs()
            .filter(|(k, _)| *k == "OPENMS_DISABLE_UPDATE_CHECK")
            .collect();
        // set explicitly, so a user's OPENMS_DISABLE_UPDATE_CHECK=OFF (which turns the check on) is replaced
        assert_eq!(
            set,
            vec![(
                OsStr::new("OPENMS_DISABLE_UPDATE_CHECK"),
                Some(OsStr::new("ON"))
            )]
        );
    }
    assert_eq!(tool::NO_UPDATE_CHECK, ("OPENMS_DISABLE_UPDATE_CHECK", "ON"));
}

// ---- running --------------------------------------------------------------------------------

struct Run {
    work: TempDir,
    searches: Arc<Searches>,
    /// The fake OpenNuXL, in a folder laid out as the bundle (with the fake FileConverter beside it).
    tool: PathBuf,
}

impl Run {
    fn new() -> Run {
        Run::with_links(InputLinks::PLATFORM)
    }

    /// With the inputs reaching the tool as `links` says (Windows' way on any platform).
    fn with_links(links: InputLinks) -> Run {
        Run::with(
            links,
            FakeBundle {
                converter: true,
                runtime: false,
            },
        )
    }

    /// With the bundle's parts `bundle` beside the fake tool.
    fn with(links: InputLinks, bundle: FakeBundle) -> Run {
        let work = TempDir::new("run");
        let tool = fake_tools(&work.path().join("nuxl"), bundle);
        Run {
            work,
            searches: Arc::new(Searches::with_links(links)),
            tool,
        }
    }

    fn dir(&self) -> PathBuf {
        self.work.path().join("searches")
    }

    fn start(
        &self,
        req: SearchRequest,
        crap: Option<&Path>,
    ) -> (
        Result<String, String>,
        std::sync::mpsc::Receiver<SearchEvent>,
    ) {
        let (sink, rx) = channel_sink();
        (
            self.searches
                .start(&self.tool, &self.dir(), crap, req, sink),
            rx,
        )
    }

    fn listing(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.dir())
            .map(|d| {
                d.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
}

fn done_folder(events: &[SearchEvent]) -> PathBuf {
    match events.last() {
        Some(SearchEvent::Done(d)) => PathBuf::from(&d.folder),
        other => panic!("not done: {other:?} in {events:?}"),
    }
}

fn outputs_of(folder: &Path, stem: &str) -> Value {
    serde_json::from_str(
        &fs::read_to_string(folder.join(format!("nuxl/{stem}.outputs.json"))).unwrap(),
    )
    .unwrap()
}

fn progress_of(events: &[SearchEvent]) -> Vec<(String, i32, f64)> {
    events
        .iter()
        .filter_map(|e| match e {
            SearchEvent::Progress(p) => Some((p.label.clone(), p.file, p.fraction)),
            _ => None,
        })
        .collect()
}

/// The stem of the `k`-th input (0-based) of a one-input search named `name`, as this platform names it.
fn stem_of(k: usize, name: &str) -> String {
    match InputLinks::PLATFORM {
        InputLinks::Symlinks => format!("{}__{}", k + 1, input_stem(name)),
        InputLinks::PathsOrHardLinks => input_stem(name),
    }
}

#[test]
fn a_search_of_the_users_database_records_its_path_for_the_reader() {
    let run = Run::new();
    let i = inputs();
    let (id, rx) = run.start(request(&[&i.mzml], &i.fasta, false, json!({})), None);
    let id = id.unwrap();
    let folder = done_folder(&until_terminal(&rx, WAIT));
    assert_eq!(folder, run.dir().join(&id));
    assert!(!folder.join("database.fasta").exists());
    let record: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(folder.join("database.json")).unwrap()).unwrap();
    assert_eq!(record["path"].as_str(), i.fasta.to_str());
    assert_eq!(
        nuxl_desktop_lib::files::recorded_database(&folder).as_deref(),
        i.fasta.to_str()
    );
}

#[test]
fn a_search_ends_with_done_its_outputs_recorded_and_the_partial_folder_becomes_the_search_folder() {
    let run = Run::new();
    let i = inputs();
    let crap = i.dir.write("crap.fasta", ">ALBU\nMKW\n");
    let (id, rx) = run.start(request(&[&i.mzml], &i.fasta, true, json!({})), Some(&crap));
    let id = id.unwrap();
    let events = until_terminal(&rx, WAIT);
    let folder = done_folder(&events);

    assert_eq!(folder, run.dir().join(&id));
    assert_eq!(
        run.listing(),
        vec![id.clone()],
        "no .partial folder is left"
    );
    assert!(
        !folder.join(".lock").exists(),
        "the lock file does not belong to the search"
    );
    assert!(fs::read_to_string(folder.join("database.fasta"))
        .unwrap()
        .contains(">CON__ALBU"));
    // OpenNuXL searched the folder's own database: no path outside the folder is recorded
    assert!(!folder.join("database.json").exists());

    // the record of the run's outputs (design §2): Percolator's files, the protein report at the cross-link FDR
    let stem = stem_of(0, "a.mzML");
    let outputs = outputs_of(&folder, &stem);
    let seconds = outputs["seconds"].as_f64().unwrap();
    assert!((0.0..60.0).contains(&seconds), "{outputs}");
    let mut expected = json!({
        "input": 0,
        "all": format!("nuxl/{stem}.idXML"),
        "xls": format!("nuxl/{stem}_perc_1.0000_XLs.idXML"),
        "peptides": format!("nuxl/{stem}_perc_0.0000_peptides.idXML"),
        "proteins": format!("nuxl/{stem}_perc_proteins0.0100_XLs.tsv"),
        "report": format!("nuxl/{stem}_perc.tsv"),
        "percolator": true,
        // (the QPX mz view of the run, which OpenNuXL wrote into nuxl/runs/)
        "mz": format!("nuxl/{stem}.mz.parquet"),
        "notes": ["autotune: too few non-cross-linked peptides found. Will keep parameters as-is."],
        "seconds": seconds,
        "fdr": { "peptide": 0.01, "xl": 0.01 },
    });
    assert_eq!(outputs, expected);
    for key in ["all", "xls", "peptides", "proteins", "report", "mz"] {
        assert!(
            folder.join(outputs[key].as_str().unwrap()).is_file(),
            "{key}"
        );
    }
    assert!(
        !folder.join("nuxl/runs").exists(),
        "nothing is left in nuxl/runs"
    );
    expected["percolator"] = json!(false);

    // the log: the run's command line, then its output
    let log = fs::read_to_string(folder.join("nuxl.log")).unwrap();
    assert!(log.starts_with("$ "), "{log}");
    assert!(log.contains("Running percolator."), "{log}");

    // every event carries the search id; progress stays below 1 (the search is not done before `done`)
    for event in &events {
        match event {
            SearchEvent::Progress(p) => {
                assert_eq!(p.search_id, id);
                assert!(p.fraction < 1.0, "{p:?}");
            }
            SearchEvent::Done(d) => assert_eq!(d.search_id, id),
            SearchEvent::Failed(f) => panic!("{f:?}"),
        }
    }
    let progress = progress_of(&events);
    assert_eq!(
        progress[0],
        ("Searching a.mzML (1 of 1)...".to_string(), 0, 0.0)
    );
    let labels: Vec<&str> = progress.iter().map(|p| p.0.as_str()).collect();
    for label in [
        "Scoring a.mzML (1 of 1)... this step 33 %",
        "Percolator: a.mzML (1 of 1)...",
    ] {
        assert!(labels.contains(&label), "{label} in {labels:?}");
    }
    for pair in progress.windows(2) {
        assert!(pair[1].2 >= pair[0].2, "{pair:?}");
    }
    // the fake ran with exactly the arguments build_runs makes for the partial folder
    let argv = fs::read_to_string(folder.join(format!("nuxl/{stem}.argv.txt"))).unwrap();
    let input = match InputLinks::PLATFORM {
        InputLinks::Symlinks => run.dir().join(format!("{id}.partial")).join("1__a.mzML"),
        InputLinks::PathsOrHardLinks => i.mzml.clone(),
    };
    assert_eq!(
        argv.lines().nth(1).map(PathBuf::from),
        Some(input),
        "{argv}"
    );
    // nothing was written next to the input
    let mut data: Vec<_> = fs::read_dir(i.mzml.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    data.sort();
    assert_eq!(data, ["a.mzML", "db.fasta"]);
}

#[test]
fn the_inputs_are_searched_one_after_the_other_each_with_its_outputs() {
    let run = Run::new();
    let i = inputs();
    let b = i.dir.write("data/b.mzML", "<mzML/>");
    let few = i.dir.write("data/fewpsms.mzML", "<mzML/>");
    let (_, rx) = run.start(
        request(&[&i.mzml, &few, &b], &i.fasta, false, json!({})),
        None,
    );
    let events = until_terminal(&rx, WAIT);
    let folder = done_folder(&events);
    // in order, one run each
    let resolved = fs::read_to_string(folder.join("inputs.txt")).unwrap();
    let ran: Vec<&str> = resolved
        .lines()
        .map(|l| l.split(" -> ").next().unwrap())
        .collect();
    assert_eq!(ran.len(), 3, "{resolved}");
    for (line, name) in ran.iter().zip(["a.mzML", "fewpsms.mzML", "b.mzML"]) {
        assert!(line.ends_with(name), "{line} {name}");
    }
    let log = fs::read_to_string(folder.join("nuxl.log")).unwrap();
    assert_eq!(
        log.lines().filter(|l| l.starts_with("$ ")).count(),
        3,
        "{log}"
    );
    // each input's record; the run with too few PSMs has the plain files and says why
    let few_outputs = outputs_of(&folder, &stem_of(1, "fewpsms.mzML"));
    let stem = stem_of(1, "fewpsms.mzML");
    assert_eq!(few_outputs["input"], 1);
    assert_eq!(few_outputs["percolator"], false);
    assert_eq!(few_outputs["xls"], format!("nuxl/{stem}_1.0000_XLs.idXML"));
    assert_eq!(few_outputs["report"], format!("nuxl/{stem}.tsv"));
    assert!(
        few_outputs["notes"]
            .as_array()
            .unwrap()
            .contains(&json!("Too few PSMs for score recalibration. Skipped.")),
        "{few_outputs}"
    );
    assert_eq!(outputs_of(&folder, &stem_of(2, "b.mzML"))["input"], 2);
    assert_eq!(
        outputs_of(&folder, &stem_of(0, "a.mzML"))["percolator"],
        true
    );
    // progress: each run in its third of the bar, in order
    let progress = progress_of(&events);
    let starts: Vec<&(String, i32, f64)> = progress
        .iter()
        .filter(|p| p.0.starts_with("Searching"))
        .collect();
    assert_eq!(
        starts
            .iter()
            .map(|p| (p.0.as_str(), p.1))
            .collect::<Vec<_>>(),
        [
            ("Searching a.mzML (1 of 3)...", 0),
            ("Searching fewpsms.mzML (2 of 3)...", 1),
            ("Searching b.mzML (3 of 3)...", 2),
        ]
    );
    for (k, start) in starts.iter().enumerate() {
        assert!((start.2 - k as f64 / 3.0).abs() < 1e-9, "{start:?}");
    }
    for pair in progress.windows(2) {
        assert!(pair[1].2 >= pair[0].2 && pair[1].1 >= pair[0].1, "{pair:?}");
    }
}

#[test]
fn the_cutoffs_and_the_rescoring_of_the_request_shape_the_outputs() {
    let run = Run::new();
    let i = inputs();
    // no rescoring, a cross-link FDR above 10 %: the plain files, no protein report
    let mut req = request(&[&i.mzml], &i.fasta, false, json!({}));
    req.settings.rescore = false;
    req.settings.xl_fdr = 0.2;
    req.settings.peptide_fdr = 0.05;
    let (_, rx) = run.start(req, None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let stem = stem_of(0, "a.mzML");
    let outputs = outputs_of(&folder, &stem);
    assert_eq!(outputs["percolator"], false);
    assert_eq!(outputs["xls"], format!("nuxl/{stem}_1.0000_XLs.idXML"));
    assert_eq!(outputs["proteins"], Value::Null);
    assert_eq!(outputs["fdr"], json!({ "peptide": 0.05, "xl": 0.2 }));
    // 5 %: the protein report at it
    let mut req = request(&[&i.mzml], &i.fasta, false, json!({}));
    req.settings.xl_fdr = 0.05;
    let (_, rx) = run.start(req, None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    assert_eq!(
        outputs_of(&folder, &stem)["proteins"],
        format!("nuxl/{stem}_perc_proteins0.0500_XLs.tsv")
    );
}

/// OpenNuXL warns "Too few PSMs for score recalibration. Skipped." for a run of fewer than 1000 PSMs also with
/// `-percolator_backend none` (OpenNuXL.cpp: the `else` of `recalibrate && sufficient_PSMs...`); with the
/// rescoring off, Percolator was not skipped but not asked for, so the note is left out.
#[test]
fn too_few_psms_is_no_note_when_the_rescoring_is_off() {
    let run = Run::new();
    let i = inputs();
    let few = i.dir.write("data/fewpsms.mzML", "<mzML/>");
    let mut req = request(&[&few], &i.fasta, false, json!({}));
    req.settings.rescore = false;
    let (_, rx) = run.start(req, None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let log = fs::read_to_string(folder.join("nuxl.log")).unwrap();
    assert!(
        log.contains("Too few PSMs for score recalibration."),
        "{log}"
    );
    let outputs = outputs_of(&folder, &stem_of(0, "fewpsms.mzML"));
    assert_eq!(outputs["percolator"], false);
    assert!(
        !outputs["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n.as_str().unwrap().starts_with("Too few PSMs")),
        "{outputs}"
    );
}

/// A cross-link FDR below 0.00005 (`-report:xlFDR 1.0 1e-05`): OpenNuXL names the filtered file `_0.0000_XLs`
/// (`%.4f`), which is not the unfiltered one; `xls` stays `_1.0000_`.
#[test]
fn a_cross_link_fdr_that_rounds_to_zero_keeps_the_unfiltered_cross_links() {
    let run = Run::new();
    let i = inputs();
    let mut req = request(&[&i.mzml], &i.fasta, false, json!({}));
    req.settings.xl_fdr = 1e-5;
    let (_, rx) = run.start(req, None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let stem = stem_of(0, "a.mzML");
    assert!(folder
        .join(format!("nuxl/{stem}_perc_0.0000_XLs.idXML"))
        .is_file());
    let outputs = outputs_of(&folder, &stem);
    assert_eq!(outputs["xls"], format!("nuxl/{stem}_perc_1.0000_XLs.idXML"));
    assert_eq!(
        outputs["proteins"],
        format!("nuxl/{stem}_perc_proteins0.0000_XLs.tsv")
    );
}

/// OpenNuXL writes `<-in>.ambiguous_masses.csv` beside its `-in` in every run (calculateNucleotideTags_). Through
/// a link that is the search folder, which drops it; by the file's own path (Windows' way) beside the user's
/// file, where the shim removes the one the run made but never one that was there before.
#[test]
fn the_tools_debug_table_beside_the_input_is_not_left_behind() {
    let table = |p: &Path| PathBuf::from(format!("{}.ambiguous_masses.csv", p.display()));
    // a link in the search folder
    let run = Run::new();
    let i = inputs();
    let (_, rx) = run.start(request(&[&i.mzml], &i.fasta, false, json!({})), None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let names: Vec<String> = fs::read_dir(&folder)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !names.iter().any(|n| n.ends_with(".ambiguous_masses.csv")),
        "{names:?}"
    );
    assert!(!table(&i.mzml).exists());

    // the user's own path: the run's table is removed, one of the user's stays
    let run = Run::with_links(InputLinks::PathsOrHardLinks);
    let b = i.dir.write("other/b.mzML", "<mzML/>");
    let kept = i.dir.write("other/c.mzML", "<mzML/>");
    fs::write(table(&kept), "the user's").unwrap();
    let (_, rx) = run.start(request(&[&b, &kept], &i.fasta, false, json!({})), None);
    done_folder(&until_terminal(&rx, WAIT));
    assert!(!table(&b).exists(), "the run's table is gone");
    assert!(table(&kept).is_file(), "a table that was there stays");
    let mut left: Vec<String> = fs::read_dir(b.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, ["b.mzML", "c.mzML", "c.mzML.ambiguous_masses.csv"]);
}

// ---- the spectra for the PSM view: OpenNuXL's QPX mz view of each run ------------------------------

/// The text of the fake's mz view of the input `-in` (a placeholder; real ones are the e2e fixtures').
fn fake_view_of(view: &Path) -> String {
    String::from_utf8(fs::read(view).unwrap()).unwrap()
}

/// A search of an mzML, a Thermo .raw and a Bruker .d: each run's mz view, which OpenNuXL writes into nuxl/runs/
/// (named after its -in) after its other outputs, is moved to nuxl/<stem>.mz.parquet and recorded in outputs.json,
/// with the progress of its last step; nothing is left in nuxl/runs/, beside the inputs or in the search folder.
#[test]
fn every_runs_mz_view_is_moved_into_place_and_recorded() {
    let run = Run::new();
    let i = inputs();
    let raw = i.dir.write("data/b.raw", "raw");
    let d = bruker_d(&i.dir, "data/c.d");
    let (_, rx) = run.start(
        request(&[&i.mzml, &raw, &d], &i.fasta, false, json!({})),
        None,
    );
    let events = until_terminal(&rx, WAIT);
    let folder = done_folder(&events);
    let progress = progress_of(&events);
    let labels: Vec<&str> = progress.iter().map(|p| p.0.as_str()).collect();
    for label in [
        "Reading the spectra of a.mzML (1 of 3)...",
        "Reading the spectra of b.raw (2 of 3)...",
        "Reading the spectra of c.d (3 of 3)...",
        "Preparing the spectra of a.mzML for the PSM view (1 of 3)...",
        "Preparing the spectra of b.raw for the PSM view (2 of 3)...",
        "Preparing the spectra of c.d for the PSM view (3 of 3)...",
    ] {
        assert!(labels.contains(&label), "{label} in {labels:?}");
    }
    for pair in progress.windows(2) {
        assert!(pair[1].2 >= pair[0].2, "{pair:?}");
    }
    // the mz view is in its run's part of the bar
    let view = progress
        .iter()
        .find(|p| p.0.starts_with("Preparing the spectra of b.raw for"))
        .unwrap();
    assert!(
        view.1 == 1 && view.2 > 1.0 / 3.0 && view.2 < 2.0 / 3.0,
        "{view:?}"
    );

    for (k, name) in [(0, "a.mzML"), (1, "b.raw"), (2, "c.d")] {
        let stem = stem_of(k, name);
        let outputs = outputs_of(&folder, &stem);
        assert_eq!(
            outputs["mz"],
            json!(format!("nuxl/{stem}.mz.parquet")),
            "{outputs}"
        );
        // the view of this run's input (OpenNuXL's -in)
        let nuxl_argv = fs::read_to_string(folder.join(format!("nuxl/{stem}.argv.txt"))).unwrap();
        let lines: Vec<&str> = nuxl_argv.lines().collect();
        let input = lines[lines.iter().position(|l| *l == "-in").unwrap() + 1];
        let qpx = lines[lines.iter().position(|l| *l == "-out_qpx").unwrap() + 1];
        assert!(qpx.ends_with("nuxl"), "{qpx}");
        let text = fake_view_of(&folder.join(format!("nuxl/{stem}.mz.parquet")));
        assert!(
            text.contains(&format!(
                "the fake mz view of {}",
                input.trim_end_matches(['/', '\\'])
            )),
            "{text}"
        );
        assert!(
            !outputs["notes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|n| n.as_str().unwrap().contains("PSM view")),
            "{outputs}"
        );
    }
    assert!(!folder.join("nuxl/runs").exists());
    let log = fs::read_to_string(folder.join("nuxl.log")).unwrap();
    let commands: Vec<&str> = log.lines().filter(|l| l.starts_with("$ ")).collect();
    assert_eq!(commands.len(), 3, "three runs, nothing else: {log}");
    assert_eq!(log.matches("-out_qpx: wrote ").count(), 3, "{log}");
    // the inputs are the user's: nothing beside them (OpenNuXL's debug table goes)
    let mut left: Vec<String> = fs::read_dir(i.dir.path().join("data"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, ["a.mzML", "b.raw", "c.d", "db.fasta"]);
    assert_eq!(
        fs::read_dir(&d).unwrap().count(),
        2,
        "nothing inside the .d either"
    );
    // nor in the search folder: the debug table beside the link to the .d (`3__c.d.ambiguous_masses.csv`) is gone
    let names: Vec<String> = fs::read_dir(&folder)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !names.iter().any(|n| n.ends_with(".ambiguous_masses.csv")),
        "{names:?}"
    );
}

/// Windows' way (on any platform): a .d folder by its own path, beside a .raw of its name as a hard link. OpenNuXL
/// names each view after its -in (the user's `a`, the link's `2__a`); the shim moves each to its stem's name.
#[test]
fn the_windows_way_moves_the_views_of_own_paths_and_hard_links() {
    let run = Run::with_links(InputLinks::PathsOrHardLinks);
    let i = inputs();
    let d = bruker_d(&i.dir, "data/a.d");
    let raw = i.dir.write("other/a.raw", "raw");
    let (_, rx) = run.start(request(&[&d, &raw], &i.fasta, false, json!({})), None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let own = outputs_of(&folder, "a");
    assert_eq!(own["mz"], json!("nuxl/a.mz.parquet"), "{own}");
    assert!(fake_view_of(&folder.join("nuxl/a.mz.parquet")).contains(&format!("{}", d.display())));
    let linked = outputs_of(&folder, "2__a");
    assert_eq!(linked["mz"], json!("nuxl/2__a.mz.parquet"), "{linked}");
    assert!(fake_view_of(&folder.join("nuxl/2__a.mz.parquet")).contains("2__a.raw"));
    assert!(!folder.join("nuxl/runs").exists());
    let mut beside: Vec<String> = fs::read_dir(i.dir.path().join("data"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    beside.sort();
    assert_eq!(beside, ["a.d", "a.mzML", "db.fasta"]);
    assert!(!folder.join("2__a.raw").exists(), "the hard link is gone");
}

/// A run whose mz view OpenNuXL could not write (its `-out_qpx:` warning) fails not the search: the input's results
/// are there, `mz` null, and a note says why the PSM view shows the annotated peaks only (OpenNuXL's warning, with
/// the search's final folder for its partial one). The next input's view is its own.
#[test]
fn an_mz_view_opennuxl_could_not_write_leaves_a_note_and_not_a_failed_search() {
    let run = Run::new();
    let i = inputs();
    let fail = i.dir.write("data/qpxfail.raw", "raw");
    let (_, rx) = run.start(request(&[&fail, &i.mzml], &i.fasta, false, json!({})), None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let failed = outputs_of(&folder, &stem_of(0, "qpxfail.raw"));
    assert_eq!(failed["mz"], Value::Null, "{failed}");
    assert!(failed["all"].is_string(), "{failed}");
    let notes: Vec<&str> = failed["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    let note = notes
        .iter()
        .find(|n| n.starts_with("The PSM view shows the annotated peaks only: the spectra of qpxfail.raw could not be kept ("))
        .unwrap_or_else(|| panic!("{notes:?}"));
    assert!(
        note.contains("cannot be read again (the fake cannot)")
            && !note.contains(".partial")
            && !note.contains("-out_qpx:"),
        "{note}"
    );
    assert!(
        !notes.iter().any(|n| n.starts_with("-out_qpx:")),
        "{notes:?}"
    );
    let next = outputs_of(&folder, &stem_of(1, "a.mzML"));
    let stem = stem_of(1, "a.mzML");
    assert_eq!(
        next["mz"],
        json!(format!("nuxl/{stem}.mz.parquet")),
        "{next}"
    );
    assert!(fake_view_of(&folder.join(format!("nuxl/{stem}.mz.parquet"))).contains("a.mzML"));
    assert!(!folder
        .join(format!("nuxl/{}.mz.parquet", stem_of(0, "qpxfail.raw")))
        .exists());
}

/// The tool of a bundle runs with its .NET runtime and Thermo bridge (which read a .raw, also for the mz view); a tool
/// without them (a build tree's) with the user's environment.
#[test]
fn the_tools_run_with_the_bundles_dotnet_and_thermo_bridge() {
    let run = Run::with(
        InputLinks::PLATFORM,
        FakeBundle {
            converter: true,
            runtime: true,
        },
    );
    let i = inputs();
    let raw = i.dir.write("data/b.raw", "raw");
    let (_, rx) = run.start(request(&[&raw], &i.fasta, false, json!({})), None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let root = run.tool.parent().unwrap().parent().unwrap();
    let stem = stem_of(0, "b.raw");
    let dump = format!("nuxl/{stem}.env.txt");
    let env = env_dump(&folder.join(&dump));
    let get = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    assert_eq!(get("DOTNET_ROOT"), root.join("dotnet").to_str(), "{dump}");
    assert_eq!(
        get("OPENMS_THERMO_MANAGED_DIR"),
        root.join("share/OpenMS/openms_thermo_bridge/managed")
            .to_str(),
        "{dump}"
    );
    assert_eq!(get("DOTNET_ROLL_FORWARD"), Some("Major"), "{dump}");
    assert_eq!(
        get("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT"),
        Some("1"),
        "{dump}"
    );
    assert_eq!(get("OPENMS_DISABLE_UPDATE_CHECK"), Some("ON"), "{dump}");
}

/// The environment of the tools' command: with a bundle's .NET runtime its folder, and without the variables of the
/// host that would win over it; with the bundle's Thermo bridge its managed part. A tool without them keeps the
/// user's variables.
#[test]
fn the_tools_command_names_the_bundles_dotnet_and_thermo_bridge() {
    let dir = TempDir::new("bundle-env");
    let bundled = fake_tools(
        &dir.path().join("bundle"),
        FakeBundle {
            converter: true,
            runtime: true,
        },
    );
    let env_of = |path: &Path| -> Vec<(String, Option<String>)> {
        tool::command_with(path, None)
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect()
    };
    let env = env_of(&bundled);
    let get = |env: &[(String, Option<String>)], name: &str| {
        env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    };
    let root = dir.path().join("bundle");
    assert_eq!(
        get(&env, "DOTNET_ROOT"),
        Some(Some(root.join("dotnet").to_string_lossy().into_owned()))
    );
    for name in tool::DOTNET_ARCH_ROOTS {
        assert_eq!(get(&env, name), Some(None), "{name} is removed");
    }
    assert_eq!(get(&env, "DOTNET_ROLL_FORWARD"), Some(Some("Major".into())));
    assert_eq!(
        get(&env, "DOTNET_CLI_TELEMETRY_OPTOUT"),
        Some(Some("1".into()))
    );
    assert_eq!(
        get(&env, "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT"),
        Some(Some("1".into()))
    );
    assert_eq!(
        get(&env, tool::THERMO_MANAGED_DIR),
        Some(Some(
            root.join("share/OpenMS/openms_thermo_bridge/managed")
                .to_string_lossy()
                .into_owned()
        ))
    );
    // FileConverter of the bundle: the same
    let converter = tool::file_converter(&bundled).unwrap();
    assert_eq!(
        converter,
        bundled.parent().unwrap().join(tool::FILE_CONVERTER)
    );
    assert_eq!(env_of(&converter), env);
    // a build tree's tool: nothing of .NET or the bridge is set or removed
    let plain = fake_tools(&dir.path().join("build"), FakeBundle::default());
    let env = env_of(&plain);
    assert!(
        env.iter()
            .all(|(k, _)| !k.starts_with("DOTNET_") && k != tool::THERMO_MANAGED_DIR),
        "{env:?}"
    );
    assert_eq!(tool::file_converter(&plain), None);
}

#[test]
fn a_database_with_decoys_is_searched_without_them_and_says_so() {
    let run = Run::new();
    let i = inputs();
    let td = i.dir.write(
        "data/td.fasta",
        ">P1\nMKWV\n>P2\nAAAK\n>DECOY_P1\nVWKM\n>DECOY_P2\nKAAA\n",
    );
    let (_, rx) = run.start(request(&[&i.mzml], &td, false, json!({})), None);
    let folder = done_folder(&until_terminal(&rx, WAIT));
    assert_eq!(
        headers(&fs::read_to_string(folder.join("database.fasta")).unwrap()),
        [">P1", ">P2"]
    );
    assert!(!folder.join("database.json").exists());
    let notes = outputs_of(&folder, &stem_of(0, "a.mzML"))["notes"].clone();
    assert!(
        notes.as_array().unwrap().iter().any(|n| n
            .as_str()
            .unwrap()
            .contains("2 decoys (the prefix DECOY_) were left out")),
        "{notes}"
    );
}

#[cfg(unix)]
#[test]
fn two_inputs_with_the_same_name_from_different_folders_are_both_searched() {
    let run = Run::new();
    let i = inputs();
    let first = i.dir.write("run1/sample.mzML", "<mzML>first</mzML>");
    let second = i.dir.write("run2/sample.mzML", "<mzML>second</mzML>");
    let (id, rx) = run.start(
        request(&[&first, &second], &i.fasta, false, json!({})),
        None,
    );
    let id = id.unwrap();
    let folder = done_folder(&until_terminal(&rx, WAIT));
    assert_eq!(folder, run.dir().join(&id));

    // the tool got two differently named files, each one a link to its own original
    let resolved = fs::read_to_string(folder.join("inputs.txt")).unwrap();
    let lines: Vec<&str> = resolved.lines().collect();
    assert_eq!(lines.len(), 2, "{resolved}");
    assert!(
        lines[0].contains("/1__sample.mzML ->")
            && lines[0].ends_with(first.canonicalize().unwrap().to_str().unwrap()),
        "{resolved}"
    );
    assert!(
        lines[1].contains("/2__sample.mzML ->")
            && lines[1].ends_with(second.canonicalize().unwrap().to_str().unwrap()),
        "{resolved}"
    );
    assert!(
        folder.join("nuxl/1__sample.idXML").is_file()
            && folder.join("nuxl/2__sample.idXML").is_file()
    );

    // links, not copies; the mapping is recorded for the results
    for (n, original) in [(1, &first), (2, &second)] {
        let link = folder.join(format!("{n}__sample.mzML"));
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "{link:?} is a link"
        );
        assert_eq!(
            fs::read_link(&link).unwrap(),
            original.canonicalize().unwrap()
        );
    }
    let mapping: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("inputs.json")).unwrap()).unwrap();
    assert_eq!(
        mapping,
        json!([
            { "id": "f0", "index": 0, "link": "1__sample.mzML", "stem": "1__sample", "name": "sample.mzML", "path": first },
            { "id": "f1", "index": 1, "link": "2__sample.mzML", "stem": "2__sample", "name": "sample.mzML", "path": second },
        ])
    );
}

#[test]
fn an_input_of_a_255_byte_name_is_searched_and_maps_back_to_its_file() {
    let run = Run::new();
    let i = inputs();
    let name = format!("{}.mzML", "n".repeat(250));
    let long = i.dir.write(&format!("long/{name}"), "<mzML/>");
    let (id, rx) = run.start(request(&[&long], &i.fasta, false, json!({})), None);
    let id = id.unwrap();
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let mapping: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("inputs.json")).unwrap()).unwrap();
    let link = mapping[0]["link"].as_str().unwrap().to_string();
    let stem = mapping[0]["stem"].as_str().unwrap().to_string();
    assert_eq!(mapping[0]["name"], name.as_str());
    assert_eq!(mapping[0]["path"], long.to_str().unwrap());
    assert_eq!(stem, input_stem(&link));
    // the stem as long as the folder allows: MAX_STEM, on Windows less (MAX_PATH)
    let partial = run.dir().join(format!("{id}.partial"));
    let max = max_stem(InputLinks::PLATFORM, &partial);
    assert!(max <= MAX_STEM && max > 20, "{max}");
    assert!(link.len() <= 255 && stem.len() == max, "{link}");
    assert!(
        link.starts_with("1__nnn") && link.ends_with(".mzML"),
        "{link}"
    );
    if cfg!(windows) {
        // a hard link (the name is too long for the outputs), which the finished search drops
        assert!(!folder.join(&link).exists(), "{link} is gone");
    } else {
        assert!(fs::symlink_metadata(folder.join(&link))
            .unwrap()
            .file_type()
            .is_symlink());
    }
    // the reader finds the input's outputs through the record named after the stem inputs.json records,
    // and the longest of them fits
    let outputs = outputs_of(&folder, &stem);
    assert_eq!(
        outputs["proteins"],
        format!("nuxl/{stem}_perc_proteins0.0100_XLs.tsv")
    );
    // Windows: such an input goes as a (shortened) link, not by its own path
    let req = request(&[&long, &i.mzml], &i.fasta, false, json!({}));
    let windows =
        Path::new(r"C:\Users\u\AppData\Roaming\org.openms.nuxl.desktop\searches\1-0.partial");
    assert_eq!(
        input_placements(&req, InputLinks::PathsOrHardLinks, windows),
        vec![Placement::HardLink, Placement::OwnPath]
    );
    let records = input_records_with(&req, InputLinks::PathsOrHardLinks, windows);
    assert_eq!(
        records[0].stem.len(),
        max_stem(InputLinks::PathsOrHardLinks, windows)
    );
    assert!(records[0].link.starts_with("1__nnn") && records[0].link.ends_with(".mzML"));
    assert_eq!(records[1].link, "a.mzML");
}

/// Windows' MAX_PATH (259 characters): the stems of the links are as short as the search folder's path needs,
/// so that OpenNuXL's longest output (`nuxl\<stem>_perc_proteins0.0100_XLs.tsv`) and every link stay within it;
/// a name that fits MAX_STEM but not the folder goes as a shortened link too; a folder of too long a path is
/// refused before anything is made.
#[test]
fn on_windows_the_search_folders_paths_stay_within_max_path() {
    let windows = InputLinks::PathsOrHardLinks;
    let dir = TempDir::new("maxpath");
    let fasta = dir.write("db.fasta", ">a\nMK\n");
    // a name of 150 bytes: within MAX_STEM, too long under a folder of 100 characters
    let name = format!("{}.mzML", "m".repeat(145));
    let long = dir.write(&format!("in/{name}"), "<mzML/>");
    let short = dir.write("in/b.mzML", "<mzML/>");
    let twin = dir.write("other/b.mzML", "<mzML/>");
    let req = request(&[&long, &short, &twin], &fasta, false, json!({}));
    let folder = format!(
        r"C:\{}\searches\1792841343610-0.partial",
        "d".repeat(100 - 36)
    );
    let folder = Path::new(&folder);
    assert_eq!(folder.as_os_str().len(), 100);
    let max = max_stem(windows, folder);
    assert_eq!(
        max,
        259 - 100 - r"\nuxl\".len() - "_perc_proteins0.0100_XLs.tsv".len()
    );
    // elsewhere only the file name limit counts
    assert_eq!(max_stem(InputLinks::Symlinks, folder), MAX_STEM);
    let records = input_records_with(&req, windows, folder);
    assert_eq!(
        input_placements(&req, windows, folder),
        [
            Placement::HardLink,
            Placement::HardLink,
            Placement::HardLink
        ]
    );
    let links: Vec<&str> = records.iter().map(|r| r.link.as_str()).collect();
    assert_eq!(links[1..], ["2__b.mzML", "3__b.mzML"]);
    assert_eq!(records[0].stem.len(), max);
    assert!(links[0].starts_with("1__mmm") && links[0].ends_with(".mzML"));
    assert_eq!(records[0].name, name);
    for r in &records {
        let longest = format!(
            r"{}\nuxl\{}_perc_proteins0.0100_XLs.tsv",
            folder.display(),
            r.stem
        );
        let link = format!(r"{}\{}", folder.display(), r.link);
        assert!(
            longest.encode_utf16().count() <= 259 && link.encode_utf16().count() <= 259,
            "{longest}"
        );
    }
    let plan = plan_database(&req).unwrap();
    let runs = build_runs_with(&req, folder, windows, &plan).unwrap();
    assert_eq!(
        values_of(&runs[0], "-in")[0],
        folder.join(&records[0].link).into_os_string()
    );
    // a multi-byte name: the stem's bytes bound its UTF-16 units
    let umlauts = dir.write(&format!("in/{}.mzML", "ä".repeat(100)), "<mzML/>");
    let req = request(&[&umlauts], &fasta, false, json!({}));
    let r = &input_records_with(&req, windows, folder)[0];
    assert!(
        r.stem.len() <= max && r.link.ends_with(".mzML"),
        "{}",
        r.link
    );
    // a name that fits stays the user's own path
    let req = request(&[&short], &fasta, false, json!({}));
    assert_eq!(
        input_placements(&req, windows, folder),
        [Placement::OwnPath]
    );
    // a folder that leaves no room for OpenNuXL's outputs is refused
    let deep = format!(r"C:\{}\1-0.partial", "d".repeat(220));
    let err = build_runs_with(&req, Path::new(&deep), windows, &plan).unwrap_err();
    assert!(
        err.contains("too long a path") && err.contains("259"),
        "{err}"
    );
}

/// Windows' way (`InputLinks::PathsOrHardLinks`), run on every platform: inputs of different names go to
/// the tool by their own paths, and nothing of them is in the search folder.
#[test]
fn inputs_of_different_names_go_to_the_tool_by_their_own_paths() {
    let run = Run::with_links(InputLinks::PathsOrHardLinks);
    let i = inputs();
    let b = i.dir.write("other/b.mzML", "<mzML/>");
    let (id, rx) = run.start(request(&[&i.mzml, &b], &i.fasta, false, json!({})), None);
    let id = id.unwrap();
    let folder = done_folder(&until_terminal(&rx, WAIT));
    assert_eq!(folder, run.dir().join(&id));
    for (stem, path) in [("a", &i.mzml), ("b", &b)] {
        let argv = fs::read_to_string(folder.join(format!("nuxl/{stem}.argv.txt"))).unwrap();
        assert_eq!(
            argv.lines().nth(1).map(PathBuf::from).as_ref(),
            Some(path),
            "{argv}"
        );
        assert!(folder.join(format!("nuxl/{stem}.outputs.json")).is_file());
    }
    let mapping: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("inputs.json")).unwrap()).unwrap();
    assert_eq!(
        mapping,
        json!([
            { "id": "f0", "index": 0, "link": "a.mzML", "stem": "a", "name": "a.mzML", "path": i.mzml },
            { "id": "f1", "index": 1, "link": "b.mzML", "stem": "b", "name": "b.mzML", "path": b },
        ])
    );
    let names: Vec<String> = fs::read_dir(&folder)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!names.iter().any(|n| n.ends_with(".mzML")), "{names:?}");
}

/// Windows' way, run on every platform: two inputs of one name go to the tool as hard links in the
/// search folder, which are gone when the search is done; the user's files stay as they are.
#[test]
fn inputs_of_one_name_go_as_hard_links_that_the_finished_search_drops() {
    let run = Run::with_links(InputLinks::PathsOrHardLinks);
    let i = inputs();
    let first = i.dir.write("run1/sample.mzML", "<mzML>first</mzML>");
    let second = i.dir.write("run2/Sample.mzML", "<mzML>second</mzML>");
    let (id, rx) = run.start(
        request(&[&first, &second], &i.fasta, false, json!({})),
        None,
    );
    let id = id.unwrap();
    let folder = done_folder(&until_terminal(&rx, WAIT));
    assert_eq!(folder, run.dir().join(&id));
    let resolved = fs::read_to_string(folder.join("inputs.txt")).unwrap();
    let partial = run.dir().join(format!("{id}.partial"));
    for (n, name) in [(1, "1__sample.mzML"), (2, "2__Sample.mzML")] {
        let line = resolved.lines().nth(n - 1).unwrap_or_default();
        assert!(
            line.starts_with(&format!("{} ->", partial.join(name).display())),
            "{resolved}"
        );
        assert!(!folder.join(name).exists(), "{name} is gone");
    }
    assert!(
        folder.join("nuxl/1__sample.idXML").is_file()
            && folder.join("nuxl/2__Sample.idXML").is_file()
    );
    assert_eq!(fs::read_to_string(&first).unwrap(), "<mzML>first</mzML>");
    assert_eq!(fs::read_to_string(&second).unwrap(), "<mzML>second</mzML>");
    let mapping: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("inputs.json")).unwrap()).unwrap();
    assert_eq!(mapping[0]["link"], "1__sample.mzML");
    assert_eq!(mapping[1]["stem"], "2__Sample");
    assert_eq!(mapping[1]["path"], json!(second));
}

/// Windows' way: a hard link cannot leave its volume. Two inputs of one name, one of them on another
/// volume than the searches folder (on the CI runner: the checkout on D:, the temporary folder on C:),
/// are refused with a message that asks to rename one; nothing is copied, no folder is left.
#[test]
fn inputs_of_one_name_on_another_volume_are_refused() {
    let elsewhere =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("volume-{}", std::process::id()));
    fs::create_dir_all(&elsewhere).unwrap();
    let far = elsewhere.join("sample.mzML");
    fs::write(&far, "<mzML>far</mzML>").unwrap();
    let run = Run::with_links(InputLinks::PathsOrHardLinks);
    fs::create_dir_all(run.dir()).unwrap();
    let probe = run.dir().join("probe");
    let same_volume = fs::hard_link(&far, &probe).is_ok();
    let _ = fs::remove_file(&probe);
    if same_volume {
        let _ = fs::remove_dir_all(&elsewhere);
        eprintln!(
            "skipped: {} and {} are on one volume",
            elsewhere.display(),
            run.dir().display()
        );
        return;
    }
    let i = inputs();
    let near = i.dir.write("near/sample.mzML", "<mzML>near</mzML>");
    let (result, _rx) = run.start(request(&[&near, &far], &i.fasta, false, json!({})), None);
    let err = result.unwrap_err();
    assert!(
        err.contains("Two inputs are named sample.mzML")
            && err.contains("Rename one of the files")
            && err.contains(&far.display().to_string()),
        "{err}"
    );
    assert!(
        run.listing().is_empty(),
        "no folder is left: {:?}",
        run.listing()
    );
    // a name that begins another's, on the other volume: its own reason
    let prefixed = elsewhere.join("near_perc.mzML");
    fs::write(&prefixed, "<mzML/>").unwrap();
    let plain = i.dir.write("near/near.mzML", "<mzML/>");
    let (result, _rx) = run.start(
        request(&[&plain, &prefixed], &i.fasta, false, json!({})),
        None,
    );
    let err = result.unwrap_err();
    assert!(
        err.contains("would be confused with those of another input")
            && !err.contains("Two inputs"),
        "{err}"
    );
    // a lone input whose name is too long for OpenNuXL's outputs in the search folder: its own reason too
    let long = elsewhere.join(format!("{}.mzML", "l".repeat(240)));
    fs::write(&long, "<mzML/>").unwrap();
    let (result, _rx) = run.start(request(&[&long], &i.fasta, false, json!({})), None);
    let err = result.unwrap_err();
    let _ = fs::remove_dir_all(&elsewhere);
    assert!(
        err.contains("is too long for OpenNuXL's result files")
            && err.contains("Rename the file to a shorter name")
            && !err.contains("Two inputs"),
        "{err}"
    );
}

// ---- failures -------------------------------------------------------------------------------

/// OpenMS' line of an output it cannot write: the message, with the output named as in the search folder
/// (which is gone) and after the user's file.
#[test]
fn a_failure_names_the_cause_and_the_outputs_without_the_search_folder() {
    let run = Run::new();
    let i = inputs();
    let full = i.dir.write("in/diskfull.mzML", "<mzML/>");
    let (id, rx) = run.start(request(&[&full], &i.fasta, false, json!({})), None);
    id.unwrap();
    let events = until_terminal(&rx, WAIT);
    let Some(SearchEvent::Failed(f)) = events.last() else {
        panic!("{events:?}")
    };
    assert_eq!(
        f.message,
        "Error: Unable to write file (the file 'nuxl/diskfull_1.0000_XLs.idXML' could not be created. writing the \
         file failed (e.g. disk full or I/O error))"
    );
    assert_eq!(f.ended.as_deref(), Some("OpenNuXL ended with exit code 12"));
    assert_eq!(f.stage, "Scoring diskfull.mzML (1 of 1)... this step 0 %");
    let detail = f.detail.as_deref().unwrap();
    assert!(!detail.contains(".partial"), "{detail}");
}

#[test]
fn humanize_gives_the_users_names_and_drops_the_search_folder() {
    let dir = Path::new("/s/1-0.partial");
    let req = request(
        &[Path::new("/data/a.mzML"), Path::new("/other/a.mzML")],
        Path::new("/data/db.fasta"),
        false,
        json!({}),
    );
    let records = input_records_with(&req, InputLinks::Symlinks, dir);
    assert_eq!(
        humanize(
            "Reading /s/1-0.partial/2__a.mzML; writing /s/1-0.partial/nuxl/2__a_perc_1.0000_XLs.idXML: run '1__a'; \
             1__a.mzML; 11__a stays; 2__ab stays",
            dir,
            &records
        ),
        "Reading /other/a.mzML; writing nuxl/a_perc_1.0000_XLs.idXML: run 'a'; a.mzML; 11__a stays; 2__ab stays"
    );
    // a Windows search folder, as OpenMS may write it: with '\\', with '/' (a path it put together), mixed, and
    // the drive letter in the other case
    let dir = Path::new(r"C:\Users\u\AppData\Roaming\nuxl\searches\1-0.partial");
    let req = request(
        // (the inputs with '/', which is a separator on every platform)
        &[Path::new("D:/data/a.mzML"), Path::new("D:/other/a.mzML")],
        Path::new("D:/data/db.fasta"),
        false,
        json!({}),
    );
    let records = input_records_with(&req, InputLinks::PathsOrHardLinks, dir);
    assert_eq!(
        humanize(
            r"Reading C:\Users\u\AppData\Roaming\nuxl\searches\1-0.partial\2__a.mzML; Reading c:/Users/u/AppData/Roaming/nuxl/searches/1-0.partial/1__a.mzML; writing C:\Users\u\AppData\Roaming\nuxl\searches\1-0.partial\nuxl/2__a.tsv and C:/Users/u/AppData/Roaming/nuxl/searches/1-0.partial/nuxl.log",
            dir,
            &records
        ),
        "Reading D:/other/a.mzML; Reading D:/data/a.mzML; writing nuxl/a.tsv and nuxl.log"
    );
}

#[test]
fn a_crash_becomes_search_failed_with_the_last_stage() {
    let run = Run::new();
    let i = inputs();
    let crash = i.dir.write("in/crash.mzML", "<mzML/>");
    let (id, rx) = run.start(
        request(&[&crash, &i.mzml], &i.fasta, false, json!({})),
        None,
    );
    let id = id.unwrap();
    let events = until_terminal(&rx, WAIT);
    let Some(SearchEvent::Failed(f)) = events.last() else {
        panic!("{events:?}")
    };
    assert_eq!(f.search_id, id);
    assert_eq!(
        f.stage, "Reading the spectra of crash.mzML (1 of 2)...",
        "the last progress label"
    );
    assert_eq!(f.file, Some(0), "the input of the run");
    assert_eq!(
        f.message,
        format!(
            "Error: Unable to read file (the input broke {})",
            crash.display()
        ),
        "the message names the user's file, not the link; noise lines are skipped"
    );
    // how OpenNuXL ended leads the message; the stderr tail is the detail, the log is kept
    assert_eq!(f.ended.as_deref(), Some("OpenNuXL ended with exit code 3"));
    assert_eq!(
        f.detail.as_deref(),
        Some(
            format!(
                "Error: Unable to read file (the input broke {})",
                crash.display()
            )
            .as_str()
        )
    );
    let log = PathBuf::from(f.log.as_deref().expect("the log is kept"));
    assert_eq!(log, run.work.path().join("logs").join("last-failure.log"));
    let text = fs::read_to_string(&log).unwrap();
    assert!(text.starts_with("$ "), "the command line first: {text}");
    assert!(text.contains("Error: Unable to read file"), "{text}");
    // the second input never ran
    assert_eq!(
        text.lines().filter(|l| l.starts_with("$ ")).count(),
        1,
        "{text}"
    );
    assert!(!progress_of(&events).iter().any(|p| p.1 == 1), "{events:?}");
    assert!(
        run.listing().is_empty(),
        "the partial folder is removed: {:?}",
        run.listing()
    );
}

#[test]
fn a_failure_of_a_later_run_fails_the_search_with_its_input() {
    let run = Run::new();
    let i = inputs();
    let crash = i.dir.write("in/crash.mzML", "<mzML/>");
    let (_, rx) = run.start(
        request(&[&i.mzml, &crash], &i.fasta, false, json!({})),
        None,
    );
    let events = until_terminal(&rx, WAIT);
    let Some(SearchEvent::Failed(f)) = events.last() else {
        panic!("{events:?}")
    };
    assert_eq!(f.file, Some(1));
    assert!(f.stage.contains("crash.mzML (2 of 2)"), "{}", f.stage);
    let text = fs::read_to_string(f.log.as_deref().unwrap()).unwrap();
    assert_eq!(
        text.lines().filter(|l| l.starts_with("$ ")).count(),
        2,
        "both runs in one log"
    );
    assert!(
        text.contains("Running percolator."),
        "the first run's output: {text}"
    );
    assert!(run.listing().is_empty());
}

#[test]
fn a_crash_by_a_signal_says_so_and_keeps_the_log_of_the_last_failure() {
    let run = Run::new();
    let i = inputs();
    // a failure before: its log is replaced
    let crash = i.dir.write("in/crash.mzML", "<mzML/>");
    let (_, rx) = run.start(request(&[&crash], &i.fasta, false, json!({})), None);
    until_terminal(&rx, WAIT);
    let segv = i.dir.write("in/segv.mzML", "<mzML/>");
    let (_, rx) = run.start(request(&[&segv], &i.fasta, false, json!({})), None);
    let events = until_terminal(&rx, WAIT);
    let Some(SearchEvent::Failed(f)) = events.last() else {
        panic!("{events:?}")
    };
    let expected = if cfg!(windows) {
        "OpenNuXL crashed (exception 0xC0000005)"
    } else {
        "OpenNuXL crashed (signal 11, SIGSEGV)"
    };
    assert_eq!(f.ended.as_deref(), Some(expected));
    // the last line of a crashed tool says nothing about the crash: it is in the details only
    assert_eq!(f.message, "", "no message of its own");
    assert_eq!(
        f.detail.as_deref(),
        Some(format!("Reading {} ...", segv.display()).as_str())
    );
    let text = fs::read_to_string(f.log.as_deref().unwrap()).unwrap();
    assert!(text.contains("segv.mzML"), "{text}");
    assert!(!text.contains("crash.mzML"), "the last failure's: {text}");
    let v = serde_json::to_value(f).unwrap();
    assert_eq!(v["ended"], expected);
    assert!(v["detail"].is_string() && v["log"].is_string());
}

#[test]
fn a_failure_reaches_the_front_end_with_camel_case_fields() {
    let run = Run::new();
    let i = inputs();
    let crash = i.dir.write("in/crash.mzML", "<mzML/>");
    let (_, rx) = run.start(request(&[&crash], &i.fasta, false, json!({})), None);
    let events = until_terminal(&rx, WAIT);
    let Some(SearchEvent::Failed(f)) = events.last() else {
        panic!("{events:?}")
    };
    let v = serde_json::to_value(f).unwrap();
    assert_eq!(v["searchId"], f.search_id.as_str());
    assert!(v.get("stage").is_some() && v.get("message").is_some());
    assert_eq!(v["file"], 0);
    let p = serde_json::to_value(match &events[0] {
        SearchEvent::Progress(p) => p,
        e => panic!("{e:?}"),
    })
    .unwrap();
    assert!(
        p.get("searchId").is_some()
            && p.get("label").is_some()
            && p.get("file").is_some()
            && p.get("fraction").is_some()
    );
}

#[test]
fn invalid_requests_fail_before_anything_is_created() {
    let run = Run::new();
    let i = inputs();
    let (id, _rx) = run.start(
        request(&[&i.mzml], &i.fasta, false, json!({ "bogus": 1 })),
        None,
    );
    assert!(id.unwrap_err().contains("bogus"));
    let (id, _rx) = run.start(request(&[&i.mzml], &i.fasta, true, json!({})), None);
    assert!(
        id.unwrap_err().to_lowercase().contains("contaminant"),
        "no cRAP file given"
    );
    assert!(run.listing().is_empty());
}

#[test]
fn a_tool_that_cannot_start_is_an_error_and_leaves_no_folder() {
    let run = Run::new();
    let i = inputs();
    let (sink, _rx) = channel_sink();
    let err = run
        .searches
        .start(
            Path::new("/nonexistent/OpenNuXL"),
            &run.dir(),
            None,
            request(&[&i.mzml], &i.fasta, false, json!({})),
            sink,
        )
        .unwrap_err();
    assert!(err.contains("/nonexistent/OpenNuXL"), "{err}");
    assert!(
        wait_for(Duration::from_secs(5), || run.listing().is_empty()),
        "{:?}",
        run.listing()
    );
    assert!(!run.searches.any_running());
}

// ---- cancel ---------------------------------------------------------------------------------

/// Starts a search of `before` (inputs that finish) and then an input named `<name>.mzML` (hang or stubborn), and
/// waits until the hanging run has started its children.
fn start_hanging(
    run: &Run,
    i: &Inputs,
    before: &[&Path],
    name: &str,
    after: &[&Path],
) -> (String, std::sync::mpsc::Receiver<SearchEvent>, PathBuf) {
    let hang = i.dir.write(&format!("in/{name}.mzML"), "<mzML/>");
    let mut files: Vec<&Path> = before.to_vec();
    files.push(&hang);
    files.extend(after);
    let (id, rx) = run.start(request(&files, &i.fasta, false, json!({})), None);
    let id = id.unwrap();
    first_progress(&rx, WAIT);
    let partial = run.dir().join(format!("{id}.partial"));
    assert!(wait_for(WAIT, || partial.join("children.pid").is_file()
        && read_pids(&partial.join("children.pid")).len() == 2));
    (id, rx, partial)
}

#[test]
fn a_running_search_holds_the_lock_of_its_partial_folder_and_the_sweep_leaves_it() {
    use nuxl_desktop_lib::history::{sweep, SWEEP_GRACE};
    let run = Run::new();
    let i = inputs();
    let (id, _rx, partial) = start_hanging(&run, &i, &[], "hang", &[]);
    // another app instance's startup sweep, however late: the partial folder is live
    let much_later = std::time::SystemTime::now() + SWEEP_GRACE * 1000;
    assert!(sweep(&run.dir(), much_later, SWEEP_GRACE).is_empty());
    assert!(partial.join("nuxl.log").exists() && partial.join("tool.pid").exists());
    // the lock is taken, by the search
    let file = fs::File::options()
        .read(true)
        .write(true)
        .open(partial.join(".lock"))
        .unwrap();
    assert!(file.try_lock().is_err(), "the search holds the lock");
    drop(file);
    // cancelled: the folder is removed, and the lock goes with it
    run.searches.cancel(&id).unwrap();
    assert!(!partial.exists());
}

#[test]
fn cancel_ends_the_process_and_its_children() {
    let run = Run::new();
    let i = inputs();
    let (id, rx, partial) = start_hanging(&run, &i, &[], "hang", &[]);
    let tool_pid = read_pids(&partial.join("tool.pid"))[0];
    let children = read_pids(&partial.join("children.pid"));
    assert!(process_alive(tool_pid) && children.iter().all(|p| process_alive(*p)));

    let started = std::time::Instant::now();
    run.searches.cancel(&id).unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "SIGTERM was enough: {:?}",
        started.elapsed()
    );

    assert!(!process_alive(tool_pid), "the tool is gone");
    assert!(
        wait_for(Duration::from_secs(5), || children
            .iter()
            .all(|p| !process_alive(*p))),
        "its children are gone"
    );
    assert!(
        run.listing().is_empty(),
        "the partial folder is removed: {:?}",
        run.listing()
    );
    // a cancelled search sends neither done nor failed
    assert!(rx.try_iter().all(|e| matches!(e, SearchEvent::Progress(_))));
    // cancelling a finished or unknown search is not an error
    run.searches.cancel(&id).unwrap();
    run.searches.cancel("nonexistent").unwrap();
}

#[test]
fn cancel_during_a_later_run_ends_it_and_starts_no_further_one() {
    let run = Run::new();
    let i = inputs();
    let last = i.dir.write("data/last.mzML", "<mzML/>");
    let (id, rx, partial) = start_hanging(&run, &i, &[&i.mzml], "hang", &[&last]);
    // the first run is done, its record written; the second hangs
    assert!(partial
        .join(format!("nuxl/{}.outputs.json", stem_of(0, "a.mzML")))
        .is_file());
    let tool_pid = read_pids(&partial.join("tool.pid"))[0];
    run.searches.cancel(&id).unwrap();
    assert!(!process_alive(tool_pid));
    assert!(run.listing().is_empty(), "{:?}", run.listing());
    // no event of the third input, and no done or failed
    std::thread::sleep(Duration::from_millis(300));
    let events: Vec<SearchEvent> = rx.try_iter().collect();
    assert!(
        events
            .iter()
            .all(|e| matches!(e, SearchEvent::Progress(p) if p.file < 2)),
        "{events:?}"
    );
    assert!(!run.searches.any_running());
}

/// The watchdogs (`--watch-search <this process> <group>`) of the tool's process `group`, by `ps`.
#[cfg(unix)]
fn watchdogs_of(group: u32) -> Vec<String> {
    let out = std::process::Command::new("ps")
        .args(["-A", "-ww", "-o", "pid=,command="])
        .output()
        .unwrap();
    let needle = format!(
        "{} {} {group}",
        nuxl_desktop_lib::watchdog::FLAG,
        std::process::id()
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.ends_with(&needle))
        .map(str::to_string)
        .collect()
}

/// (macOS's way; the code is the same on every Unix) a watched search starts the watchdog of its tool's
/// group with each run, and ends it with the run.
#[cfg(unix)]
#[test]
fn a_watched_search_starts_its_watchdog_and_ends_it_with_the_search() {
    let mut run = Run::new();
    run.searches = Arc::new(
        Searches::default().with_watchdog(PathBuf::from(env!("CARGO_BIN_EXE_nuxl-desktop"))),
    );
    let i = inputs();
    let (id, _rx, partial) = start_hanging(&run, &i, &[], "hang", &[]);
    let tool_pid = read_pids(&partial.join("tool.pid"))[0];
    assert!(
        wait_for(WAIT, || watchdogs_of(tool_pid).len() == 1),
        "one watchdog of the tool's group: {:?}",
        watchdogs_of(tool_pid)
    );
    run.searches.cancel(&id).unwrap();
    assert!(
        watchdogs_of(tool_pid).is_empty(),
        "the watchdog ended with the search"
    );
    // a search that finishes ends its watchdog too
    let (id, rx) = run.start(request(&[&i.mzml], &i.fasta, false, json!({})), None);
    let id = id.unwrap();
    let folder = done_folder(&until_terminal(&rx, WAIT));
    let pid = read_pids(&folder.join("tool.pid"))[0];
    assert!(watchdogs_of(pid).is_empty(), "{id}");
}

#[test]
fn cancel_kills_a_process_that_ignores_sigterm() {
    let run = Run::new();
    let i = inputs();
    let (id, _rx, partial) = start_hanging(&run, &i, &[], "stubborn", &[]);
    let tool_pid = read_pids(&partial.join("tool.pid"))[0];
    let children = read_pids(&partial.join("children.pid"));
    run.searches.cancel(&id).unwrap();
    assert!(!process_alive(tool_pid));
    assert!(wait_for(Duration::from_secs(5), || children
        .iter()
        .all(|p| !process_alive(*p))));
    assert!(run.listing().is_empty());
}

#[test]
fn cancel_all_stops_every_running_search() {
    let run = Run::new();
    let i = inputs();
    let (_, _rx1, p1) = start_hanging(&run, &i, &[], "hang", &[]);
    let (_, _rx2, p2) = start_hanging(&run, &i, &[], "stubborn", &[]);
    let pids: Vec<u32> = [&p1, &p2]
        .iter()
        .flat_map(|p| read_pids(&p.join("tool.pid")))
        .collect();
    run.searches.cancel_all();
    assert!(pids.iter().all(|p| !process_alive(*p)));
    assert!(run.listing().is_empty());
}
