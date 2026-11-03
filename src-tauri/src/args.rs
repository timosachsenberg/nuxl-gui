//! The search request and its translation into ProSE's command line.
//!
//! The front end sends a [`SearchRequest`] (camelCase JSON). [`build_args`] checks it and turns it into
//! arguments for the tool. Nothing here runs a process or touches the search folder; the folder is made
//! by [`mod@crate::run`], which also creates the links and the database that these arguments name.
//!
//! Parameters are ProSE's `Search:` parameters by their name without the prefix, as in the web app
//! (`peptide:missed_cleavages`, `FDR:PSM`). Only the names in [`PARAMETERS`] pass, each with the type
//! it has in ProSE, so that nothing from the front end can become another option of the tool
//! (`-in`, `-ini`, an output of its own choosing).

use crate::decoys::{decoy_sequence, DecoyRules, DecoyStatistics};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::Path;

/// One input file: the front end's id for it and its path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings {
    /// ProSE parameters by name, without the `Search:` prefix (see [`PARAMETERS`]).
    pub parameters: Map<String, Value>,
    /// Percolator rescoring (`Search:rescore`).
    pub rescore: bool,
    /// PeptDeep features (`Search:peptdeep:enable`); ProSE finds its models itself.
    pub peptdeep: bool,
    /// `-threads` (0: all cores).
    pub threads: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub files: Vec<SearchFile>,
    pub database: String,
    /// Append the bundled cRAP to the database, with `CON__` accessions.
    pub contaminants: bool,
    pub settings: SearchSettings,
}

/// The type of a ProSE parameter, which decides how a JSON value becomes arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// An integer (`<number>` in ProSE's help).
    Int,
    /// A real number (`<value>`).
    Float,
    /// One of ProSE's choices, a string; the `true`/`false` ones also take a JSON boolean.
    Choice,
    /// Free text; empty means unset.
    Text,
    /// A list of strings, one argument each (an empty list clears the default).
    List,
    /// A switch without a value: `-Search:name` when true, nothing when false.
    Flag,
}

use Kind::*;

/// Every `Search:` parameter a search may set, with its type. The four that the request's own fields
/// set (`rescore`, `peptdeep:enable` and the two PeptDeep model paths) are not in the list.
/// The list is ProSE's `--helphelp` of the pinned build (`native/OPENMS_COMMIT`).
pub const PARAMETERS: &[(&str, Kind)] = &[
    ("enzyme", Choice),
    ("decoys", Choice),
    ("decoy_prefix", Text),
    ("low_memory", Flag),
    ("precursor:mass_tolerance_lower", Float),
    ("precursor:mass_tolerance_upper", Float),
    ("precursor:mass_tolerance_unit", Choice),
    ("precursor:min_charge", Int),
    ("precursor:max_charge", Int),
    ("precursor:isotope_error_min", Int),
    ("precursor:isotope_error_max", Int),
    ("fragment:mass_tolerance", Float),
    ("fragment:mass_tolerance_unit", Choice),
    ("fragment:deisotope", Choice),
    ("fragment:deisotope_min_peaks", Int),
    ("fragment:deisotope_charge_cap", Choice),
    ("fragment:deisotope_sum_intensity", Choice),
    ("fragment:min_mz", Int),
    ("fragment:max_mz", Int),
    ("fragment:min_ion_index", Int),
    ("fragment:query_spectrum", Choice),
    ("fragment:min_matched_ions", Int),
    ("fragment:max_charge", Int),
    ("peaks:keep_n", Int),
    ("peaks:window_top", Int),
    ("peaks:window_type", Choice),
    ("modifications:fixed", List),
    ("modifications:variable", List),
    ("modifications:variable_max_per_peptide", Int),
    ("annotate:PSM", List),
    ("annotate:self_trained_ion_priors", Choice),
    ("annotate:ion_prior_model", Choice),
    ("annotate:ion_prior_peaks", Choice),
    ("annotate:ion_prior_max_fragment_charge", Int),
    ("annotate:ion_prior_train_fdr", Float),
    ("annotate:ion_prior_min_psms", Int),
    ("annotate:ion_prior_features", List),
    ("annotate:local_fragment_evidence", Choice),
    ("peptdeep:instrument", Choice),
    ("peptdeep:nce", Float),
    ("peptdeep:rt_model_type", Choice),
    ("peptdeep:batch_size", Int),
    ("peptide:min_size", Int),
    ("peptide:max_size", Int),
    ("peptide:missed_cleavages", Int),
    ("peptide:clip_nterm_methionine", Choice),
    ("peptide:deduplicate", Choice),
    ("peptide:protein_mapping", Choice),
    ("peptide:enzyme_specificity", Choice),
    ("peptide:motif", Text),
    ("peptide:min_mass", Int),
    ("peptide:max_mass", Int),
    ("report:top_hits", Int),
    ("report:isotope_error_convention", Choice),
    ("percolator:max_train_psms", Int),
    ("FDR:PSM", Float),
    ("FDR:PSM_groups", Choice),
    ("FDR:protein", Float),
    ("FDR:protein_inference_PSM", Float),
    ("scoring:max_candidates_per_spectrum", Int),
    ("scoring:fragment_charges", Choice),
    ("scoring:method", Choice),
    ("scoring:mass_error_sd", Float),
    ("ions:add_y_ions", Choice),
    ("ions:add_b_ions", Choice),
    ("ions:add_a_ions", Flag),
    ("ions:add_c_ions", Flag),
    ("ions:add_x_ions", Flag),
    ("ions:add_z_ions", Flag),
    ("ions:add_zp1_ions", Flag),
    ("ions:by_activation", Choice),
    ("calibration:enabled", Flag),
    ("calibration:subset_ratio", Float),
    ("calibration:min_psms", Int),
    ("database:chunk_size", Int),
    ("chimeric:enabled", Flag),
    ("chimeric:max_coisolated", Int),
    ("chimeric:max_kl", Float),
    ("chimeric:top_hits", Int),
    ("chimeric:mz_tolerance", Float),
];

