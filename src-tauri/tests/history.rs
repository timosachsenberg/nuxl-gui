//! History: the search folders of the app's data folder, listed, renamed, deleted, imported from a
//! project file's entries, and the sweep of what an interrupted search left.

mod common;

use common::{set_folder_modified, TempDir};
use prose_desktop_lib::history::{
    delete, finish_partial, folder_files, frame, import, list, lock_partial, read_chosen_project,
    remove_partial, rename, save_proteins, save_record, sweep, with_backoff, BACKOFF_TRIES,
    LOCK_FILE, NOT_A_SEARCH, NO_RECORD, SWEEP_GRACE,
};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

fn record(id: &str, name: &str) -> String {
    format!(
        r#"{{"schema":1,"id":"{id}","name":"{name}","createdAt":"2026-10-20T10:00:00.000Z","appVersion":"0.1.0","toolVersion":"3.6.0","files":["a.mzML","b.mzML"],"database":"human.fasta","psms":42,"design":{{}},"settings":{{}}}}"#
    )
}

/// A searches folder.
fn searches() -> (TempDir, PathBuf) {
    let tmp = TempDir::new("history");
    let dir = tmp.path().join("searches");
    fs::create_dir_all(&dir).unwrap();
    (tmp, dir)
}

/// A finished search folder with outputs, saved to History under `name`.
fn saved(dir: &Path, id: &str, name: &str) {
    let folder = dir.join(id);
    fs::create_dir_all(folder.join("qpx")).unwrap();
    fs::write(folder.join("qpx/1__a.psm.parquet"), b"PAR1....PAR1").unwrap();
    fs::write(folder.join("inputs.json"), "[]").unwrap();
    save_record(dir, id, &record(id, name)).unwrap();
    save_proteins(dir, id, ">P1 first\nPEPTIDE\n").unwrap();
}

fn json(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn history_lists_renames_and_deletes() {
    let (_tmp, dir) = searches();
    saved(&dir, "1-0", "first");
    saved(&dir, "2-0", "second");
    // the newest first; the entry says what History shows
    let entries = list(&dir);
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|e| e.error.is_none()));
    let first = entries.iter().find(|e| e.id == "1-0").unwrap();
    assert_eq!(first.name.as_deref(), Some("first"));
    assert_eq!(first.files, ["a.mzML", "b.mzML"]);
    assert_eq!(first.psms, Some(42));
    assert_eq!(first.database.as_deref(), Some("human.fasta"));
    assert!(
        first.bytes > 12,
        "the folder's size, not zero: {}",
        first.bytes
    );
    // save wrote proteins.fasta and search.json
    assert_eq!(
        fs::read_to_string(dir.join("1-0/proteins.fasta")).unwrap(),
        ">P1 first\nPEPTIDE\n"
    );

    rename(&dir, "1-0", "  renamed  ").unwrap();
    assert_eq!(json(&dir.join("1-0/search.json"))["name"], "renamed");
    // everything else of the record is kept
    assert_eq!(json(&dir.join("1-0/search.json"))["psms"], 42);
    assert!(rename(&dir, "1-0", "   ").is_err());
    assert!(rename(&dir, "1-0", "two\nlines").is_err());
    assert!(rename(&dir, "../1-0", "x").is_err());
    assert!(rename(&dir, "9-9", "x").is_err());

    delete(&dir, "1-0").unwrap();
    assert!(!dir.join("1-0").exists());
    assert_eq!(list(&dir).len(), 1);
    // a search that is gone is gone
    delete(&dir, "1-0").unwrap();
    // only ids of the searches folder
    assert!(delete(&dir, "..").is_err());
    assert!(delete(&dir, "2-0/qpx").is_err());
    assert!(dir.join("2-0/qpx").exists());
}

/// (symbolic links: Unix; Windows makes none without a privilege)
#[cfg(unix)]
#[test]
fn delete_does_not_follow_a_link() {
    let (tmp, dir) = searches();
    let outside = tmp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep"), "x").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("3-0")).unwrap();
    assert!(delete(&dir, "3-0").is_err());
    assert!(outside.join("keep").exists());
    // a link inside a search folder is removed as a link
    saved(&dir, "4-0", "x");
    std::os::unix::fs::symlink(&outside, dir.join("4-0/0__input")).unwrap();
    delete(&dir, "4-0").unwrap();
    assert!(outside.join("keep").exists());
}

