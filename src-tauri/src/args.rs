//! The search request and its translation into OpenNuXL's command lines, one per input file.
//!
//! The front end sends a [`SearchRequest`] (camelCase JSON). [`build_runs`] checks it and turns it into the
//! arguments of one run of the tool per input (`docs/design.md` §3), which `run.rs` starts one after the other.
//! Nothing here runs a process or writes to the search folder; the folder is made by [`mod@crate::run`],
//! which also creates the links and the database that these arguments name. The one thing read is the user's
//! FASTA, for its decoys ([`plan_database`]).
//!
//! Parameters are OpenNuXL's options by their full names (`precursor:mass_tolerance`, `NuXL:presets`,
//! `filter`). Only the names in [`PARAMETERS`] pass, each with the type it has in OpenNuXL, so that nothing
//! from the front end can become another option of the tool (`-in`, `-ini`, an output of its own choosing,
//! `-percolator_executable`).

use crate::decoys::{DecoyStatistics, Marker};
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
    /// OpenNuXL options by their full names (see [`PARAMETERS`]).
    pub parameters: Map<String, Value>,
    /// Percolator rescoring (`-percolator_backend builtin`, else `none`).
    pub rescore: bool,
    /// `-threads` (0: all cores).
    pub threads: u32,
    /// The FDR of the peptide PSMs (a fraction in (0, 1]): the results view filters at it, OpenNuXL does not
    /// (`report:peptideFDR 0`); it goes into `outputs.json`.
    pub peptide_fdr: f64,
    /// The FDR of the cross-link PSMs (a fraction in (0, 1]): the results view filters at it; OpenNuXL writes its
    /// protein report at it when it is at most [`MAX_PROTEIN_REPORT_FDR`].
    pub xl_fdr: f64,
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

/// The type of an OpenNuXL option, which decides how a JSON value becomes arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// An integer (`registerIntOption_`, 32 bits).
    Int,
    /// A real number (`registerDoubleOption_`).
    Float,
    /// One of the option's valid strings, a string; the `true`/`false` ones also take a JSON boolean.
    /// OpenNuXL checks the value against its list.
    Choice,
    /// Free text (`registerStringOption_` without valid strings); empty means unset (the default).
    Text,
    /// A list of strings (`registerStringList_`), one argument each; an empty list clears the default.
    List,
    /// A list of integers (`registerIntList_`), one argument each; an empty list clears the default.
    IntList,
    /// A flag (`registerFlag_`): `-name` when true, nothing when false.
    Flag,
}

use Kind::*;

/// Every OpenNuXL option a search may set, with its type: those of `registerOptionsAndFlags_` (OpenNuXL.cpp of
/// the pinned build, `native/OPENMS_COMMIT`) but the shim's own (design §3: the inputs and outputs, `threads`,
/// the report FDRs, the Percolator backend and executable, `NuXL:decoys`, `NuXL:presets_file`, the RAW
/// converter's executables, `output_folder`) and the `presets:<name>:*` sections, which show a preset and are
/// ignored by the tool.
pub const PARAMETERS: &[(&str, Kind)] = &[
    ("precursor:mass_tolerance", Float),
    ("precursor:mass_tolerance_unit", Choice),
    ("precursor:min_charge", Int),
    ("precursor:max_charge", Int),
    ("precursor:isotopes", IntList),
    ("fragment:mass_tolerance", Float),
    ("fragment:mass_tolerance_unit", Choice),
    ("modifications:fixed", List),
    ("modifications:variable", List),
    ("modifications:variable_max_per_peptide", Int),
    ("peptide:min_size", Int),
    ("peptide:max_size", Int),
    ("peptide:missed_cleavages", Int),
    ("peptide:enzyme", Choice),
    ("peptide:clip_nterm_methionine", Choice),
    ("report:top_hits", Int),
    ("report:xl_fdr_groups", Choice),
    ("NuXL:presets", Choice),
    ("NuXL:length", Int),
    ("NuXL:sequence", Text),
    ("NuXL:target_nucleotides", List),
    ("NuXL:nt_groups", List),
    ("NuXL:mapping", List),
    ("NuXL:can_cross_link", Text),
    ("NuXL:standalone", Text),
    ("NuXL:localization", Choice),
    ("NuXL:fragment_adducts", List),
    ("NuXL:modifications", List),
    ("NuXL:scoring", Choice),
    ("NuXL:rescoring", Choice),
    ("NuXL:decoy_factor", Int),
    ("NuXL:CysteineAdduct", Flag),
    ("NuXL:filter_fractional_mass", Flag),
    ("NuXL:carbon_labeled_fragments", Flag),
    ("NuXL:only_xl", Flag),
    ("NuXL:filter_small_peptide_mass", Float),
    ("NuXL:marker_ions_tolerance", Float),
    ("filter", List),
    ("window_size", Float),
    ("peak_count", Int),
];

