//! The shim against a fake ProSE (tests/fake-prose.sh; on Windows examples/fake_prose.rs) and fixtures of
//! real ProSE output.

mod common;

use common::*;
use prose_desktop_lib::args::{
    build_args, build_args_with, humanize, input_placements, input_records_with, input_stem,
    is_input_link, link_name, max_stem, with_contaminants, InputLinks, Placement, SearchRequest,
    MAX_STEM,
};
use prose_desktop_lib::decoys::DecoyRules;
use prose_desktop_lib::progress::ProgressTracker;
use prose_desktop_lib::run::{SearchEvent, Searches};
use prose_desktop_lib::tool;
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
        "settings": { "parameters": parameters, "rescore": true, "peptdeep": false, "threads": 2 },
    }))
    .unwrap()
}

/// The arguments with every input as a link `<n>__<name>` (Linux, macOS; Windows below).
fn args_of(req: &SearchRequest, out: &Path) -> Vec<OsString> {
    build_args_with(req, out, InputLinks::Symlinks).unwrap()
}

/// The values after `flag` up to the next option.
fn values_of(args: &[OsString], flag: &str) -> Vec<OsString> {
    let at = args
        .iter()
        .position(|a| a == flag)
        .unwrap_or_else(|| panic!("{flag} is not in {args:?}"));
    args[at + 1..]
        .iter()
        .take_while(|a| {
            !a.to_string_lossy().starts_with('-') || a.to_string_lossy().parse::<f64>().is_ok()
        })
        .cloned()
        .collect()
}

fn has(args: &[OsString], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// A folder with an mzML (empty contents are enough: the shim reads nothing) and a FASTA.
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
    let gz = dir.write("two words/Probe ä.mzML.gz", "gz");
    let fasta = dir.write("Datenbank ö/prot ein.fasta", ">a\nMK\n");
    let out = dir.path().join("out dir ü/s.partial");
    let args = args_of(&request(&[&mzml, &gz], &fasta, false, json!({})), &out);

    assert_eq!(
        values_of(&args, "-in"),
        vec![
            out.join("1__ünï cøde 1.mzML").into_os_string(),
            out.join("2__Probe ä.mzML.gz").into_os_string()
        ],
        "inputs are the symlinks of the search folder, each one argument"
    );
    assert_eq!(
        values_of(&args, "-database"),
        vec![fasta.clone().into_os_string()]
    );
    assert_eq!(
        values_of(&args, "-out_qpx"),
        vec![out.join("qpx").into_os_string()]
    );
    assert!(!has(&args, "-summary_out"));
}

#[test]
fn the_app_outputs_are_always_requested() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let args = args_of(&request(&[&i.mzml], &i.fasta, false, json!({})), &out);
    // the QPX files with the columns and the footer of -qpx_extended are all the app reads
    assert_eq!(
        values_of(&args, "-out_qpx"),
        vec![out.join("qpx").into_os_string()]
    );
    assert!(has(&args, "-qpx_extended"));
    assert_eq!(
        values_of(&args, "-qpx_peak_window"),
        vec![OsString::from("100")]
    );
    assert_eq!(
        values_of(&args, "-qpx_peak_top"),
        vec![OsString::from("100")]
    );
    for flag in ["-out_parquet", "-out_psm_spectra", "-summary_out"] {
        assert!(!has(&args, flag), "{flag}");
    }
    assert!(has(&args, "-keep_decoys"));
    assert_eq!(values_of(&args, "-threads"), vec![OsString::from("2")]);
    assert_eq!(
        values_of(&args, "-Search:rescore"),
        vec![OsString::from("true")]
    );
    assert!(!has(&args, "-Search:peptdeep:enable"));
    // one input: its own idXML (the Export menu's), no pooled output; a closed search: no modification analysis
    assert_eq!(
        values_of(&args, "-out_idxml"),
        vec![out.join("search.idXML").into_os_string()]
    );
    assert!(!has(&args, "-out_merged"));
    assert!(!has(&args, "-out_mod_analysis_dir"));
}

#[test]
fn several_inputs_ask_for_the_merged_output_and_open_search_for_the_modification_tables() {
    let i = inputs();
    let b = i.dir.write("other/b.mzML", "<mzML/>");
    let out = i.dir.path().join("o");
    let open = json!({
        "precursor:mass_tolerance_lower": 500, "precursor:mass_tolerance_upper": 500,
        "precursor:mass_tolerance_unit": "Da",
    });
    let args = args_of(&request(&[&i.mzml, &b], &i.fasta, false, open), &out);
    assert_eq!(
        values_of(&args, "-out_merged"),
        vec![out.join("merged.idXML").into_os_string()]
    );
    assert!(!has(&args, "-out_idxml"));
    assert_eq!(
        values_of(&args, "-out_mod_analysis_dir"),
        vec![out.join("mods").into_os_string()]
    );

    // ProSE's own rule: more than 1000 ppm or 1 Da on either side
    let wide_ppm = json!({ "precursor:mass_tolerance_upper": 1500 });
    assert!(has(
        &args_of(&request(&[&i.mzml], &i.fasta, false, wide_ppm), &out),
        "-out_mod_analysis_dir"
    ));
    let narrow_da = json!({ "precursor:mass_tolerance_unit": "Da", "precursor:mass_tolerance_lower": 0.5, "precursor:mass_tolerance_upper": 1 });
    assert!(!has(
        &args_of(&request(&[&i.mzml], &i.fasta, false, narrow_da), &out),
        "-out_mod_analysis_dir"
    ));
}

#[test]
fn parameters_are_typed_and_use_the_search_prefix() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let params = json!({
        "enzyme": "Trypsin/P",
        "peptide:missed_cleavages": 2,
        "precursor:isotope_error_min": -1,
        "precursor:mass_tolerance_lower": 10,
        "fragment:mass_tolerance": 0.02,
        "FDR:PSM": 0.01,
        "modifications:fixed": ["Carbamidomethyl (C)"],
        "modifications:variable": ["Oxidation (M)", "Acetyl (Protein N-term)"],
        "annotate:self_trained_ion_priors": false,
        "calibration:enabled": true,
        "ions:add_a_ions": false,
        "database:chunk_size": 100000,
        "peptdeep:instrument": "timsTOF",
    });
    let args = args_of(&request(&[&i.mzml], &i.fasta, false, params), &out);
    let one = |flag: &str| values_of(&args, flag);
    assert_eq!(one("-Search:enzyme"), vec![OsString::from("Trypsin/P")]);
    assert_eq!(
        one("-Search:peptide:missed_cleavages"),
        vec![OsString::from("2")]
    );
    assert_eq!(
        one("-Search:precursor:isotope_error_min"),
        vec![OsString::from("-1")]
    );
    assert_eq!(
        one("-Search:precursor:mass_tolerance_lower"),
        vec![OsString::from("10")]
    );
    assert_eq!(
        one("-Search:fragment:mass_tolerance"),
        vec![OsString::from("0.02")]
    );
    assert_eq!(one("-Search:FDR:PSM"), vec![OsString::from("0.01")]);
    assert_eq!(
        one("-Search:modifications:fixed"),
        vec![OsString::from("Carbamidomethyl (C)")]
    );
    assert_eq!(
        one("-Search:modifications:variable"),
        vec![
            OsString::from("Oxidation (M)"),
            OsString::from("Acetyl (Protein N-term)")
        ],
        "a list is one argument per item"
    );
    assert_eq!(
        one("-Search:annotate:self_trained_ion_priors"),
        vec![OsString::from("false")],
        "a true/false choice takes its value"
    );
    assert_eq!(
        one("-Search:database:chunk_size"),
        vec![OsString::from("100000")]
    );
    assert_eq!(
        one("-Search:peptdeep:instrument"),
        vec![OsString::from("timsTOF")]
    );
    // a switch: present when on, absent when off (ProSE's flags take no value)
    assert!(has(&args, "-Search:calibration:enabled"));
    assert!(!has(&args, "-Search:ions:add_a_ions"));
}

