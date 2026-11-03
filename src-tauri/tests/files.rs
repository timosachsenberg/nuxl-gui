//! The front end's access to files: the search folder's files (scoped), what the New search page shows
//! of an input (counts, never contents), and the bundled example.

mod common;

use common::TempDir;
use prose_desktop_lib::files::{
    example_files, inspect, read_search_file, recorded_database, ByteRange, ReadError,
};
use std::fs;
use std::path::Path;

#[cfg(unix)]
fn link(original: &Path, link: &Path) {
    std::os::unix::fs::symlink(original, link).unwrap();
}

/// A searches folder with one finished search `1-0` (its database.json naming `database`) and a user
/// folder beside it with an input and the database.
fn search_with(database: &str) -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new("files");
    let searches = tmp.path().join("searches");
    let folder = searches.join("1-0");
    fs::create_dir_all(folder.join("qpx")).unwrap();
    fs::write(folder.join("inputs.json"), "[]").unwrap();
    fs::write(folder.join("qpx/1__a.psm.parquet"), b"PAR1....PAR1").unwrap();
    fs::write(
        folder.join("database.json"),
        serde_json::json!({ "path": database }).to_string(),
    )
    .unwrap();
    tmp.write("user/a.mzML", "<mzML/>");
    (tmp, searches)
}

fn not_found(result: Result<Vec<u8>, ReadError>) -> bool {
    matches!(
        result,
        Err(ReadError {
            not_found: true,
            ..
        })
    )
}

fn refused(result: Result<Vec<u8>, ReadError>) -> bool {
    matches!(
        result,
        Err(ReadError {
            not_found: false,
            ..
        })
    )
}

#[test]
fn a_file_of_the_search_folder_is_served() {
    let (_tmp, searches) = search_with("/nowhere/db.fasta");
    assert_eq!(
        read_search_file(&searches, "1-0", "inputs.json", ByteRange::All).unwrap(),
        b"[]"
    );
    assert_eq!(
        read_search_file(&searches, "1-0", "qpx/1__a.psm.parquet", ByteRange::All).unwrap(),
        b"PAR1....PAR1"
    );
}

#[test]
fn a_missing_file_rejects_with_not_found_and_a_message() {
    let (_tmp, searches) = search_with("/nowhere/db.fasta");
    let error =
        read_search_file(&searches, "1-0", "qpx/quantms.pg.parquet", ByteRange::All).unwrap_err();
    assert!(error.not_found);
    assert!(
        error.message.contains("qpx/quantms.pg.parquet"),
        "{}",
        error.message
    );
    // serialised for the front end as { notFound, message }
    let json = serde_json::to_value(&error).unwrap();
    assert_eq!(json["notFound"], true);
    assert!(json["message"].is_string());
    // a search that does not exist: its files do not exist either
    assert!(not_found(read_search_file(
        &searches,
        "9-9",
        "inputs.json",
        ByteRange::All
    )));
}

#[test]
fn names_that_leave_the_folder_are_refused() {
    let (tmp, searches) = search_with("/nowhere/db.fasta");
    tmp.write("searches/secret.txt", "secret");
    for name in [
        "../secret.txt",
        "qpx/../../secret.txt",
        "./inputs.json",
        "qpx/./1__a.psm.parquet",
        "",
        "qpx",
        "/etc/passwd",
    ] {
        assert!(
            refused(read_search_file(&searches, "1-0", name, ByteRange::All)),
            "{name:?} was not refused"
        );
    }
}

/// On Windows a search's inputs of one name are hard links in the folder while ProSE runs (removed
/// when it ends): regular files inside the folder, which are still the user's and never served.
#[test]
fn the_inputs_hard_links_are_not_served() {
    let (tmp, searches) = search_with("/nowhere/db.fasta");
    fs::hard_link(
        tmp.path().join("user/a.mzML"),
        searches.join("1-0/1__a.mzML"),
    )
    .unwrap();
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        "1__a.mzML",
        ByteRange::All
    )));
    let err = read_search_file(&searches, "1-0", "1__a.mzML", ByteRange::All).unwrap_err();
    assert!(err.message.contains("input"), "{}", err.message);
}

#[test]
fn search_ids_that_are_paths_are_refused() {
    let (tmp, searches) = search_with("/nowhere/db.fasta");
    tmp.write("secret/inputs.json", "secret");
    for id in [
        "",
        "..",
        "../secret",
        "1-0/qpx",
        "/tmp",
        "1-0.partial",
        "a b",
    ] {
        assert!(
            refused(read_search_file(
                &searches,
                id,
                "inputs.json",
                ByteRange::All
            )),
            "{id:?} was not refused"
        );
    }
}

