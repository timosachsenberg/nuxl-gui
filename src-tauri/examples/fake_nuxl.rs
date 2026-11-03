//! A stand-in for OpenNuXL in the shim's tests, as an executable: what `tests/fake-nuxl.sh` does, for Windows
//! (where a shell script cannot be started as a program) and for any platform with `NUXL_FAKE_EXE=1`
//! (`tests/common/mod.rs`). `cargo test` builds it (examples are built with the tests).
//!
//! It reads the same arguments (`-in`, `-out`, `-out_tsv`, `-report:xlFDR`, `-percolator_backend`), prints
//! progress lines in the format of OpenMS' ProgressLogger (the percentages after `\r`, without a line end) and
//! OpenNuXL's log lines, and writes the outputs OpenNuXL writes (see `tests/fake-nuxl.sh`). What it does is
//! chosen by the stem of the input (after the shim's "<n>__"):
//!
//!   hang      prints the first step, starts two child processes and waits for them
//!   stubborn  as hang, but ignores SIGTERM (children too; Unix): only SIGKILL ends it
//!   crash     prints two steps, writes OpenMS' error of a file it cannot read to stderr, exits with code 3
//!   segv      prints a step and a line to stderr, then crashes: SIGSEGV (Unix), an access violation's
//!             status 0xC0000005 (Windows)
//!   diskfull  writes OpenMS' error of an output it cannot write, exit code 12
//!   fewpsms   as a search, but "Too few PSMs for score recalibration. Skipped." (stderr), no _perc_ files
//!   <other>   searches the input and exits 0
//!
//! In the search folder (the parent of `<out>`'s folder) it appends a line to inputs.txt (the -in path and the
//! file it resolves to) and leaves tool.pid and, for hang and stubborn, children.pid; beside `<out>` it leaves
//! `<stem>.argv.txt` (one argument per line). `--help` prints OpenMS' version line (to stderr, as TOPPBase
//! does); `--sleep` (the children) sleeps five minutes.

use std::fs;
use std::io::Write;
use std::path::Path;
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

/// Writes to stdout at once (no line end added).
fn out(text: &str) {
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

fn progress(label: &str) {
    out(&format!("Progress of '{label}':\n"));
}

fn done_line() {
    out("\r-- done [took 0.01 s (CPU), 0.01 s (Wall)] -- \n");
}

fn idxml(what: &str, path: &str) {
    fs::write(
        path,
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<IdXML version=\"1.5\"><!-- {what} --></IdXML>\n"),
    )
    .unwrap();
}

/// The peptides and cross-links of `prefix` (`<out without .idXML>_`, or `..._perc_`), for the thresholds.
fn write_fdr_outputs(prefix: &str, thresholds: &[f64]) {
    idxml("peptides", &format!("{prefix}0.0000_peptides.idXML"));
    for q in thresholds {
        idxml("XLs", &format!("{prefix}{q:.4}_XLs.idXML"));
        if *q <= 0.1 {
            fs::write(format!("{prefix}proteins{q:.4}_XLs.tsv"), "protein\tXLs\n").unwrap();
        }
    }
}