#[test]
fn an_empty_list_clears_the_default_and_peptdeep_is_a_switch() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let mut req = request(
        &[&i.mzml],
        &i.fasta,
        false,
        json!({ "modifications:variable": [] }),
    );
    req.settings.peptdeep = true;
    req.settings.rescore = false;
    let args = args_of(&req, &out);
    let at = args
        .iter()
        .position(|a| a == "-Search:modifications:variable")
        .unwrap();
    assert!(
        args.get(at + 1)
            .is_none_or(|next| next.to_string_lossy().starts_with('-')),
        "no value follows: {args:?}"
    );
    assert!(has(&args, "-Search:peptdeep:enable"));
    assert_eq!(
        values_of(&args, "-Search:rescore"),
        vec![OsString::from("false")]
    );
}

#[test]
fn unknown_parameters_are_refused() {
    let i = inputs();
    let out = i.dir.path().join("o");
    for name in [
        "bogus",
        "Search:enzyme",
        "in",
        "out_idxml",
        "ini",
        "peptdeep:ms2_model",
        "rescore",
        "peptdeep:enable",
    ] {
        let err = build_args(
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
fn parameter_values_of_the_wrong_type_are_refused() {
    let i = inputs();
    let out = i.dir.path().join("o");
    for params in [
        json!({ "peptide:missed_cleavages": "two" }),
        json!({ "peptide:missed_cleavages": 1.5 }),
        json!({ "peptide:missed_cleavages": null }),
        json!({ "FDR:protein": "0.01" }),
        json!({ "enzyme": 3 }),
        json!({ "enzyme": "-in" }),
        json!({ "enzyme": "" }),
        json!({ "modifications:fixed": "Carbamidomethyl (C)" }),
        json!({ "modifications:fixed": ["-database"] }),
        json!({ "modifications:fixed": [1] }),
        json!({ "calibration:enabled": "yes" }),
        json!({ "enzyme": "Tryp\nsin" }),
    ] {
        assert!(
            build_args(&request(&[&i.mzml], &i.fasta, false, params.clone()), &out).is_err(),
            "{params} is refused"
        );
    }
}

#[test]
fn integers_beyond_proses_32_bits_and_absurd_threads_are_refused() {
    let i = inputs();
    let out = i.dir.path().join("o");
    // ProSE reads its integers as 32-bit: 3000000000 made it print its 152 KB help and stop
    for (params, words) in [
        (
            json!({ "precursor:max_charge": 3_000_000_000_u64 }),
            "precursor:max_charge",
        ),
        (
            json!({ "precursor:isotope_error_min": -2_147_483_649_i64 }),
            "precursor:isotope_error_min",
        ),
        (
            json!({ "peptide:missed_cleavages": 9.0e15 }),
            "peptide:missed_cleavages",
        ),
        (json!({ "threads": 4_294_967_295_u64 }), "threads"),
        (json!({ "threads": 1025 }), "threads"),
    ] {
        let err =
            build_args(&request(&[&i.mzml], &i.fasta, false, params.clone()), &out).unwrap_err();
        assert!(err.contains(words), "{params}: {err}");
    }
    let err = build_args(
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
    assert!(build_args(&req, &out).unwrap_err().contains("1024"));
    // the bounds themselves pass
    let args = args_of(
        &request(
            &[&i.mzml],
            &i.fasta,
            false,
            json!({ "precursor:max_charge": 2_147_483_647_i64, "precursor:isotope_error_min": -2_147_483_648_i64, "threads": 1024 }),
        ),
        &out,
    );
    assert_eq!(
        values_of(&args, "-Search:precursor:max_charge"),
        vec![OsString::from("2147483647")]
    );
    assert_eq!(
        values_of(&args, "-Search:precursor:isotope_error_min"),
        vec![OsString::from("-2147483648")]
    );
    assert_eq!(values_of(&args, "-threads"), vec![OsString::from("1024")]);
}

#[test]
fn co_isolated_precursors_are_left_out_with_database_chunks() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let with = |chunk: i64| {
        args_of(
            &request(
                &[&i.mzml],
                &i.fasta,
                false,
                json!({ "chimeric:enabled": true, "database:chunk_size": chunk }),
            ),
            &out,
        )
    };
    assert!(has(&with(0), "-Search:chimeric:enabled"));
    let chunked = with(1000);
    assert!(
        !has(&chunked, "-Search:chimeric:enabled"),
        "ProSE would ignore it"
    );
    assert_eq!(
        values_of(&chunked, "-Search:database:chunk_size"),
        vec![OsString::from("1000")]
    );
    // a wrong value is still refused
    assert!(build_args(
        &request(
            &[&i.mzml],
            &i.fasta,
            false,
            json!({ "chimeric:enabled": "yes", "database:chunk_size": 1000 })
        ),
        &out
    )
    .is_err());
}

#[test]
fn the_psm_fdr_is_above_zero() {
    let i = inputs();
    let out = i.dir.path().join("o");
    // absent: the shim sends 1 %, because ProSE's default (0) leaves a search without q-values
    let args = args_of(&request(&[&i.mzml], &i.fasta, false, json!({})), &out);
    assert_eq!(
        values_of(&args, "-Search:FDR:PSM"),
        vec![OsString::from("0.01")]
    );
    for fdr in [json!(0), json!(-0.5)] {
        let err = build_args(
            &request(&[&i.mzml], &i.fasta, false, json!({ "FDR:PSM": fdr })),
            &out,
        )
        .unwrap_err();
        assert!(err.contains("FDR:PSM"), "{err}");
    }
}

#[test]
fn a_search_without_decoys_has_no_fdr() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let fdr = json!({ "FDR:PSM": 0.01, "FDR:protein": 0.05, "FDR:protein_inference_PSM": 0.1 });
    let mut without = fdr.clone();
    without["decoys"] = json!("ignore");
    // decoys 'ignore': no FDR is sent (ProSE would skip it), not even the shim's default PSM FDR, and 0 is no error
    for params in [
        without,
        json!({ "decoys": "ignore" }),
        json!({ "decoys": "ignore", "FDR:PSM": 0 }),
    ] {
        let args = args_of(&request(&[&i.mzml], &i.fasta, false, params.clone()), &out);
        for name in [
            "-Search:FDR:PSM",
            "-Search:FDR:protein",
            "-Search:FDR:protein_inference_PSM",
        ] {
            assert!(!has(&args, name), "{name} sent with {params}");
        }
        assert_eq!(
            values_of(&args, "-Search:decoys"),
            vec![OsString::from("ignore")]
        );
    }
    // with decoys they are sent
    for decoys in ["auto", "generate"] {
        let mut params = fdr.clone();
        params["decoys"] = json!(decoys);
        let args = args_of(&request(&[&i.mzml], &i.fasta, false, params), &out);
        assert_eq!(
            values_of(&args, "-Search:FDR:PSM"),
            vec![OsString::from("0.01")]
        );
        assert_eq!(
            values_of(&args, "-Search:FDR:protein"),
            vec![OsString::from("0.05")]
        );
    }
    // a value of the wrong type is still refused
    assert!(build_args(
        &request(
            &[&i.mzml],
            &i.fasta,
            false,
            json!({ "decoys": "ignore", "FDR:PSM": "x" })
        ),
        &out
    )
    .is_err());
}

#[test]
fn input_paths_are_validated() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let missing = i.dir.path().join("data/missing.mzML");
    let folder = i.dir.path().join("data");
    let raw = i.dir.write("data/a.raw", "x");
    let text = i.dir.write("data/db.txt", ">a\nMK\n");
    assert!(
        build_args(&request(&[&missing], &i.fasta, false, json!({})), &out)
            .unwrap_err()
            .contains("missing.mzML")
    );
    assert!(
        build_args(&request(&[&folder], &i.fasta, false, json!({})), &out).is_err(),
        "a folder is not a file"
    );
    assert!(
        build_args(&request(&[&raw], &i.fasta, false, json!({})), &out)
            .unwrap_err()
            .contains("a.raw")
    );
    assert!(
        build_args(&request(&[&i.mzml], &text, false, json!({})), &out)
            .unwrap_err()
            .contains("db.txt")
    );
    assert!(build_args(
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
        build_args(&request(&[], &i.fasta, false, json!({})), &out).is_err(),
        "no input file"
    );
    // the extensions the app takes
    let gz = i.dir.write("data/b.MZML.GZ", "gz");
    let fa = i.dir.write("data/db.fa", ">a\nMK\n");
    let faa = i.dir.write("data/db.faa", ">a\nMK\n");
    for db in [&fa, &faa] {
        assert!(build_args(&request(&[&i.mzml, &gz], db, false, json!({})), &out).is_ok());
    }
}

#[test]
fn relative_paths_are_refused_so_none_can_pass_for_an_option() {
    let i = inputs();
    let out = i.dir.path().join("o");
    let json = |files: Value, database: Value| -> SearchRequest {
        serde_json::from_value(json!({
            "files": files, "database": database, "contaminants": false,
            "settings": { "parameters": {}, "rescore": true, "peptdeep": false, "threads": 1 },
        }))
        .unwrap()
    };
    let good_file = json!([{ "id": "f", "path": i.mzml }]);
    let good_db = json!(i.fasta);
    for path in [
        "-in.mzML",
        "-out_qpx",
        "data/a.mzML",
        "a.mzML",
        "./a.mzML",
        "../a.mzML",
    ] {
        let err = build_args(
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
        let err = build_args(&json(good_file.clone(), json!(path)), &out).unwrap_err();
        assert!(
            err.contains("absolute") && err.contains(path),
            "{path}: {err}"
        );
    }
    assert!(build_args(&json(good_file, good_db), &out).is_ok());
}

#[test]
fn contaminants_swap_the_database_for_the_search_folders_copy() {
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
    with_contaminants(&user, &crap, &dest, &DecoyRules::default()).unwrap();
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
    with_contaminants(&user2, &crap, &dest, &DecoyRules::default()).unwrap();
    assert!(fs::read_to_string(&dest)
        .unwrap()
        .starts_with(">x\nMK\n>CON__sp|ALBU_BOVIN|\n"));
}

#[test]
fn the_bundled_crap_has_116_entries_and_gets_the_prefix() {
    let dir = TempDir::new("bundled-crap");
    let crap = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/fasta/crap.fasta");
    let user = dir.write("user.fasta", ">a\nMK\n");
    let dest = dir.path().join("database.fasta");
    with_contaminants(&user, &crap, &dest, &DecoyRules::default()).unwrap();
    let text = fs::read_to_string(&dest).unwrap();
    let headers: Vec<&str> = text.lines().filter(|l| l.starts_with('>')).collect();
    assert_eq!(headers.len(), 117);
    assert_eq!(headers[0], ">a");
    assert!(headers[1..].iter().all(|h| h.starts_with(">CON__")));
}

fn bundled_crap() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/fasta/crap.fasta")
}

fn headers(text: &str) -> Vec<&str> {
    text.lines().filter(|l| l.starts_with('>')).collect()
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
    with_contaminants(&user, &crap, &dest, &DecoyRules::default()).unwrap();
    assert_eq!(
        fs::read_to_string(&dest).unwrap(),
        ">sp|P1|ONE\nMKWV\n>CON__sp|ALBU_BOVIN| own text\r\nMKWVT\r\n>CON__gi|2|keratin\nGGGG\n"
    );
    // the database.fasta of an earlier search, searched again with contaminants: nothing is added
    let first = dir.path().join("first.fasta");
    let again = dir.path().join("again.fasta");
    let plain = dir.write("plain.fasta", ">a\nMK\n");
    with_contaminants(&plain, &bundled_crap(), &first, &DecoyRules::default()).unwrap();
    with_contaminants(&first, &bundled_crap(), &again, &DecoyRules::default()).unwrap();
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
fn a_database_with_decoys_gets_decoys_of_the_contaminants_too() {
    let dir = TempDir::new("crap-decoys");
    let crap = dir.write("crap.fasta", ">sp|TRY|trypsin\nMABCKDE\n>CON__kept\nAKPR\n");
    let dest = dir.path().join("database.fasta");
    // a prefix as DecoyHelper knows it, spelled as the database spells it
    let user = dir.write(
        "decoys.fasta",
        ">P1 one\nMKWV\n>P2\nAAAK\n>rev_P1 one\nMVWK\n>rev_P2\nAAAK\n",
    );
    with_contaminants(&user, &crap, &dest, &DecoyRules::default()).unwrap();
    let text = fs::read_to_string(&dest).unwrap();
    assert!(
        text.ends_with(
            ">CON__sp|TRY|trypsin\nMABCKDE\n>CON__kept\nAKPR\n>rev_CON__sp|TRY|trypsin\nMCBAKED\n>rev_CON__kept\nRPKA\n"
        ),
        "{text}"
    );
    // targets and decoys pair up again
    let decoys = headers(&text)
        .iter()
        .filter(|h| h.starts_with(">rev_"))
        .count();
    assert_eq!(headers(&text).len(), 2 * decoys);
    // a suffix, and Trypsin/P without keeping the initial Met
    let suffixed = dir.write("suffixed.fasta", ">P1\nMK\n>P1_REVERSED\nKM\n");
    let rules = DecoyRules::of(
        json!({ "enzyme": "Trypsin/P", "peptide:clip_nterm_methionine": false })
            .as_object()
            .unwrap(),
    );
    with_contaminants(&suffixed, &crap, &dest, &rules).unwrap();
    let text = fs::read_to_string(&dest).unwrap();
    assert!(
        text.ends_with(">CON__sp|TRY|trypsin_REVERSED\nCBAMKED\n>CON__kept_REVERSED\nAKRP\n"),
        "{text}"
    );
    // ProSE removes the database's decoys and generates all of them (generate, ignore), or the database has
    // none: no decoys from the app
    for (db, params) in [
        (&user, json!({ "decoys": "generate" })),
        (&user, json!({ "decoys": "ignore" })),
        (&dir.write("targets.fasta", ">P1\nMK\n>P2\nAK\n"), json!({})),
    ] {
        with_contaminants(
            db,
            &crap,
            &dest,
            &DecoyRules::of(params.as_object().unwrap()),
        )
        .unwrap();
        let text = fs::read_to_string(&dest).unwrap();
        assert!(
            headers(&text)
                .iter()
                .all(|h| !h.contains("rev_CON") && !h.contains("REVERSED")),
            "{params}: {text}"
        );
    }
}

#[test]
fn a_database_without_proteins_is_refused_with_contaminants() {
    let dir = TempDir::new("crap-empty");
    let dest = dir.path().join("database.fasta");
    for (name, contents) in [
        ("empty.fasta", ""),
        ("blank.fasta", "\n\n  \n"),
        ("nohdr.fasta", "MKWVTFISLLK\n"),
    ] {
        let user = dir.write(name, contents);
        let err =
            with_contaminants(&user, &bundled_crap(), &dest, &DecoyRules::default()).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData, "{name}");
        assert!(err.to_string().contains("has no proteins"), "{name}: {err}");
        assert!(!dest.exists(), "{name}: no half-written copy is left");
    }
    // a byte order mark before the first header is no problem
    let bom = dir.write("bom.fasta", "\u{feff}>P1\nMK\n");
    with_contaminants(&bom, &bundled_crap(), &dest, &DecoyRules::default()).unwrap();
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

#[test]
fn on_windows_inputs_go_by_their_own_paths_unless_their_names_clash() {
    let dir = TempDir::new("placements");
    let a = dir.write("one/a.mzML", "<mzML/>");
    let b = dir.write("one/b.mzML.gz", "gz");
    let a_upper = dir.write("two/A.MZML", "<mzML/>");
    let a_gz = dir.write("three/a.mzML.gz", "gz");
    let fasta = dir.write("db.fasta", ">a\nMK\n");
    let out = dir.path().join("s.partial");
    let windows = InputLinks::PathsOrHardLinks;
    let plan = |files: &[&Path]| {
        let req = request(files, &fasta, false, json!({}));
        let args = build_args_with(&req, &out, windows).unwrap();
        let records = input_records_with(&req, windows, &out);
        (
            input_placements(&req, windows, &out),
            values_of(&args, "-in"),
            records
                .iter()
                .map(|r| (r.link.clone(), r.stem.clone()))
                .collect::<Vec<_>>(),
        )
    };

    // names that differ: the user's paths themselves, and ProSE names the outputs after them
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
            ("b.mzML.gz".to_string(), "b".to_string())
        ]
    );
    // one stem, ignoring case (NTFS) or the .gz: the clashing ones as hard links in the folder
    let (placements, ins, records) = plan(&[&a, &b, &a_upper, &a_gz]);
    use Placement::*;
    assert_eq!(placements, [HardLink, OwnPath, HardLink, HardLink]);
    assert_eq!(
        ins,
        [
            out.join("1__a.mzML").into_os_string(),
            b.clone().into_os_string(),
            out.join("3__A.MZML").into_os_string(),
            out.join("4__a.mzML.gz").into_os_string(),
        ]
    );
    assert_eq!(
        records
            .iter()
            .map(|(_, stem)| stem.as_str())
            .collect::<Vec<_>>(),
        ["1__a", "b", "3__A", "4__a"]
    );
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
    // an input of stem `quantms`, which ProSE refuses (its merged QPX views are quantms.*): as a link
    let quantms = dir.write("five/QuantMS.mzML", "<mzML/>");
    let (placements, ins, records) = plan(&[&b, &quantms]);
    assert_eq!(placements, [OwnPath, HardLink]);
    assert_eq!(ins[1], out.join("2__QuantMS.mzML").into_os_string());
    assert_eq!(records[1].1, "2__QuantMS");
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
fn input_links_are_known_by_their_names() {
    for name in ["1__a.mzML", "12__x y.mzML.gz", "3__1__a.MZML"] {
        assert!(is_input_link(name), "{name}");
    }
    for name in [
        "a.mzML",
        "__a.mzML",
        "x__a.mzML",
        "1__a.fasta",
        "1__",
        "summary.yaml",
        "1_a.mzML",
    ] {
        assert!(!is_input_link(name), "{name}");
    }
}

#[test]
fn link_names_keep_the_name_and_the_gz_suffix() {
    assert_eq!(link_name(0, "/data/x.mzML"), "1__x.mzML");
    assert_eq!(link_name(9, "/data/x.mzML.gz"), "10__x.mzML.gz");
    assert_eq!(link_name(0, "/Daten ä/ünï cøde.mzML"), "1__ünï cøde.mzML");
    assert_eq!(input_stem("1__x.mzML"), "1__x");
    assert_eq!(input_stem("10__x.mzML.gz"), "10__x");
    assert_eq!(input_stem("2__a.b.MZML.GZ"), "2__a.b");
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
    // ProSE's longest output name fits
    assert!(
        format!(
            "{}_ModificationAnalysis_DeltaMassStats.tsv",
            input_stem(&link)
        )
        .len()
            <= 255
    );
    assert!(is_input_link(&link));
    // `<n>__` keeps two such inputs apart, and the suffix stays as it is
    let gz = link_name(11, &format!("/data/{}.MZML.GZ", "x".repeat(246)));
    assert!(
        gz.starts_with("12__xxx") && gz.ends_with(".MZML.GZ"),
        "{gz}"
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
/// `ẞ` (3 -> 2) and the Kelvin sign (3 -> 1). The stem is ProSE's (`File::stemName`: ASCII suffixes,
/// ignoring their case), and no name makes the shim panic.
#[test]
fn input_stems_of_names_whose_lower_case_has_another_length() {
    for (link, stem) in [
        ("1__İstanbul_run.mzML", "1__İstanbul_run"),
        ("1__İstanbul_run.mzML.gz", "1__İstanbul_run"),
        ("1__Ⱥ.mzML.gz", "1__Ⱥ"),
        ("1__Ⱥ.mzML", "1__Ⱥ"),
        ("2__ẞ.mzML", "2__ẞ"),
        ("2__ẞẞ.MzMl.gZ", "2__ẞẞ"),
        ("3__\u{212A}.mzML", "3__\u{212A}"),
        ("3__\u{212A}\u{212A}.mzML.GZ", "3__\u{212A}\u{212A}"),
        ("4__İ.mZmL", "4__İ"),
        ("5__a.mzML.mzML", "5__a.mzML"),
        ("6__Ⱥ.gz", "6__Ⱥ"),
        (".mzML", ""),
        ("İ", "İ"),
        ("", ""),
    ] {
        assert_eq!(input_stem(link), stem, "{link}");
    }
    for name in ["İstanbul.mzML", "Ⱥ.MZML.GZ", "ẞ.mzml", "\u{212A}.mZmL.Gz"] {
        assert!(prose_desktop_lib::args::is_spectrum_file(name), "{name}");
    }
    for name in ["Ⱥ.mzM", "x.mzml.gzip", "x.gz", "ẞ"] {
        assert!(!prose_desktop_lib::args::is_spectrum_file(name), "{name}");
    }
    // the records of a search with such inputs carry these stems (the reader looks for <stem>.psm.parquet)
    let req = request(
        &[
            Path::new("/data/İstanbul_run.mzML"),
            Path::new("/data/Ⱥ.mzML.gz"),
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

// ---- progress -------------------------------------------------------------------------------

type Step = (String, i32, f64);

fn steps_of(fixture_name: &str, names: &[&str]) -> Vec<Step> {
    let mut tracker = ProgressTracker::new(names.iter().map(|n| n.to_string()).collect());
    let mut steps = Vec::new();
    for line in fixture(fixture_name).lines() {
        if let Some(p) = tracker.feed(line) {
            steps.push((p.label, p.file, p.fraction));
        }
    }
    steps
}

fn labels(steps: &[Step]) -> Vec<&str> {
    steps.iter().map(|s| s.0.as_str()).collect()
}

fn assert_monotone(steps: &[Step]) {
    for pair in steps.windows(2) {
        assert!(pair[1].2 >= pair[0].2, "the fraction goes back: {pair:?}");
    }
    assert!(
        steps.iter().all(|s| (0.0..=1.0).contains(&s.2)),
        "{steps:?}"
    );
}

#[test]
fn progress_lines_become_events_with_file_and_fraction() {
    // real output of the pinned ProSE: two files, PeptDeep and Percolator on, closed search
    let steps = steps_of(
        "prose-closed-two-files-peptdeep.stdout.txt",
        &["DatabaseSuitability_1.mzML", "DatabaseSuitability_2.mzML"],
    );
    assert_eq!(
        labels(&steps),
        [
            "Searching DatabaseSuitability_1.mzML (1 of 2)...",
            "Building the fragment index...",
            "Searching DatabaseSuitability_1.mzML (1 of 2)...",
            "Adding PeptDeep rescoring features...",
            "Mapping peptides to proteins...",
            "Rescoring with Percolator...",
            "Searching DatabaseSuitability_2.mzML (2 of 2)...",
            "Adding PeptDeep rescoring features...",
            "Mapping peptides to proteins...",
            "Rescoring with Percolator...",
            // (a ProSE without -qpx_extended: the views' lines are not there)
            "Preparing the spectrum view (file 1 of 2)...",
            "Pooling the files...",
            "Writing the results...",
        ]
    );
    let files: Vec<i32> = steps.iter().map(|s| s.1).collect();
    assert_eq!(files, [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, -1, -1, -1]);
    assert_eq!(steps[0].2, 0.0, "the first file starts at 0");
    // the second file's step starts where the first one's share ends: half of the 35 % for the files' search
    assert!((steps[6].2 - 0.175).abs() < 1e-9, "{:?}", steps[6]);
    // the spectrum views follow the files' search, not 95 %
    assert!((steps[10].2 - 0.35).abs() < 1e-9, "{:?}", steps[10]);
    assert!(
        (steps[11].2 - 0.95).abs() < 1e-9,
        "pooling holds at 95 %: {:?}",
        steps[11]
    );
    assert_monotone(&steps);
}

#[test]
fn progress_names_the_file_by_the_original_name_not_the_symlink() {
    // the fixture names the files "1__DatabaseSuitability_1.mzML" (the shim's link); the label shows the user's name
    let steps = steps_of(
        "prose-closed-two-files-peptdeep.stdout.txt",
        &["First run.mzML", "Zweite Probe ä.mzML.gz"],
    );
    assert_eq!(steps[0].0, "Searching First run.mzML (1 of 2)...");
    assert!(labels(&steps).contains(&"Searching Zweite Probe ä.mzML.gz (2 of 2)..."));
    // without names, the line's own file name is used
    let plain = steps_of("prose-closed-two-files-peptdeep.stdout.txt", &[]);
    assert_eq!(
        plain[0].0,
        "Searching 1__DatabaseSuitability_1.mzML (1 of 2)..."
    );
}

#[test]
fn progress_of_a_single_open_search_ends_with_the_modification_analysis() {
    let steps = steps_of(
        "prose-open-one-file.stdout.txt",
        &["DatabaseSuitability_1.mzML"],
    );
    assert_eq!(
        labels(&steps),
        [
            "Searching DatabaseSuitability_1.mzML (1 of 1)...",
            "Building the fragment index...",
            "Searching DatabaseSuitability_1.mzML (1 of 1)...",
            "Mapping peptides to proteins...",
            "Rescoring with Percolator...",
            "Analysing modifications...",
            "Writing the results...",
        ]
    );
    assert_eq!(steps.last().unwrap().1, -1);
    assert_monotone(&steps);
}

#[test]
fn progress_of_several_open_files_pools_after_the_last_modification_analysis() {
    let steps = steps_of("prose-open-two-files.stdout.txt", &["a.mzML", "b.mzML"]);
    let l = labels(&steps);
    assert_eq!(
        &l[l.len() - 4..],
        [
            "Analysing modifications...",
            "Preparing the spectrum view (file 1 of 2)...",
            "Pooling the files...",
            "Writing the results..."
        ]
    );
    assert_eq!(
        l.iter()
            .filter(|x| **x == "Analysing modifications...")
            .count(),
        2
    );
    assert_eq!(
        steps
            .iter()
            .find(|s| s.0 == "Pooling the files...")
            .unwrap()
            .1,
        -1
    );
    assert_monotone(&steps);
}

const CHUNK_NAMES: [&str; 2] = ["a.mzML", "b.mzML"];

fn chunk_labels(n: usize) -> Vec<String> {
    (1..=n)
        .map(|k| format!("Searching database chunk {k} of {n}..."))
        .collect()
}

#[test]
fn a_chunked_search_of_two_files_reports_its_chunks_and_each_files_rescoring() {
    // real output: `database:chunk_size 20` on two inputs prints no "Searching" line (chunk-major mode)
    let steps = steps_of("prose-chunked-two-files-peptdeep.stdout.txt", &CHUNK_NAMES);
    let mut expected = vec!["Reading the spectra...".to_string()];
    expected.extend(chunk_labels(17));
    expected.extend(
        [
            "Adding PeptDeep rescoring features...",
            "Mapping peptides to proteins...",
            "Rescoring with Percolator...",
            "Adding PeptDeep rescoring features...",
            "Mapping peptides to proteins...",
            "Rescoring with Percolator...",
            // (no end marker of the last file in a closed chunked search, and this ProSE had no -qpx_extended)
            "Pooling the files...",
            "Writing the results...",
        ]
        .map(String::from),
    );
    assert_eq!(
        labels(&steps),
        expected.iter().map(String::as_str).collect::<Vec<_>>()
    );
    let files: Vec<i32> = steps.iter().map(|s| s.1).collect();
    assert!(
        files[..18].iter().all(|f| *f == -1),
        "reading and chunks are outside the files"
    );
    assert_eq!(files[18..], [0, 0, 0, 1, 1, 1, -1, -1]);
    // the chunks take the first half of the files' 35 % of the bar, in 17 equal steps
    assert_eq!(steps[1].2, 0.0);
    assert!(
        (steps[17].2 - 16.0 / 17.0 * 0.5 * 0.35).abs() < 1e-9,
        "{:?}",
        steps[17]
    );
    // the files' rescoring follows, file 1 after file 0
    assert!(
        steps[18].2 >= 0.175 && steps[23].2 > steps[20].2 && steps[23].2 < 0.35,
        "{steps:?}"
    );
    assert!((steps[24].2 - 0.95).abs() < 1e-9 && (steps[25].2 - 0.97).abs() < 1e-9);
    assert_monotone(&steps);
}

#[test]
fn a_chunked_search_of_one_file_reports_its_chunks() {
    let steps = steps_of(
        "prose-chunked-one-file-peptdeep.stdout.txt",
        &CHUNK_NAMES[..1],
    );
    let mut expected = vec!["Reading the spectra...".to_string()];
    expected.extend(chunk_labels(17));
    expected.extend(
        [
            "Adding PeptDeep rescoring features...",
            "Mapping peptides to proteins...",
            "Rescoring with Percolator...",
            "Writing the results...",
        ]
        .map(String::from),
    );
    assert_eq!(
        labels(&steps),
        expected.iter().map(String::as_str).collect::<Vec<_>>()
    );
    assert_eq!(
        steps[18..21].iter().map(|s| s.1).collect::<Vec<_>>(),
        [0, 0, 0]
    );
    assert_eq!(steps.last().unwrap().1, -1);
    assert_monotone(&steps);
}

#[test]
fn a_chunked_open_search_pools_after_the_aggregate_modification_analysis() {
    // no PeptDeep: the mapping line starts each file's rescoring
    let steps = steps_of("prose-chunked-open-two-files.stdout.txt", &CHUNK_NAMES);
    let l = labels(&steps);
    assert_eq!(l[0], "Reading the spectra...");
    assert_eq!(l[1], "Searching database chunk 1 of 4...");
    assert_eq!(
        l[5..],
        [
            "Mapping peptides to proteins...",
            "Rescoring with Percolator...",
            "Mapping peptides to proteins...",
            "Rescoring with Percolator...",
            "Preparing the spectrum view (file 1 of 2)...",
            "Pooling the files...",
            "Writing the results...",
        ]
    );
    assert_eq!(
        steps[5..12].iter().map(|s| s.1).collect::<Vec<_>>(),
        [0, 0, 1, 1, -1, -1, -1]
    );
    assert_monotone(&steps);
}

#[test]
fn progress_never_stalls_on_lines_it_does_not_know() {
    // unknown lines between the known ones change nothing, in every mode
    for (fixture, names) in [
        (
            "prose-closed-two-files-peptdeep.stdout.txt",
            &CHUNK_NAMES[..],
        ),
        (
            "prose-chunked-two-files-peptdeep.stdout.txt",
            &CHUNK_NAMES[..],
        ),
        (
            "prose-chunked-one-file-peptdeep.stdout.txt",
            &CHUNK_NAMES[..1],
        ),
        ("prose-open-one-file.stdout.txt", &CHUNK_NAMES[..1]),
    ] {
        let plain = steps_of(fixture, names);
        let mut tracker = ProgressTracker::new(names.iter().map(|n| n.to_string()).collect());
        let mut noisy = Vec::new();
        for line in fixture_lines(fixture) {
            for junk in [
                "",
                "[ProSE] something new",
                "Chunk",
                "Chunk x/y",
                "[ProSE] Chunk-major",
                "Mapping",
                "[PeptDeepRescoring",
            ] {
                assert!(tracker.feed(junk).is_none(), "{junk:?} in {fixture}");
            }
            if let Some(p) = tracker.feed(&line) {
                noisy.push((p.label, p.file, p.fraction));
            }
        }
        assert_eq!(noisy, plain, "{fixture}");
    }
}

fn fixture_lines(name: &str) -> Vec<String> {
    fixture(name).lines().map(String::from).collect()
}

#[test]
fn a_chunked_search_pools_on_the_protein_inference_line_of_current_prose() {
    // Since OpenMS #10707 the pooled protein inference and FDR logs "[ProSE] Protein inference on …" (the recorded runs
    // have the earlier "[ProSE] Merged protein inference + FDR …"): the same steps
    let fixture_name = "prose-chunked-two-files-peptdeep.stdout.txt";
    let mut tracker = ProgressTracker::new(CHUNK_NAMES.iter().map(|n| n.to_string()).collect());
    let mut steps = Vec::new();
    let mut replaced = 0;
    for line in fixture_lines(fixture_name) {
        let line = if line.starts_with("[ProSE] Merged protein inference") {
            replaced += 1;
            "[ProSE] Protein inference on 1792 PSMs (2 of them up to FDR:protein_inference_PSM, not reported), protein \
             score PEP: 51 target and 3 decoy proteins."
                .to_string()
        } else {
            line
        };
        if let Some(p) = tracker.feed(&line) {
            steps.push((p.label, p.file, p.fraction));
        }
    }
    assert_eq!(replaced, 1);
    assert_eq!(steps, steps_of(fixture_name, &CHUNK_NAMES));
    assert!(labels(&steps).contains(&"Pooling the files..."));
}

#[test]
fn progress_reports_the_calibration_pass() {
    let steps = steps_of(
        "prose-calibration-one-file.stdout.txt",
        &["DatabaseSuitability_1.mzML"],
    );
    assert!(
        labels(&steps).contains(&"Running calibration pass..."),
        "{:?}",
        labels(&steps)
    );
    assert!(
        !labels(&steps).contains(&"Rescoring with Percolator..."),
        "rescoring was off in this run"
    );
    assert_monotone(&steps);
}

#[test]
fn lines_without_a_step_give_no_event() {
    let mut tracker = ProgressTracker::new(vec!["a.mzML".into()]);
    for line in [
        "",
        "Generating fragments...",
        "Collapsed 12 repeated peptidoform occurrences.",
        "random text",
        "[ProSE] open_search=false (precursor tolerance [-10, +10] ppm)",
    ] {
        assert!(tracker.feed(line).is_none(), "{line:?}");
    }
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
fn the_tool_is_found_through_prose_bin_then_the_bundle_then_path() {
    let dir = TempDir::new("resolve");
    let env_bin = executable(&dir, "env/ProSE");
    let bundled = executable(&dir, &format!("res/resources/prose/bin/{}", tool::EXE));
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
    assert!(err.contains("ProSE"), "{err}");

    // a PROSE_BIN that does not exist is an error, not a reason to look elsewhere
    let err = tool::resolve_with(
        Some(OsStr::new("/nonexistent/ProSE")),
        Some(&res),
        Some(&path_var),
    )
    .unwrap_err();
    assert!(
        err.contains("PROSE_BIN") && err.contains("/nonexistent/ProSE"),
        "{err}"
    );
}

/// macOS: Tauri names no resource folder when the app's path goes through a symbolic link; the app then
/// takes the Resources folder of the bundle its executable really is in.
#[cfg(unix)]
#[test]
fn the_resources_of_an_app_bundle_are_found_through_a_link() {
    let dir = TempDir::new("bundle");
    let exe = executable(&dir, "real/ProSE.app/Contents/MacOS/prose-desktop");
    dir.write(
        "real/ProSE.app/Contents/Resources/resources/prose/build.json",
        "{}",
    );
    let resources = dir
        .path()
        .join("real/ProSE.app/Contents/Resources")
        .canonicalize()
        .unwrap();
    assert_eq!(tool::bundle_resources(&exe), Some(resources.clone()));
    // the app through a linked folder, and as a linked bundle
    std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("linked")).unwrap();
    std::os::unix::fs::symlink(
        dir.path().join("real/ProSE.app"),
        dir.path().join("Linked.app"),
    )
    .unwrap();
    for through in [
        "linked/ProSE.app/Contents/MacOS/prose-desktop",
        "Linked.app/Contents/MacOS/prose-desktop",
    ] {
        assert_eq!(
            tool::bundle_resources(&dir.path().join(through)),
            Some(resources.clone()),
            "{through}"
        );
    }
    // not in a bundle: no Resources folder, none
    let loose = executable(&dir, "bin/prose-desktop");
    assert_eq!(tool::bundle_resources(&loose), None);
    assert_eq!(tool::bundle_resources(&dir.path().join("nothing")), None);
}

#[test]
fn the_tools_version_is_read_from_its_help() {
    let help = "ProSE -- Annotates bottom-up MS/MS spectra using ProSE.\nFull documentation: http://x\nVersion: 3.7.0-pre-exported-20261020 Oct 20 2026, 22:16:02\nTo cite OpenMS:\n";
    assert_eq!(
        tool::parse_version(help).as_deref(),
        Some("3.7.0-pre-exported-20261020")
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
fn probing_a_tool_reports_its_version_path_and_onnx_support() {
    let dir = TempDir::new("probe");
    // a script on Unix; on Windows the fake tool, which answers --help the same way
    #[cfg(unix)]
    let script = executable(&dir, "ProSE");
    #[cfg(unix)]
    fs::write(&script, "#!/bin/sh\necho 'Version: 9.9.9 Oct 20 2026'\n").unwrap();
    #[cfg(not(unix))]
    let script = fake_prose_exe();
    let info = probe_written_script(&script).unwrap();
    assert_eq!(info.version, "9.9.9");
    assert_eq!(info.path, script.to_string_lossy());
    assert!(!info.onnx, "a tool without a build manifest has no ONNX");
    assert!(tool::probe(&dir.path().join("none")).is_err());
}

#[test]
fn onnx_support_comes_from_the_bundles_manifest_and_its_models() {
    let dir = TempDir::new("onnx");
    let bin = executable(&dir, "prose/bin/ProSE");
    let models = [
        "share/OpenMS/models/peptdeep_ms2_dynamic.onnx",
        "share/OpenMS/models/peptdeep_rt_dynamic.onnx",
    ];
    let manifest = |with_onnx: bool| {
        dir.write(
            "prose/build.json",
            &serde_json::json!({ "tool": "ProSE", "withOnnx": with_onnx, "models": models })
                .to_string(),
        );
    };

    // no manifest (a tool from a build tree or the PATH): no ONNX, whatever it links
    assert!(!tool::has_onnx(&bin));
    // a build with ONNX, but the models are missing
    manifest(true);
    assert!(!tool::has_onnx(&bin));
    for model in models {
        dir.write(&format!("prose/{model}"), "onnx");
    }
    assert!(tool::has_onnx(&bin));
    // one model gone
    fs::remove_file(dir.path().join("prose").join(models[1])).unwrap();
    assert!(!tool::has_onnx(&bin));
    dir.write(&format!("prose/{}", models[1]), "onnx");
    // a build without ONNX, models or not
    manifest(false);
    assert!(!tool::has_onnx(&bin));
    // a manifest that names no models, or cannot be read
    dir.write("prose/build.json", r#"{"withOnnx": true, "models": []}"#);
    assert!(!tool::has_onnx(&bin));
    dir.write("prose/build.json", "not json");
    assert!(!tool::has_onnx(&bin));
    // a model path that leaves the bundle does not count
    dir.write("outside.onnx", "onnx");
    dir.write(
        "prose/build.json",
        r#"{"withOnnx": true, "models": ["../outside.onnx"]}"#,
    );
    assert!(!tool::has_onnx(&bin));
}

#[test]
fn the_tool_runs_with_one_blas_thread_unless_set() {
    let cmd = tool::command_with(Path::new("/x/ProSE"), None);
    let env: Vec<_> = cmd.get_envs().collect();
    assert!(env.contains(&(OsStr::new("OPENBLAS_NUM_THREADS"), Some(OsStr::new("1")))));
    let cmd = tool::command_with(Path::new("/x/ProSE"), Some(OsString::from("4")));
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
        let cmd = tool::command_with(Path::new("/x/ProSE"), openblas);
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
}

impl Run {
    fn new() -> Run {
        Run {
            work: TempDir::new("run"),
            searches: Arc::new(Searches::default()),
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
                .start(&fake_prose(), &self.dir(), crap, req, sink),
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

impl Run {
    /// As `new`, with the inputs reaching the tool as `links` says (Windows' way on any platform).
    fn with_links(links: InputLinks) -> Run {
        Run {
            work: TempDir::new("run"),
            searches: Arc::new(Searches::with_links(links)),
        }
    }
}

fn done_folder(events: &[SearchEvent]) -> PathBuf {
    match events.last() {
        Some(SearchEvent::Done(d)) => PathBuf::from(&d.folder),
        other => panic!("not done: {other:?} in {events:?}"),
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
        prose_desktop_lib::files::recorded_database(&folder).as_deref(),
        i.fasta.to_str()
    );
}

#[test]
fn a_search_ends_with_done_and_the_partial_folder_becomes_the_search_folder() {
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
    assert!(folder.join("qpx/quantms.psm.parquet").is_file());
    assert!(
        !folder.join(".lock").exists(),
        "the lock file does not belong to the search"
    );
    assert!(fs::read_to_string(folder.join("database.fasta"))
        .unwrap()
        .contains(">CON__ALBU"));
    // ProSE searched the folder's own database: no path outside the folder is recorded
    assert!(!folder.join("database.json").exists());
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
    assert!(
        matches!(&events[0], SearchEvent::Progress(p) if p.file == -1 && p.fraction == 0.0),
        "{:?}",
        events[0]
    );
    assert!(events.iter().any(|e| matches!(e, SearchEvent::Progress(p) if p.label == "Searching a.mzML (1 of 1)..." && p.file == 0)));
    // the fake ran with exactly the arguments build_args makes for the partial folder
    let argv = fs::read_to_string(folder.join("argv.txt")).unwrap();
    let input = match InputLinks::PLATFORM {
        InputLinks::Symlinks => run.dir().join(format!("{id}.partial")).join("1__a.mzML"),
        InputLinks::PathsOrHardLinks => i.mzml.clone(),
    };
    assert!(
        argv.lines().any(|l| Path::new(l) == input),
        "{input:?} in {argv}"
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
        folder.join("qpx/runs/1__sample.psm.parquet").is_file()
            && folder.join("qpx/runs/2__sample.psm.parquet").is_file()
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

#[cfg(unix)]
#[test]
fn gz_inputs_keep_their_suffix_in_the_link() {
    let run = Run::new();
    let i = inputs();
    let gz = i.dir.write("zipped/x.mzML.gz", "gz");
    let (id, rx) = run.start(request(&[&gz], &i.fasta, false, json!({})), None);
    id.unwrap();
    let folder = done_folder(&until_terminal(&rx, WAIT));
    assert!(fs::symlink_metadata(folder.join("1__x.mzML.gz"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(folder.join("qpx/runs/1__x.psm.parquet").is_file());
    let mapping: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("inputs.json")).unwrap()).unwrap();
    assert_eq!(mapping[0]["link"], "1__x.mzML.gz");
    assert_eq!(mapping[0]["name"], "x.mzML.gz");
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
        // a hard link (the name is too long for ProSE's outputs), which the finished search drops
        assert!(!folder.join(&link).exists(), "{link} is gone");
    } else {
        assert!(fs::symlink_metadata(folder.join(&link))
            .unwrap()
            .file_type()
            .is_symlink());
    }
    // the reader finds the input's outputs by the stem inputs.json records
    assert!(folder
        .join(format!("qpx/runs/{stem}.psm.parquet"))
        .is_file());
    // Windows: such an input goes as a (shortened) link, not by its own path
    let req = request(&[&long, &i.mzml], &i.fasta, false, json!({}));
    let windows =
        Path::new(r"C:\Users\u\AppData\Roaming\org.openms.prose.desktop\searches\1-0.partial");
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
/// so that ProSE's longest output (`mods\<stem>_ModificationAnalysis_DeltaMassStats.tsv`) and every link stay
/// within it; a name that fits MAX_STEM but not the folder goes as a shortened link too; a folder of too long a
/// path is refused before anything is made.
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
        259 - 100 - r"\mods\".len() - "_ModificationAnalysis_DeltaMassStats.tsv".len()
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
            r"{}\mods\{}_ModificationAnalysis_DeltaMassStats.tsv",
            folder.display(),
            r.stem
        );
        let link = format!(r"{}\{}", folder.display(), r.link);
        assert!(
            longest.encode_utf16().count() <= 259 && link.encode_utf16().count() <= 259,
            "{longest}"
        );
    }
    let args = build_args_with(&req, folder, windows).unwrap();
    assert_eq!(
        values_of(&args, "-in")[0],
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
    // a folder that leaves no room for ProSE's outputs is refused
    let deep = format!(r"C:\{}\1-0.partial", "d".repeat(220));
    let err = build_args_with(&req, Path::new(&deep), windows).unwrap_err();
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
    let b = i.dir.write("other/b.mzML.gz", "gz");
    let (id, rx) = run.start(request(&[&i.mzml, &b], &i.fasta, false, json!({})), None);
    let id = id.unwrap();
    let folder = done_folder(&until_terminal(&rx, WAIT));
    assert_eq!(folder, run.dir().join(&id));
    let argv = fs::read_to_string(folder.join("argv.txt")).unwrap();
    let ins: Vec<&str> = argv.lines().skip(1).take(2).collect();
    assert_eq!(
        ins.iter().map(PathBuf::from).collect::<Vec<_>>(),
        [i.mzml.clone(), b.clone()],
        "{argv}"
    );
    assert!(
        folder.join("qpx/runs/a.psm.parquet").is_file()
            && folder.join("qpx/runs/b.psm.parquet").is_file()
    );
    let mapping: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("inputs.json")).unwrap()).unwrap();
    assert_eq!(
        mapping,
        json!([
            { "id": "f0", "index": 0, "link": "a.mzML", "stem": "a", "name": "a.mzML", "path": i.mzml },
            { "id": "f1", "index": 1, "link": "b.mzML.gz", "stem": "b", "name": "b.mzML.gz", "path": b },
        ])
    );
    let names: Vec<String> = fs::read_dir(&folder)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !names
            .iter()
            .any(|n| n.ends_with(".mzML") || n.ends_with(".gz")),
        "{names:?}"
    );
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
        folder.join("qpx/runs/1__sample.psm.parquet").is_file()
            && folder.join("qpx/runs/2__Sample.psm.parquet").is_file()
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
    let _ = fs::remove_dir_all(&elsewhere);
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
    // a lone input of stem quantms on the other volume: its own reason
    let reserved = elsewhere.join("QuantMS.mzML");
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(&reserved, "<mzML/>").unwrap();
    let (result, _rx) = run.start(request(&[&reserved], &i.fasta, false, json!({})), None);
    let err = result.unwrap_err();
    let _ = fs::remove_dir_all(&elsewhere);
    assert!(
        err.contains("ProSE cannot search a file named QuantMS.mzML")
            && err.contains("Rename the file")
            && !err.contains("Two inputs"),
        "{err}"
    );
    // a lone input whose name is too long for ProSE's outputs in the search folder: its own reason too
    let long = elsewhere.join(format!("{}.mzML", "l".repeat(240)));
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(&long, "<mzML/>").unwrap();
    let (result, _rx) = run.start(request(&[&long], &i.fasta, false, json!({})), None);
    let err = result.unwrap_err();
    let _ = fs::remove_dir_all(&elsewhere);
    assert!(
        err.contains("is too long for ProSE's result files")
            && err.contains("Rename the file to a shorter name")
            && !err.contains("Two inputs"),
        "{err}"
    );
}

/// ProSE's lines of a full disk: the first one is the message, with the outputs named as in the search folder
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
        "Failed to write qpx/runs/diskfull.psm.parquet: IOError: Error writing bytes to file. Detail: [errno 28] No \
         space left on device"
    );
    assert_eq!(f.ended.as_deref(), Some("ProSE ended with exit code 12"));
    let detail = f.detail.as_deref().unwrap();
    assert!(
        detail.ends_with("ProSE finished with 1 file(s) failing out of 1.")
            && !detail.contains(".partial"),
        "{detail}"
    );
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
            "Reading /s/1-0.partial/2__a.mzML; writing /s/1-0.partial/qpx/runs/2__a.pg.parquet: row 3 reuses run '1__a'; \
             1__a.mzML; 11__a stays",
            dir,
            &records
        ),
        "Reading /other/a.mzML; writing qpx/runs/a.pg.parquet: row 3 reuses run 'a'; a.mzML; 11__a stays"
    );
    // a Windows search folder, as ProSE may write it: with '\\', with '/' (a path it put together), mixed, and
    // the drive letter in the other case
    let dir = Path::new(r"C:\Users\u\AppData\Roaming\prose\searches\1-0.partial");
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
            r"Reading C:\Users\u\AppData\Roaming\prose\searches\1-0.partial\2__a.mzML; Reading c:/Users/u/AppData/Roaming/prose/searches/1-0.partial/1__a.mzML; writing C:\Users\u\AppData\Roaming\prose\searches\1-0.partial\qpx/runs/2__a.pg.parquet and C:/Users/u/AppData/Roaming/prose/searches/1-0.partial/merged.idXML",
            dir,
            &records
        ),
        "Reading D:/other/a.mzML; Reading D:/data/a.mzML; writing qpx/runs/a.pg.parquet and merged.idXML"
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
        f.stage, "Rescoring with Percolator...",
        "the last progress label"
    );
    assert_eq!(f.file, Some(0), "the input of the last report");
    assert_eq!(
        f.message,
        format!(
            "Error: Unable to read file (the input broke {})",
            crash.display()
        ),
        "the message names the user's file, not the link; noise lines are skipped"
    );
    // how ProSE ended leads the message; the stderr tail is the detail, the log is kept
    assert_eq!(f.ended.as_deref(), Some("ProSE ended with exit code 3"));
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
    assert!(
        run.listing().is_empty(),
        "the partial folder is removed: {:?}",
        run.listing()
    );
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
        "ProSE crashed (exception 0xC0000005)"
    } else {
        "ProSE crashed (signal 11, SIGSEGV)"
    };
    assert_eq!(f.ended.as_deref(), Some(expected));
    // the last line of a crashed tool says nothing about the crash (Percolator's "Split 3:" after a SIGKILL):
    // it is in the details only
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
            Path::new("/nonexistent/ProSE"),
            &run.dir(),
            None,
            request(&[&i.mzml], &i.fasta, false, json!({})),
            sink,
        )
        .unwrap_err();
    assert!(err.contains("/nonexistent/ProSE"), "{err}");
    assert!(run.listing().is_empty());
}

fn start_hanging(
    run: &Run,
    i: &Inputs,
    name: &str,
) -> (String, std::sync::mpsc::Receiver<SearchEvent>, PathBuf) {
    let hang = i.dir.write(&format!("in/{name}.mzML"), "<mzML/>");
    let (id, rx) = run.start(request(&[&hang], &i.fasta, false, json!({})), None);
    let id = id.unwrap();
    first_progress(&rx, WAIT);
    let partial = run.dir().join(format!("{id}.partial"));
    assert!(wait_for(WAIT, || partial.join("children.pid").is_file()
        && read_pids(&partial.join("children.pid")).len() == 2));
    (id, rx, partial)
}

#[test]
fn a_running_search_holds_the_lock_of_its_partial_folder_and_the_sweep_leaves_it() {
    use prose_desktop_lib::history::{sweep, SWEEP_GRACE};
    let run = Run::new();
    let i = inputs();
    let (id, _rx, partial) = start_hanging(&run, &i, "hang");
    // another app instance's startup sweep, however late: the partial folder is live
    let much_later = std::time::SystemTime::now() + SWEEP_GRACE * 1000;
    assert!(sweep(&run.dir(), much_later, SWEEP_GRACE).is_empty());
    assert!(partial.join("prose.log").exists() || partial.join("prose.pid").exists());
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
    let (id, rx, partial) = start_hanging(&run, &i, "hang");
    let tool_pid = read_pids(&partial.join("prose.pid"))[0];
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

/// The watchdogs (`--watch-search <this process> <group>`) of the tool's process `group`, by `ps`.
#[cfg(unix)]
fn watchdogs_of(group: u32) -> Vec<String> {
    let out = std::process::Command::new("ps")
        .args(["-A", "-ww", "-o", "pid=,command="])
        .output()
        .unwrap();
    let needle = format!(
        "{} {} {group}",
        prose_desktop_lib::watchdog::FLAG,
        std::process::id()
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.ends_with(&needle))
        .map(str::to_string)
        .collect()
}

/// (macOS's way; the code is the same on every Unix) a watched search starts the watchdog of its tool's
/// group with the tool, and ends it with the search.
#[cfg(unix)]
#[test]
fn a_watched_search_starts_its_watchdog_and_ends_it_with_the_search() {
    let run = Run {
        work: TempDir::new("run"),
        searches: Arc::new(
            Searches::default().with_watchdog(PathBuf::from(env!("CARGO_BIN_EXE_prose-desktop"))),
        ),
    };
    let i = inputs();
    let (id, _rx, partial) = start_hanging(&run, &i, "hang");
    let tool_pid = read_pids(&partial.join("prose.pid"))[0];
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
    let pid = read_pids(&folder.join("prose.pid"))[0];
    assert!(watchdogs_of(pid).is_empty(), "{id}");
}

#[test]
fn cancel_kills_a_process_that_ignores_sigterm() {
    let run = Run::new();
    let i = inputs();
    let (id, _rx, partial) = start_hanging(&run, &i, "stubborn");
    let tool_pid = read_pids(&partial.join("prose.pid"))[0];
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
    let (_, _rx1, p1) = start_hanging(&run, &i, "hang");
    let (_, _rx2, p2) = start_hanging(&run, &i, "stubborn");
    let pids: Vec<u32> = [&p1, &p2]
        .iter()
        .flat_map(|p| read_pids(&p.join("prose.pid")))
        .collect();
    run.searches.cancel_all();
    assert!(pids.iter().all(|p| !process_alive(*p)));
    assert!(run.listing().is_empty());
}
