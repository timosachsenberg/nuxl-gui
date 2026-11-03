//! What the front end may read of the disk, and nothing more:
//!
//! - [`read_search_file`]: a file of one search's folder (`<searches>/<id>/`), by its name relative to
//!   the folder (all of it, its last bytes, or a byte range), or the database that the search's `database.json`
//!   records (the shim writes it when OpenNuXL reads the user's FASTA as it is), or a part of one of the search's
//!   inputs ([`input_file`]: byte ranges only, never for an imported search). Names are checked as text
//!   (no `..`, `.`, empty parts, other absolute paths) and the file's canonical path must lie inside
//!   the canonical folder, so no symlink leads out of it: the shim's input links (`<n>__<name>`, to the
//!   user's files) are not readable as the search's own files. A file that does not exist rejects with
//!   `{ notFound: true, message }`, which the results reader takes for a missing output.
//! - [`inspect`]: what the New search page shows of an input it was given by path (size, the spectrum
//!   count of an mzML's header, the proteins and residues of a FASTA, and what in them OpenNuXL cannot search:
//!   `content`): numbers and short messages, never contents, and only of absolute paths with the suffixes
//!   the shim takes (`.mzML`, `.fasta`, `.fa`, `.faa`; `.mzML.gz` to say that it has to be unpacked); any other
//!   path is refused before the disk is asked.
//! - [`example_files`]: the bundled example, OpenMS' OpenNuXL test run and its FASTA.

use crate::args::{
    is_compressed_mzml, is_fasta_file, is_input_link, is_spectrum_file, InputRecord,
    DATABASE_RECORD,
};
use crate::content;
use serde::Serialize;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// Why a search file is not served: it does not exist (`not_found`), or it is not one of the search's.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadError {
    pub not_found: bool,
    pub message: String,
}

impl ReadError {
    pub(crate) fn refused(message: String) -> ReadError {
        ReadError {
            not_found: false,
            message,
        }
    }

    fn missing(name: &str) -> ReadError {
        ReadError {
            not_found: true,
            message: format!("{name} does not exist."),
        }
    }

    fn io(name: &str, e: io::Error) -> ReadError {
        if e.kind() == io::ErrorKind::NotFound {
            ReadError::missing(name)
        } else {
            ReadError::refused(format!("{name} cannot be read ({e})."))
        }
    }
}

/// A search id as the shim makes them (`<millis>-<n>`): letters, digits, `-` and `_` only, so that it
/// names one folder of the searches folder and nothing else.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A name relative to the folder: parts separated by `/`, none of them empty, `.` or `..`, no `\`
/// (a separator on Windows) and no absolute path.
pub fn valid_relative(name: &str) -> bool {
    !name.is_empty()
        && !Path::new(name).is_absolute()
        && !name.contains('\\')
        && !name.contains(':')
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// The search's folder, canonical. The folder itself has to be a folder, not a link to one (as History
/// has it: `history::existing_folder`): a link in the searches folder could lead anywhere.
fn search_folder(searches_dir: &Path, search_id: &str) -> Result<PathBuf, ReadError> {
    if !valid_id(search_id) {
        return Err(ReadError::refused(format!(
            "{search_id:?} is not a search."
        )));
    }
    let folder = searches_dir.join(search_id);
    if fs::symlink_metadata(&folder).is_ok_and(|m| !m.is_dir()) {
        return Err(ReadError::refused(format!(
            "The search {search_id} is not a folder."
        )));
    }
    let canonical = fs::canonicalize(&folder).map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            ReadError {
                not_found: true,
                message: format!("The search {search_id} does not exist."),
            }
        } else {
            ReadError::refused(format!("The search {search_id} cannot be read ({e})."))
        }
    })?;
    if !canonical.is_dir() {
        return Err(ReadError::refused(format!(
            "The search {search_id} is not a folder."
        )));
    }
    Ok(canonical)
}

/// Whether the search counts as imported from a project file: its `search.json` says so, or is there
/// and cannot be read as a record (then it is not trusted). A folder without a `search.json` (one just
/// finished, not saved yet) is not imported.
fn is_imported(folder: &Path) -> bool {
    const MAX: u64 = 64 << 20;
    let canonical = match fs::canonicalize(folder.join("search.json")) {
        Ok(canonical) => canonical,
        Err(e) => return e.kind() != io::ErrorKind::NotFound,
    };
    if !canonical.starts_with(folder)
        || fs::metadata(&canonical).map_or(true, |m| !m.is_file() || m.len() > MAX)
    {
        return true;
    }
    match fs::read(&canonical)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    {
        Some(record) => record.get("imported").and_then(|i| i.as_bool()) == Some(true),
        None => true,
    }
}