/// The steps of OpenNuXL's `filter` a search may ask for: its valid strings but `pcrecalibration` (it writes the
/// recalibrated spectra next to the input, `<input>_pc.mzML`, and overwrites them), `optimize` and `RTpredict`
/// (left out of the app for now, design §6).
pub const FILTER_STEPS: &[&str] = &[
    "filter_pc_mass_error",
    "impute_decoy_medians",
    "filter_bad_partial_loss_scores",
    "autotune",
    "idfilter",
    "spectrumclusterfilter",
];

/// The name of the database in the search folder when the shim writes one: the user's FASTA with the
/// contaminants, or without its own decoys ([`plan_database`]).
pub const DATABASE_FILE: &str = "database.fasta";

/// The record of the user's database in the search folder when OpenNuXL searches it as it is: `{"path":
/// "<absolute path>"}`, the one absolute path the reader may read (`files::resolve_search_file`).
pub const DATABASE_RECORD: &str = "database.json";

/// The folder of OpenNuXL's outputs in the search folder (design §2).
pub const OUTPUT_DIR: &str = "nuxl";

/// The log of all runs of a search, in the search folder.
pub const LOG_FILE: &str = "nuxl.log";

/// What the shim writes beside an input's outputs when its run has ended (`nuxl/<stem>.outputs.json`).
pub const OUTPUTS_SUFFIX: &str = ".outputs.json";

/// The most a cross-link FDR may be for OpenNuXL to write its protein report at it (NuXLFDR.cpp: "only for
/// results with FDR < 10%"; it compares `xlFDR <= 0.1`).
pub const MAX_PROTEIN_REPORT_FDR: f64 = 0.1;

/// The most threads a search may ask for (`-threads`): far beyond any computer the app runs on, but a typo of
/// a few more digits is refused here, before OpenNuXL starts that many OpenMP threads (or refuses the number).
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

/// An input OpenNuXL searches: `.mzML` (its `-in` also takes `.raw`, through ThermoRawFileParser, which the app
/// does not bundle).
pub fn is_spectrum_file(name: &str) -> bool {
    has_suffix(name, &[".mzml"])
}

