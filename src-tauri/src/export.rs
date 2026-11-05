//! An export with a companion file: the text the user saves where the save dialog says (e.g. a spectral library's
//! TSV), and a second text written beside it under the chosen file's stem and a fixed suffix (its DIA-NN
//! modification declarations: `<stem>_diann_mods.txt`). The page names the suffix, never a path or a folder; the
//! suffix is a plain file name ending ([`valid_suffix`]), so the companion lands in the chosen file's folder.
//!
//! The save dialog asks before it replaces the chosen file, but knows nothing of the companion: when that exists,
//! nothing is written ([`Saved::CompanionExists`]) and the page asks the user. Replace saves again to the file chosen
//! then, which the shim kept ([`PendingSave`]); the page never names it.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// The longest companion suffix.
const MAX_SUFFIX: usize = 64;

/// A companion suffix: letters, digits, `_`, `-` and `.`, with an extension (`_diann_mods.txt`); not starting
/// with `.`, no `..`, at most [`MAX_SUFFIX`] characters. Nothing of it can name another folder.
pub fn valid_suffix(suffix: &str) -> bool {
    !suffix.is_empty()
        && suffix.len() <= MAX_SUFFIX
        && !suffix.starts_with('.')
        && !suffix.ends_with('.')
        && suffix.contains('.')
        && !suffix.contains("..")
        && suffix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// The companion of the chosen file `chosen`: in its folder, its stem and `suffix` (`lib.tsv` and
/// `_diann_mods.txt`: `lib_diann_mods.txt`).
pub fn companion_path(chosen: &Path, suffix: &str) -> Result<PathBuf, String> {
    if !valid_suffix(suffix) {
        return Err(format!("{suffix:?} is not a file name ending."));
    }
    let stem = chosen
        .file_stem()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{} is not a file.", chosen.display()))?;
    let mut name = stem.to_os_string();
    name.push(suffix);
    Ok(chosen.with_file_name(name))
}

/// What became of an export and its companion: both written, or nothing because the companion exists (the page
/// then asks whether to replace it). Both name the chosen file and the companion.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Saved {
    Written { path: String, companion: String },
    CompanionExists { path: String, companion: String },
}

/// Writes `contents` to `chosen` and `companion` beside it ([`companion_path`]), the export first. Unless `replace`,
/// a companion that exists (a file, a folder, a link) writes nothing: [`Saved::CompanionExists`]. A companion that
/// cannot be written says that the export was.
pub fn write_with_companion(
    chosen: &Path,
    contents: &str,
    suffix: &str,
    companion: &str,
    replace: bool,
) -> Result<Saved, String> {
    let beside = companion_path(chosen, suffix)?;
    let names = || {
        (
            chosen.to_string_lossy().into_owned(),
            beside.to_string_lossy().into_owned(),
        )
    };
    if !replace && fs::symlink_metadata(&beside).is_ok() {
        let (path, companion) = names();
        return Ok(Saved::CompanionExists { path, companion });
    }
    fs::write(chosen, contents)
        .map_err(|e| format!("{} cannot be written ({e}).", chosen.display()))?;
    fs::write(&beside, companion).map_err(|e| {
        format!(
            "{} was written, but {} cannot be written beside it ({e}).",
            chosen.display(),
            beside.display()
        )
    })?;
    let (path, companion) = names();
    Ok(Saved::Written { path, companion })
}

/// The file chosen in the save dialog of an export whose companion exists, kept until the page answers: Replace
/// writes there ([`PendingSave::take`]), any other save forgets it.
#[derive(Debug, Default)]
pub struct PendingSave(std::sync::Mutex<Option<PathBuf>>);

impl PendingSave {
    pub fn set(&self, path: Option<PathBuf>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = path;
    }