/// The path of `name` for [`read_search_file`], checked.
pub fn resolve_search_file(
    searches_dir: &Path,
    search_id: &str,
    name: &str,
) -> Result<PathBuf, ReadError> {
    let folder = search_folder(searches_dir, search_id)?;
    if Path::new(name).is_absolute() {
        // an imported search (a project from elsewhere) never reads outside its folder: a path it records
        // is that of another computer, or an attempt to name one of this
        if is_imported(&folder) {
            return Err(ReadError::refused(format!(
                "{name} is not a file of the search {search_id}: an imported search reads only its own folder."
            )));
        }
        // only the database this search was run with
        let recorded = recorded_database(&folder);
        if recorded.as_deref() != Some(name) || !is_fasta_file(name) {
            return Err(ReadError::refused(format!(
                "{name} is not a file of the search {search_id}."
            )));
        }
        let meta = fs::metadata(name).map_err(|e| ReadError::io(name, e))?;
        if !meta.is_file() {
            return Err(ReadError::refused(format!("{name} is not a file.")));
        }
        return Ok(PathBuf::from(name));
    }
    if !valid_relative(name) {
        return Err(ReadError::refused(format!(
            "{name:?} is not a file of the search {search_id}."
        )));
    }
    // a link to an input (on Windows a hard link, which resolves inside the folder) is the user's file
    if is_input_link(name) {
        return Err(ReadError::refused(format!(
            "{name} is an input of the search {search_id}, not one of its files: it is read in parts only."
        )));
    }
    let canonical = fs::canonicalize(folder.join(name)).map_err(|e| ReadError::io(name, e))?;
    if !canonical.starts_with(&folder) {
        return Err(ReadError::refused(format!(
            "{name} lies outside the search {search_id}."
        )));
    }
    if !canonical.is_file() {
        return Err(ReadError::refused(format!("{name} is not a file.")));
    }
    Ok(canonical)
}

/// Which bytes of a file [`read_search_file`] reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteRange {
    /// All of it.
    All,
    /// The last bytes (all of a smaller file): the index at the end of an indexed mzML, which the PSM view
    /// reads to find a spectrum.
    Tail(u64),
    /// `length` bytes from `offset` (fewer at the end of the file, none past it): a part of a file, e.g. one
    /// spectrum of an input's mzML, which the PSM view reads.
    Range { offset: u64, length: u64 },
}

impl ByteRange {
    /// The range of the command's arguments: `tail`, or `offset` with `length`, or all (an `offset` without
    /// `length` or the other way round, or `tail` with them, is refused).
    pub fn of(
        tail: Option<u64>,
        offset: Option<u64>,
        length: Option<u64>,
    ) -> Result<Self, ReadError> {
        match (tail, offset, length) {
            (None, None, None) => Ok(ByteRange::All),
            (Some(tail), None, None) => Ok(ByteRange::Tail(tail)),
            (None, Some(offset), Some(length)) => Ok(ByteRange::Range { offset, length }),
            _ => Err(ReadError::refused(
                "Give either tail, or offset and length, or none of them.".to_string(),
            )),
        }
    }
}

/// The largest byte range [`read_search_file`] reads at once (a spectrum is a few kB to a few MB; the scan of
/// an mzML without an index goes in parts of this or less).
pub const MAX_RANGE: u64 = 1 << 30;

/// The largest `inputs.json` read (a record per input, a few hundred bytes each).
const MAX_INPUTS_RECORD: u64 = 16 << 20;

/// The records of `inputs.json` of the search `folder` (canonical), if it has a readable one inside it.
fn input_records(folder: &Path) -> Option<Vec<InputRecord>> {
    let canonical = fs::canonicalize(folder.join("inputs.json")).ok()?;
    if !canonical.starts_with(folder)
        || fs::metadata(&canonical).map_or(true, |m| !m.is_file() || m.len() > MAX_INPUTS_RECORD)
    {
        return None;
    }
    serde_json::from_slice(&fs::read(&canonical).ok()?).ok()
}