/// The name of the database in the search folder when contaminants are appended.
pub const DATABASE_FILE: &str = "database.fasta";

/// The record of the user's database in the search folder when ProSE searches it as it is (no contaminants):
/// `{"path": "<absolute path>"}`, the one absolute path the reader may read (`files::resolve_search_file`).
pub const DATABASE_RECORD: &str = "database.json";

/// The QPX output of ProSE in the search folder: `-out_qpx`, with `-qpx_extended` (the columns and the footer
/// the results reader needs, docs/parity.md).
pub const QPX_DIR: &str = "qpx";

/// The peak filter of the stored spectra (`-qpx_peak_window`, `-qpx_peak_top`; ProSE's QPX mz view): the 100
/// most intense peaks per 100 m/z and every peak ProSE annotated (the user's choice). On an Orbitrap HCD run
/// (~1,100 peaks per MS2 spectrum) it keeps 631 peaks per spectrum and removes 6.2 % of the peaks the PSM view's
/// annotation matches (b/y/a/c/x/z, charge 1-2), nearly all of intensity 0; of b/y matches 1.2 % (docs/parity.md).
pub const PEAK_WINDOW: f64 = 100.0;
pub const PEAK_TOP: u32 = 100;

/// The idXML of a search of several inputs (`-out_merged`), and of one input (`-out_idxml`), in the search
/// folder (the Export menu's idXML: `src/lib/results/exports.ts`).
pub const MERGED_IDXML: &str = "merged.idXML";
pub const SINGLE_IDXML: &str = "search.idXML";

/// The FDR the shim uses when the request has no `FDR:PSM`: ProSE's default (0) filters nothing and
/// leaves a search without q-values, which the results need. Not for a search without decoys
/// ([`FDR_PARAMETERS`]), which has no FDR.
pub const DEFAULT_PSM_FDR: f64 = 0.01;

/// The FDR parameters, which a search without decoys (`decoys` 'ignore') leaves out: ProSE cannot estimate an FDR
/// then and would skip a PSM or protein FDR above 0 with only a warning in its log (and the inference's PSM cutoff,
/// a q-value, has nothing to cut). The front end turns them off then; the shim leaves them out too, so that no
/// search claims an FDR it did not apply.
pub const FDR_PARAMETERS: [&str; 3] = ["FDR:PSM", "FDR:protein", "FDR:protein_inference_PSM"];

/// Whether the parameters search without decoys (`decoys` 'ignore'): no FDR then ([`FDR_PARAMETERS`]).
pub fn without_decoys(params: &Map<String, Value>) -> bool {
    params.get("decoys").and_then(Value::as_str) == Some("ignore")
}

/// The most threads a search may ask for (`-threads`): far beyond any computer the app runs on, but a typo of
/// a few more digits is refused here, before ProSE starts that many OpenMP threads (or refuses the number).
pub const MAX_THREADS: u32 = 1024;

/// Where `suffix` (ASCII, with the dot) begins at the end of `name`, compared ignoring ASCII case as
/// OpenMS compares extensions (`FileNameUtils`); None if `name` does not end with it. The original's own
/// bytes are compared: a lower-cased copy can be longer or shorter (`İ`, `Ⱥ`, `ẞ`, the Kelvin sign), and
/// its byte offsets do not fit the original.
pub fn suffix_start(name: &str, suffix: &str) -> Option<usize> {
    let start = name.len().checked_sub(suffix.len())?;
    (name.is_char_boundary(start) && name[start..].eq_ignore_ascii_case(suffix)).then_some(start)
}

