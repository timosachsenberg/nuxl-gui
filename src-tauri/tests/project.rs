//! Project files: a search folder written as a zip entry by entry (`project`), read back here as the front
//! end reads it: the central directory, then each entry's local header and data (stored or deflated, its CRC).
//! The zip of the fixture folder below is `src/lib/history/fixtures/rust-project.prose`, which the front end's
//! tests open with `unpackProject` (fflate): the round trip. `PROSE_WRITE_FIXTURES=1 cargo test --test project`
//! writes it again after a change of the writer.

mod common;

use common::TempDir;
use flate2::read::DeflateDecoder;
use prose_desktop_lib::history::save_record;
use prose_desktop_lib::project::{
    dos_time, project_files, without_paths, write_project, ZipWriter, INPUTS, RECORD,
};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 2026-10-24 12:34:56 UTC: the time of the fixture's entries.
fn fixture_time() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_792_845_296)
}

/// A saved search folder as the app keeps it, with what a project leaves out.
fn folder(dir: &Path, id: &str) {
    let folder = dir.join(id);
    fs::create_dir_all(folder.join("qpx/runs")).unwrap();
    fs::create_dir_all(folder.join("mods")).unwrap();
    // (Parquet: stored; text: deflated)
    let parquet: Vec<u8> = (0..5000u32)
        .flat_map(|i| (i * 7919).to_le_bytes())
        .collect();
    fs::write(folder.join("qpx/quantms.psm.parquet"), &parquet).unwrap();
    fs::write(folder.join("qpx/runs/1__a.mz.parquet"), b"PAR1 mz PAR1").unwrap();
    fs::write(
        folder.join("proteins.fasta"),
        ">P1 first protein\nPEPTIDEKPEPTIDEKPEPTIDEK\n".repeat(50),
    )
    .unwrap();
    fs::write(
        folder.join("mods/1__a_PTMStats.tsv"),
        "name\tcount\nOxidation\t3\n",
    )
    .unwrap();
    fs::write(folder.join("empty.txt"), "").unwrap();
    fs::write(
        folder.join(INPUTS),
        r#"[{"id":"f1","name":"a.mzML","path":"/home/me/runs/a.mzML"},{"id":"f2","path":"C:\\data\\b.mzML"}]"#,
    )
    .unwrap();
    // left out: the database copy, its path, the log
    fs::write(folder.join("database.fasta"), ">P1\nPEPTIDEK\n").unwrap();
    fs::write(
        folder.join("database.json"),
        r#"{"path":"/home/me/db.fasta"}"#,
    )
    .unwrap();
    fs::write(folder.join("prose.log"), "ProSE -in /home/me/runs/a.mzML").unwrap();
    let record = format!(
        r#"{{"schema":1,"id":"{id}","name":"Fixture","createdAt":"2026-10-24T12:34:56.000Z","appVersion":"0.1.3","toolVersion":"3.7.0","files":["a.mzML","b.mzML"],"database":"db.fasta","psms":2,"psmFdr":0.01,"proteinFdr":0.01,"seconds":1,"design":{{"rows":[],"samples":[],"conditions":[]}},"settings":{{"parameters":{{}},"fixedMods":[],"rescore":true,"peptdeep":false,"contaminants":true}}}}"#
    );
    save_record(dir, id, &record).unwrap();
}

struct Unzipped {
    name: String,
    method: u16,
    data: Vec<u8>,
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(b[at..at + 2].try_into().unwrap())
}
fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