/// The user's file of an input of the search `folder` (canonical), when `name` names one: the name of its link
/// (`<n>__<name>`, or on Windows the file's own name when it was searched by its own path), or the absolute path
/// `inputs.json` records for it. `Ok(None)`: `name` is no input. Refused for an imported search (its records
/// name files of another computer, or would be an attempt to name one of this) and for anything but an `.mzML`.
/// The file is the one at the recorded path now: moved or deleted, it is `not_found` (the PSM view then shows
/// the annotated peaks only).
pub fn input_file(
    folder: &Path,
    search_id: &str,
    name: &str,
) -> Result<Option<PathBuf>, ReadError> {
    let absolute = Path::new(name).is_absolute();
    // (a link name of an input, or an absolute path: only those can be inputs)
    if !absolute && !is_spectrum_file(name) {
        return Ok(None);
    }
    let Some(records) = input_records(folder) else {
        return Ok(None);
    };
    let Some(record) = records
        .iter()
        .find(|r| r.link == name || (absolute && r.path == name))
    else {
        return Ok(None);
    };
    if is_imported(folder) {
        return Err(ReadError::refused(format!(
            "{name} is an input of the search {search_id}, which was imported: an imported search reads only its \
             own folder."
        )));
    }
    if !Path::new(&record.path).is_absolute() || !is_spectrum_file(&record.path) {
        return Err(ReadError::refused(format!(
            "{name} is not an input of the search {search_id} that can be read."
        )));
    }
    let meta = fs::metadata(&record.path).map_err(|e| ReadError::io(&record.path, e))?;
    if !meta.is_file() {
        return Err(ReadError::refused(format!("{} is not a file.", record.path)));
    }
    Ok(Some(PathBuf::from(&record.path)))
}

/// The contents of `name` of the search `search_id` (see the module docs for what is served): the bytes of
/// `range`. An input ([`input_file`]) is served by `Tail` or `Range` only, never whole (an mzML is up to
/// gigabytes; the PSM view reads its index and one spectrum at a time).
pub fn read_search_file(
    searches_dir: &Path,
    search_id: &str,
    name: &str,
    range: ByteRange,
) -> Result<Vec<u8>, ReadError> {
    let folder = search_folder(searches_dir, search_id)?;
    let path = match input_file(&folder, search_id, name)? {
        Some(_) if range == ByteRange::All => {
            return Err(ReadError::refused(format!(
                "{name} is an input of the search {search_id}: it is read in parts (tail, or offset and length) \
                 only, not whole."
            )))
        }
        Some(path) => path,
        None => resolve_search_file(searches_dir, search_id, name)?,
    };
    if range == ByteRange::All {
        return fs::read(&path).map_err(|e| ReadError::io(name, e));
    }
    use io::Seek;
    let mut file = fs::File::open(&path).map_err(|e| ReadError::io(name, e))?;
    let size = file.metadata().map_err(|e| ReadError::io(name, e))?.len();
    let (start, length) = match range {
        ByteRange::Tail(tail) => (size.saturating_sub(tail), tail.min(size)),
        ByteRange::Range { offset, length } => {
            if length > MAX_RANGE {
                return Err(ReadError::refused(format!(
                    "{name}: {length} bytes at once are more than the {MAX_RANGE} the app reads."
                )));
            }
            let start = offset.min(size);
            (start, length.min(size - start))
        }
        ByteRange::All => unreachable!(),
    };
    file.seek(io::SeekFrom::Start(start))
        .map_err(|e| ReadError::io(name, e))?;
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(length)
        .read_to_end(&mut bytes)
        .map_err(|e| ReadError::io(name, e))?;
    Ok(bytes)
}

/// The database the search `folder` read as it is (no contaminants): the path its [`DATABASE_RECORD`]
/// records (written by the shim, `run.rs`), if it is one.
pub fn recorded_database(folder: &Path) -> Option<String> {
    const MAX: u64 = 1 << 20;
    let path = folder.join(DATABASE_RECORD);
    if fs::symlink_metadata(&path).map_or(true, |m| !m.is_file() || m.len() > MAX) {
        return None;
    }
    let record: serde_json::Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    record.get("path")?.as_str().map(str::to_string)
}

/// What the New search page shows of a file it was given by path.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    /// As given.
    pub path: String,
    pub name: String,
    /// Bytes (0 with an error).
    pub size: u64,
    /// The `count` of an mzML's `<spectrumList>` (all spectra); None if the header does not say.
    pub spectra: Option<u64>,
    /// The entries of a FASTA file and the residues (letters) of their sequences.
    pub proteins: Option<u64>,
    pub residues: Option<u64>,
    /// Why the file cannot be used (not absolute, missing, a folder, unreadable).
    pub error: Option<String>,
    /// Why OpenNuXL cannot search the file, which is there and readable (`content`): an mzML that is not one,
    /// is compressed, is cut off or has no spectra; a FASTA without entries, with an accession twice, ... New
    /// search does not start with it. Sentences, the file named.
    pub problem: Option<String>,
    /// What may surprise (an entry listed twice): shown, not blocking.
    pub warnings: Vec<String>,
}