/// Extension check: `name` ends with one of `suffixes` (with the dot), ignoring ASCII case.
fn has_suffix(name: &str, suffixes: &[&str]) -> bool {
    suffixes.iter().any(|s| suffix_start(name, s).is_some())
}

pub fn is_spectrum_file(name: &str) -> bool {
    has_suffix(name, &[".mzml", ".mzml.gz"])
}

pub fn is_fasta_file(name: &str) -> bool {
    has_suffix(name, &[".fasta", ".fa", ".faa"])
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The longest stem (bytes) an input may have where ProSE names outputs after it. Its longest output name is
/// `<stem>_ModificationAnalysis_DeltaMassStats.tsv` (open search), and a file name has at most 255 bytes (Linux,
/// macOS; NTFS 255 UTF-16 units, which are never more than the bytes).
pub const MAX_STEM: usize = 255 - LONGEST_OUTPUT_SUFFIX.len();

/// The end of ProSE's longest output name after an input's stem (open search, in `mods/`).
const LONGEST_OUTPUT_SUFFIX: &str = "_ModificationAnalysis_DeltaMassStats.tsv";
/// The folder of that output in the search folder, with the separators around it (`mods\`, `qpx\runs\` is
/// shorter with its `.psm.parquet`).
const LONGEST_OUTPUT_FOLDER: &str = "\\mods\\";
/// Windows' MAX_PATH: a path has at most 259 UTF-16 units (260 with its terminating null), unless the
/// program opts into long paths, which ProSE (OpenMS, Arrow) is not known to do.
const WINDOWS_MAX_PATH: usize = 259;

/// The longest stem (bytes) an input may have in the search folder `folder` (its `.partial` path), for links
/// `links`: [`MAX_STEM`]; on Windows ([`InputLinks::PathsOrHardLinks`]) also short enough that the path of
/// ProSE's longest output in the folder (`<folder>\mods\<stem>_ModificationAnalysis_DeltaMassStats.tsv`) and of
/// every link (`<folder>\<n>__<stem>.mzML.gz`, shorter) stays within MAX_PATH. A stem's UTF-16 units are never
/// more than its bytes, so the bytes bound it. 0 if not even the fixed part of that path fits.
pub fn max_stem(links: InputLinks, folder: &Path) -> usize {
    match links {
        InputLinks::Symlinks => MAX_STEM,
        InputLinks::PathsOrHardLinks => {
            let fixed = folder.as_os_str().to_string_lossy().encode_utf16().count()
                + LONGEST_OUTPUT_FOLDER.len()
                + LONGEST_OUTPUT_SUFFIX.len();
            WINDOWS_MAX_PATH.saturating_sub(fixed).min(MAX_STEM)
        }
    }
}

/// The shortest stem limit that still gives the `count` inputs link names of their own (`<n>__` and a character
/// of the name).
fn shortest_stem(count: usize) -> usize {
    format!("{count}__").len() + 1
}

/// The name of input `index` (0-based) in the search folder: `<n>__<name>` with `n` from 1. ProSE names
/// its per-input outputs after the input and refuses two inputs of one name, so an input goes in as
/// a link with a name of its own (see [`InputLinks`]); the suffix (`.mzML.gz`) stays as it is. A name
/// whose stem would be longer than [`MAX_STEM`] is shortened (at a character) to that length: `<n>__`
/// keeps the stems unique, `inputs.json` maps the link back to the user's file ([`InputRecord`]).
pub fn link_name(index: usize, path: &str) -> String {
    link_name_within(index, path, MAX_STEM)
}

/// As [`link_name`], the stem at most `max_stem` bytes ([`max_stem`]).
pub fn link_name_within(index: usize, path: &str, max_stem: usize) -> String {
    let link = format!("{}__{}", index + 1, file_name(path));
    let stem = input_stem(&link).len();
    if stem <= max_stem {
        return link;
    }
    let mut end = max_stem;
    while !link.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &link[..end], &link[stem..])
}

/// Whether ProSE's outputs of an input of this name would have names (or, on Windows, paths) too long for the
/// file system, with stems of at most `max_stem` bytes.
pub fn stem_too_long(name: &str, max_stem: usize) -> bool {
    input_stem(name).len() > max_stem
}

/// Whether `name`, a name in the top level of a search folder, is one of the links to the inputs
/// (`<n>__<name>.mzML[.gz]`): never one of the search's own files.
pub fn is_input_link(name: &str) -> bool {
    name.split_once("__").is_some_and(|(n, rest)| {
        !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && is_spectrum_file(rest)
    })
}

