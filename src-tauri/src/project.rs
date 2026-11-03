//! Project files (`.prose`): a search folder as one zip, written entry by entry from the folder's files
//! straight to the file the user chose (`save_project_file`), so that nothing of it is held in memory and
//! the save dialog comes first. What a project holds is what `src/lib/history/history.ts` describes: the
//! folder's regular files ([`history::folder_files`]) but [`LEFT_OUT`], `search.json` first, and
//! `inputs.json` with the searched files by name only ([`without_paths`]).
//!
//! The zip is the one the front end reads (fflate, `unpackProject`): no zip64 (so at most 4 GiB and 65,535
//! entries; a project holds at most [`MAX_UNPACKED`] anyway), names in UTF-8 (flag bit 11), each entry
//! stored (Parquet, gzip and zstd files are compressed already) or deflated at the quickest level, its
//! sizes and CRC in the local header (written after the data: the file is seekable), no data descriptors,
//! no extra fields.

use crate::files::resolve_search_file;
use crate::history::{folder_files, FolderFile};
use flate2::write::DeflateEncoder;
use flate2::Compression;
use std::fs;
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The record, the first entry of a project.
pub const RECORD: &str = "search.json";
/// The searched files, by name only in a project.
pub const INPUTS: &str = "inputs.json";
/// Files of the folder that a project leaves out: the database copy (`proteins.fasta` has the sequences),
/// the path of a database searched without contaminants, and the tool's log (its first line is the full
/// command line, with paths of this computer).
pub const LEFT_OUT: [&str; 3] = ["database.fasta", "database.json", "prose.log"];
/// The most a project may unpack to (the front end reads it into memory).
pub const MAX_UNPACKED: u64 = 3 * 1024 * 1024 * 1024;
/// The most entries of a zip without zip64.
pub const MAX_ENTRIES: usize = 0xffff;
/// The largest offset or size of a zip without zip64.
const MAX_ZIP: u64 = u32::MAX as u64;

/// Why a search makes no project (the front end says it first, with the sizes: `exportProject`).
pub const TOO_LARGE: &str =
    "This search is too large for a project file: a project file holds at most 3 GB \
     and 65,535 files. The search stays in History on this computer.";

/// Whether a file is stored as it is: compressed already.
fn stored(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".parquet", ".gz", ".zst"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// The files of search `id` that its project holds, in the order of the zip: `search.json` first, the
/// others by name. Refused (with the front end's messages) if the search has no record or is too large.
pub fn project_files(dir: &Path, id: &str) -> Result<Vec<FolderFile>, String> {
    let listed = folder_files(dir, id)?;
    if !listed.iter().any(|f| f.name == RECORD) {
        return Err(format!(
            "The search is not saved to History (it has no {RECORD}), so there is no project to make."
        ));
    }
    let mut kept: Vec<FolderFile> = listed
        .into_iter()
        .filter(|f| !LEFT_OUT.contains(&f.name.as_str()))
        .collect();
    let total: u64 = kept.iter().map(|f| f.size).sum();
    if total > MAX_UNPACKED || kept.len() > MAX_ENTRIES {
        return Err(TOO_LARGE.to_string());
    }
    kept.sort_by(|a, b| (a.name != RECORD, &a.name).cmp(&(b.name != RECORD, &b.name)));
    Ok(kept)
}

/// `inputs.json` as a project holds it: each searched file's `path` replaced by its name (its `name`, else
/// the last part of its path), not where it was on this computer.
pub fn without_paths(inputs: &[u8]) -> Result<Vec<u8>, String> {
    let not_a_list =
        || format!("{INPUTS} is not a list of the searched files, so the project cannot be made.");
    let value: serde_json::Value = serde_json::from_slice(inputs)
        .map_err(|_| format!("{INPUTS} cannot be read, so the project cannot be made."))?;
    let serde_json::Value::Array(records) = value else {
        return Err(not_a_list());
    };
    let mut reduced = Vec::with_capacity(records.len());
    for record in records {
        let serde_json::Value::Object(mut map) = record else {
            return Err(not_a_list());
        };
        let name = match map.get("name").and_then(|n| n.as_str()) {
            Some(name) => name.to_string(),
            None => map
                .get("path")
                .and_then(|p| p.as_str())
                .and_then(|p| p.rsplit(['/', '\\']).next())
                .unwrap_or("")
                .to_string(),
        };
        map.insert("path".to_string(), serde_json::Value::String(name));
        reduced.push(serde_json::Value::Object(map));
    }
    serde_json::to_vec_pretty(&reduced).map_err(|e| e.to_string())
}

/// The MS-DOS time and date of `time` (UTC; 1980 to 2107), as a zip has them.
pub fn dos_time(time: SystemTime) -> (u16, u16) {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rest) = (secs / 86_400, secs % 86_400);
    // the civil date of a day count (Howard Hinnant's days_from_civil, inverted)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    if year < 1980 {
        return (0, (1 << 5) | 1);
    }
    let year = year.min(2107);
    let (h, m, s) = (rest / 3600, rest % 3600 / 60, rest % 60);
    let time = ((h << 11) | (m << 5) | (s / 2)) as u16;
    let date = (((year - 1980) << 9) | (month << 5) | day) as u16;
    (time, date)
}