/// The entries of a zip, read as the front end does: the end record, the central directory, each entry's
/// local header and data, its size and CRC checked; no zip64, no data descriptor, UTF-8 names.
fn unzip(bytes: &[u8]) -> Vec<Unzipped> {
    let eocd = bytes.len() - 22;
    assert_eq!(
        u32_at(bytes, eocd),
        0x0605_4b50,
        "the end record ends the file (no comment)"
    );
    let count = u16_at(bytes, eocd + 10) as usize;
    let size = u32_at(bytes, eocd + 12) as usize;
    let start = u32_at(bytes, eocd + 16) as usize;
    assert_eq!(start + size, eocd);
    let mut at = start;
    let mut out = Vec::new();
    for _ in 0..count {
        assert_eq!(u32_at(bytes, at), 0x0201_4b50);
        assert_eq!(
            u16_at(bytes, at + 4) >> 8,
            0,
            "made on MS-DOS: no Unix modes, no links"
        );
        let flags = u16_at(bytes, at + 8);
        assert_eq!(
            flags, 0x0800,
            "a UTF-8 name, no data descriptor, no encryption"
        );
        let method = u16_at(bytes, at + 10);
        let crc = u32_at(bytes, at + 16);
        let compressed = u32_at(bytes, at + 20) as usize;
        let length = u32_at(bytes, at + 24) as usize;
        let name_length = u16_at(bytes, at + 28) as usize;
        assert_eq!(u16_at(bytes, at + 30), 0, "no extra field");
        let offset = u32_at(bytes, at + 42) as usize;
        let name = String::from_utf8(bytes[at + 46..at + 46 + name_length].to_vec()).unwrap();
        // the local header says the same
        assert_eq!(u32_at(bytes, offset), 0x0403_4b50);
        assert_eq!(u16_at(bytes, offset + 6), flags);
        assert_eq!(u16_at(bytes, offset + 8), method);
        assert_eq!(u32_at(bytes, offset + 14), crc);
        assert_eq!(u32_at(bytes, offset + 18) as usize, compressed);
        assert_eq!(u32_at(bytes, offset + 22) as usize, length);
        assert_eq!(u16_at(bytes, offset + 26) as usize, name_length);
        let data_at = offset + 30 + name_length + u16_at(bytes, offset + 28) as usize;
        let raw = &bytes[data_at..data_at + compressed];
        let data = match method {
            0 => raw.to_vec(),
            8 => {
                let mut data = Vec::new();
                DeflateDecoder::new(raw).read_to_end(&mut data).unwrap();
                data
            }
            other => panic!("method {other}"),
        };
        assert_eq!(data.len(), length, "{name}");
        assert_eq!(crc32fast::hash(&data), crc, "{name}");
        out.push(Unzipped { name, method, data });
        at += 46 + name_length;
    }
    out
}

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/history/fixtures/rust-project.prose")
}

#[test]
fn a_project_is_the_folder_as_a_zip_written_entry_by_entry() {
    let tmp = TempDir::new("project");
    let dir = tmp.path().join("searches");
    folder(&dir, "1-0");
    let target = tmp.path().join("out/Fixture.prose");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let mut reports = Vec::new();
    write_project(
        &dir,
        "1-0",
        &target,
        fixture_time(),
        &mut |written, total| reports.push((written, total)),
    )
    .unwrap();
    let bytes = fs::read(&target).unwrap();
    // nothing else is left beside it
    assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);

    let entries = unzip(&bytes);
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    // the record first, the others by name; without the database copy, its path and the log
    assert_eq!(
        names,
        [
            RECORD,
            "empty.txt",
            INPUTS,
            "mods/1__a_PTMStats.tsv",
            "proteins.fasta",
            "qpx/quantms.psm.parquet",
            "qpx/runs/1__a.mz.parquet"
        ]
    );
    let get = |name: &str| entries.iter().find(|e| e.name == name).unwrap();
    // the files as they are; Parquet stored, the rest deflated
    for e in &entries {
        if e.name != INPUTS {
            assert_eq!(
                e.data,
                fs::read(dir.join("1-0").join(&e.name)).unwrap(),
                "{}",
                e.name
            );
        }
        assert_eq!(
            e.method,
            if e.name.ends_with(".parquet") { 0 } else { 8 },
            "{}",
            e.name
        );
    }
    assert!(bytes.len() < 20_000 + 2_500, "proteins.fasta is deflated");
    // the searched files by name only
    let inputs: serde_json::Value = serde_json::from_slice(&get(INPUTS).data).unwrap();
    assert_eq!(inputs[0]["path"], "a.mzML");
    assert_eq!(inputs[0]["id"], "f1");
    assert_eq!(inputs[1]["path"], "b.mzML");
    // the progress: up to the total of the files, never back
    let total = reports[0].1;
    assert!(reports
        .windows(2)
        .all(|w| w[0].0 <= w[1].0 && w[1].1 == total));
    assert_eq!(reports.last().unwrap().0, total);

    // the front end's round trip reads this zip (history.test.ts): it is the fixture
    if std::env::var_os("PROSE_WRITE_FIXTURES").is_some() {
        fs::write(fixture_path(), &bytes).unwrap();
    }
    assert!(
        fs::read(fixture_path()).unwrap() == bytes,
        "the writer changed: PROSE_WRITE_FIXTURES=1 cargo test --test project writes {} again",
        fixture_path().display()
    );
}