/// How the inputs reach ProSE, which names its outputs after each input's stem and refuses two inputs
/// of one stem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputLinks {
    /// Every input as a symbolic link `<n>__<name>` in the search folder (Linux, macOS).
    Symlinks,
    /// Windows, where a symbolic link needs a privilege (developer mode): the inputs by their own paths
    /// when their stems differ (ignoring case, as NTFS does); those that share a stem as hard links
    /// `<n>__<name>` in the search folder, which works on the same volume only; never a copy.
    PathsOrHardLinks,
}

impl InputLinks {
    /// This platform's way.
    pub const PLATFORM: InputLinks = if cfg!(windows) {
        InputLinks::PathsOrHardLinks
    } else {
        InputLinks::Symlinks
    };
}

/// How one input reaches ProSE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// A symbolic link `<n>__<name>` in the search folder.
    Symlink,
    /// A hard link `<n>__<name>` in the search folder, removed again when the search ends.
    HardLink,
    /// The user's path itself.
    OwnPath,
}

/// The stem ProSE refuses for an input with `-out_qpx` (the merged views are `quantms.*.parquet`).
const RESERVED_STEM: &str = "quantms";

/// Whether ProSE refuses an input of this name as it is (its stem is `quantms`, ignoring case).
pub fn reserved_stem(name: &str) -> bool {
    stem_key(name) == RESERVED_STEM
}

/// The stem ProSE gives an input of this name, compared as NTFS compares names.
fn stem_key(name: &str) -> String {
    input_stem(name).to_lowercase()
}

fn all_unique(names: impl IntoIterator<Item = String>) -> bool {
    let mut seen = std::collections::HashSet::new();
    names.into_iter().all(|n| seen.insert(stem_key(&n)))
}

/// How each input of `req` reaches ProSE (in order), in the search folder `folder`.
pub fn input_placements(req: &SearchRequest, links: InputLinks, folder: &Path) -> Vec<Placement> {
    let max = max_stem(links, folder);
    match links {
        InputLinks::Symlinks => vec![Placement::Symlink; req.files.len()],
        InputLinks::PathsOrHardLinks => {
            let keys: Vec<String> = req
                .files
                .iter()
                .map(|f| stem_key(&file_name(&f.path)))
                .collect();
            let placements: Vec<Placement> = keys
                .iter()
                .zip(&req.files)
                .map(|(k, f)| {
                    // ProSE refuses an input of stem `quantms` (its QPX outputs would clash with the merged
                    // `quantms.*` views): such an input goes as a link `<n>__<name>` too, as does one whose
                    // name is too long for ProSE's outputs (the link's is shortened)
                    if keys.iter().filter(|other| *other == k).count() > 1
                        || k == RESERVED_STEM
                        || stem_too_long(&file_name(&f.path), max)
                    {
                        Placement::HardLink
                    } else {
                        Placement::OwnPath
                    }
                })
                .collect();
            // a file whose own name looks like a link (`1__a.mzML` beside two `a.mzML`): all as links
            let names = req
                .files
                .iter()
                .enumerate()
                .zip(&placements)
                .map(|((i, f), p)| seen_name(i, &f.path, *p, max));
            if all_unique(names) {
                placements
            } else {
                vec![Placement::HardLink; req.files.len()]
            }
        }
    }
}

/// The name ProSE sees for input `index`: the link's (its stem at most `max_stem` bytes), or the file's own.
fn seen_name(index: usize, path: &str, placement: Placement, max_stem: usize) -> String {
    match placement {
        Placement::OwnPath => file_name(path),
        Placement::Symlink | Placement::HardLink => link_name_within(index, path, max_stem),
    }
}

/// What ProSE calls an input in its outputs (`runs/<stem>.psm.parquet`): the link's name without `.gz`
/// and `.mzML`, ignoring ASCII case (OpenMS's `File::stemName`).
pub fn input_stem(link: &str) -> String {
    let mut stem = link;
    if let Some(end) = suffix_start(stem, ".gz") {
        stem = &stem[..end];
    }
    if let Some(end) = suffix_start(stem, ".mzml") {
        stem = &stem[..end];
    }
    stem.to_string()
}

fn check_file(
    kind: &str,
    path: &str,
    accepted: fn(&str) -> bool,
    expected: &str,
) -> Result<(), String> {
    if path.is_empty() {
        return Err(format!("No {kind} was given."));
    }
    // an absolute path cannot be taken for an option (a relative "-in" would be), and does not depend
    // on the folder the app was started in
    if !Path::new(path).is_absolute() {
        return Err(format!("The {kind} {path} is not an absolute path."));
    }
    let meta =
        fs::metadata(path).map_err(|e| format!("The {kind} {path} cannot be read ({e})."))?;
    if !meta.is_file() {
        return Err(format!("The {kind} {path} is not a file."));
    }
    if !accepted(&file_name(path)) {
        return Err(format!("The {kind} {path} is not {expected}."));
    }
    Ok(())
}

