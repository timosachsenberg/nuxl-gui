//! Where the searches are kept (docs/design.md §2): the searches folder of the app's data, `<app data>/searches`,
//! unless the user chose a folder of their own for them (New search and History: "Change…"), e.g. on a drive with room.
//! The choice is kept in `<app data>/searches-folder.json` ([`SETTINGS_FILE`]):
//! `{ "folder": "<path>", "previous": ["<path>", ...] }`.
//!
//! New searches and opened projects go to the current folder. History lists the searches of every folder the app has
//! kept them in ([`Locations::roots`]): the current one, the app's own, and the folders chosen before that still held
//! searches when another was chosen (`previous`); so a search stays in History wherever it is, and is found by its id
//! in these folders, in that order ([`Locations::root_of`]). A search moved by hand (the app closed) from one of
//! them to another is found there.
//!
//! A folder of the user's is taken only when it is empty or holds searches of the app only ([`check_folder`]), and
//! never one inside another searches folder: History lists what is in a searches folder, and offers to delete it. In a
//! folder of the user's, History lists only the folders that are searches ([`crate::history::is_search_folder`]), and the
//! startup sweep removes only partial folders with the app's lock file: nothing else of it is listed, deleted or swept.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::files::valid_id;
use crate::history::is_search_folder;

/// The file of the choice, in the app's data folder.
pub const SETTINGS_FILE: &str = "searches-folder.json";
/// The app's own searches folder, in its data folder.
pub const DEFAULT_FOLDER: &str = "searches";
/// The most folders chosen before that History keeps listing.
const MAX_PREVIOUS: usize = 16;
/// The file [`check_folder`] writes (and removes again) to see that the folder takes files.
const PROBE: &str = ".nuxl-write-test";

/// The choice as the file keeps it.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    folder: Option<PathBuf>,
    #[serde(default)]
    previous: Vec<PathBuf>,
}

/// Where the searches are: the folder new ones go to, the app's own, and the folders chosen before.
#[derive(Debug, Clone, PartialEq)]
pub struct Locations {
    /// The app's own searches folder (`<app data>/searches`).
    pub default: PathBuf,
    /// Where new searches and opened projects go.
    pub current: PathBuf,
    /// The folders chosen before that held searches when another was chosen, the latest first.
    pub previous: Vec<PathBuf>,
}

/// What the page is told (`searches_location`): where new searches go, whether that is the app's own folder, and the
/// app's own.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub folder: String,
    pub is_default: bool,
    pub default_folder: String,
}