/// A compressed mzML, which OpenNuXL cannot read (the app says so: unpack it first).
pub fn is_compressed_mzml(name: &str) -> bool {
    has_suffix(name, &[".mzml.gz"])
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

/// The longest stem (bytes) an input may have, as the shim names OpenNuXL's outputs after it. The longest output
/// name is `<stem>_perc_proteins<q>_XLs.tsv` ([`LONGEST_OUTPUT_SUFFIX`]), and a file name has at most 255 bytes
/// (Linux, macOS; NTFS 255 UTF-16 units, which are never more than the bytes).
pub const MAX_STEM: usize = 255 - LONGEST_OUTPUT_SUFFIX.len();

/// The end of OpenNuXL's longest output name after an input's stem (the protein report after Percolator; `<q>`
/// has always four decimals, `0.0100`). The others: `_perc_<q>_peptides.idXML`, `_perc_<q>_XLs.idXML`,
/// `_sse_perc_out.idXML` (the autotune's Percolator), `.outputs.json` (the shim's).
const LONGEST_OUTPUT_SUFFIX: &str = "_perc_proteins0.0000_XLs.tsv";
/// The folder of the outputs in the search folder, with the separators around it.
const LONGEST_OUTPUT_FOLDER: &str = "\\nuxl\\";
/// Windows' MAX_PATH: a path has at most 259 UTF-16 units (260 with its terminating null), unless the
/// program opts into long paths, which OpenMS is not known to do.
const WINDOWS_MAX_PATH: usize = 259;

/// The longest stem (bytes) an input may have in the search folder `folder` (its `.partial` path), for links
/// `links`: [`MAX_STEM`]; on Windows ([`InputLinks::PathsOrHardLinks`]) also short enough that the path of
/// OpenNuXL's longest output in the folder (`<folder>\nuxl\<stem>_perc_proteins0.0100_XLs.tsv`) and of every
/// link (`<folder>\<n>__<stem>.mzML`, shorter) stays within MAX_PATH. A stem's UTF-16 units are never more
/// than its bytes, so the bytes bound it. 0 if not even the fixed part of that path fits.
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

/// The name of input `index` (0-based) in the search folder: `<n>__<name>` with `n` from 1. The shim names an
/// input's outputs after its stem, so an input goes in as a link with a name of its own (see [`InputLinks`]),
/// which keeps inputs of one name apart; the suffix (`.mzML`) stays as it is. A name whose stem would be longer
/// than [`MAX_STEM`] is shortened (at a character) to that length: `<n>__` keeps the stems unique, `inputs.json`
/// maps the link back to the user's file ([`InputRecord`]).
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

/// Whether OpenNuXL's outputs of an input of this name would have names (or, on Windows, paths) too long for the
/// file system, with stems of at most `max_stem` bytes.
pub fn stem_too_long(name: &str, max_stem: usize) -> bool {
    input_stem(name).len() > max_stem
}

/// Whether `name`, a name in the top level of a search folder, is one of the links to the inputs
/// (`<n>__<name>.mzML`): never one of the search's own files.
pub fn is_input_link(name: &str) -> bool {
    name.split_once("__").is_some_and(|(n, rest)| {
        !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && is_spectrum_file(rest)
    })
}

/// How the inputs reach OpenNuXL. The shim names each input's outputs after its stem, so two inputs need stems
/// whose outputs cannot be confused ([`stems_clash`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputLinks {
    /// Every input as a symbolic link `<n>__<name>` in the search folder (Linux, macOS).
    Symlinks,
    /// Windows, where a symbolic link needs a privilege (developer mode): the inputs by their own paths
    /// when their stems do not clash (ignoring case, as NTFS does); those that do as hard links `<n>__<name>`
    /// in the search folder, which works on the same volume only; never a copy.
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

/// How one input reaches OpenNuXL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// A symbolic link `<n>__<name>` in the search folder.
    Symlink,
    /// A hard link `<n>__<name>` in the search folder, removed again when the search ends.
    HardLink,
    /// The user's path itself.
    OwnPath,
}

/// The stem the outputs of an input of this name are named after, compared as NTFS compares names.
fn stem_key(name: &str) -> String {
    input_stem(name).to_lowercase()
}

/// Whether the outputs of two inputs of these stem keys ([`stem_key`]) could be confused: one stem, or one stem
/// that is the other's followed by `_` (`a` and `a_perc`: OpenNuXL's `a_perc_1.0000_XLs.idXML` after Percolator
/// is the plain `<stem>_1.0000_XLs.idXML` of `a_perc`, and `a_perc.idXML` is its `-out` and `a`'s Percolator
/// output).
pub fn stems_clash(a: &str, b: &str) -> bool {
    let under = |long: &str, short: &str| {
        long.len() > short.len() && long.starts_with(short) && long[short.len()..].starts_with('_')
    };
    a == b || under(a, b) || under(b, a)
}