/// A string for the command line: not empty (unless `allow_empty`), no control characters, and not
/// starting with `-`, which ProSE would take for an option.
fn text_value(name: &str, value: &str, allow_empty: bool) -> Result<String, String> {
    if value.is_empty() && !allow_empty {
        return Err(format!("The value of {name} is empty."));
    }
    if value.starts_with('-') {
        return Err(format!(
            "The value of {name} may not start with \"-\": {value}"
        ));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!("The value of {name} has control characters."));
    }
    Ok(value.to_string())
}

fn number(name: &str, value: &Value) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|f| f.is_finite())
        .ok_or_else(|| format!("The value of {name} must be a number, not {value}."))
}

/// The arguments one parameter becomes.
fn parameter_args(name: &str, kind: Kind, value: &Value) -> Result<Vec<OsString>, String> {
    let flag = OsString::from(format!("-Search:{name}"));
    let one = |v: String| vec![flag.clone(), OsString::from(v)];
    Ok(match kind {
        Int => {
            let f = number(name, value)?;
            if f.fract() != 0.0 {
                return Err(format!(
                    "The value of {name} must be a whole number, not {value}."
                ));
            }
            // ProSE's integers are 32-bit: a larger one makes it print its whole help and stop
            if f < f64::from(i32::MIN) || f > f64::from(i32::MAX) {
                return Err(format!(
                    "The value of {name} is outside the range ProSE accepts: {value} (whole numbers from {} to {}).",
                    i32::MIN,
                    i32::MAX
                ));
            }
            one(format!("{}", f as i32))
        }
        Float => one(format!("{}", number(name, value)?)),
        Choice => match value {
            Value::String(s) => one(text_value(name, s, false)?),
            Value::Bool(b) => one(b.to_string()),
            _ => return Err(format!("The value of {name} must be text, not {value}.")),
        },
        Text => match value {
            Value::String(s) if s.is_empty() => vec![],
            Value::String(s) => one(text_value(name, s, false)?),
            _ => return Err(format!("The value of {name} must be text, not {value}.")),
        },
        List => {
            let Value::Array(items) = value else {
                return Err(format!("The value of {name} must be a list, not {value}."));
            };
            let mut args = vec![flag];
            for item in items {
                let Value::String(s) = item else {
                    return Err(format!("The items of {name} must be text, not {item}."));
                };
                args.push(OsString::from(text_value(name, s, false)?));
            }
            args
        }
        Flag => match value {
            Value::Bool(true) => vec![flag],
            Value::Bool(false) => vec![],
            _ => {
                return Err(format!(
                    "The value of {name} must be true or false, not {value}."
                ))
            }
        },
    })
}

/// A parameter of the request as a number (for the open-search rule), or the default.
fn number_or(params: &Map<String, Value>, name: &str, default: f64) -> f64 {
    params.get(name).and_then(Value::as_f64).unwrap_or(default)
}

/// ProSE's rule (`FragmentIndex::isOpenSearchMode`): a precursor window of more than 1000 ppm or 1 Da on
/// either side is an open search, which gets the modification analysis.
pub fn is_open_search(params: &Map<String, Value>) -> bool {
    let ppm = params
        .get("precursor:mass_tolerance_unit")
        .and_then(Value::as_str)
        .unwrap_or("ppm")
        == "ppm";
    let lower = number_or(params, "precursor:mass_tolerance_lower", 10.0);
    let upper = number_or(params, "precursor:mass_tolerance_upper", 10.0);
    lower.max(upper) > if ppm { 1000.0 } else { 1.0 }
}

/// The command line of a search whose folder is `out_dir`, with this platform's [`InputLinks`].
pub fn build_args(req: &SearchRequest, out_dir: &Path) -> Result<Vec<OsString>, String> {
    build_args_with(req, out_dir, InputLinks::PLATFORM)
}

