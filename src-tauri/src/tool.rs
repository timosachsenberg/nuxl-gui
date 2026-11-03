//! Finding OpenNuXL, asking it for its version, and building the command that runs it.
//!
//! OpenNuXL rescores with Percolator through another OpenMS tool, `PercolatorAdapter`, which it looks for
//! beside its own executable (`File::findSiblingTOPPExecutable`), then on the PATH. The bundle has both in
//! one `bin/` (`native/scripts/bundle-nuxl.sh`); a tool of a build tree has its sibling there too. OpenMS finds
//! its data (`share/OpenMS`: CHEMISTRY, the NUXL presets) next to the executable, `bin/../share/OpenMS`,
//! which the bundle provides (and whose compiled-in alternatives it rules out), so the app sets no data path.

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What the front end learns of the tool (`tool_info`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub version: String,
    pub path: String,
}

pub const EXE: &str = if cfg!(windows) {
    "OpenNuXL.exe"
} else {
    "OpenNuXL"
};

/// The tool OpenNuXL rescores with, which it expects beside itself.
pub const PERCOLATOR_ADAPTER: &str = if cfg!(windows) {
    "PercolatorAdapter.exe"
} else {
    "PercolatorAdapter"
};

/// The variable that names the tool to use instead of the bundled one (a development build, a test).
pub const TOOL_VARIABLE: &str = "NUXL_TOOL";

/// Where the bundled tool is, below the app's resource directory.
pub fn bundled_tool(resource_dir: &Path) -> PathBuf {
    resource_dir.join("resources/nuxl/bin").join(EXE)
}

/// The Resources folder of the macOS app bundle that `exe` (`<App>.app/Contents/MacOS/<exe>`) really is
/// in: the executable's path with every symbolic link resolved, then `../Resources`, which has to be a
/// folder. (The app's fallback where Tauri names none: `lib.rs`, `resource_dir`.)
pub fn bundle_resources(exe: &Path) -> Option<PathBuf> {
    let real = exe.canonicalize().ok()?;
    let contents = real.parent()?.parent()?;
    let resources = contents.join("Resources").canonicalize().ok()?;
    resources.is_dir().then_some(resources)
}

/// Where the bundled cRAP FASTA is. In development (no bundle yet) the file in the source tree.
pub fn bundled_crap(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let in_bundle = resource_dir.map(|d| d.join("resources/fasta/crap.fasta"));
    let in_source =
        option_env!("CARGO_MANIFEST_DIR").map(|d| Path::new(d).join("resources/fasta/crap.fasta"));
    in_bundle.into_iter().chain(in_source).find(|p| p.is_file())
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}

/// The tool, by the first of: `tool_variable` (the `NUXL_TOOL` variable; if set it has to exist), the
/// bundled tool in `resource_dir`, an `OpenNuXL` on `path_var`.
pub fn resolve_with(
    tool_variable: Option<&OsStr>,
    resource_dir: Option<&Path>,
    path_var: Option<&OsStr>,
) -> Result<PathBuf, String> {
    if let Some(bin) = tool_variable.filter(|b| !b.is_empty()) {
        let path = PathBuf::from(bin);
        return if is_file(&path) {
            Ok(path)
        } else {
            Err(format!(
                "{TOOL_VARIABLE} is set to {}, which is not a file.",
                path.display()
            ))
        };
    }
    if let Some(bundled) = resource_dir.map(bundled_tool).filter(|p| is_file(p)) {
        return Ok(bundled);
    }
    if let Some(found) = path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|d| d.join(EXE))
        .find(|p| is_file(p))
    {
        return Ok(found);
    }
    Err(format!(
        "OpenNuXL was not found: it is not bundled with this app, {TOOL_VARIABLE} is not set and there is no \
         OpenNuXL on the PATH."
    ))
}

pub fn resolve(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    resolve_with(
        std::env::var_os(TOOL_VARIABLE).as_deref(),
        resource_dir,
        std::env::var_os("PATH").as_deref(),
    )
}

/// Whether `PercolatorAdapter` is beside the tool at `path` (where OpenNuXL looks first; else it tries the
/// PATH, and without one a rescoring fails with OpenNuXL's warning "Score recalibration failed.").
pub fn has_percolator_adapter(path: &Path) -> bool {
    path.parent()
        .is_some_and(|bin| bin.join(PERCOLATOR_ADAPTER).is_file())
}

/// Variables of the dynamic loader that would make the bundled tool load other libraries than its own
/// (macOS: they are searched before the bundle's `@rpath`); removed from the tool's environment.
pub const LOADER_VARIABLES: &[&str] = &[
    "DYLD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_INSERT_LIBRARIES",
];

/// The variable that turns off the update check of OpenMS tools, and its value: a tool of a build with
/// the check (CMake's `ENABLE_UPDATE_CHECK`, on by default) otherwise contacts openms-update.cs.uni-tuebingen.de
/// once a day, waits up to 5 s for it when offline, and writes `<tool>.ver` beside the user's OpenMS
/// settings. The bundled tools are built without the check (`native/scripts/build-openms.sh`); the variable
/// covers a tool from `NUXL_TOOL` or the PATH, and the `PercolatorAdapter` OpenNuXL starts (which inherits
/// it). Any value but `OFF` turns the check off.
pub const NO_UPDATE_CHECK: (&str, &str) = ("OPENMS_DISABLE_UPDATE_CHECK", "ON");

/// The command that runs the tool: `OPENBLAS_NUM_THREADS=1` unless the user has set it (Percolator's
/// linear algebra would otherwise start a thread per core inside the tool's own threads), as the
/// FASTag shim does. `openblas` is the variable's current value. Always with [`NO_UPDATE_CHECK`] (a
/// user's `OFF` included: the app makes no network contact). On macOS without the
/// [`LOADER_VARIABLES`]; on Windows without a console window (the app has none to share).
pub fn command_with(path: &Path, openblas: Option<OsString>) -> Command {
    let mut command = Command::new(path);
    command.env(NO_UPDATE_CHECK.0, NO_UPDATE_CHECK.1);
    if openblas.is_none() {
        command.env("OPENBLAS_NUM_THREADS", "1");
    }
    if cfg!(target_os = "macos") {
        for name in LOADER_VARIABLES {
            command.env_remove(name);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn command(path: &Path) -> Command {
    command_with(path, std::env::var_os("OPENBLAS_NUM_THREADS"))
}

/// `text` without the ANSI escape sequences (`ESC [ ... <letter>`) that OpenMS' help may carry (its
/// `Colorizer` makes "Version:" bold when it writes to a terminal).
fn without_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The version in the tool's `--help` (TOPPBase: "Version: 3.7.0-pre-exported-20261020 Oct 20 2026, 22:16:02",
/// with ", Revision: ..." for a build of a git checkout).
pub fn parse_version(help: &str) -> Option<String> {
    without_escapes(help)
        .lines()
        .find_map(|l| l.trim().strip_prefix("Version:").map(str::to_string))
        .and_then(|v| v.split_whitespace().next().map(str::to_string))
}

/// Runs `path --help` and reads the version; fails if the tool does not run or does not say.
pub fn probe(path: &Path) -> Result<ToolInfo, String> {
    let output = command(path)
        .arg("--help")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("OpenNuXL ({}) cannot be run ({e}).", path.display()))?;
    // OpenMS tools print their help to stderr
    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = parse_version(&help).ok_or_else(|| {
        format!(
            "{} did not report a version; is it OpenNuXL of OpenMS?",
            path.display()
        )
    })?;
    Ok(ToolInfo {
        version,
        path: path.to_string_lossy().into_owned(),
    })
}
