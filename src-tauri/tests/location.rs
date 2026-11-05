//! Where the searches are: the app's own searches folder, or a folder the user chose for them; History lists the
//! searches of all of them, and finds a search by its id in them.

mod common;

use common::TempDir;
use nuxl_desktop_lib::history::{
    is_search_folder, list_in, lock_partial, save_record, sweep_in, SWEEP_GRACE,
};
use nuxl_desktop_lib::location::{
    check_folder, choose, use_default, Locations, DEFAULT_FOLDER, SETTINGS_FILE,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

fn record(id: &str) -> String {
    format!(
        r#"{{"schema":1,"id":"{id}","name":"search {id}","createdAt":"2026-10-20T10:00:00.000Z","appVersion":"0.1.0","toolVersion":"3.6.0","files":["a.mzML"],"database":"human.fasta","psms":1,"design":{{}},"settings":{{}}}}"#
    )
}

/// A finished search `id` in the searches folder `dir`, saved to History.
fn saved(dir: &Path, id: &str) {
    let folder = dir.join(id);
    fs::create_dir_all(folder.join("nuxl")).unwrap();
    fs::write(folder.join("inputs.json"), "[]").unwrap();
    save_record(dir, id, &record(id)).unwrap();
}

/// The app's data folder, and an empty folder of the user's beside it.
fn setup() -> (TempDir, PathBuf, PathBuf) {
    let tmp = TempDir::new("location");
    let data = tmp.path().join("app data");
    let mine = tmp.path().join("D drive").join("NuXL searches");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&mine).unwrap();
    (tmp, data, mine)
}

#[test]
fn without_a_choice_the_searches_are_in_the_apps_data_folder() {
    let (_tmp, data, _) = setup();
    let locations = Locations::load(&data);
    assert_eq!(locations.current, data.join(DEFAULT_FOLDER));
    assert_eq!(locations.roots(), [data.join(DEFAULT_FOLDER)]);
    let shown = locations.location();
    assert!(shown.is_default);
    assert_eq!(shown.folder, shown.default_folder);
    // a choice that cannot be read (or is no absolute path) is no choice
    fs::write(data.join(SETTINGS_FILE), "not json").unwrap();
    assert_eq!(Locations::load(&data).current, data.join(DEFAULT_FOLDER));
    fs::write(data.join(SETTINGS_FILE), r#"{"folder":"relative/path"}"#).unwrap();
    assert_eq!(Locations::load(&data).current, data.join(DEFAULT_FOLDER));
}

#[test]
fn an_empty_folder_is_chosen_and_kept() {
    let (_tmp, data, mine) = setup();
    // (what a file manager leaves in an empty folder does not count)
    fs::write(mine.join("desktop.ini"), "x").unwrap();
    fs::write(mine.join(".DS_Store"), "x").unwrap();
    let locations = choose(&data, &mine).unwrap();
    assert_eq!(locations.current, mine);
    let shown = locations.location();
    assert!(!shown.is_default);
    assert_eq!(shown.folder, mine.to_string_lossy());
    // kept: the next start finds it
    assert_eq!(Locations::load(&data), locations);
    // History lists the new folder first, and the app's own
    assert_eq!(locations.roots(), [mine.clone(), data.join(DEFAULT_FOLDER)]);
    // the check left nothing behind
    let mut names: Vec<String> = fs::read_dir(&mine)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, [".DS_Store", "desktop.ini"]);
}

#[test]
fn a_folder_with_other_things_in_it_is_refused() {
    let (_tmp, data, mine) = setup();
    fs::write(mine.join("notes.txt"), "x").unwrap();
    fs::create_dir_all(mine.join("raw_files")).unwrap();
    let e = choose(&data, &mine).unwrap_err();
    assert!(
        e.contains("holds other files or folders (\"notes.txt\", \"raw_files\")"),
        "{e}"
    );
    assert!(e.contains("choose an empty folder"), "{e}");
    // nothing changed
    assert_eq!(Locations::load(&data).current, data.join(DEFAULT_FOLDER));
    assert!(!data.join(SETTINGS_FILE).exists());
}

#[test]
fn a_folder_of_searches_moved_by_hand_is_taken_and_its_searches_listed() {
    let (_tmp, data, mine) = setup();
    saved(&mine, "1-0");
    // (a search that ended without its record is one too)
    fs::create_dir_all(mine.join("2-0")).unwrap();
    fs::write(mine.join("2-0/inputs.json"), "[]").unwrap();
    let locations = choose(&data, &mine).unwrap();
    assert_eq!(locations.root_of("1-0"), mine);
    let ids: Vec<String> = list_in(&mine, false).into_iter().map(|e| e.id).collect();
    assert_eq!(ids, ["1-0", "2-0"]);
}