/// An entry written: what its central directory record needs.
struct Entry {
    name: String,
    method: u16,
    crc: u32,
    compressed: u32,
    size: u32,
    offset: u32,
}

/// A writer that counts what goes through it.
struct Counting<'a, W: Write> {
    inner: &'a mut W,
    count: u64,
}

impl<W: Write> Write for Counting<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.count += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// A zip written entry by entry to a seekable file.
pub struct ZipWriter<W: Write + Seek> {
    out: W,
    entries: Vec<Entry>,
    time: u16,
    date: u16,
}

fn too_large() -> io::Error {
    io::Error::other(TOO_LARGE)
}

fn u32_of(n: u64) -> io::Result<u32> {
    if n >= MAX_ZIP {
        return Err(too_large());
    }
    Ok(n as u32)
}

impl<W: Write + Seek> ZipWriter<W> {
    /// A zip whose entries have the time `time`.
    pub fn new(out: W, time: SystemTime) -> ZipWriter<W> {
        let (time, date) = dos_time(time);
        ZipWriter {
            out,
            entries: Vec::new(),
            time,
            date,
        }
    }

    /// Adds the entry `name` with the bytes of `source`, deflated unless `store`. `read` is called with the
    /// bytes read from `source` so far.
    pub fn add(
        &mut self,
        name: &str,
        source: &mut dyn Read,
        store: bool,
        read: &mut dyn FnMut(u64),
    ) -> io::Result<()> {
        if self.entries.len() >= MAX_ENTRIES || name.len() > u16::MAX as usize {
            return Err(too_large());
        }
        let offset = u32_of(self.out.stream_position()?)?;
        let method: u16 = if store { 0 } else { 8 };
        // the local header, its CRC and sizes written once the data is
        let mut header = Vec::with_capacity(30 + name.len());
        header.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        header.extend_from_slice(&20u16.to_le_bytes()); // version needed: 2.0
        header.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 name
        header.extend_from_slice(&method.to_le_bytes());
        header.extend_from_slice(&self.time.to_le_bytes());
        header.extend_from_slice(&self.date.to_le_bytes());
        header.extend_from_slice(&[0; 12]); // CRC, compressed size, size
        header.extend_from_slice(&(name.len() as u16).to_le_bytes());
        header.extend_from_slice(&0u16.to_le_bytes()); // no extra field
        header.extend_from_slice(name.as_bytes());
        self.out.write_all(&header)?;

        let mut crc = crc32fast::Hasher::new();
        let mut size = 0u64;
        let mut buf = vec![0u8; 1 << 20];
        let compressed = {
            let mut counting = Counting {
                inner: &mut self.out,
                count: 0,
            };
            if store {
                loop {
                    let n = source.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    crc.update(&buf[..n]);
                    size += n as u64;
                    counting.write_all(&buf[..n])?;
                    read(size);
                }
                counting.count
            } else {
                let mut encoder = DeflateEncoder::new(&mut counting, Compression::new(1));
                loop {
                    let n = source.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    crc.update(&buf[..n]);
                    size += n as u64;
                    encoder.write_all(&buf[..n])?;
                    read(size);
                }
                encoder.finish()?;
                counting.count
            }
        };
        let end = self.out.stream_position()?;
        u32_of(end)?;
        let (crc, compressed, size) = (crc.finalize(), u32_of(compressed)?, u32_of(size)?);
        self.out.seek(SeekFrom::Start(u64::from(offset) + 14))?;
        self.out.write_all(&crc.to_le_bytes())?;
        self.out.write_all(&compressed.to_le_bytes())?;
        self.out.write_all(&size.to_le_bytes())?;
        self.out.seek(SeekFrom::Start(end))?;
        self.entries.push(Entry {
            name: name.to_string(),
            method,
            crc,
            compressed,
            size,
            offset,
        });
        Ok(())
    }

