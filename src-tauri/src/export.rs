//! An export with a companion file: the text the user saves where the save dialog says (e.g. a spectral library's
//! TSV), and a second text written beside it under the chosen file's stem and a fixed suffix (its DIA-NN
//! modification declarations: `<stem>_diann_mods.txt`). The page names the suffix, never a path or a folder; the
//! suffix is a plain file name ending ([`valid_suffix`]), so the companion lands in the chosen file's folder.

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

/// Where an export and its companion were written.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Written {
    pub path: String,
    pub companion: String,
}

/// Writes `contents` to `chosen` and `companion` beside it ([`companion_path`]), the export first. A companion that
/// cannot be written says that the export was.
pub fn write_with_companion(
    chosen: &Path,
    contents: &str,
    suffix: &str,
    companion: &str,
) -> Result<Written, String> {
    let beside = companion_path(chosen, suffix)?;
    fs::write(chosen, contents)
        .map_err(|e| format!("{} cannot be written ({e}).", chosen.display()))?;
    fs::write(&beside, companion).map_err(|e| {
        format!(
            "{} was written, but {} cannot be written beside it ({e}).",
            chosen.display(),
            beside.display()
        )
    })?;
    Ok(Written {
        path: chosen.to_string_lossy().into_owned(),
        companion: beside.to_string_lossy().into_owned(),
    })
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

    #[test]
    fn both_files_are_written() {
        let dir = std::env::temp_dir().join(format!("nuxl-export-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let chosen = dir.join("lib.tsv");
        let written =
            write_with_companion(&chosen, "a\tb\n", "_diann_mods.txt", "--mod x,1\n").unwrap();
        assert_eq!(written.path, chosen.to_string_lossy());
        assert_eq!(fs::read_to_string(&chosen).unwrap(), "a\tb\n");
        assert_eq!(
            fs::read_to_string(dir.join("lib_diann_mods.txt")).unwrap(),
            "--mod x,1\n"
        );
        // a bad suffix writes nothing
        let other = dir.join("other.tsv");
        assert!(write_with_companion(&other, "x", "../x.txt", "y").is_err());
        assert!(!other.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