#[cfg(unix)]
#[test]
fn the_input_links_and_other_symlinks_cannot_lead_out_of_the_folder() {
    let (tmp, searches) = search_with("/nowhere/db.fasta");
    let folder = searches.join("1-0");
    // the shim's input link, to the user's file
    link(&tmp.path().join("user/a.mzML"), &folder.join("1__a.mzML"));
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        "1__a.mzML",
        ByteRange::All
    )));
    // a link to a folder outside, and a file through it
    link(&tmp.path().join("user"), &folder.join("out"));
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        "out/a.mzML",
        ByteRange::All
    )));
    // a link inside the folder to a file inside is fine
    link(&folder.join("inputs.json"), &folder.join("again.json"));
    assert_eq!(
        read_search_file(&searches, "1-0", "again.json", ByteRange::All).unwrap(),
        b"[]"
    );
}

/// One rule for a search folder that is a link, in the reader and in History: refused (a link in the
/// searches folder could lead anywhere).
#[cfg(unix)]
#[test]
fn a_search_folder_that_is_a_link_is_refused_by_the_reader_and_by_history() {
    use prose_desktop_lib::history;
    let (tmp, searches) = search_with("/nowhere/db.fasta");
    let folder = searches.join("1-0");
    fs::write(
        folder.join("search.json"),
        r#"{"schema":1,"id":"1-0","name":"x"}"#,
    )
    .unwrap();
    let elsewhere = tmp.path().join("elsewhere");
    fs::rename(&folder, &elsewhere).unwrap();
    link(&elsewhere, &folder);
    for name in ["inputs.json", "search.json", "qpx/1__a.psm.parquet"] {
        let result = read_search_file(&searches, "1-0", name, ByteRange::All);
        assert!(refused(result.clone()), "{name}: {result:?}");
        assert!(result.unwrap_err().message.contains("not a folder"));
    }
    assert!(history::rename(&searches, "1-0", "y").is_err());
    assert!(history::folder_files(&searches, "1-0").is_err());
    assert!(
        history::save_record(&searches, "1-0", r#"{"schema":1,"id":"1-0","name":"x"}"#).is_err()
    );
    assert!(history::save_proteins(&searches, "1-0", ">A\nB\n").is_err());
    assert!(history::delete(&searches, "1-0").is_err());
    // the list leaves it out, and nothing behind the link was touched
    assert!(history::list(&searches).is_empty());
    assert!(elsewhere.join("inputs.json").exists());
    assert!(!elsewhere.join("proteins.fasta").exists());
    // the same folder, not a link, is served
    fs::remove_file(&folder).unwrap();
    fs::rename(&elsewhere, &folder).unwrap();
    assert_eq!(
        read_search_file(&searches, "1-0", "inputs.json", ByteRange::All).unwrap(),
        b"[]"
    );
}

#[test]
fn the_database_that_database_json_records_is_served_and_no_other_absolute_path() {
    let tmp0 = TempDir::new("db");
    // (a name with quotes for the JSON; Windows allows no '"' in names, its paths have '\')
    let name = if cfg!(windows) {
        "my folder/it's db.fasta"
    } else {
        "my folder/\"quoted\" db.fasta"
    };
    let db = tmp0.write(name, ">P1\nPEPTIDE\n");
    let other = tmp0.write("other.fasta", ">P2\nPEPTIDE\n");
    let (_tmp, searches) = search_with(db.to_str().unwrap());
    assert_eq!(
        read_search_file(&searches, "1-0", db.to_str().unwrap(), ByteRange::All).unwrap(),
        b">P1\nPEPTIDE\n"
    );
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        other.to_str().unwrap(),
        ByteRange::All
    )));
    // the recorded database gone (moved): not found, so the reader goes on without it
    fs::remove_file(&db).unwrap();
    assert!(not_found(read_search_file(
        &searches,
        "1-0",
        db.to_str().unwrap(),
        ByteRange::All
    )));
}