/// The command line of a search whose folder is `out_dir`: the inputs as the links `<n>__<name>` in it
/// or by their own paths ([`input_placements`]), the database (the folder's `database.fasta` with
/// contaminants, else the user's file), and the outputs the app reads (`docs/parity.md`, "How the app
/// runs ProSE"). Checks the request first.
pub fn build_args_with(
    req: &SearchRequest,
    out_dir: &Path,
    links: InputLinks,
) -> Result<Vec<OsString>, String> {
    if req.files.is_empty() {
        return Err("There is no input file.".to_string());
    }
    for file in &req.files {
        check_file(
            "input file",
            &file.path,
            is_spectrum_file,
            "an mzML file (.mzML or .mzML.gz)",
        )?;
    }
    check_file(
        "database",
        &req.database,
        is_fasta_file,
        "a FASTA file (.fasta, .fa or .faa)",
    )?;

    let mut params = req.settings.parameters.clone();
    let mut threads = req.settings.threads;
    let mut parameter_args_list: Vec<OsString> = Vec::new();
    // ProSE ignores co-isolated precursors with database chunks (with a warning): the front end leaves the
    // switch out then, and so does the shim, so that the record of the search does not claim them
    let chunked = params
        .get("database:chunk_size")
        .and_then(Value::as_f64)
        .is_some_and(|n| n > 0.0);
    let no_decoys = without_decoys(&params);
    // validate every parameter before using any of them, in the order the front end gave
    for (name, value) in &params {
        if name == "threads" {
            let n = number(name, value)?;
            if n < 0.0 || n.fract() != 0.0 || n > f64::from(MAX_THREADS) {
                return Err(format!(
                    "The value of threads must be a whole number from 0 (all cores) to {MAX_THREADS}, not {value}."
                ));
            }
            threads = n as u32;
            continue;
        }
        let Some((_, kind)) = PARAMETERS.iter().find(|(n, _)| n == name) else {
            return Err(format!(
                "The parameter {name} is not one of ProSE's search parameters the app sets."
            ));
        };
        let args = parameter_args(name, *kind, value)?;
        if (chunked && name == "chimeric:enabled")
            || (no_decoys && FDR_PARAMETERS.contains(&name.as_str()))
        {
            continue;
        }
        parameter_args_list.extend(args);
    }
    if threads > MAX_THREADS {
        return Err(format!(
            "The value of threads must be a whole number from 0 (all cores) to {MAX_THREADS}, not {threads}."
        ));
    }
    match params.get("FDR:PSM") {
        // without decoys there is no FDR (left out above)
        _ if no_decoys => {}
        Some(v) => {
            if number("FDR:PSM", v)? <= 0.0 {
                return Err(
                    "FDR:PSM must be above 0: without it the search has no q-values, which the results need.".to_string()
                );
            }
        }
        None => {
            params.insert("FDR:PSM".to_string(), Value::from(DEFAULT_PSM_FDR));
            parameter_args_list.extend(parameter_args(
                "FDR:PSM",
                Float,
                &Value::from(DEFAULT_PSM_FDR),
            )?);
        }
    }

    // (Windows) a search folder whose path leaves no room for ProSE's outputs within MAX_PATH
    let max = max_stem(links, out_dir);
    if max < shortest_stem(req.files.len()) {
        return Err(format!(
            "The app's data folder ({}) has too long a path: Windows limits a path to {WINDOWS_MAX_PATH} \
             characters, and ProSE's result files in it would be longer. Move the app's data to a folder of a \
             shorter path.",
            out_dir.parent().unwrap_or(out_dir).display()
        ));
    }
    let mut args: Vec<OsString> = vec!["-in".into()];
    args.extend(
        req.files
            .iter()
            .zip(input_placements(req, links, out_dir))
            .enumerate()
            .map(|(i, (f, placement))| match placement {
                Placement::OwnPath => OsString::from(&f.path),
                Placement::Symlink | Placement::HardLink => out_dir
                    .join(link_name_within(i, &f.path, max))
                    .into_os_string(),
            }),
    );
    args.push("-database".into());
    args.push(if req.contaminants {
        out_dir.join(DATABASE_FILE).into_os_string()
    } else {
        OsString::from(&req.database)
    });
    args.push("-out_qpx".into());
    args.push(out_dir.join(QPX_DIR).into_os_string());
    args.push("-qpx_extended".into());
    args.push("-qpx_peak_window".into());
    args.push(PEAK_WINDOW.to_string().into());
    args.push("-qpx_peak_top".into());
    args.push(PEAK_TOP.to_string().into());
    args.push("-keep_decoys".into());
    // the idXML of the Export menu: the merged one of several inputs, the one input's own
    if req.files.len() > 1 {
        args.push("-out_merged".into());
        args.push(out_dir.join(MERGED_IDXML).into_os_string());
    } else {
        args.push("-out_idxml".into());
        args.push(out_dir.join(SINGLE_IDXML).into_os_string());
    }
    if is_open_search(&params) {
        args.push("-out_mod_analysis_dir".into());
        args.push(out_dir.join("mods").into_os_string());
    }
    args.push("-threads".into());
    args.push(threads.to_string().into());
    args.push("-Search:rescore".into());
    args.push(req.settings.rescore.to_string().into());
    if req.settings.peptdeep {
        args.push("-Search:peptdeep:enable".into());
    }
    args.extend(parameter_args_list);
    Ok(args)
}

