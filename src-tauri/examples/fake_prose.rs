//! A stand-in for the ProSE tool in the shim's tests, as an executable: what `tests/fake-prose.sh` does,
//! for Windows (where a shell script cannot be started as a program) and for any platform with
//! `PROSE_FAKE_EXE=1` (`tests/common/mod.rs`). `cargo test` builds it (examples are built with the tests).
//!
//! It reads the same arguments, prints progress lines in ProSE's format and writes a few outputs. What
//! it does is chosen by the stem of the first input (after the shim's "<n>__"):
//!
//!   hang      prints the first step, starts two child processes and waits for them
//!   stubborn  as hang, but ignores SIGTERM (children too; Unix): only SIGKILL ends it
//!   crash     prints two steps, writes a message to stderr and exits with code 3
//!   segv      prints a step and a line to stderr, then crashes: SIGSEGV (Unix), an access violation's
//!             status 0xC0000005 (Windows)
//!   <other>   searches every input and exits 0
//!
//! Next to the -out_qpx folder it leaves argv.txt (one argument per line), inputs.txt (every -in path with
//! the file it resolves to), prose.pid and, for hang and stubborn, children.pid; in it, a psm file per input
//! (in runs/) and quantms.psm.parquet (stand-ins: not Parquet). `--help` prints a version line; `--sleep` (the children)
//! sleeps five minutes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};
use std::time::Duration;

#[cfg(unix)]
fn ignore_sigterm() {
    extern "C" {
        fn signal(signum: std::os::raw::c_int, handler: usize) -> usize;
    }
    const SIGTERM: std::os::raw::c_int = 15;
    const SIG_IGN: usize = 1;
    // SAFETY: setting a signal's disposition to "ignore" has no memory effects; it is inherited by the
    // children (exec keeps ignored signals ignored).
    unsafe { signal(SIGTERM, SIG_IGN) };
}

#[cfg(not(unix))]
fn ignore_sigterm() {}

/// Ends the process as a crash does: SIGSEGV.
#[cfg(unix)]
fn crash() -> ! {
    extern "C" {
        fn signal(signum: std::os::raw::c_int, handler: usize) -> usize;
        fn raise(signum: std::os::raw::c_int) -> std::os::raw::c_int;
    }
    const SIGSEGV: std::os::raw::c_int = 11;
    const SIG_DFL: usize = 0;
    // SAFETY: the default action (Rust's runtime has a handler of its own for SIGSEGV), then raise(3): the
    // signal ends the process; neither call has memory effects.
    unsafe {
        signal(SIGSEGV, SIG_DFL);
        raise(SIGSEGV);
    }
    exit(139);
}

/// Ends the process with the status of an access violation, as Windows ends a crashed process.
#[cfg(not(unix))]
fn crash() -> ! {
    exit(0xC000_0005_u32 as i32);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--sleep") {
        std::thread::sleep(Duration::from_secs(300));
        exit(0);
    }
    if args.iter().any(|a| a == "--help") {
        println!("ProSE -- a stand-in for the shim's tests");
        println!("Version: 9.9.9 Oct 20 2026, 12:00:00");
        exit(0);
    }

    let mut inputs: Vec<String> = Vec::new();
    let mut qpx: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-in" => {
                i += 1;
                while i < args.len() && !args[i].starts_with('-') {
                    inputs.push(args[i].clone());
                    i += 1;
                }
                continue;
            }
            "-out_qpx" => qpx = args.get(i + 1).map(PathBuf::from),
            _ => {}
        }
        i += 1;
    }

    let Some(qpx) = qpx else {
        eprintln!("fake-prose: no -out_qpx");
        exit(2);
    };
    let out = qpx.parent().unwrap_or(Path::new(".")).to_path_buf();
    fs::create_dir_all(&out).unwrap();
    fs::write(
        out.join("argv.txt"),
        args.iter().map(|a| format!("{a}\n")).collect::<String>(),
    )
    .unwrap();
    fs::write(out.join("prose.pid"), format!("{}\n", std::process::id())).unwrap();
    let mut resolved = String::new();
    for f in &inputs {
        let Ok(real) = fs::canonicalize(f) else {
            eprintln!("Error: the input {f} does not exist");
            exit(6);
        };
        resolved.push_str(&format!("{f} -> {}\n", real.display()));
    }
    fs::write(out.join("inputs.txt"), resolved).unwrap();

    let base = |f: &str| {
        Path::new(f)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let first = inputs.first().map(|f| base(f)).unwrap_or_default();
    let first = first
        .split_once("__")
        .map_or(first.as_str(), |(_, rest)| rest);
    let stem = first.split('.').next().unwrap_or("");
    let count = inputs.len();
    let say = |line: String| {
        let mut stdout = std::io::stdout();
        let _ = writeln!(stdout, "{line}");
        let _ = stdout.flush();
    };

    match stem {
        "hang" | "stubborn" => {
            if stem == "stubborn" {
                ignore_sigterm();
            }
            say(format!("[ProSE] [1/{count}] Searching {}", inputs[0]));
            let me = std::env::current_exe().unwrap();
            let mut children = Vec::new();
            let mut pids = String::new();
            for _ in 0..2 {
                let child = Command::new(&me).arg("--sleep").spawn().unwrap();
                pids.push_str(&format!("{}\n", child.id()));
                children.push(child);
            }
            fs::write(out.join("children.pid"), pids).unwrap();
            for mut child in children {
                let _ = child.wait();
            }
            exit(0);
        }
        "crash" => {
            say(format!("[ProSE] [1/{count}] Searching {}", inputs[0]));
            say("[ProSE] Rescoring the PSMs with Percolator...".to_string());
            eprintln!("Schema error: Trying to register schema with name Abs");
            eprintln!("Error: Unable to read file (the input broke {})", inputs[0]);
            exit(3);
        }
        "diskfull" => {
            // ProSE's lines of a full disk, its outputs in the search folder (fake-prose.sh: diskfull)
            say(format!("[ProSE] [1/{count}] Searching {}", inputs[0]));
            let psm = format!("{}/runs/{stem}.psm.parquet", qpx.display());
            eprintln!("ArrowIOHelpers: Failed to write {psm}: IOError: Error writing bytes to file. Detail: [errno 28] No space left on device");
            eprintln!("Failed to write the QPX psm view -> {psm}");
            eprintln!("ProSE finished with 1 file(s) failing out of 1.");
            exit(12);
        }
        "segv" => {
            say(format!("[ProSE] [1/{count}] Searching {}", inputs[0]));
            eprintln!("Reading {} ...", inputs[0]);
            crash();
        }
        _ => {}
    }

    fs::create_dir_all(qpx.join("runs")).unwrap();
    for (k, f) in inputs.iter().enumerate() {
        say(format!("[ProSE] [{}/{count}] Searching {f}", k + 1));
        say("[ProSE] Rescoring the PSMs with Percolator...".to_string());
        let name = base(f);
        let name = name.strip_suffix(".gz").unwrap_or(&name);
        let name = name.strip_suffix(".mzML").unwrap_or(name);
        fs::write(qpx.join("runs").join(format!("{name}.psm.parquet")), "psm\n").unwrap();
    }
    fs::write(qpx.join("quantms.psm.parquet"), "psm\n").unwrap();
    say("[ProSE] ===================== Search Report =====================".to_string());
    exit(0);
}