fn none_clash(names: &[String]) -> bool {
    let keys: Vec<String> = names.iter().map(|n| stem_key(n)).collect();
    keys.iter()
        .enumerate()
        .all(|(i, k)| keys[i + 1..].iter().all(|other| !stems_clash(k, other)))
}

/// How each input of `req` reaches OpenNuXL (in order), in the search folder `folder`.
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
                .enumerate()
                .zip(&req.files)
                .map(|((i, k), f)| {
                    // an input whose outputs would clash with another's goes as a link `<n>__<name>`, as does one
                    // whose name is too long for its outputs (the link's is shortened)
                    let clashes = keys
                        .iter()
                        .enumerate()
                        .any(|(j, other)| j != i && stems_clash(k, other));
                    if clashes || stem_too_long(&file_name(&f.path), max) {
                        Placement::HardLink
                    } else {
                        Placement::OwnPath
                    }
                })
                .collect();
            // a file whose own name clashes with a link (`1__a.mzML` beside two `a.mzML`): all as links, whose
            // `<n>__` keeps every stem apart
            let names: Vec<String> = req
                .files
                .iter()
                .enumerate()
                .zip(&placements)
                .map(|((i, f), p)| seen_name(i, &f.path, *p, max))
                .collect();
            if none_clash(&names) {
                placements
            } else {
                vec![Placement::HardLink; req.files.len()]
            }
        }
    }
}

/// The name OpenNuXL sees for input `index`: the link's (its stem at most `max_stem` bytes), or the file's own.
fn seen_name(index: usize, path: &str, placement: Placement, max_stem: usize) -> String {
    match placement {
        Placement::OwnPath => file_name(path),
        Placement::Symlink | Placement::HardLink => link_name_within(index, path, max_stem),
    }
}

/// What the shim calls an input in the names of its outputs (`nuxl/<stem>.idXML`): the link's name without
/// `.mzML`, ignoring ASCII case (as OpenMS' `File::stemName`).
pub fn input_stem(link: &str) -> String {
    match suffix_start(link, ".mzml") {
        Some(end) => link[..end].to_string(),
        None => link.to_string(),
    }
}

/// The outputs of the run of the input of stem `stem`, relative to the search folder: `-out` and `-out_tsv`.
pub fn output_idxml(stem: &str) -> String {
    format!("{OUTPUT_DIR}/{stem}.idXML")
}

pub fn output_tsv(stem: &str) -> String {
    format!("{OUTPUT_DIR}/{stem}.tsv")
}

/// The shim's record of the outputs of the input of stem `stem` (design §2), relative to the search folder.
pub fn outputs_record(stem: &str) -> String {
    format!("{OUTPUT_DIR}/{stem}{OUTPUTS_SUFFIX}")
}

fn check_file(kind: &str, path: &str) -> Result<(), String> {
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
    Ok(())
}

fn check_input(path: &str) -> Result<(), String> {
    check_file("input file", path)?;
    let name = file_name(path);
    if is_compressed_mzml(&name) {
        return Err(format!(
            "OpenNuXL reads .mzML files only, not compressed ones: unpack {path} first (e.g. with gunzip or \
             7-Zip) and add the .mzML."
        ));
    }
    if !is_spectrum_file(&name) {
        return Err(format!(
            "The input file {path} is not an mzML file (.mzML)."
        ));
    }
    // OpenNuXL names its derived outputs by replacing every ".idXML" of the -out path (`StringUtils::substitute`):
    // one in the stem would give them names the shim does not find
    if input_stem(&name).contains(".idXML") {
        return Err(format!(
            "OpenNuXL cannot name its result files after {name}, which has \".idXML\" in its name: rename the file \
             and add it again."
        ));
    }
    Ok(())
}

fn check_database(path: &str) -> Result<(), String> {
    check_file("database", path)?;
    if !is_fasta_file(&file_name(path)) {
        return Err(format!(
            "The database {path} is not a FASTA file (.fasta, .fa or .faa)."
        ));
    }
    Ok(())
}