/// Whether `a` and `b` are the same folder: as written, or, when both exist, as the system resolves them (case on
/// Windows and macOS, links).
pub fn same_folder(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Whether `inner` is inside `outer` (not the same folder), as the system resolves them where they exist.
fn inside(inner: &Path, outer: &Path) -> bool {
    let resolve = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (inner, outer) = (resolve(inner), resolve(outer));
    inner != outer && inner.starts_with(&outer)
}

impl Locations {
    /// The choice kept in `data_dir` (the app's data folder). Without one, or one that cannot be read, the app's own
    /// folder; a folder that is not an absolute path is left out.
    pub fn load(data_dir: &Path) -> Locations {
        let default = data_dir.join(DEFAULT_FOLDER);
        let stored: Stored = fs::read(data_dir.join(SETTINGS_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let current = stored
            .folder
            .filter(|f| f.is_absolute())
            .unwrap_or_else(|| default.clone());
        let previous = stored
            .previous
            .into_iter()
            .filter(|p| p.is_absolute())
            .collect();
        Locations {
            default,
            current,
            previous,
        }
    }

    /// Whether `root` is the app's own searches folder (History lists all of it, also what is no search).
    pub fn is_own(&self, root: &Path) -> bool {
        same_folder(root, &self.default)
    }

    /// The folders whose searches History lists: the current one, the app's own, then those chosen before; each once.
    pub fn roots(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = Vec::new();
        let all = [&self.current, &self.default]
            .into_iter()
            .chain(self.previous.iter());
        for root in all {
            if !roots.iter().any(|r| same_folder(r, root)) {
                roots.push(root.clone());
            }
        }
        roots
    }

    /// The searches folder that holds search `id` (its folder, or the partial folder of a running search; also a
    /// folder of the app's own searches folder that History lists as no search, by its name): the first of
    /// [`Locations::roots`] that has it; else the current one (where a search of that id would be, and an error says
    /// that it is not there). The commands check `id` again.
    pub fn root_of(&self, id: &str) -> PathBuf {
        let plain = !id.is_empty() && id != "." && id != ".." && !id.contains(['/', '\\', ':']);
        if plain {
            for root in self.roots() {
                // (a name that is no id is only ever listed in the app's own folder)
                if !valid_id(id) && !self.is_own(&root) {
                    continue;
                }
                let has =
                    |name: &str| fs::symlink_metadata(root.join(name)).is_ok_and(|m| m.is_dir());
                if has(id) || has(&format!("{id}.partial")) {
                    return root;
                }
            }
        }
        self.current.clone()
    }

    /// What the page is told.
    pub fn location(&self) -> Location {
        Location {
            folder: self.current.to_string_lossy().into_owned(),
            is_default: self.is_own(&self.current),
            default_folder: self.default.to_string_lossy().into_owned(),
        }
    }

    /// New searches go to `folder`; the current folder is kept among the previous ones when it holds searches (not the
    /// app's own, which is always listed).
    fn switch_to(&mut self, folder: PathBuf) {
        if same_folder(&folder, &self.current) {
            self.current = folder;
            return;
        }
        let old = std::mem::replace(&mut self.current, folder);
        let current = self.current.clone();
        self.previous
            .retain(|p| !same_folder(p, &current) && !same_folder(p, &old));
        if !self.is_own(&old) && holds_searches(&old) {
            self.previous.insert(0, old);
        }
        self.previous.truncate(MAX_PREVIOUS);
    }

    /// Writes the choice into `data_dir` (through a temporary file: whole or not at all).
    fn save(&self, data_dir: &Path) -> Result<(), String> {
        let stored = Stored {
            folder: (!self.is_own(&self.current)).then(|| self.current.clone()),
            previous: self.previous.clone(),
        };
        let text = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
        let path = data_dir.join(SETTINGS_FILE);
        let tmp = data_dir.join(format!("{SETTINGS_FILE}.tmp"));
        let written = (|| -> io::Result<()> {
            fs::create_dir_all(data_dir)?;
            let mut file = fs::File::create(&tmp)?;
            file.write_all(&text)?;
            file.sync_all()?;
            fs::rename(&tmp, &path)
        })();
        written.map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("The choice of the searches folder cannot be saved ({e}).")
        })
    }
}

/// Whether `folder` holds a search (a finished one, or the partial folder of a running one).
fn holds_searches(folder: &Path) -> bool {
    let Ok(read) = fs::read_dir(folder) else {
        return false;
    };
    read.flatten().any(|item| {
        let name = item.file_name().to_string_lossy().into_owned();
        match name.strip_suffix(".partial") {
            Some(id) => valid_id(id) && item.path().is_dir(),
            None => valid_id(&name) && is_search_folder(&item.path()),
        }
    })
}

/// What the system or a file manager may leave in an empty folder.
fn system_file(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("desktop.ini")
        || name.eq_ignore_ascii_case("Thumbs.db")
}

/// Whether `folder` can be the searches folder ([`Locations::switch_to`]): an existing folder, not inside another
/// searches folder of the app (whose History would list it as no search, and offer to delete it), empty or holding
/// searches of the app only (besides hidden files), and one the app can write in. The app's own folder and those it
/// lists are always fine. Else why not, in words that say what to do.
pub fn check_folder(folder: &Path, locations: &Locations) -> Result<(), String> {
    let shown = folder.display();
    if !folder.is_absolute() {
        return Err(format!("{shown} is not a full path of a folder."));
    }
    let roots = locations.roots();
    if roots.iter().any(|r| same_folder(r, folder)) {
        return Ok(());
    }
    if let Some(root) = roots.iter().find(|r| inside(folder, r)) {
        return Err(format!(
            "{shown} is inside the searches folder {}. Choose a folder outside it.",
            root.display()
        ));
    }
    let read = fs::read_dir(folder).map_err(|e| format!("{shown} cannot be read ({e})."))?;
    let mut foreign: Vec<String> = Vec::new();
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if system_file(&name) {
            continue;
        }
        let ours = match name.strip_suffix(".partial") {
            Some(id) => valid_id(id) && item.path().is_dir(),
            None => valid_id(&name) && is_search_folder(&item.path()),
        };
        if !ours {
            foreign.push(name);
        }
    }
    if !foreign.is_empty() {
        foreign.sort();
        let n = foreign.len();
        let named: Vec<String> = foreign.iter().take(3).map(|f| format!("\"{f}\"")).collect();
        let more = if n > 3 {
            format!(" and {} more", n - 3)
        } else {
            String::new()
        };
        return Err(format!(
            "{shown} holds other files or folders ({}{more}). NuXL keeps its searches in a folder of their own: choose \
             an empty folder (the dialog can make a new one), or one that holds NuXL's searches only.",
            named.join(", ")
        ));
    }
    let probe = folder.join(PROBE);
    fs::write(&probe, b"").map_err(|e| format!("NuXL cannot write in {shown} ({e})."))?;
    let _ = fs::remove_file(&probe);
    Ok(())
}

/// New searches go to `folder` from now on, which [`check_folder`] has to accept; the choice is kept in `data_dir`.
pub fn choose(data_dir: &Path, folder: &Path) -> Result<Locations, String> {
    let mut locations = Locations::load(data_dir);
    check_folder(folder, &locations)?;
    locations.switch_to(folder.to_path_buf());
    locations.save(data_dir)?;
    Ok(locations)
}

/// New searches go to the app's own folder again (the searches of the folder chosen stay in History).
pub fn use_default(data_dir: &Path) -> Result<Locations, String> {
    let mut locations = Locations::load(data_dir);
    let default = locations.default.clone();
    locations.switch_to(default);
    locations.save(data_dir)?;
    Ok(locations)
}