    /// Writes the central directory and its end record; returns the writer.
    pub fn finish(mut self) -> io::Result<W> {
        let start = u32_of(self.out.stream_position()?)?;
        for e in &self.entries {
            let mut record = Vec::with_capacity(46 + e.name.len());
            record.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            record.extend_from_slice(&20u16.to_le_bytes()); // made by: 2.0, MS-DOS (no Unix modes, no links)
            record.extend_from_slice(&20u16.to_le_bytes()); // version needed
            record.extend_from_slice(&0x0800u16.to_le_bytes());
            record.extend_from_slice(&e.method.to_le_bytes());
            record.extend_from_slice(&self.time.to_le_bytes());
            record.extend_from_slice(&self.date.to_le_bytes());
            record.extend_from_slice(&e.crc.to_le_bytes());
            record.extend_from_slice(&e.compressed.to_le_bytes());
            record.extend_from_slice(&e.size.to_le_bytes());
            record.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            record.extend_from_slice(&[0; 8]); // extra, comment, disk, internal attributes
            record.extend_from_slice(&0u32.to_le_bytes()); // external attributes
            record.extend_from_slice(&e.offset.to_le_bytes());
            record.extend_from_slice(e.name.as_bytes());
            self.out.write_all(&record)?;
        }
        let end = self.out.stream_position()?;
        let size = u32_of(end - u64::from(start))?;
        u32_of(end)?;
        let count = self.entries.len() as u16;
        let mut record = Vec::with_capacity(22);
        record.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        record.extend_from_slice(&[0; 4]); // this disk, the directory's disk
        record.extend_from_slice(&count.to_le_bytes());
        record.extend_from_slice(&count.to_le_bytes());
        record.extend_from_slice(&size.to_le_bytes());
        record.extend_from_slice(&start.to_le_bytes());
        record.extend_from_slice(&0u16.to_le_bytes()); // no comment
        self.out.write_all(&record)?;
        self.out.flush()?;
        Ok(self.out)
    }
}

/// `<target>.part`: where the project is written before it takes the name the user chose.
fn part_of(target: &Path) -> PathBuf {
    let mut part = target.as_os_str().to_owned();
    part.push(".part");
    PathBuf::from(part)
}

/// Writes the project of search `id` to `target` (the path the user chose), entry by entry, the entries'
/// time `time`; `progress` is told the bytes of the folder's files read so far, and their total. The zip is
/// written as `<target>.part` and renamed when complete, so that a failure leaves nothing (and an existing
/// file at `target` as it was).
pub fn write_project(
    dir: &Path,
    id: &str,
    target: &Path,
    time: SystemTime,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    let files = project_files(dir, id)?;
    let total: u64 = files.iter().map(|f| f.size).sum();
    let part = part_of(target);
    let shown = target.display();
    let written = (|| -> Result<(), String> {
        let file =
            fs::File::create(&part).map_err(|e| format!("{shown} cannot be written ({e})."))?;
        let mut zip = ZipWriter::new(BufWriter::with_capacity(1 << 20, file), time);
        let mut done = 0u64;
        for f in &files {
            let path = resolve_search_file(dir, id, &f.name).map_err(|e| e.message)?;
            let fail = |e: io::Error| {
                if e.to_string() == TOO_LARGE {
                    TOO_LARGE.to_string()
                } else {
                    format!("{} cannot be added to the project ({e}).", f.name)
                }
            };
            let mut read = |n: u64| progress(done + n, total);
            if f.name == INPUTS {
                let bytes = fs::read(&path).map_err(fail)?;
                let reduced = without_paths(&bytes)?;
                zip.add(&f.name, &mut reduced.as_slice(), false, &mut |_| {})
                    .map_err(fail)?;
            } else {
                let mut source = fs::File::open(&path).map_err(fail)?;
                zip.add(&f.name, &mut source, stored(&f.name), &mut read)
                    .map_err(fail)?;
            }
            done += f.size;
            progress(done.min(total), total);
        }
        let out = zip.finish().map_err(|e| {
            if e.to_string() == TOO_LARGE {
                TOO_LARGE.to_string()
            } else {
                format!("{shown} cannot be written ({e}).")
            }
        })?;
        let file = out
            .into_inner()
            .map_err(|e| format!("{shown} cannot be written ({}).", e.error()))?;
        file.sync_all()
            .map_err(|e| format!("{shown} cannot be written ({e})."))?;
        drop(file);
        fs::rename(&part, target).map_err(|e| format!("{shown} cannot be written ({e})."))
    })();
    if written.is_err() {
        let _ = fs::remove_file(&part);
    }
    written
}