#[test]
fn an_imported_search_never_reads_the_database_path_it_records() {
    let tmp0 = TempDir::new("db");
    let db = tmp0.write("db.fasta", ">P1\nPEPTIDE\n");
    let name = db.to_str().unwrap();
    let (_tmp, searches) = search_with(name);
    let record = searches.join("1-0/search.json");
    // a search of this app (a record without the mark, or none yet): served
    assert!(read_search_file(&searches, "1-0", name, ByteRange::All).is_ok());
    fs::write(&record, r#"{"schema":1,"id":"1-0"}"#).unwrap();
    assert!(read_search_file(&searches, "1-0", name, ByteRange::All).is_ok());
    fs::write(&record, r#"{"schema":1,"id":"1-0","imported":false}"#).unwrap();
    assert!(read_search_file(&searches, "1-0", name, ByteRange::All).is_ok());
    // an imported one: refused, with a message that is no not-found (the reader goes on to its own files)
    fs::write(&record, r#"{"schema":1,"id":"1-0","imported":true}"#).unwrap();
    let err = read_search_file(&searches, "1-0", name, ByteRange::All).unwrap_err();
    assert!(
        !err.not_found && err.message.contains("imported"),
        "{err:?}"
    );
    // its own files are served as before
    assert!(read_search_file(&searches, "1-0", "qpx/1__a.psm.parquet", ByteRange::All).is_ok());
    // a record that cannot be read is not trusted either
    fs::write(&record, "{ broken").unwrap();
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        name,
        ByteRange::All
    )));
    fs::remove_file(&record).unwrap();
    fs::create_dir(&record).unwrap();
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        name,
        ByteRange::All
    )));
}

#[test]
fn a_recorded_database_that_is_not_a_fasta_file_is_not_served() {
    let tmp0 = TempDir::new("db");
    let secret = tmp0.write("notes.txt", "secret");
    let (_tmp, searches) = search_with(secret.to_str().unwrap());
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        secret.to_str().unwrap(),
        ByteRange::All
    )));
}

#[test]
fn the_database_path_is_read_from_database_json() {
    let tmp = TempDir::new("record");
    let folder = tmp.path().join("1-0");
    fs::create_dir_all(&folder).unwrap();
    assert_eq!(recorded_database(&folder), None);
    fs::write(
        folder.join("database.json"),
        r#"{"path":"/ä/\"q\" b.fasta"}"#,
    )
    .unwrap();
    assert_eq!(
        recorded_database(&folder).as_deref(),
        Some("/ä/\"q\" b.fasta")
    );
    // not JSON, no path, a path that is no string, a folder: none
    for bad in ["{ broken", r#"{"file":"/x.fasta"}"#, r#"{"path":1}"#] {
        fs::write(folder.join("database.json"), bad).unwrap();
        assert_eq!(recorded_database(&folder), None, "{bad}");
    }
    fs::remove_file(folder.join("database.json")).unwrap();
    fs::create_dir(folder.join("database.json")).unwrap();
    assert_eq!(recorded_database(&folder), None);
}

#[test]
fn the_last_bytes_of_a_file_are_served() {
    let (_tmp, searches) = search_with("/nowhere/db.fasta");
    let name = "qpx/1__a.psm.parquet";
    assert_eq!(
        read_search_file(&searches, "1-0", name, ByteRange::Tail(4)).unwrap(),
        b"PAR1"
    );
    assert_eq!(
        read_search_file(&searches, "1-0", name, ByteRange::Tail(100)).unwrap(),
        b"PAR1....PAR1"
    );
    assert_eq!(
        read_search_file(&searches, "1-0", name, ByteRange::Tail(0)).unwrap(),
        b""
    );
    assert!(not_found(read_search_file(
        &searches,
        "1-0",
        "qpx/x.psm.parquet",
        ByteRange::Tail(4)
    )));
}

#[test]
fn a_byte_range_of_a_file_is_served() {
    let (_tmp, searches) = search_with("/nowhere/db.fasta");
    let name = "qpx/1__a.psm.parquet";
    let range = |offset, length| ByteRange::Range { offset, length };
    assert_eq!(
        read_search_file(&searches, "1-0", name, range(4, 4)).unwrap(),
        b"...."
    );
    // fewer bytes at the end, none past it
    assert_eq!(
        read_search_file(&searches, "1-0", name, range(8, 100)).unwrap(),
        b"PAR1"
    );
    assert_eq!(
        read_search_file(&searches, "1-0", name, range(100, 4)).unwrap(),
        b""
    );
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        name,
        range(0, (1 << 30) + 1)
    )));
    // scoped as the whole file: an input link is no file of the search
    assert!(refused(read_search_file(
        &searches,
        "1-0",
        "1__a.mzML",
        range(0, 4)
    )));
    assert!(not_found(read_search_file(
        &searches,
        "1-0",
        "qpx/x.psm.parquet",
        range(0, 4)
    )));
}