/// An option of TOPPBase: `-` and a letter.
fn is_option(arg: &str) -> bool {
    arg.strip_prefix('-')
        .and_then(|rest| rest.chars().next())
        .is_some_and(|c| c.is_ascii_alphabetic())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--sleep") {
        std::thread::sleep(Duration::from_secs(300));
        exit(0);
    }
    if args.iter().any(|a| a == "--help") {
        eprintln!("OpenNuXL -- a stand-in for the shim's tests");
        eprintln!("Version: 9.9.9 Oct 20 2026, 12:00:00");
        exit(0);
    }

    let (mut input, mut output, mut tsv) = (String::new(), String::new(), String::new());
    let mut backend = "builtin".to_string();
    let mut thresholds: Vec<f64> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let value = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "-in" => input = value,
            "-out" => output = value,
            "-out_tsv" => tsv = value,
            "-percolator_backend" => backend = value,
            "-report:xlFDR" => {
                i += 1;
                while i < args.len() && !is_option(&args[i]) {
                    thresholds.push(args[i].parse().unwrap_or(1.0));
                    i += 1;
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    if output.is_empty() {
        eprintln!("Error: The required parameter '-out' was not given or is empty!");
        exit(2);
    }
    let outputs = Path::new(&output).parent().unwrap().to_path_buf();
    let folder = outputs.parent().unwrap().to_path_buf();
    if !outputs.is_dir() {
        eprintln!(
            "Error: Unable to write file (the folder {} does not exist)",
            outputs.display()
        );
        exit(2);
    }
    let base = output.strip_suffix(".idXML").unwrap_or(&output).to_string();
    let stem = Path::new(&base)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    fs::write(
        outputs.join(format!("{stem}.argv.txt")),
        args.iter().map(|a| format!("{a}\n")).collect::<String>(),
    )
    .unwrap();
    fs::write(folder.join("tool.pid"), format!("{}\n", std::process::id())).unwrap();
    let Ok(real) = fs::canonicalize(&input) else {
        eprintln!("Error: File not found (the file '{input}' could not be found)");
        exit(6);
    };
    let mut inputs = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(folder.join("inputs.txt"))
        .unwrap();
    writeln!(inputs, "{input} -> {}", real.display()).unwrap();

    let name = Path::new(&input)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let name = name
        .split_once("__")
        .map_or(name.as_str(), |(_, rest)| rest);
    let mode = name.split('.').next().unwrap_or("");

    match mode {
        "hang" | "stubborn" => {
            if mode == "stubborn" {
                ignore_sigterm();
            }
            progress("loading mzML");
            let me = std::env::current_exe().unwrap();
            let mut children = Vec::new();
            let mut pids = String::new();
            for _ in 0..2 {
                let child = Command::new(&me).arg("--sleep").spawn().unwrap();
                pids.push_str(&format!("{}\n", child.id()));
                children.push(child);
            }
            fs::write(folder.join("children.pid"), pids).unwrap();
            for mut child in children {
                let _ = child.wait();
            }
            exit(0);
        }
        "crash" => {
            out("Running autotune...\n");
            progress("loading mzML");
            eprintln!("Schema error: Trying to register schema with name Abs");
            eprintln!("Error: Unable to read file (the input broke {input})");
            exit(3);
        }
        "diskfull" => {
            progress("Scoring peptide models against spectra...");
            done_line();
            eprintln!("Error: Unable to write file (the file '{base}_1.0000_XLs.idXML' could not be created. writing the file failed (e.g. disk full or I/O error))");
            exit(12);
        }
        "segv" => {
            progress("loading mzML");
            eprintln!("Reading {input} ...");
            crash();
        }
        _ => {}
    }

    out("Running autotune...\n");
    out("autotune: too few non-cross-linked peptides found. Will keep parameters as-is.\n");
    progress("loading mzML");
    done_line();
    for step in [
        "Filtering spectra...",
        "Calculate Nucleotide Tags...",
        "Calculate intensity ranks...",
        "Calculate AA Tags...",
        "Mapping precursors to scan...",
        "Indexing spectra...",
        "Load database from FASTA file...",
        "Generating decoys...",
    ] {
        progress(step);
        done_line();
    }
    progress("Scoring peptide models against spectra...");
    for pct in ["0.00", "33.33", "66.67", "99.99"] {
        out(&format!("\r{pct} %               "));
    }
    done_line();
    for step in [
        "Post-processing PSMs... (spectra filtering)",
        "Post-processing PSMs... (localization of cross-links)",
        "Post-processing PSMs... (annotation)",
    ] {
        progress(step);
        done_line();
    }
    out("Calculating peptide and XL q-values.\n");
    idxml("all", &output);
    write_fdr_outputs(&format!("{base}_"), &thresholds);
    out("done.\n");
    if backend != "none" {
        if mode == "fewpsms" {
            eprintln!("Too few PSMs for score recalibration. Skipped.");
        } else {
            out("Running percolator.\ndone.\n");
            idxml("percolator", &format!("{base}_perc.idXML"));
            if !tsv.is_empty() {
                let perc = format!("{}_perc.tsv", tsv.strip_suffix(".tsv").unwrap_or(&tsv));
                fs::write(perc, "report\tperc\n").unwrap();
            }
            out("Calculating peptide and XL q-values for percolator results.\n");
            write_fdr_outputs(&format!("{base}_perc_"), &thresholds);
            out("done.\n");
        }
    }
    if !tsv.is_empty() {
        fs::write(&tsv, "report\n").unwrap();
    }
    out("OpenNuXL took 0.10 s (wall), 0.10 s (CPU), 0.00 s (system), 0.10 s (user); Peak Memory Usage: 10 MB.\n");
    exit(0);
}