/// A string for the command line: not empty (unless `allow_empty`), no control characters, and not
/// starting with `-`, which OpenNuXL would take for an option.
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

/// A whole number OpenNuXL can read: its integers are 32-bit (`Int`), and a larger one makes it print its
/// whole help and stop.
fn integer(name: &str, value: &Value) -> Result<i32, String> {
    let f = number(name, value)?;
    if f.fract() != 0.0 {
        return Err(format!(
            "The value of {name} must be a whole number, not {value}."
        ));
    }
    if f < f64::from(i32::MIN) || f > f64::from(i32::MAX) {
        return Err(format!(
            "The value of {name} is outside the range OpenNuXL accepts: {value} (whole numbers from {} to {}).",
            i32::MIN,
            i32::MAX
        ));
    }
    Ok(f as i32)
}

/// The arguments one parameter becomes. A list's values follow its option, one argument each, up to the next
/// option (TOPPBase takes every argument that is not an option: a `-` and a letter); none clears the default.
fn parameter_args(name: &str, kind: Kind, value: &Value) -> Result<Vec<OsString>, String> {
    let flag = OsString::from(format!("-{name}"));
    let one = |v: String| vec![flag.clone(), OsString::from(v)];
    Ok(match kind {
        Int => one(integer(name, value)?.to_string()),
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
                if name == "filter" && !FILTER_STEPS.contains(&s.as_str()) {
                    return Err(format!(
                        "{s} is not one of the filter steps the app runs ({}).",
                        FILTER_STEPS.join(", ")
                    ));
                }
                args.push(OsString::from(text_value(name, s, false)?));
            }
            args
        }
        IntList => {
            let Value::Array(items) = value else {
                return Err(format!("The value of {name} must be a list, not {value}."));
            };
            let mut args = vec![flag];
            for item in items {
                // (a negative number is no option to TOPPBase: "-1" has no letter after the "-")
                args.push(OsString::from(integer(name, item)?.to_string()));
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

/// A cutoff of the request (`peptideFdr`, `xlFdr`): a fraction above 0, at most 1.
fn check_fdr(name: &str, value: f64) -> Result<(), String> {
    if !(value.is_finite() && value > 0.0 && value <= 1.0) {
        return Err(format!(
            "{name} must be a fraction above 0 and at most 1 (0.01 for 1 %), not {value}."
        ));
    }
    Ok(())
}

/// What the shim makes of the user's database ([`plan_database`]).
#[derive(Debug, Clone, PartialEq)]
pub struct DatabasePlan {
    /// The shim writes the database OpenNuXL reads, [`DATABASE_FILE`] in the search folder
    /// ([`write_database`]): with the contaminants, or without the database's own decoys, or both.
    pub copy: bool,
    /// The marker of the decoys the user's database has; they are left out of the copy (OpenNuXL generates its
    /// own, [`crate::decoys`]).
    pub decoys: Option<Marker>,
}

/// The accession of a FASTA header line (`>` and the text up to the first white space, as OpenMS' FASTAFile
/// reads it); None if the line is no header. A byte order mark before the first header is skipped.
fn fasta_accession(line: &str) -> Option<&str> {
    let header = line.trim_start_matches('\u{feff}').strip_prefix('>')?;
    let header = header.trim_start();
    Some(header.split(char::is_whitespace).next().unwrap_or(""))
}

/// Reads the lines of `path` that are FASTA headers, as `each(accession)`.
fn each_accession(path: &Path, mut each: impl FnMut(&str)) -> io::Result<()> {
    use io::BufRead;
    let mut input = io::BufReader::with_capacity(1 << 20, fs::File::open(path)?);
    let mut line = Vec::new();
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line)? == 0 {
            return Ok(());
        }
        if line.first() == Some(&b'>') || line.starts_with("\u{feff}>".as_bytes()) {
            if let Some(accession) = fasta_accession(&String::from_utf8_lossy(&line)) {
                each(accession);
            }
        }
    }
}

/// The decoys of the FASTA at `path`, as OpenMS finds them (`crate::decoys`); None: it has none.
pub fn database_decoys(path: &Path) -> io::Result<Option<Marker>> {
    let mut stats = DecoyStatistics::default();
    each_accession(path, |accession| stats.count(accession))?;
    Ok(stats.marker())
}

/// How the request's database reaches OpenNuXL: as it is, or as the search folder's copy. Reads the FASTA once,
/// for its decoys (which [`build_runs`] and the folder's database have to agree on).
pub fn plan_database(req: &SearchRequest) -> Result<DatabasePlan, String> {
    check_database(&req.database)?;
    let decoys = database_decoys(Path::new(&req.database))
        .map_err(|e| format!("The database {} cannot be read ({e}).", req.database))?;
    Ok(DatabasePlan {
        copy: req.contaminants || decoys.is_some(),
        decoys,
    })
}

/// The command lines of a search whose folder is `out_dir`, with this platform's [`InputLinks`] and the
/// database as [`plan_database`] finds it.
pub fn build_runs(req: &SearchRequest, out_dir: &Path) -> Result<Vec<Vec<OsString>>, String> {
    let plan = plan_database(req)?;
    build_runs_with(req, out_dir, InputLinks::PLATFORM, &plan)
}

/// The command line of each input's run in the search folder `out_dir` (design §3): the input as the link
/// `<n>__<name>` in it or by its own path ([`input_placements`]), the database (the folder's
/// [`DATABASE_FILE`] when `plan` copies it, else the user's file), the outputs named after the input's stem in
/// [`OUTPUT_DIR`], the threads, the reports without an FDR filter, the Percolator backend, and the form's
/// parameters. Checks the request first.
///
/// - `-report:peptideFDR 0` keeps every target peptide PSM with its q-value and `-report:xlFDR 1.0` every target
///   cross-link (OpenNuXL takes 0 and 1 for "no filter"), so that the results view filters at the request's FDRs;
///   the cross-link FDR, when it is at most [`MAX_PROTEIN_REPORT_FDR`], is a second threshold so that OpenNuXL
///   writes its protein report at it. `report:xl_peptidelevel_FDR` needs as many values, all 1.0 (no filter).
/// - `-percolator_backend builtin` or `none`. `-percolator_executable` is never given: its default only serves
///   the backend `executable`, and an empty one would turn the rescoring off even with `builtin`.
/// - `NuXL:decoys` is never given: OpenNuXL generates the decoys (its default `true`), the only way it writes its
///   FDR outputs ([`crate::decoys`]); a database's own decoys are left out of the folder's copy.
pub fn build_runs_with(
    req: &SearchRequest,
    out_dir: &Path,
    links: InputLinks,
    plan: &DatabasePlan,
) -> Result<Vec<Vec<OsString>>, String> {
    if req.files.is_empty() {
        return Err("There is no input file.".to_string());
    }
    for file in &req.files {
        check_input(&file.path)?;
    }
    check_database(&req.database)?;
    let settings = &req.settings;
    check_fdr("The peptide FDR (peptideFdr)", settings.peptide_fdr)?;
    check_fdr("The cross-link FDR (xlFdr)", settings.xl_fdr)?;

    let mut threads = settings.threads;
    let mut parameter_args_list: Vec<OsString> = Vec::new();
    // validate every parameter before using any of them, in the order the front end gave
    for (name, value) in &settings.parameters {
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
                "The parameter {name} is not one of OpenNuXL's options the app sets."
            ));
        };
        parameter_args_list.extend(parameter_args(name, *kind, value)?);
    }
    if threads > MAX_THREADS {
        return Err(format!(
            "The value of threads must be a whole number from 0 (all cores) to {MAX_THREADS}, not {threads}."
        ));
    }

    // (Windows) a search folder whose path leaves no room for OpenNuXL's outputs within MAX_PATH
    let max = max_stem(links, out_dir);
    if max < shortest_stem(req.files.len()) {
        return Err(format!(
            "The app's data folder ({}) has too long a path: Windows limits a path to {WINDOWS_MAX_PATH} \
             characters, and OpenNuXL's result files in it would be longer. Move the app's data to a folder of a \
             shorter path.",
            out_dir.parent().unwrap_or(out_dir).display()
        ));
    }

    let database = if plan.copy {
        out_dir.join(DATABASE_FILE).into_os_string()
    } else {
        OsString::from(&req.database)
    };
    let protein_fdr =
        (settings.xl_fdr <= MAX_PROTEIN_REPORT_FDR).then(|| settings.xl_fdr.to_string());
    let records = input_records_with(req, links, out_dir);
    let placements = input_placements(req, links, out_dir);
    let runs = records
        .iter()
        .zip(placements)
        .map(|(record, placement)| {
            let input = match placement {
                Placement::OwnPath => OsString::from(&record.path),
                Placement::Symlink | Placement::HardLink => {
                    out_dir.join(&record.link).into_os_string()
                }
            };
            let mut args: Vec<OsString> = vec![
                "-in".into(),
                input,
                "-database".into(),
                database.clone(),
                "-out".into(),
                out_dir.join(output_idxml(&record.stem)).into_os_string(),
                "-out_tsv".into(),
                out_dir.join(output_tsv(&record.stem)).into_os_string(),
                "-threads".into(),
                threads.to_string().into(),
                "-report:peptideFDR".into(),
                "0".into(),
                "-report:xlFDR".into(),
                "1.0".into(),
            ];
            args.extend(protein_fdr.iter().map(OsString::from));
            // (one peptide-level threshold per PSM-level one, none of them a filter)
            args.push("-report:xl_peptidelevel_FDR".into());
            args.push("1.0".into());
            if protein_fdr.is_some() {
                args.push("1.0".into());
            }
            args.push("-percolator_backend".into());
            args.push(if settings.rescore { "builtin" } else { "none" }.into());
            args.extend(parameter_args_list.iter().cloned());
            args
        })
        .collect();
    Ok(runs)
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