#[test]
fn a_byte_range_is_tail_or_offset_and_length() {
    assert_eq!(ByteRange::of(None, None, None).unwrap(), ByteRange::All);
    assert_eq!(
        ByteRange::of(Some(8), None, None).unwrap(),
        ByteRange::Tail(8)
    );
    assert_eq!(
        ByteRange::of(None, Some(1), Some(2)).unwrap(),
        ByteRange::Range {
            offset: 1,
            length: 2
        }
    );
    assert!(ByteRange::of(None, Some(1), None).is_err());
    assert!(ByteRange::of(Some(1), Some(1), Some(2)).is_err());
}

/// An indexed mzML's end.
const MZML_END: &str = "</run></mzML><indexListOffset>9</indexListOffset></indexedmzML>\n";

fn gzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

#[test]
fn an_mzml_shows_its_size_and_spectrum_count() {
    let tmp = TempDir::new("inspect");
    let text = format!("<?xml?>\n<indexedmzML><mzML><run><spectrumList count=\"2789\" defaultDataProcessingRef=\"x\">{MZML_END}");
    let mzml = tmp.write("run 1.mzML", &text);
    let facts = inspect(mzml.to_str().unwrap());
    assert_eq!(facts.name, "run 1.mzML");
    assert_eq!(facts.size, fs::metadata(&mzml).unwrap().len());
    assert_eq!(facts.spectra, Some(2789));
    assert_eq!(facts.proteins, None);
    assert_eq!(facts.error, None);
    assert_eq!(facts.problem, None);
    // compressed: decompressed to be counted and checked
    let gz = tmp.path().join("run.mzML.gz");
    fs::write(&gz, gzip(text.as_bytes())).unwrap();
    let facts = inspect(gz.to_str().unwrap());
    assert_eq!(facts.spectra, Some(2789));
    assert_eq!((facts.error, facts.problem), (None, None));
}

#[test]
fn an_mzml_that_prose_cannot_search_has_a_problem() {
    let tmp = TempDir::new("inspect");
    let problem = |name: &str, contents: &[u8]| {
        let path = tmp.path().join(name);
        fs::write(&path, contents).unwrap();
        let facts = inspect(path.to_str().unwrap());
        assert_eq!(facts.error, None, "{name}");
        facts
            .problem
            .unwrap_or_else(|| panic!("{name}: no problem"))
    };
    assert_eq!(problem("empty.mzML", b""), "empty.mzML is empty.");
    assert!(problem("fake.mzML", b"not xml at all").contains("is not an mzML file"));
    // cut off after its header (the battle test's trunc.mzML said 139 spectra)
    let whole =
        format!("<?xml?><indexedmzML><mzML><run><spectrumList count=\"139\"><spectrum/>{MZML_END}");
    let cut = &whole.as_bytes()[..whole.len() - 30];
    assert!(problem("trunc.mzML", cut).contains("trunc.mzML is incomplete"));
    // a long file cut off: its head and its tail are read
    let mut long = whole.as_bytes()[..whole.len() - MZML_END.len()].to_vec();
    long.extend(std::iter::repeat_n(b' ', 3 << 20));
    assert!(problem("long.mzML", &long).contains("is incomplete"));
    long.extend_from_slice(MZML_END.as_bytes());
    let path = tmp.path().join("long.mzML");
    fs::write(&path, &long).unwrap();
    assert_eq!(inspect(path.to_str().unwrap()).problem, None);
    // compressed: not gzip, cut off, or an mzML cut off before it was compressed
    assert!(problem("plain.mzML.gz", whole.as_bytes()).contains("is not gzip-compressed"));
    let gz = gzip(whole.as_bytes());
    assert!(
        problem("cut.mzML.gz", &gz[..gz.len() - 12]).contains("cannot be decompressed to its end")
    );
    assert!(problem("cut-inside.mzML.gz", &gzip(cut)).contains("is incomplete"));
}

#[test]
fn a_fasta_shows_its_proteins_and_residues() {
    let tmp = TempDir::new("inspect");
    let fasta = tmp.write("db.fasta", ">sp|P1|A desc\nPEPTIDE\nKR\r\n>sp|P2|B\nAC*\n");
    let facts = inspect(fasta.to_str().unwrap());
    assert_eq!(facts.proteins, Some(2));
    assert_eq!(facts.residues, Some(11));
    assert_eq!(facts.spectra, None);
    assert_eq!((facts.problem, facts.warnings), (None, vec![]));
}