/// The facts of the file at `path` (an absolute path). Never fails: what goes wrong is in `error`.
pub fn inspect(path: &str) -> FileFacts {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut facts = FileFacts {
        path: path.to_string(),
        name: name.clone(),
        size: 0,
        spectra: None,
        proteins: None,
        residues: None,
        error: None,
        problem: None,
        warnings: Vec::new(),
    };
    if !Path::new(path).is_absolute() {
        facts.error = Some(format!("{path} is not an absolute path."));
        return facts;
    }
    // only what a search takes, before anything is asked of the disk: other files (a key, a document)
    // are not even looked up, so the page learns nothing of them
    if !is_spectrum_file(&name) && !is_compressed_mzml(&name) && !is_fasta_file(&name) {
        facts.error = Some(format!(
            "{path} is not an mzML file (.mzML) or a FASTA file (.fasta, .fa, .faa)."
        ));
        return facts;
    }
    let meta = match fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta,
        Ok(_) => {
            facts.error = Some(format!("{path} is not a file."));
            return facts;
        }
        Err(e) => {
            facts.error = Some(format!("{path} cannot be read ({e})."));
            return facts;
        }
    };
    facts.size = meta.len();
    let file = Path::new(path);
    if is_compressed_mzml(&name) {
        // (not read: the search cannot take it as it is)
        facts.problem = Some(format!(
            "{name} is compressed: OpenNuXL reads .mzML files only. Unpack it first (e.g. with gunzip or 7-Zip) and \
             add the .mzML."
        ));
        return facts;
    }
    let counted = if is_fasta_file(&name) {
        content::fasta(file, &name).map(|f| {
            facts.proteins = Some(f.proteins);
            facts.residues = Some(f.residues);
            facts.problem = (!f.problems.is_empty()).then(|| f.problems.join(" "));
            facts.warnings = f.warnings;
        })
    } else {
        content::mzml(file, &name).map(|m| {
            facts.spectra = m.spectra;
            facts.problem = m.problem;
        })
    };
    if let Err(e) = counted {
        facts.error = Some(format!("{path} cannot be read ({e})."));
    }
    facts
}

/// [`inspect`] of each path, in the order given, several at once.
pub fn inspect_all(paths: &[String]) -> Vec<FileFacts> {
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .clamp(1, 8)
        .min(paths.len().max(1));
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut facts: Vec<Option<FileFacts>> = vec![None; paths.len()];
    let slots = std::sync::Mutex::new(&mut facts);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(path) = paths.get(i) else { break };
                let f = inspect(path);
                slots.lock().unwrap()[i] = Some(f);
            });
        }
    });
    facts.into_iter().flatten().collect()
}

/// The bundled example: OpenMS' OpenNuXL test data (`src/tests/topp/OpenNuXL_1_input.mzML`, a few MS2 spectra of
/// a UV cross-linked protein–RNA sample, and `OpenNuXL_1_input.fasta`, its proteins, targets only: OpenNuXL
/// generates the decoys).
pub const EXAMPLE_RUN: &str = "OpenNuXL_1_input.mzML";
pub const EXAMPLE_FASTA: &str = "OpenNuXL_1_input.fasta";

/// Where the bundled example is. In development (no bundle yet) the folder in the source tree.
pub fn bundled_example(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let in_bundle = resource_dir.map(|d| d.join("resources/example"));
    let in_source =
        option_env!("CARGO_MANIFEST_DIR").map(|d| Path::new(d).join("resources/example"));
    in_bundle
        .into_iter()
        .chain(in_source)
        .find(|p| p.join(EXAMPLE_RUN).is_file())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExampleFiles {
    pub spectra: Vec<String>,
    pub database: String,
}

/// The example's inputs: the bundled run and FASTA, by their paths in the app's resources (read where they are,
/// as any input; nothing is written).
pub fn example_files(source_dir: &Path) -> Result<ExampleFiles, String> {
    let run = source_dir.join(EXAMPLE_RUN);
    let fasta = source_dir.join(EXAMPLE_FASTA);
    if !run.is_file() || !fasta.is_file() {
        return Err("The example is not part of this installation.".to_string());
    }
    Ok(ExampleFiles {
        spectra: vec![run.to_string_lossy().into_owned()],
        database: fasta.to_string_lossy().into_owned(),
    })
}