/// The accession of a FASTA header line (`>` and the text up to the first white space, as OpenMS' FASTAFile
/// reads it); None if the line is no header. A byte order mark before the first header is skipped.
fn fasta_accession(line: &str) -> Option<&str> {
    let header = line.trim_start_matches('\u{feff}').strip_prefix('>')?;
    let header = header.trim_start();
    Some(header.split(char::is_whitespace).next().unwrap_or(""))
}

/// The contaminant prefix of the app's cRAP accessions.
const CONTAMINANT_PREFIX: &str = "CON__";

/// One entry of the cRAP FASTA, as the app appends it.
struct CrapEntry {
    /// with [`CONTAMINANT_PREFIX`]
    accession: String,
    /// the header after the accession (the description, with the white space before it)
    rest: String,
    /// its sequence lines, with their line ends
    lines: Vec<String>,
}

fn crap_entries(text: &str) -> Vec<CrapEntry> {
    let mut entries: Vec<CrapEntry> = Vec::new();
    for line in text.split_inclusive('\n') {
        match fasta_accession(line) {
            Some(accession) => {
                let at = line.find(accession).unwrap_or(1) + accession.len();
                let rest = line[at..].trim_end_matches(['\n', '\r']).to_string();
                let accession = if accession.starts_with(CONTAMINANT_PREFIX) {
                    accession.to_string()
                } else {
                    format!("{CONTAMINANT_PREFIX}{accession}")
                };
                entries.push(CrapEntry {
                    accession,
                    rest,
                    lines: Vec::new(),
                });
            }
            None => {
                if let Some(entry) = entries.last_mut() {
                    entry.lines.push(line.to_string());
                }
            }
        }
    }
    entries
}

/// Writes `dest`: the user's FASTA, then the entries of `crap` with `CON__` before their accession
/// (unless it is there already), as the web app's `withContaminants` does. A newline is added after
/// the user's last line if it has none. The user's file is only read.
///
/// - A cRAP entry whose accession (with `CON__`) the user's FASTA has already (the `database.fasta` of an
///   earlier search, which holds them) is left out: ProSE would get the accession twice.
/// - When the user's FASTA has decoys of its own, which ProSE then uses instead of generating any (`decoys`
///   `auto`), each appended entry gets its decoy, with the database's marker, as ProSE would generate it
///   ([`crate::decoys`]).
/// - A FASTA without any entry is refused (`InvalidData`, with the message for the user): the search would
///   search the contaminants alone.
pub fn with_contaminants(
    user: &Path,
    crap: &Path,
    dest: &Path,
    rules: &DecoyRules,
) -> io::Result<()> {
    use io::{BufRead, Write};
    // (InvalidData is the user's database's: not the bundled file's)
    let crap = crap_entries(&fs::read_to_string(crap).map_err(io::Error::other)?);
    let wanted: std::collections::HashMap<&str, usize> = crap
        .iter()
        .enumerate()
        .map(|(k, e)| (e.accession.as_str(), k))
        .collect();
    let mut present = vec![false; crap.len()];
    let mut stats = DecoyStatistics::default();
    let mut entries = 0usize;

    let mut out = io::BufWriter::new(fs::File::create(dest)?);
    let mut input = io::BufReader::with_capacity(1 << 20, fs::File::open(user)?);
    let mut last = b'\n';
    let mut line = Vec::new();
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        out.write_all(&line)?;
        last = line[line.len() - 1];
        if line.first() == Some(&b'>') || line.starts_with("\u{feff}>".as_bytes()) {
            let text = String::from_utf8_lossy(&line);
            if let Some(accession) = fasta_accession(&text) {
                entries += 1;
                stats.count(accession, &rules.decoy_prefix);
                if let Some(&k) = wanted.get(accession) {
                    present[k] = true;
                }
            }
        }
    }
    if entries == 0 {
        drop(out);
        let _ = fs::remove_file(dest);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "The database {} has no proteins (no line starting with \">\"), so the search would find \
                 contaminants only.",
                user.display()
            ),
        ));
    }
    if last != b'\n' {
        out.write_all(b"\n")?;
    }
    let appended: Vec<&CrapEntry> = crap
        .iter()
        .zip(&present)
        .filter(|(_, there)| !**there)
        .map(|(e, _)| e)
        .collect();
    for entry in &appended {
        writeln!(out, ">{}{}", entry.accession, entry.rest)?;
        for line in &entry.lines {
            out.write_all(line.as_bytes())?;
        }
    }
    // ProSE reuses the database's decoys (decoys auto): the appended entries need theirs. The marker is the
    // user's database's; ProSE detects it in the whole database the same way (the appended targets and their
    // decoys only add to its share)
    let marker = if rules.mode == "auto" {
        stats.marker(&rules.decoy_prefix)
    } else {
        None
    };
    if let Some(marker) = marker {
        for entry in &appended {
            let sequence: String = entry
                .lines
                .iter()
                .flat_map(|l| l.chars().filter(|c| !c.is_whitespace()))
                .collect();
            let decoy = decoy_sequence(&sequence, rules);
            write!(
                out,
                ">{}{}\n{decoy}\n",
                marker.decoy_of(&entry.accession),
                entry.rest
            )?;
        }
    }
    out.flush()
}