    /// The kept file, once.
    pub fn take(&self) -> Option<PathBuf> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suffix_is_a_plain_file_name_ending() {
        for ok in ["_diann_mods.txt", "-mods.txt", "_mods.v2.txt", "a.b"] {
            assert!(valid_suffix(ok), "{ok}");
        }
        for bad in [
            "",
            ".txt",
            "mods",
            "mods.",
            "/x.txt",
            "\\x.txt",
            "../x.txt",
            "_..txt",
            "a/b.txt",
            "a b.txt",
            "C:x.txt",
            "_mods.txt\0",
            "_möds.txt",
            &format!("{}.txt", "x".repeat(MAX_SUFFIX)),
        ] {
            assert!(!valid_suffix(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_companion_is_beside_the_chosen_file_under_its_stem() {
        let dir = Path::new("/home/u/libraries");
        assert_eq!(
            companion_path(&dir.join("run_library.tsv"), "_diann_mods.txt").unwrap(),
            dir.join("run_library_diann_mods.txt")
        );
        // no extension, or several dots: the last extension goes
        assert_eq!(
            companion_path(&dir.join("lib"), "_diann_mods.txt").unwrap(),
            dir.join("lib_diann_mods.txt")
        );
        assert_eq!(
            companion_path(&dir.join("lib.pep0.01.tsv"), "_diann_mods.txt").unwrap(),
            dir.join("lib.pep0.01_diann_mods.txt")
        );
        assert!(companion_path(&dir.join("lib.tsv"), "/../evil.txt").is_err());
        assert!(companion_path(Path::new("/"), "_diann_mods.txt").is_err());
    }

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nuxl-export-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn both_files_are_written() {
        let dir = folder("written");
        let chosen = dir.join("lib.tsv");
        let saved =
            write_with_companion(&chosen, "a\tb\n", "_diann_mods.txt", "--mod x,1\n", false)
                .unwrap();
        assert_eq!(
            saved,
            Saved::Written {
                path: chosen.to_string_lossy().into_owned(),
                companion: dir
                    .join("lib_diann_mods.txt")
                    .to_string_lossy()
                    .into_owned()
            }
        );
        assert_eq!(fs::read_to_string(&chosen).unwrap(), "a\tb\n");
        assert_eq!(
            fs::read_to_string(dir.join("lib_diann_mods.txt")).unwrap(),
            "--mod x,1\n"
        );
        // a bad suffix writes nothing
        let other = dir.join("other.tsv");
        assert!(write_with_companion(&other, "x", "../x.txt", "y", false).is_err());
        assert!(!other.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_existing_companion_writes_nothing_unless_replaced() {
        let dir = folder("exists");
        let chosen = dir.join("lib.tsv");
        let beside = dir.join("lib_diann_mods.txt");
        fs::write(&chosen, "old export").unwrap();
        fs::write(&beside, "old mods").unwrap();
        let saved =
            write_with_companion(&chosen, "new", "_diann_mods.txt", "--mod x,1\n", false).unwrap();
        assert_eq!(
            saved,
            Saved::CompanionExists {
                path: chosen.to_string_lossy().into_owned(),
                companion: beside.to_string_lossy().into_owned()
            }
        );
        assert_eq!(fs::read_to_string(&chosen).unwrap(), "old export");
        assert_eq!(fs::read_to_string(&beside).unwrap(), "old mods");
        // a folder of that name counts, too
        fs::remove_file(&beside).unwrap();
        fs::create_dir(&beside).unwrap();
        assert!(matches!(
            write_with_companion(&chosen, "new", "_diann_mods.txt", "m", false),
            Ok(Saved::CompanionExists { .. })
        ));
        fs::remove_dir(&beside).unwrap();
        fs::write(&beside, "old mods").unwrap();
        // replaced: both written
        assert!(matches!(
            write_with_companion(&chosen, "new", "_diann_mods.txt", "--mod x,1\n", true),
            Ok(Saved::Written { .. })
        ));
        assert_eq!(fs::read_to_string(&chosen).unwrap(), "new");
        assert_eq!(fs::read_to_string(&beside).unwrap(), "--mod x,1\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pending_save_is_taken_once() {
        let pending = PendingSave::default();
        assert_eq!(pending.take(), None);
        pending.set(Some(PathBuf::from("/a/lib.tsv")));
        assert_eq!(pending.take(), Some(PathBuf::from("/a/lib.tsv")));
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn the_outcome_reads_as_the_page_expects() {
        let saved = Saved::CompanionExists {
            path: "/a/lib.tsv".into(),
            companion: "/a/lib_diann_mods.txt".into(),
        };
        assert_eq!(
            serde_json::to_string(&saved).unwrap(),
            r#"{"status":"companionExists","path":"/a/lib.tsv","companion":"/a/lib_diann_mods.txt"}"#
        );
    }
}
