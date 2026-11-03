//! Finding the ProSE tool, asking it for its version, and building the command that runs it.

use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

/// What the front end learns of the tool (`tool_info`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub version: String,
    pub path: String,
    /// Whether the tool was built with ONNX Runtime and has the PeptDeep models (see `has_onnx`).
    pub onnx: bool,
}

pub const EXE: &str = if cfg!(windows) { "ProSE.exe" } else { "ProSE" };

/// Where the bundled tool is, below the app's resource directory.
pub fn bundled_tool(resource_dir: &Path) -> PathBuf {
    resource_dir.join("resources/prose/bin").join(EXE)
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

/// The tool, by the first of: `prose_bin` (the `PROSE_BIN` variable; if set it has to exist),
/// the bundled tool in `resource_dir`, a `ProSE` on `path_var`.
pub fn resolve_with(
    prose_bin: Option<&OsStr>,
    resource_dir: Option<&Path>,
    path_var: Option<&OsStr>,
) -> Result<PathBuf, String> {
    if let Some(bin) = prose_bin.filter(|b| !b.is_empty()) {
        let path = PathBuf::from(bin);
        return if is_file(&path) {
            Ok(path)
        } else {
            Err(format!(
                "PROSE_BIN is set to {}, which is not a file.",
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
    Err("The ProSE tool was not found: it is not bundled with this app, PROSE_BIN is not set and there is no ProSE on the PATH.".to_string())
}

pub fn resolve(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    resolve_with(
        std::env::var_os("PROSE_BIN").as_deref(),
        resource_dir,
        std::env::var_os("PATH").as_deref(),
    )
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
/// settings. The bundled tool is built without the check (`native/scripts/build-openms.sh`); the variable
/// covers a tool from `PROSE_BIN` or the PATH. Any value but `OFF` turns the check off.
pub const NO_UPDATE_CHECK: (&str, &str) = ("OPENMS_DISABLE_UPDATE_CHECK", "ON");

/// The command that runs the tool: `OPENBLAS_NUM_THREADS=1` unless the user has set it (Percolator's
/// linear algebra would otherwise start a thread per core inside ProSE's own threads), as the
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

/// The version in the tool's `--help` ("Version: 3.7.0-pre-exported-20261020 Oct 20 2026, 22:16:02").
pub fn parse_version(help: &str) -> Option<String> {
    help.lines()
        .find_map(|l| l.trim().strip_prefix("Version:"))
        .and_then(|v| v.split_whitespace().next())
        .map(str::to_string)
}

/// The build manifest that `native/scripts/bundle-prose.sh` writes into the bundle, beside `bin/`.
pub const MANIFEST: &str = "build.json";

/// The part of the manifest the app reads.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    /// `WITH_ONNX` of the OpenMS build (its CMakeCache), read at packaging time.
    with_onnx: bool,
    /// The PeptDeep models ProSE uses, relative to the manifest's folder.
    #[serde(default)]
    models: Vec<String>,
}

/// Whether the tool can run PeptDeep: its bundle's manifest (`<tool>/../../build.json`) says the build
/// has ONNX Runtime, and the models it names are there (inside the bundle). ProSE reports neither, so a
/// tool without a manifest (a build tree's, one on the PATH) counts as without ONNX.
pub fn has_onnx(path: &Path) -> bool {
    let Some(root) = path.parent().and_then(Path::parent) else {
        return false;
    };
    let Some(manifest) = std::fs::read(root.join(MANIFEST))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
    else {
        return false;
    };
    let inside = |model: &str| {
        Path::new(model)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    };
    manifest.with_onnx
        && !manifest.models.is_empty()
        && manifest
            .models
            .iter()
            .all(|m| inside(m) && root.join(m).is_file())
}

/// Runs `path --help` and reads the version; fails if the tool does not run or does not say.
pub fn probe(path: &Path) -> Result<ToolInfo, String> {
    let output = command(path)
        .arg("--help")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("The ProSE tool {} cannot be run ({e}).", path.display()))?;
    // OpenMS tools print their help to stderr
    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = parse_version(&help).ok_or_else(|| {
        format!(
            "{} did not report a version; is it the ProSE tool?",
            path.display()
        )
    })?;
    Ok(ToolInfo {
        version,
        path: path.to_string_lossy().into_owned(),
        onnx: has_onnx(path),
    })
}