#[test]
fn a_folder_inside_a_searches_folder_is_refused() {
    let (_tmp, data, _) = setup();
    let own = data.join(DEFAULT_FOLDER);
    let inner = own.join("mine");
    fs::create_dir_all(&inner).unwrap();
    let e = check_folder(&inner, &Locations::load(&data)).unwrap_err();
    assert!(e.contains("is inside the searches folder"), "{e}");
    // nor a relative path
    let e = check_folder(Path::new("relative"), &Locations::load(&data)).unwrap_err();
    assert!(e.contains("not a full path"), "{e}");
}

#[test]
fn history_keeps_listing_the_folders_that_hold_searches() {
    let (tmp, data, mine) = setup();
    let other = tmp.path().join("E drive");
    let empty = tmp.path().join("F drive");
    fs::create_dir_all(&other).unwrap();
    fs::create_dir_all(&empty).unwrap();
    let own = data.join(DEFAULT_FOLDER);
    saved(&own, "1-0");

    choose(&data, &mine).unwrap();
    saved(&mine, "2-0");
    // another folder: the one before holds a search, and stays listed
    let locations = choose(&data, &other).unwrap();
    assert_eq!(locations.previous, vec![mine.clone()]);
    assert_eq!(
        locations.roots(),
        [other.clone(), own.clone(), mine.clone()]
    );
    // each search is found where it is; one that is nowhere: the current folder
    assert_eq!(locations.root_of("1-0"), own);
    assert_eq!(locations.root_of("2-0"), mine);
    assert_eq!(locations.root_of("9-9"), other);
    // a running search's partial folder is found too
    fs::create_dir_all(mine.join("3-0.partial")).unwrap();
    assert_eq!(locations.root_of("3-0"), mine);

    // a folder without searches is not kept when the next one is chosen
    let locations = choose(&data, &empty).unwrap();
    assert_eq!(locations.previous, vec![mine.clone()]);
    // back to the app's own: the folder chosen is listed while it has searches
    saved(&empty, "4-0");
    let locations = use_default(&data).unwrap();
    assert_eq!(locations.current, own);
    assert!(locations.location().is_default);
    assert_eq!(locations.previous, [empty.clone(), mine.clone()]);
    // choosing a listed folder again makes it the current one (listed once)
    let locations = choose(&data, &mine).unwrap();
    assert_eq!(
        locations.roots(),
        [mine.clone(), own.clone(), empty.clone()]
    );
    assert_eq!(Locations::load(&data), locations);
}

#[test]
fn in_a_folder_of_the_users_only_searches_are_listed_and_swept() {
    let (_tmp, _data, mine) = setup();
    saved(&mine, "1-0");
    // what the user put there later: a folder named like an id, one named like no id, a file
    fs::create_dir_all(mine.join("raw_files")).unwrap();
    fs::write(mine.join("raw_files/run.raw"), "x").unwrap();
    fs::create_dir_all(mine.join("my results")).unwrap();
    fs::write(mine.join("notes.txt"), "x").unwrap();
    assert!(is_search_folder(&mine.join("1-0")));
    assert!(!is_search_folder(&mine.join("raw_files")));
    let ids: Vec<String> = list_in(&mine, false).into_iter().map(|e| e.id).collect();
    assert_eq!(ids, ["1-0"]);
    // (the app's own folder lists them, so that they can be deleted)
    assert_eq!(list_in(&mine, true).len(), 3);

    // a partial folder without the app's lock file is never swept there (it is in the app's own folder)
    fs::create_dir_all(mine.join("backup.partial")).unwrap();
    let later = SystemTime::now() + SWEEP_GRACE * 10;
    assert!(sweep_in(&mine, later, SWEEP_GRACE, false).is_empty());
    assert!(mine.join("backup.partial").exists());
    // one whose owner is gone is
    let stale = mine.join("5-0.partial");
    fs::create_dir_all(&stale).unwrap();
    drop(lock_partial(&stale).unwrap());
    let soon = SystemTime::now() + Duration::from_secs(30);
    assert_eq!(sweep_in(&mine, soon, SWEEP_GRACE, false), ["5-0.partial"]);
    assert_eq!(
        sweep_in(&mine, later, SWEEP_GRACE, true),
        ["backup.partial"]
    );
}