/// What [`write_database`] wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DatabaseCopy {
    /// The user's entries in it.
    pub targets: usize,
    /// The user's decoys left out.
    pub decoys_left_out: usize,
    /// The cRAP entries appended.
    pub contaminants: usize,
}

/// Writes `dest`: the user's FASTA without the decoys of `decoys` (OpenNuXL generates its own), then, with
/// `crap`, the entries of the contaminants with `CON__` before their accession (unless it is there already), as
/// the web app's `withContaminants` does. A newline is added after the user's last line if it has none. The
/// user's file is only read.
///
/// - A cRAP entry whose accession (with `CON__`) the user's FASTA has already (the `database.fasta` of an
///   earlier search, which holds them) is left out: OpenNuXL would get the accession twice.
/// - A FASTA without any target entry is refused (`InvalidData`, with the message for the user): the search
///   would find nothing, or contaminants only.
pub fn write_database(
    user: &Path,
    crap: Option<&Path>,
    decoys: Option<&Marker>,
    dest: &Path,
) -> io::Result<DatabaseCopy> {
    use io::{BufRead, Write};
    // (InvalidData is the user's database's: not the bundled file's)
    let crap = match crap {
        Some(crap) => crap_entries(&fs::read_to_string(crap).map_err(io::Error::other)?),
        None => Vec::new(),
    };
    let wanted: std::collections::HashMap<&str, usize> = crap
        .iter()
        .enumerate()
        .map(|(k, e)| (e.accession.as_str(), k))
        .collect();
    let mut present = vec![false; crap.len()];
    let mut copy = DatabaseCopy::default();

    let mut out = io::BufWriter::new(fs::File::create(dest)?);
    let mut input = io::BufReader::with_capacity(1 << 20, fs::File::open(user)?);
    let mut last = b'\n';
    let mut line = Vec::new();
    // whether the lines of the current entry are written (not a decoy's)
    let mut keep = true;
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if line.first() == Some(&b'>') || line.starts_with("\u{feff}>".as_bytes()) {
            let text = String::from_utf8_lossy(&line);
            if let Some(accession) = fasta_accession(&text) {
                keep = !decoys.is_some_and(|m| m.marks(accession));
                if keep {
                    copy.targets += 1;
                    if let Some(&k) = wanted.get(accession) {
                        present[k] = true;
                    }
                } else {
                    copy.decoys_left_out += 1;
                }
            }
        }
        if keep {
            out.write_all(&line)?;
            last = line[line.len() - 1];
        }
    }
    if copy.targets == 0 {
        drop(out);
        let _ = fs::remove_file(dest);
        let what = if copy.decoys_left_out > 0 {
            format!(
                "has decoys only ({} entries with {})",
                copy.decoys_left_out,
                decoys.map(Marker::describe).unwrap_or_default()
            )
        } else {
            "has no proteins (no line starting with \">\")".to_string()
        };
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "The database {} {what}, so the search would find no proteins of the sample.",
                user.display()
            ),
        ));
    }
    if last != b'\n' {
        out.write_all(b"\n")?;
    }
    for (entry, _) in crap.iter().zip(&present).filter(|(_, there)| !**there) {
        writeln!(out, ">{}{}", entry.accession, entry.rest)?;
        for line in &entry.lines {
            out.write_all(line.as_bytes())?;
        }
        copy.contaminants += 1;
    }
    out.flush()?;
    Ok(copy)
}