#[test]
fn a_project_is_refused_before_anything_is_written() {
    let tmp = TempDir::new("project-refused");
    let dir = tmp.path().join("searches");
    // a folder without record: not saved, so no project
    fs::create_dir_all(dir.join("2-0/qpx")).unwrap();
    fs::write(dir.join("2-0/qpx/x.parquet"), "x").unwrap();
    let message = project_files(&dir, "2-0").unwrap_err();
    assert!(message.contains("not saved to History"), "{message}");
    let target = tmp.path().join("x.prose");
    assert!(write_project(&dir, "2-0", &target, fixture_time(), &mut |_, _| {}).is_err());
    assert!(!target.exists());
    // no such search, or not a search
    assert!(project_files(&dir, "9-9").is_err());
    assert!(project_files(&dir, "../searches").is_err());
}

#[test]
fn a_project_that_cannot_be_made_leaves_nothing_and_keeps_what_was_there() {
    let tmp = TempDir::new("project-failed");
    let dir = tmp.path().join("searches");
    folder(&dir, "1-0");
    fs::write(dir.join("1-0").join(INPUTS), "{ not a list").unwrap();
    let target = tmp.path().join("old.prose");
    fs::write(&target, "the old project").unwrap();
    let message = write_project(&dir, "1-0", &target, fixture_time(), &mut |_, _| {}).unwrap_err();
    assert!(message.contains("inputs.json cannot be read"), "{message}");
    assert_eq!(fs::read_to_string(&target).unwrap(), "the old project");
    assert_eq!(
        fs::read_dir(tmp.path()).unwrap().count(),
        2,
        "no .part file is left"
    );
    // a folder that cannot be written to
    folder(&dir, "3-0");
    let message = write_project(
        &dir,
        "3-0",
        &tmp.path().join("absent/x.prose"),
        fixture_time(),
        &mut |_, _| {},
    )
    .unwrap_err();
    assert!(message.contains("cannot be written"), "{message}");
}

#[test]
fn inputs_json_names_the_files_without_their_paths() {
    let reduced = without_paths(
        br#"[{"name":"a.mzML","path":"/x/a.mzML","size":3},{"path":"/y/b.mzML.gz"},{"path":"D:\\z\\c.mzML"},{}]"#,
    )
    .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&reduced).unwrap();
    assert_eq!(value[0]["path"], "a.mzML");
    assert_eq!(value[0]["size"], 3);
    assert_eq!(value[1]["path"], "b.mzML.gz");
    assert_eq!(value[2]["path"], "c.mzML");
    assert_eq!(value[3]["path"], "");
    assert!(without_paths(b"{ no")
        .unwrap_err()
        .contains("cannot be read"));
    assert!(without_paths(b"{}").unwrap_err().contains("not a list"));
    assert!(without_paths(b"[1]").unwrap_err().contains("not a list"));
}

#[test]
fn the_entries_have_the_time_of_the_project_in_ms_dos_format() {
    // 2026-10-24 12:34:56
    let (time, date) = dos_time(fixture_time());
    assert_eq!(time, (12 << 11) | (34 << 5) | 28);
    assert_eq!(date, ((2026 - 1980) << 9) | (10 << 5) | 24);
    // a leap day, and the start of the format
    let (_, date) = dos_time(UNIX_EPOCH + Duration::from_secs(951_782_400));
    assert_eq!(date, ((2000 - 1980) << 9) | (2 << 5) | 29);
    assert_eq!(dos_time(UNIX_EPOCH), (0, (1 << 5) | 1));
}

#[test]
fn an_empty_zip_is_a_zip() {
    let zip = ZipWriter::new(Cursor::new(Vec::new()), fixture_time());
    let bytes = zip.finish().unwrap().into_inner();
    assert_eq!(bytes.len(), 22);
    assert!(unzip(&bytes).is_empty());
}