#[test]
fn history_lists_an_incomplete_folder_with_its_message() {
    let (_tmp, dir) = searches();
    saved(&dir, "1-0", "good");
    // a record that is not JSON, one without a schema, a newer one, one of another kind
    fs::create_dir_all(dir.join("2-0")).unwrap();
    fs::write(dir.join("2-0/search.json"), "{ not json").unwrap();
    fs::create_dir_all(dir.join("3-0")).unwrap();
    fs::write(dir.join("3-0/search.json"), r#"{"name":"x"}"#).unwrap();
    fs::create_dir_all(dir.join("4-0")).unwrap();
    fs::write(
        dir.join("4-0/search.json"),
        r#"{"schema":2,"id":"4-0","name":"future"}"#,
    )
    .unwrap();
    fs::create_dir_all(dir.join("5-0")).unwrap();
    fs::write(dir.join("5-0/search.json"), "[1,2]").unwrap();
    fs::create_dir_all(dir.join("6-0")).unwrap();
    fs::write(dir.join("6-0/search.json"), vec![0xff, 0xfe, 0x00]).unwrap();
    // search.json is a folder
    fs::create_dir_all(dir.join("7-0/search.json")).unwrap();
    // wrong types of fields do not matter
    fs::create_dir_all(dir.join("8-0")).unwrap();
    fs::write(
        dir.join("8-0/search.json"),
        r#"{"schema":1,"id":"8-0","name":5,"files":"a","psms":"many"}"#,
    )
    .unwrap();
    // no search.json: a search that was not saved, listed as such
    fs::create_dir_all(dir.join("9-0")).unwrap();
    // not listed: a partial folder (running), a file, a hidden folder
    fs::create_dir_all(dir.join("10-0.partial")).unwrap();
    fs::write(dir.join("loose.txt"), "x").unwrap();
    fs::create_dir_all(dir.join(".hidden")).unwrap();
    // a folder whose name is no id: listed as no search, so that it can be deleted
    fs::create_dir_all(dir.join("not an id")).unwrap();
    fs::write(dir.join("not an id/search.json"), record("x", "x")).unwrap();

    let entries = list(&dir);
    let ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(entries.len(), 10, "{ids:?}");
    assert_eq!(get_error(&entries, "not an id"), Some(NOT_A_SEARCH));
    let get = |id: &str| entries.iter().find(|e| e.id == id).unwrap();
    assert!(get("1-0").error.is_none());
    assert_eq!(get("9-0").error.as_deref(), Some(NO_RECORD));
    for id in ["2-0", "3-0", "5-0", "6-0", "7-0"] {
        assert!(get(id).error.is_some(), "{id} lists with an error");
    }
    assert!(get("2-0").error.as_ref().unwrap().contains("search.json"));
    let newer = get("4-0").error.as_ref().unwrap();
    assert!(
        newer.contains("newer version of ProSE") && newer.contains("schema 2"),
        "{newer}"
    );
    // the good one first, the broken ones after
    assert_eq!(entries[0].id, "1-0");
    // a record of schema 1 with odd fields still lists
    let odd = get("8-0");
    assert!(odd.error.is_none());
    assert_eq!(odd.name.as_deref(), None);
    assert!(odd.files.is_empty());
    assert_eq!(odd.psms, None);
    // a rename of a broken one is refused with the message, not a crash
    assert!(rename(&dir, "2-0", "x").is_err());
    assert!(rename(&dir, "4-0", "x").is_err());
    // a missing searches folder lists nothing
    assert!(list(&dir.join("absent")).is_empty());
}

fn get_error<'a>(
    entries: &'a [prose_desktop_lib::history::HistoryEntry],
    id: &str,
) -> Option<&'a str> {
    entries.iter().find(|e| e.id == id)?.error.as_deref()
}

