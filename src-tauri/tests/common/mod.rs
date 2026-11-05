//! Helpers of the shim's integration tests: temporary directories, the fake tool, event collection.
#![allow(dead_code)]

use nuxl_desktop_lib::run::{SearchEvent, Sink};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(label: &str) -> TempDir {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("nuxl-shim-{}-{label}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Writes `contents` to `relative` (creating its folders) and returns the path.
    pub fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The fake tool: `tests/fake-nuxl.sh`, or on Windows (and with `NUXL_FAKE_EXE` set) the same as an
/// executable, `examples/fake_nuxl.rs`.
pub fn fake_nuxl() -> PathBuf {
    if cfg!(windows) || std::env::var_os("NUXL_FAKE_EXE").is_some() {
        fake_nuxl_exe()
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-nuxl.sh")
    }
}

/// The example `fake_nuxl`, which `cargo test` builds with the tests (into `<target>/<profile>/examples`,
/// beside the tests' own `deps` folder).
pub fn fake_nuxl_exe() -> PathBuf {
    let test = std::env::current_exe().unwrap();
    let profile = test.parent().and_then(Path::parent).unwrap();
    let exe = profile
        .join("examples")
        .join(format!("fake_nuxl{}", std::env::consts::EXE_SUFFIX));
    assert!(
        exe.is_file(),
        "{} is missing: run all of `cargo test` (or `cargo build --example fake_nuxl`)",
        exe.display()
    );
    exe
}

/// What [`fake_tools`] puts into its folder beside the fake OpenNuXL.
#[derive(Debug, Clone, Copy, Default)]
pub struct FakeBundle {
    /// `bin/FileConverter`, the fake's stand-in for OpenMS' FileConverter.
    pub converter: bool,
    /// `dotnet/` (a .NET runtime's folder, empty) and `share/OpenMS/openms_thermo_bridge/managed/` (the Thermo
    /// bridge's managed part, empty): the bundle's parts that the tools' environment names.
    pub runtime: bool,
}

/// A folder `dir` laid out as the bundle (`resources/nuxl`): `bin/OpenNuXL` (the fake tool: a link to
/// `tests/fake-nuxl.sh`, or a copy of the fake executable) and what `bundle` asks for beside it (FileConverter: a
/// link of that name to the same script, or a copy of the executable of that name; the fake is the one or the
/// other by the name it is started under). Returns the path of the fake OpenNuXL.
pub fn fake_tools(dir: &Path, bundle: FakeBundle) -> PathBuf {
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let suffix = std::env::consts::EXE_SUFFIX;
    let place = |name: &str| {
        let target = bin.join(format!("{name}{suffix}"));
        let fake = fake_nuxl();
        #[cfg(unix)]
        if fake.extension().is_some_and(|e| e == "sh") {
            std::os::unix::fs::symlink(&fake, &target).unwrap();
            return target;
        }
        // (an executable knows itself by its own path, which a link would resolve to: a copy)
        fs::copy(&fake, &target).unwrap();
        target
    };
    let tool = place("OpenNuXL");
    if bundle.converter {
        place("FileConverter");
    }
    if bundle.runtime {
        fs::create_dir_all(dir.join("dotnet/host/fxr")).unwrap();
        fs::create_dir_all(dir.join("share/OpenMS/openms_thermo_bridge/managed")).unwrap();
    }
    tool
}

/// A Bruker timsTOF `.d` folder at `relative` in `dir` (empty TDF files: the shim reads nothing of them).
pub fn bruker_d(dir: &TempDir, relative: &str) -> PathBuf {
    dir.write(&format!("{relative}/analysis.tdf"), "");
    dir.write(&format!("{relative}/analysis.tdf_bin"), "");
    dir.path().join(relative)
}

/// The `NAME=value` lines a fake tool wrote of its environment (`<stem>.env.txt`).
pub fn env_dump(path: &Path) -> Vec<(String, String)> {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

pub fn fixture(name: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

/// A sink that sends the events to a channel.
pub fn channel_sink() -> (Sink, Receiver<SearchEvent>) {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let sink: Sink = Arc::new(move |event| {
        let _ = tx.lock().unwrap().send(event);
    });
    (sink, rx)
}

/// Receives events until `done` or `failed` (or `timeout`); returns all of them, the terminal one last.
pub fn until_terminal(rx: &Receiver<SearchEvent>, timeout: Duration) -> Vec<SearchEvent> {
    let deadline = Instant::now() + timeout;
    let mut events = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(event) => {
                let terminal = matches!(event, SearchEvent::Done(_) | SearchEvent::Failed(_));
                events.push(event);
                if terminal {
                    return events;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                panic!("no done or failed event within {timeout:?}; got {events:?}")
            }
            Err(RecvTimeoutError::Disconnected) => return events,
        }
    }
}

/// Waits for the first progress event.
pub fn first_progress(rx: &Receiver<SearchEvent>, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(SearchEvent::Progress(p)) if p.label.starts_with("Searching") => return,
            Ok(_) => {}
            Err(e) => panic!("no search progress: {e:?}"),
        }
    }
}

/// Whether a process exists and is not a zombie (a killed child whose parent has not reaped it yet).
#[cfg(target_os = "linux")]
pub fn process_alive(pid: u32) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            let state = stat.rsplit(')').next().unwrap_or("").trim().chars().next();
            !matches!(state, Some('Z') | Some('X'))
        }
        Err(_) => false,
    }
}

/// Whether a process exists and is not a zombie.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn process_alive(pid: u32) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&out.stdout).trim().to_string();
    !state.is_empty() && !state.starts_with('Z')
}

/// Whether a process is running.
#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
}

/// Sets a folder's modification time (Windows opens a folder only with backup semantics).
pub fn set_folder_modified(folder: &Path, time: std::time::SystemTime) {
    let mut options = fs::File::options();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        options.write(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    #[cfg(not(windows))]
    options.read(true);
    options.open(folder).unwrap().set_modified(time).unwrap();
}

pub fn read_pids(file: &Path) -> Vec<u32> {
    fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .collect()
}

/// Waits until `check` holds (polling), for at most `timeout`.
pub fn wait_for(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    check()
}