/// The record of one input in `inputs.json`: how the search folder's link maps to the user's file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputRecord {
    /// The front end's id of the file.
    pub id: String,
    /// Position in the request.
    pub index: usize,
    /// The name ProSE saw: the link in the search folder (`<n>__<name>`), or the file's own name when
    /// it was given its own path (Windows, [`InputLinks::PathsOrHardLinks`]).
    pub link: String,
    /// What ProSE calls the input in its outputs.
    pub stem: String,
    /// The user's file name.
    pub name: String,
    /// The user's path, as given.
    pub path: String,
}

/// The records of `inputs.json` of the inputs of `req` in the search folder `folder` (its `.partial` path).
pub fn input_records_with(
    req: &SearchRequest,
    links: InputLinks,
    folder: &Path,
) -> Vec<InputRecord> {
    let max = max_stem(links, folder);
    let placements = input_placements(req, links, folder);
    req.files
        .iter()
        .zip(placements)
        .enumerate()
        .map(|(index, (f, placement))| {
            let link = seen_name(index, &f.path, placement, max);
            InputRecord {
                id: f.id.clone(),
                index,
                stem: input_stem(&link),
                link,
                name: file_name(&f.path),
                path: f.path.clone(),
            }
        })
        .collect()
}

/// `text` with the search folder's names for the inputs replaced by the user's: the path of a link by
/// the user's path, the bare name of a link by the user's file name, the stem ProSE names an input's
/// outputs after by the user's (`qpx/runs/1__a.psm.parquet` -> `qpx/runs/a.psm.parquet`). The path of an
/// output in the search folder `dir` loses the folder (`<dir>/merged.idXML` -> `merged.idXML`): the folder
/// of a search that failed is gone. Only whole names are replaced (`1__a.mzML` inside `11__a.mzML` stays).
/// The folder is recognised in each way a tool may write it (Windows: `\\` or `/` after any part, the drive
/// letter in either case), whatever the platform.
pub fn humanize(text: &str, dir: &Path, records: &[InputRecord]) -> String {
    let mut text = text.to_string();
    let folders = path_forms(&dir.to_string_lossy());
    for r in records {
        for folder in &folders {
            for sep in ['/', '\\'] {
                text = replace_whole(&text, &format!("{folder}{sep}{}", r.link), &r.path);
            }
        }
    }
    for folder in &folders {
        for sep in ['/', '\\'] {
            text = text.replace(&format!("{folder}{sep}"), "");
        }
    }
    for r in records {
        text = replace_whole(&text, &r.link, &r.name);
        if r.link != r.name {
            text = replace_whole(&text, &r.stem, &input_stem(&r.name));
        }
    }
    text
}

/// The ways a path can be written: as it is, with `/` or `\\` between all its parts, and with a drive letter
/// (`C:`) in the other case too; without a trailing separator. None for an empty path.
fn path_forms(path: &str) -> Vec<String> {
    let path = path.trim_end_matches(['/', '\\']);
    if path.is_empty() {
        return Vec::new();
    }
    let mut forms = Vec::new();
    for form in [
        path.to_string(),
        path.replace('\\', "/"),
        path.replace('/', "\\"),
    ] {
        let mut chars = form.chars();
        let other_drive = match (chars.next(), chars.next()) {
            (Some(letter), Some(':')) if letter.is_ascii_alphabetic() => {
                let flipped = if letter.is_ascii_uppercase() {
                    letter.to_ascii_lowercase()
                } else {
                    letter.to_ascii_uppercase()
                };
                Some(format!("{flipped}{}", &form[1..]))
            }
            _ => None,
        };
        for f in std::iter::once(form).chain(other_drive) {
            if !forms.contains(&f) {
                forms.push(f);
            }
        }
    }
    forms
}

fn replace_whole(text: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return text.to_string();
    }
    let boundary = |c: Option<char>| c.is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut before: Option<char> = None;
    while let Some(at) = rest.find(from) {
        let prev = rest[..at].chars().next_back().or(before);
        let after = rest[at + from.len()..].chars().next();
        out.push_str(&rest[..at]);
        if boundary(prev) && boundary(after) {
            out.push_str(to);
        } else {
            out.push_str(from);
        }
        before = from.chars().next_back();
        rest = &rest[at + from.len()..];
    }
    out.push_str(rest);
    out
}