/// The record of one input in `inputs.json`: how the search folder's link maps to the user's file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputRecord {
    /// The front end's id of the file.
    pub id: String,
    /// Position in the request.
    pub index: usize,
    /// The name OpenNuXL saw: the link in the search folder (`<n>__<name>`), or the file's own name when
    /// it was given its own path (Windows, [`InputLinks::PathsOrHardLinks`]).
    pub link: String,
    /// What the input's outputs are named after (`nuxl/<stem>.idXML`).
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
/// the user's path, the bare name of a link by the user's file name, the stem the outputs of an input are named
/// after by the user's (`nuxl/1__a.idXML` -> `nuxl/a.idXML`). The path of an output in the search folder `dir`
/// loses the folder (`<dir>/nuxl/a.idXML` -> `nuxl/a.idXML`): the folder of a search that failed is gone. Only
/// whole names are replaced (`1__a.mzML` inside `11__a.mzML` stays). The folder is recognised in each way a tool
/// may write it (Windows: `\\` or `/` after any part, the drive letter in either case), whatever the platform.
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
            text = replace_name(&text, &r.stem, &input_stem(&r.name), true);
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

/// `text` with every whole occurrence of `from` (not inside a longer name: no letter, digit or `_` either side)
/// replaced by `to`.
fn replace_whole(text: &str, from: &str, to: &str) -> String {
    replace_name(text, from, to, false)
}

/// As [`replace_whole`]; with `stem`, `from` may also be followed by `_`: a link's stem (`1__a`) begins the
/// names of OpenNuXL's derived outputs (`1__a_perc_1.0000_XLs.idXML`), and no other input's stem begins with it
/// (`<n>__` differs).
fn replace_name(text: &str, from: &str, to: &str, stem: bool) -> String {
    if from.is_empty() {
        return text.to_string();
    }
    let boundary = |c: Option<char>| c.is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
    let boundary_after = |c: Option<char>| boundary(c) || (stem && c == Some('_'));
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut before: Option<char> = None;
    while let Some(at) = rest.find(from) {
        let prev = rest[..at].chars().next_back().or(before);
        let after = rest[at + from.len()..].chars().next();
        out.push_str(&rest[..at]);
        if boundary(prev) && boundary_after(after) {
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