#[test]
fn a_folder_that_is_no_search_by_its_name_is_listed_and_can_be_deleted() {
    let (tmp, dir) = searches();
    saved(&dir, "1-0", "kept");
    for name in ["bad id", "a.b", "copy of 1-0"] {
        fs::create_dir_all(dir.join(name).join("qpx")).unwrap();
        fs::write(dir.join(name).join("qpx/x.parquet"), "x".repeat(10)).unwrap();
    }
    let entries = list(&dir);
    assert_eq!(entries.len(), 4);
    for name in ["bad id", "a.b", "copy of 1-0"] {
        let entry = entries.iter().find(|e| e.id == name).unwrap();
        assert_eq!(entry.error.as_deref(), Some(NOT_A_SEARCH));
        assert_eq!(entry.bytes, 10);
        assert_eq!(entry.name, None);
    }
    // listed last (with the errors)
    assert_eq!(entries[0].id, "1-0");
    delete(&dir, "bad id").unwrap();
    delete(&dir, "a.b").unwrap();
    assert!(!dir.join("bad id").exists() && !dir.join("a.b").exists());
    assert_eq!(list(&dir).len(), 2);
    // never a path, a hidden or partial folder, or what is above the searches folder
    fs::create_dir_all(dir.join("2-0.partial")).unwrap();
    fs::create_dir_all(dir.join(".hidden")).unwrap();
    for bad in [
        "..",
        ".",
        "",
        "../searches",
        "copy of 1-0/qpx",
        "2-0.partial",
        ".hidden",
        "a\\b",
        "c:x",
    ] {
        assert!(delete(&dir, bad).is_err(), "{bad:?} is refused");
    }
    assert!(dir.join("copy of 1-0/qpx").exists());
    assert!(dir.join("2-0.partial").exists() && dir.join(".hidden").exists());
    assert!(tmp.path().join("searches").exists());
    // a file of that name is not a folder
    fs::write(dir.join("loose file"), "x").unwrap();
    assert!(delete(&dir, "loose file").is_err());
    assert!(dir.join("loose file").exists());
}

/// (symbolic links: Unix)
#[cfg(unix)]
#[test]
fn a_link_named_like_no_search_is_neither_listed_nor_deleted() {
    let (tmp, dir) = searches();
    let outside = tmp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep"), "x").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("a link")).unwrap();
    assert!(list(&dir).is_empty());
    assert!(delete(&dir, "a link").is_err());
    assert!(outside.join("keep").exists());
}

#[test]
fn an_entry_has_the_cutoffs_and_settings_of_its_record() {
    let (_tmp, dir) = searches();
    fs::create_dir_all(dir.join("1-0")).unwrap();
    let text = r#"{"schema":1,"id":"1-0","name":"x","createdAt":"2026-10-20T10:00:00.000Z","psmFdr":0.01,"proteinFdr":0.05,"settings":{"parameters":{"chimeric:enabled":true},"presetId":"p","rescore":true}}"#;
    save_record(&dir, "1-0", text).unwrap();
    let entry = &list(&dir)[0];
    assert_eq!(entry.psm_fdr, Some(0.01));
    assert_eq!(entry.protein_fdr, Some(0.05));
    let settings = entry.settings.as_ref().unwrap();
    assert_eq!(settings["parameters"]["chimeric:enabled"], true);
    assert_eq!(settings["presetId"], "p");
    // as JSON for the page: camelCase
    let json = serde_json::to_value(entry).unwrap();
    assert_eq!(json["psmFdr"], 0.01);
    assert_eq!(json["proteinFdr"], 0.05);
    assert_eq!(json["settings"]["rescore"], true);
}