#[test]
fn a_fasta_that_prose_refuses_has_a_problem_and_what_it_may_mishandle_warnings() {
    let tmp = TempDir::new("inspect");
    for (name, contents, expected) in [
        ("empty.fasta", "", "empty.fasta is empty."),
        (
            "notfasta.fasta",
            "hello world\nthis is not a fasta\n",
            "no protein entries",
        ),
        (
            "headeronly.fasta",
            ">P1\n>P2\n",
            "2 entries without a sequence (the first: P1)",
        ),
        (
            "dup.fasta",
            ">P1\nKK\n>P1\nRR\n",
            "1 accession more than once with different sequences (the first: P1)",
        ),
    ] {
        let facts = inspect(tmp.write(name, contents).to_str().unwrap());
        let problem = facts.problem.unwrap_or_default();
        assert!(problem.contains(expected), "{name}: {problem}");
    }
    let facts = inspect(
        tmp.write("bom.fasta", "\u{feff}>P1\nmkr\n")
            .to_str()
            .unwrap(),
    );
    assert_eq!(
        (facts.proteins, facts.residues, facts.problem),
        (Some(1), Some(3), None)
    );
    // ProSE reads a byte-order mark and lowercase residues
    assert!(facts.warnings.is_empty(), "{:?}", facts.warnings);
    // an entry listed twice: searched once
    let facts = inspect(
        tmp.write("twice.fasta", ">P1\nKK\n>P1\nKK\n")
            .to_str()
            .unwrap(),
    );
    assert_eq!(facts.problem, None);
    assert_eq!(facts.warnings.len(), 1, "{:?}", facts.warnings);
}

#[test]
fn what_is_not_an_absolute_existing_file_has_an_error() {
    let tmp = TempDir::new("inspect");
    for path in [
        "relative.mzML".to_string(),
        tmp.path()
            .join("missing.mzML")
            .to_string_lossy()
            .into_owned(),
        tmp.path().to_string_lossy().into_owned(),
    ] {
        let facts = inspect(&path);
        assert!(facts.error.is_some(), "{path}: no error");
        assert_eq!(facts.spectra, None);
    }
}

#[test]
fn the_example_is_two_named_links_to_the_bundled_run_and_its_fasta() {
    let source = TempDir::new("example-src");
    source.write("Ecoli_MS2_small.mzML", "<mzML/>");
    source.write("Ecoli_K12_proteome.fasta", ">P\nK\n");
    let data = TempDir::new("example-data");
    // an earlier version's example links in the app's example folder
    fs::create_dir_all(data.path().join("example")).unwrap();
    fs::write(
        data.path().join("example/DatabaseSuitability_1.mzML"),
        "old",
    )
    .unwrap();
    let example = example_files(source.path(), data.path()).unwrap();
    assert!(!data
        .path()
        .join("example/DatabaseSuitability_1.mzML")
        .exists());
    let names: Vec<_> = example
        .spectra
        .iter()
        .map(|p| {
            Path::new(p)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(names, ["Ecoli_1.mzML", "Ecoli_2.mzML"]);
    for p in &example.spectra {
        assert!(Path::new(p).is_absolute());
        assert_eq!(fs::read_to_string(p).unwrap(), "<mzML/>");
    }
    assert_eq!(
        Path::new(&example.database).file_name().unwrap(),
        "Ecoli_K12_proteome.fasta"
    );
    // again (the links exist): the same answer
    let again = example_files(source.path(), data.path()).unwrap();
    assert_eq!(again.spectra, example.spectra);
    // no bundled example: an error, nothing made
    let empty = TempDir::new("example-none");
    assert!(example_files(empty.path(), data.path()).is_err());
}

#[test]
fn the_bundled_crap_has_the_counts_new_search_shows() {
    // CRAP_PROTEINS and CRAP_RESIDUES of src/lib/search/form.svelte.ts
    let crap = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/fasta/crap.fasta");
    let facts = inspect(crap.to_str().unwrap());
    assert_eq!(facts.proteins, Some(116));
    assert_eq!(facts.residues, Some(38459));
}

#[test]
fn the_bundled_example_is_the_e_coli_run_and_its_target_proteins() {
    // the counts New search shows for the example (EmptyState.svelte, e2e/search.spec.ts)
    let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/example");
    let run = inspect(example.join("Ecoli_MS2_small.mzML").to_str().unwrap());
    assert_eq!(run.spectra, Some(139));
    let fasta_path = example.join("Ecoli_K12_proteome.fasta");
    let fasta = inspect(fasta_path.to_str().unwrap());
    assert_eq!(fasta.proteins, Some(4136));
    // targets only: ProSE makes the decoys
    let text = fs::read_to_string(&fasta_path).unwrap();
    assert!(!text.lines().any(|l| l.starts_with(">rev_")));
}