#[test]
fn save_refuses_what_is_not_a_record() {
    let (_tmp, dir) = searches();
    fs::create_dir_all(dir.join("1-0")).unwrap();
    assert!(save_record(&dir, "1-0", "not json").is_err());
    assert!(save_record(&dir, "1-0", r#"{"schema":2,"id":"1-0"}"#).is_err());
    assert!(
        save_record(&dir, "1-0", &record("other", "x")).is_err(),
        "the id is the folder's"
    );
    assert!(
        save_record(&dir, "2-0", &record("2-0", "x")).is_err(),
        "no such folder"
    );
    assert!(save_record(&dir, "../x", &record("../x", "x")).is_err());
    assert!(
        !dir.join("1-0/search.json").exists(),
        "a refused save leaves no record"
    );
    // proteins go only to a saved search
    assert!(save_proteins(&dir, "1-0", ">A\nB\n")
        .unwrap_err()
        .contains("not saved"));
    save_record(&dir, "1-0", &record("1-0", "x")).unwrap();
    // a record is written once (History's name is changed by rename): saving again keeps it
    save_record(&dir, "1-0", &record("1-0", "y")).unwrap();
    assert_eq!(json(&dir.join("1-0/search.json"))["name"], "x");
    save_proteins(&dir, "1-0", ">A\nB\n").unwrap();
    // no leftovers of the atomic writes
    let mut names: Vec<String> = fs::read_dir(dir.join("1-0"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["proteins.fasta", "search.json"]);
}

#[test]
fn the_record_comes_first_then_proteins_fasta_replaces_the_database_copy() {
    let (_tmp, dir) = searches();
    // a finished search as the shim leaves it: its outputs and database.fasta (the FASTA with cRAP)
    let folder = dir.join("1-0");
    fs::create_dir_all(folder.join("qpx")).unwrap();
    fs::write(folder.join("qpx/quantms.psm.parquet"), "psm").unwrap();
    fs::write(
        folder.join("database.fasta"),
        ">P1\nPEPTIDE\n>CON__P2\nKR\n",
    )
    .unwrap();
    // right after done: the record alone; the search is in History, database.fasta still there
    save_record(&dir, "1-0", &record("1-0", "x")).unwrap();
    assert!(list(&dir)[0].error.is_none());
    assert!(folder.join("database.fasta").exists());
    // the results read: proteins.fasta, and database.fasta goes
    save_proteins(&dir, "1-0", ">P1\nPEPTIDE\n").unwrap();
    assert_eq!(
        fs::read_to_string(folder.join("proteins.fasta")).unwrap(),
        ">P1\nPEPTIDE\n"
    );
    assert!(!folder.join("database.fasta").exists());
    // again (an opening that writes it once more): fine without database.fasta
    save_proteins(&dir, "1-0", ">P1\nPEPTIDE\n").unwrap();
}

#[test]
fn a_finished_folder_without_record_is_listed_as_not_saved() {
    let (_tmp, dir) = searches();
    saved(&dir, "1-0", "kept");
    fs::create_dir_all(dir.join("2-0/qpx")).unwrap();
    fs::write(dir.join("2-0/qpx/1__a.psm.parquet"), "x".repeat(100)).unwrap();
    let entries = list(&dir);
    assert_eq!(entries.len(), 2);
    let unsaved = entries.iter().find(|e| e.id == "2-0").unwrap();
    assert_eq!(unsaved.error.as_deref(), Some(NO_RECORD));
    assert_eq!(unsaved.bytes, 100);
    assert_eq!(unsaved.name, None);
    // listed last (with the errors), and it can be deleted
    assert_eq!(entries.last().unwrap().id, "2-0");
    delete(&dir, "2-0").unwrap();
    assert_eq!(list(&dir).len(), 1);
    // a partial folder (a running search) is not listed
    fs::create_dir_all(dir.join("3-0.partial")).unwrap();
    assert_eq!(list(&dir).len(), 1);
}

#[test]
fn folder_files_lists_regular_files_only() {
    let (tmp, dir) = searches();
    saved(&dir, "1-0", "x");
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hostname", dir.join("1-0/0__a.mzML")).unwrap();
    // a hard link to an input that a search on Windows left (it removes them; one in use may stay)
    let input = tmp.path().join("b.mzML.gz");
    fs::write(&input, "<mzML/>").unwrap();
    fs::hard_link(&input, dir.join("1-0/2__b.mzML.gz")).unwrap();
    let files = folder_files(&dir, "1-0").unwrap();
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "inputs.json",
            "proteins.fasta",
            "qpx/1__a.psm.parquet",
            "search.json"
        ]
    );
    assert_eq!(files[2].size, 12);
    assert!(folder_files(&dir, "9-9").is_err());
    assert!(folder_files(&dir, "..").is_err());
}

/// A project's entries as the app sends them.
fn project(id: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let rec = record(id, "imported");
    let mut entries: Vec<(&str, &[u8])> = vec![("search.json", rec.as_bytes())];
    entries.extend_from_slice(extra);
    frame(&entries)
}

#[test]
fn import_writes_a_fresh_folder() {
    let (_tmp, dir) = searches();
    let body = project(
        "old-id",
        &[
            ("qpx/1__a.psm.parquet", b"PAR1"),
            ("proteins.fasta", b">P\nAA\n"),
        ],
    );
    let id = import(&dir, &body).unwrap();
    assert_ne!(id, "old-id");
    let folder = dir.join(&id);
    assert_eq!(
        fs::read(folder.join("qpx/1__a.psm.parquet")).unwrap(),
        b"PAR1"
    );
    assert_eq!(
        fs::read(folder.join("proteins.fasta")).unwrap(),
        b">P\nAA\n"
    );
    // the record belongs to the new folder
    assert_eq!(json(&folder.join("search.json"))["id"], id.as_str());
    assert_eq!(json(&folder.join("search.json"))["name"], "imported");
    assert!(!dir.join(format!("{id}.partial")).exists());
    // twice: two searches
    let again = import(&dir, &body).unwrap();
    assert_ne!(again, id);
    assert_eq!(list(&dir).len(), 2);
    assert!(list(&dir).iter().all(|e| e.error.is_none()));
}

#[test]
fn import_rechecks_every_path() {
    let (_tmp, dir) = searches();
    let bad: [&str; 11] = [
        "../escape.txt",
        "a/../../escape.txt",
        "/etc/escape.txt",
        "a//b",
        "./a",
        "a/./b",
        "a\\b",
        "C:evil",
        "trailing/",
        "",
        "with\nnewline",
    ];
    for name in bad {
        let body = project("x", &[(name, b"x")]);
        let err = import(&dir, &body).unwrap_err();
        assert!(err.contains("not a plain"), "{name:?}: {err}");
    }
    // a name used twice, a file that is also a folder
    assert!(import(&dir, &project("x", &[("a", b"1"), ("a", b"2")])).is_err());
    assert!(import(&dir, &project("x", &[("a", b"1"), ("a/b", b"2")])).is_err());
    assert!(import(&dir, &project("x", &[("a/b", b"1"), ("a", b"2")])).is_err());
    // nothing was written, in or beside the searches folder
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    assert!(!dir.parent().unwrap().join("escape.txt").exists());
}

#[test]
fn import_needs_a_record_of_this_schema() {
    let (_tmp, dir) = searches();
    // no search.json
    assert!(import(&dir, &frame(&[("qpx/a", b"x")]))
        .unwrap_err()
        .contains("search.json"));
    // not JSON, no schema
    assert!(import(&dir, &frame(&[("search.json", b"{")])).is_err());
    assert!(import(&dir, &frame(&[("search.json", b"{}")])).is_err());
    // a newer schema: refused, with a message
    let err = import(&dir, &frame(&[("search.json", br#"{"schema":2}"#)])).unwrap_err();
    assert!(
        err.contains("newer version of ProSE") && err.contains("schema 2"),
        "{err}"
    );
    // nothing is empty
    assert!(import(&dir, &[]).is_err());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
}

#[test]
fn import_refuses_a_damaged_body() {
    let (_tmp, dir) = searches();
    let good = project("x", &[("a", b"hello")]);
    for cut in [1, 5, good.len() - 1] {
        assert!(import(&dir, &good[..cut]).is_err(), "cut at {cut}");
    }
    // a length that exceeds the body
    let mut huge = Vec::new();
    huge.extend_from_slice(&11u32.to_be_bytes());
    huge.extend_from_slice(b"search.json");
    huge.extend_from_slice(&u64::MAX.to_be_bytes());
    assert!(import(&dir, &huge).is_err());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
}

#[test]
fn frames_have_a_fixed_layout() {
    // [u32 BE name length][name][u64 BE data length][data], repeated: the app's encoder makes the same bytes
    assert_eq!(
        frame(&[("ab", b"xyz")]),
        [0, 0, 0, 2, b'a', b'b', 0, 0, 0, 0, 0, 0, 0, 3, b'x', b'y', b'z']
    );
}

#[test]
fn read_chosen_project_serves_any_regular_file() {
    let tmp = TempDir::new("project");
    let good = tmp.write("a.prose", "zip");
    assert_eq!(read_chosen_project(&good).unwrap(), b"zip");
    let upper = tmp.write("B.PROSE", "zip");
    assert!(read_chosen_project(&upper).is_ok());
    // any name: the front end checks what the file holds
    for name in ["a.zip", "project", "a.prose.zip", "Ergebnis ü.txt"] {
        assert_eq!(
            read_chosen_project(&tmp.write(name, "zip")).unwrap(),
            b"zip"
        );
    }
    assert!(
        read_chosen_project(Path::new("a.prose")).is_err(),
        "absolute paths only"
    );
    assert!(read_chosen_project(&tmp.path().join("absent.prose")).is_err());
    fs::create_dir_all(tmp.path().join("dir.prose")).unwrap();
    assert!(read_chosen_project(&tmp.path().join("dir.prose")).is_err());
    assert!(read_chosen_project(&tmp.write("empty.prose", ""))
        .unwrap_err()
        .contains("empty"));
}

#[cfg(unix)]
#[test]
fn read_chosen_project_does_not_follow_a_link() {
    let tmp = TempDir::new("project-link");
    let secret = tmp.write("secret.txt", "not a project");
    let link = tmp.path().join("x.prose");
    std::os::unix::fs::symlink(&secret, &link).unwrap();
    let err = read_chosen_project(&link).unwrap_err();
    assert!(err.contains("not a regular file"), "{err}");
}

#[test]
fn the_sweep_removes_what_an_interrupted_search_left_and_no_finished_search() {
    let (_tmp, dir) = searches();
    saved(&dir, "1-0", "kept");
    // a partial folder of an interrupted search of an older version (no lock file)
    fs::create_dir_all(dir.join("2-0.partial/qpx")).unwrap();
    fs::write(dir.join("2-0.partial/prose.log"), "x").unwrap();
    // a finished folder that never got its record (the app ended as the search finished): the user's
    fs::create_dir_all(dir.join("3-0")).unwrap();
    fs::write(dir.join("3-0/inputs.json"), "x").unwrap();
    // things that are not searches stay
    fs::write(dir.join("loose.txt"), "x").unwrap();
    fs::create_dir_all(dir.join("not an id")).unwrap();
    fs::create_dir_all(dir.join("x.partial.keep")).unwrap();
    fs::create_dir_all(dir.join("not an id.partial")).unwrap();

    // now: the partial folder is younger than the grace and stays
    assert!(sweep(&dir, SystemTime::now(), SWEEP_GRACE).is_empty());
    // later than the grace: the partial folder only
    let later = SystemTime::now() + SWEEP_GRACE + Duration::from_secs(60);
    assert_eq!(sweep(&dir, later, SWEEP_GRACE), ["2-0.partial"]);
    // however much later: a finished search, with or without record, is never swept
    assert!(sweep(&dir, later + SWEEP_GRACE * 1000, SWEEP_GRACE).is_empty());
    assert!(dir.join("3-0/inputs.json").exists());
    assert!(dir.join("1-0/search.json").exists());
    // a loose file and odd names are never touched
    assert!(dir.join("loose.txt").exists());
    assert!(dir.join("not an id").exists());
    assert!(dir.join("x.partial.keep").exists());
    assert!(dir.join("not an id.partial").exists());
    // a missing searches folder is fine
    assert!(sweep(&dir.join("absent"), later, SWEEP_GRACE).is_empty());
}

#[test]
fn a_live_partial_folder_survives_the_sweep() {
    let (_tmp, dir) = searches();
    let live = dir.join("4-0.partial");
    fs::create_dir_all(&live).unwrap();
    // the owner (a search or import of this or another app instance) holds the lock
    let lock = lock_partial(&live).unwrap();
    fs::write(live.join("prose.log"), "x").unwrap();
    // however long ago it was written
    let much_later = SystemTime::now() + SWEEP_GRACE * 1000;
    assert!(sweep(&dir, much_later, SWEEP_GRACE).is_empty());
    assert!(live.join("prose.log").exists());
    drop(lock);
}

#[test]
fn a_partial_folder_whose_owner_is_gone_is_removed() {
    let (_tmp, dir) = searches();
    let stale = dir.join("5-0.partial");
    fs::create_dir_all(&stale).unwrap();
    // locked, then released (the owner ended; the system releases the lock of a process that died)
    drop(lock_partial(&stale).unwrap());
    fs::write(stale.join("prose.log"), "x").unwrap();
    // a lock file that is brand new is not taken for a stale one (the owner may be about to lock it)
    assert!(sweep(&dir, SystemTime::now(), SWEEP_GRACE).is_empty());
    assert!(stale.exists());
    // a few seconds later it is, whatever the grace for finished folders
    let later = SystemTime::now() + Duration::from_secs(30);
    assert_eq!(sweep(&dir, later, SWEEP_GRACE), ["5-0.partial"]);
    assert!(!stale.exists());
}

#[test]
fn the_lock_file_never_belongs_to_a_search_or_a_project() {
    let (_tmp, dir) = searches();
    // finishing a partial folder removes the lock file, then renames
    let partial = dir.join("8-0.partial");
    fs::create_dir_all(&partial).unwrap();
    let lock = lock_partial(&partial).unwrap();
    assert!(partial.join(LOCK_FILE).exists());
    fs::write(partial.join("a.txt"), "x").unwrap();
    finish_partial(Some(lock), &partial, &dir.join("8-0")).unwrap();
    assert!(!dir.join("8-0").join(LOCK_FILE).exists());
    assert!(dir.join("8-0/a.txt").exists());
    // a lock file in a folder is not one of its project's files
    fs::write(dir.join("8-0").join(LOCK_FILE), "").unwrap();
    let names: Vec<String> = folder_files(&dir, "8-0")
        .unwrap()
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(names, ["a.txt"]);
    // an import leaves none, and a project that names one is refused
    let id = import(&dir, &project("x", &[("a.txt", b"x")])).unwrap();
    assert!(!dir.join(&id).join(LOCK_FILE).exists());
    assert!(import(&dir, &project("x", &[(".lock", b"")]))
        .unwrap_err()
        .contains("not a plain"));
}

#[test]
fn the_sweep_spares_an_old_partial_folder_that_was_just_written() {
    let (_tmp, dir) = searches();
    // a partial folder of an older version (no lock file) whose own time is old but whose log was written a
    // moment ago (a long search of another instance that is still running)
    fs::create_dir_all(dir.join("3-0.partial")).unwrap();
    fs::write(dir.join("3-0.partial/prose.log"), "x").unwrap();
    let old = SystemTime::now() - Duration::from_secs(3600);
    set_folder_modified(&dir.join("3-0.partial"), old);
    assert!(sweep(&dir, SystemTime::now(), SWEEP_GRACE).is_empty());
    // and one whose log is old too goes
    fs::File::options()
        .write(true)
        .open(dir.join("3-0.partial/prose.log"))
        .unwrap()
        .set_modified(old)
        .unwrap();
    assert_eq!(sweep(&dir, SystemTime::now(), SWEEP_GRACE), ["3-0.partial"]);
}

#[test]
fn an_import_in_progress_holds_its_lock() {
    // (the import's partial folder is locked from its creation to its rename: see import's code; here
    // the outcome: nothing of a finished import is locked or left)
    let (_tmp, dir) = searches();
    let id = import(&dir, &project("x", &[("a.txt", b"x")])).unwrap();
    assert!(sweep(&dir, SystemTime::now() + SWEEP_GRACE * 10, SWEEP_GRACE).is_empty());
    assert!(dir.join(&id).join("search.json").exists());
}

#[cfg(unix)]
#[test]
fn the_sweep_does_not_follow_links() {
    let (tmp, dir) = searches();
    let outside = tmp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep"), "x").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("5-0.partial")).unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("6-0")).unwrap();
    let later = SystemTime::now() + SWEEP_GRACE * 2;
    sweep(&dir, later, SWEEP_GRACE);
    assert!(outside.join("keep").exists());
}

#[test]
fn names_are_checked_on_save_and_import() {
    let (_tmp, dir) = searches();
    fs::create_dir_all(dir.join("1-0")).unwrap();
    let long = "x".repeat(201);
    assert!(save_record(&dir, "1-0", &record("1-0", &long))
        .unwrap_err()
        .contains("at most 200"));
    assert!(save_record(&dir, "1-0", &record("1-0", "a\\u0007b"))
        .unwrap_err()
        .contains("one line"));
    assert!(save_record(&dir, "1-0", &record("1-0", "   ")).is_err());
    assert!(!dir.join("1-0/search.json").exists());
    // a name with spaces around is kept trimmed
    save_record(&dir, "1-0", &record("1-0", "  padded  ")).unwrap();
    assert_eq!(json(&dir.join("1-0/search.json"))["name"], "padded");

    // a project's record with such a name is refused, nothing written
    let json_with = |name: &str| {
        format!(
            r#"{{"schema":1,"id":"x","name":{}}}"#,
            serde_json::to_string(name).unwrap()
        )
    };
    for name in [long.as_str(), "two\nlines", ""] {
        let body = frame(&[("search.json", json_with(name).as_bytes())]);
        assert!(import(&dir, &body).is_err(), "{name:?}");
    }
    let body = frame(&[("search.json", json_with("  ok  ").as_bytes())]);
    let id = import(&dir, &body).unwrap();
    assert_eq!(json(&dir.join(&id).join("search.json"))["name"], "ok");
    assert_eq!(
        fs::read_dir(&dir).unwrap().count(),
        2,
        "no partial folder is left"
    );
}

#[test]
fn an_imported_search_is_marked() {
    let (_tmp, dir) = searches();
    // whatever the project says
    let body = frame(&[(
        "search.json",
        br#"{"schema":1,"id":"x","name":"n","imported":false}"#,
    )]);
    let id = import(&dir, &body).unwrap();
    assert_eq!(json(&dir.join(&id).join("search.json"))["imported"], true);
    // a rename keeps the mark
    rename(&dir, &id, "renamed").unwrap();
    assert_eq!(json(&dir.join(&id).join("search.json"))["imported"], true);
    // a search of this app is not marked
    saved(&dir, "1-0", "mine");
    assert!(json(&dir.join("1-0/search.json")).get("imported").is_none());
}

#[test]
fn with_backoff_retries_what_passes_and_nothing_else() {
    let denied = || io::Error::from(io::ErrorKind::PermissionDenied);
    // a file held open for a moment (Windows): it works on the third try
    let mut tries = 0;
    let started = std::time::Instant::now();
    let result = with_backoff(|| {
        tries += 1;
        if tries < 3 {
            Err(denied())
        } else {
            Ok(tries)
        }
    });
    assert_eq!(result.unwrap(), 3);
    assert!(
        started.elapsed() >= Duration::from_millis(30),
        "10 + 20 ms waited"
    );
    // one that stays: given up after BACKOFF_TRIES tries, with the last error
    let mut tries = 0;
    let err = with_backoff(|| -> io::Result<()> {
        tries += 1;
        Err(denied())
    })
    .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(tries, BACKOFF_TRIES);
    // an error that does not pass is not retried
    let mut tries = 0;
    let err = with_backoff(|| -> io::Result<()> {
        tries += 1;
        Err(io::Error::from(io::ErrorKind::NotFound))
    })
    .unwrap_err();
    assert_eq!((err.kind(), tries), (io::ErrorKind::NotFound, 1));
}

/// Another app instance's sweep has the lock file open while the owner finishes (on Windows the deleted
/// file then stays pending in the folder, and the folder cannot be renamed, until that handle is closed).
#[test]
fn finish_partial_waits_for_a_lock_file_that_another_sweep_holds_open() {
    let (_tmp, dir) = searches();
    let partial = dir.join("9-0.partial");
    fs::create_dir_all(&partial).unwrap();
    let lock = lock_partial(&partial).unwrap();
    fs::write(partial.join("inputs.json"), "x").unwrap();
    // the sweep's handle (it opens the file, fails to take the lock, and closes it again)
    let sweeper = fs::File::options()
        .read(true)
        .write(true)
        .open(partial.join(LOCK_FILE))
        .unwrap();
    assert!(sweeper.try_lock().is_err(), "the owner holds the lock");
    let closer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        drop(sweeper);
    });
    finish_partial(Some(lock), &partial, &dir.join("9-0")).unwrap();
    closer.join().unwrap();
    assert!(!partial.exists());
    assert!(dir.join("9-0/inputs.json").is_file());
    assert!(!dir.join("9-0").join(LOCK_FILE).exists());
}

/// The sweep and a cancelled search remove a partial folder whose lock file is open and locked (the
/// sweep holds the lock it claimed; the search its own). That has to work on Windows too.
#[test]
fn a_partial_folder_is_removed_while_its_lock_is_held() {
    let (_tmp, dir) = searches();
    // std's remove_dir_all, with the lock held by the remover
    let partial = dir.join("10-0.partial");
    fs::create_dir_all(partial.join("qpx")).unwrap();
    let lock = lock_partial(&partial).unwrap();
    fs::write(partial.join("qpx/a.psm.parquet"), "x").unwrap();
    fs::remove_dir_all(&partial).unwrap();
    assert!(!partial.exists());
    drop(lock);
    // remove_partial, with the lock held by the remover and the lock file open in another handle
    let partial = dir.join("11-0.partial");
    fs::create_dir_all(partial.join("qpx")).unwrap();
    let lock = lock_partial(&partial).unwrap();
    let other = fs::File::open(partial.join(LOCK_FILE)).unwrap();
    let closer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        drop(other);
    });
    remove_partial(Some(lock), &partial).unwrap();
    closer.join().unwrap();
    assert!(!partial.exists());
    // a folder that is gone already is fine
    remove_partial(None, &partial).unwrap();
}
