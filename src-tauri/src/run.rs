//! Running a search: the search folder, the runs of OpenNuXL, their progress, and cancel.
//!
//! A search lives in `<searches>/<id>.partial/` while it runs (design §2). Beside the tool's outputs (in
//! `nuxl/`) it holds
//!
//! - the inputs as links `<n>__<name>` to the user's files (never copies) and `inputs.json`, the
//!   mapping from link to the user's path (see [`crate::args::InputRecord`]). On Windows, where a
//!   symbolic link needs a privilege, OpenNuXL gets the user's paths themselves when the inputs' names
//!   do not clash, and hard links only for those that do, removed again when the search ends
//!   ([`crate::args::InputLinks`]);
//! - `database.fasta`, the user's FASTA with the contaminants and without its own decoys, when the shim writes
//!   one, else `database.json`, the path of the user's FASTA ([`crate::args::plan_database`]);
//! - `nuxl.log`, the tool's output of all runs, each after the line `$ <command line>`;
//! - `nuxl/<stem>.mz.parquet` of each input: the QPX mz view of the MS2 spectra of its PSMs (their peaks filtered),
//!   which OpenNuXL writes with `-out_qpx` into `nuxl/runs/` for the PSM view and the shim moves here when the run has
//!   ended ([`take_mz_view`], [`crate::args::mz_view_output`]);
//! - `nuxl/<stem>.outputs.json` of each input whose run ended successfully ([`InputOutputs`]).
//!
//! The inputs are searched one after the other, one run of OpenNuXL each, by one supervising thread: a run
//! starts when the one before it has ended successfully. A run that fails fails the search (with OpenNuXL's
//! message, the stage and the input); cancel ends the current run and starts no further one. A run whose mz view
//! OpenNuXL could not write (its `-out_qpx:` warning) does not fail the search: the input's `outputs.json` has `mz`
//! null and a note says that the PSM view shows the annotated peaks only.
//!
//! The folder holds `.lock`, locked exclusively (`history::lock_partial`) for as long as the search
//! lives, so that the startup sweep of any app instance can tell a live folder from a stale one.
//!
//! On success the folder is renamed to `<searches>/<id>/` and `done` is sent; on failure or cancel it is
//! removed (a failure sends `failed`, a cancel nothing: `cancel` returns when the process is gone). The
//! log of a failed search is kept, as `<app data>/logs/last-failure.log` ([`LAST_FAILURE_LOG`]; the
//! searches folder's sibling), replacing the one before.
//!
//! Each run of the tool is a process group of its own, started from the supervising thread, which waits for
//! it. Cancel signals the group (SIGTERM, then SIGKILL after a grace period), and the group is swept with
//! SIGKILL after the tool has ended, so nothing it started (PercolatorAdapter) outlives it. If the app dies:
//! - Linux: the tool gets SIGKILL (`PR_SET_PDEATHSIG`; the thread that starts it lives as long as it runs);
//! - Windows: the group is a job object, closed with the app, which ends whatever is still in it (cancel
//!   terminates the job: Windows has no SIGTERM for a console tool);
//! - macOS has no death signal: a watchdog process per run (the app's own executable, started with
//!   `--watch-search`: [`crate::watchdog`]) ends the tool's group within a second of the app's end. Without
//!   it (it could not be started) the tool would end at its next write to stdout or stderr, whose reading
//!   ends died with the app (SIGPIPE, at its default in the child: `Command` resets it, and OpenMS sets no
//!   handler), at the end of its current step; a later start of the app sweeps the folder.

use crate::args::{
    build_search_with, humanize, input_placements, input_records_with, mz_view_output,
    outputs_record, plan_database, write_database, DatabasePlan, InputLinks, InputRecord,
    Placement, SearchRequest, SearchRuns, DATABASE_FILE, DATABASE_RECORD, LOG_FILE, MZ_VIEW_SUFFIX,
    OUTPUT_DIR, QPX_RUNS_DIR,
};
use crate::history::{finish_partial, lock_partial, remove_partial, with_backoff};
use crate::progress::ProgressTracker;
use crate::tool;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a tool gets to end after SIGTERM before it is killed.
const GRACE: Duration = Duration::from_secs(3);
/// How long cancel waits for the kill to take effect.
const KILL_WAIT: Duration = Duration::from_secs(10);
/// How many of the tool's last stderr lines are kept for a failure message.
const STDERR_TAIL: usize = 60;
/// How many of the tool's error lines are kept (the first ones: a cause comes before its consequences).
const ERROR_LINES: usize = 20;
/// The longest line of the tool's output that is read (bytes); the rest of a longer line is dropped (a
/// 300 MB line on stderr was otherwise read whole, logged and sent as an event).
const MAX_LINE: usize = 64 * 1024;
/// The longest line a failure shows (characters).
const MAX_SHOWN: usize = 1000;
/// The most notes of a run ([`note_of`]) kept in its `outputs.json`.
const MAX_NOTES: usize = 20;
/// The log of the last failed search, in the folder `logs` beside the searches folder.
pub const LAST_FAILURE_LOG: &str = "last-failure.log";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub search_id: String,
    pub label: String,
    /// The input of the step (0-based); -1 outside the files.
    pub file: i32,
    pub fraction: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DoneEvent {
    pub search_id: String,
    /// The search folder, `<searches>/<id>`.
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FailedEvent {
    pub search_id: String,
    /// What went wrong: the informative line(s) of the tool's stderr (`StderrDigest::message`), or the
    /// shim's own message; empty when the tool said nothing that explains it.
    pub message: String,
    /// The last progress label.
    pub stage: String,
    /// The input whose run failed (0-based); absent outside the runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<i32>,
    /// How the tool ended, when it ended badly: "OpenNuXL crashed (signal 11, SIGSEGV)", "OpenNuXL ended with
    /// exit code 3" ([`how_it_ended`]); the message leads with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended: Option<String>,
    /// The last lines the tool wrote to stderr in the failed run (the user's names for the inputs), for the
    /// details.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Where the search's whole log was kept ([`LAST_FAILURE_LOG`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SearchEvent {
    Progress(ProgressEvent),
    Done(DoneEvent),
    Failed(FailedEvent),
}

/// Where a search's events go (the app emits them as `search://…` events).
pub type Sink = Arc<dyn Fn(SearchEvent) + Send + Sync>;

/// The cutoffs of the search, as the request gave them (`outputs.json`'s `fdr`).
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct Cutoffs {
    pub peptide: f64,
    pub xl: f64,
}

/// `nuxl/<stem>.outputs.json`: OpenNuXL's outputs of one input, as the shim found them in `nuxl/` when the
/// input's run had ended successfully (design §2), relative to the search folder. The reader's only way to
/// the derived files: it never guesses their names.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InputOutputs {
    /// The input (0-based).
    pub input: usize,
    /// `-out`: every PSM, targets and decoys, before any FDR filter.
    pub all: Option<String>,
    /// The cross-link PSMs of the highest threshold (`1.0000`: every target cross-link with its q-value).
    pub xls: Option<String>,
    /// The peptide PSMs (`<q>` 0: unfiltered).
    pub peptides: Option<String>,
    /// The protein report of the lowest threshold of at most 10 %.
    pub proteins: Option<String>,
    /// `-out_tsv` (OpenNuXL's report), or after Percolator its `_perc.tsv`.
    pub report: Option<String>,
    /// Whether Percolator ran and its results were written: then the four above are its `_perc_` files.
    pub percolator: bool,
    /// The QPX mz view of the spectra of the input's PSMs (`nuxl/<stem>.mz.parquet`, OpenNuXL's `-out_qpx`), from
    /// which the PSM view reads the peaks; null when OpenNuXL could not write it (a note says so).
    pub mz: Option<String>,
    /// OpenNuXL's warnings of the run worth showing ([`note_of`]), and the shim's notes of the search.
    pub notes: Vec<String>,
    /// The run's wall time.
    pub seconds: f64,
    pub fdr: Cutoffs,
}

/// A running search, as `cancel` sees it.
struct Handle {
    /// The process group of the current run (see `sys::Group`); set for each run before it is waited
    /// for, taken when the search is over. Its lock also orders a run's start against cancel: a run is
    /// started only while it is held and the search is not cancelled.
    group: Mutex<Option<Arc<sys::Group>>>,
    cancelled: AtomicBool,
    /// Set when the search is over and its folder dealt with.
    finished: Mutex<bool>,
    changed: Condvar,
}

impl Handle {
    fn group(&self) -> Option<Arc<sys::Group>> {
        self.group.lock().unwrap().clone()
    }

    fn finish(&self) {
        *self.finished.lock().unwrap() = true;
        self.changed.notify_all();
    }

    fn wait_finished(&self, timeout: Duration) -> bool {
        let guard = self.finished.lock().unwrap();
        let (guard, _) = self
            .changed
            .wait_timeout_while(guard, timeout, |done| !*done)
            .unwrap();
        *guard
    }
}

/// The searches running in this app.
pub struct Searches {
    running: Mutex<HashMap<String, Arc<Handle>>>,
    counter: AtomicU64,
    /// How the inputs reach the tool: this platform's way, unless a test chooses.
    links: InputLinks,
    /// The executable that watches each run's tool ([`crate::watchdog`]; macOS: the app's own), or
    /// none. (Unix only: Windows' job object ends the tool with the app.)
    #[cfg_attr(not(unix), allow(dead_code))]
    watchdog: Option<PathBuf>,
}

impl Default for Searches {
    fn default() -> Searches {
        Searches::with_links(InputLinks::PLATFORM)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{how_it_ended, how_tool_ended};
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    /// (wait statuses: a signal in the low seven bits, an exit code in the next byte)
    #[test]
    fn how_a_tool_ended_leads_its_failure() {
        assert_eq!(how_it_ended(&ExitStatus::from_raw(0)), None);
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(3 << 8)).as_deref(),
            Some("OpenNuXL ended with exit code 3")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(11)).as_deref(),
            Some("OpenNuXL crashed (signal 11, SIGSEGV)")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(6)).as_deref(),
            Some("OpenNuXL crashed (signal 6, SIGABRT)")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(9)).as_deref(),
            Some("OpenNuXL crashed (signal 9, SIGKILL; the system may have ended it for lack of memory)")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(31)).as_deref(),
            Some("OpenNuXL crashed (signal 31)")
        );
        // the system's limits (ulimit -f, -t): a run with ulimit -f 50 ended with "signal 25" alone
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(25)).as_deref(),
            Some("OpenNuXL crashed (signal 25, SIGXFSZ; a file grew larger than the system allows, or the disk is full)")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(24)).as_deref(),
            Some("OpenNuXL crashed (signal 24, SIGXCPU; it used more CPU time than the system allows it)")
        );
        // the spectra conversion's tool by its name
        assert_eq!(
            how_tool_ended("PercolatorAdapter", &ExitStatus::from_raw(6 << 8)).as_deref(),
            Some("PercolatorAdapter ended with exit code 6")
        );
    }

    /// A partial folder that cannot be removed is said in the kept log of the failure.
    #[test]
    fn a_folder_that_cannot_be_removed_is_noted_in_the_failure_log() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("nuxl-discard-{}", std::process::id()));
        let searches = base.join("searches");
        let partial = searches.join("1-0.partial");
        std::fs::create_dir_all(partial.join("nuxl")).unwrap();
        std::fs::write(partial.join("nuxl/a.idXML"), "x").unwrap();
        let kept = base.join("last-failure.log");
        std::fs::write(&kept, "$ OpenNuXL ...\n").unwrap();
        // a folder whose parent may not be written cannot be removed
        std::fs::set_permissions(&searches, std::fs::Permissions::from_mode(0o555)).unwrap();
        super::discard_partial(None, &partial, Some(&kept));
        std::fs::set_permissions(&searches, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log = std::fs::read_to_string(&kept).unwrap();
        let removed = !partial.exists();
        std::fs::remove_dir_all(&base).unwrap();
        if removed {
            return; // (root may remove it anyway)
        }
        assert!(
            log.contains("could not be removed") && log.contains("1-0.partial"),
            "{log}"
        );
    }
}

#[cfg(test)]
mod digest_tests {
    use super::{clean_line, note_of, read_lines, StderrDigest, MAX_LINE, MAX_SHOWN};

    fn digest(lines: &[&str]) -> StderrDigest {
        let mut d = StderrDigest::default();
        for l in lines {
            d.feed(l);
        }
        d
    }

    const CI: &str = "/home/runner/work/nuxl-gui/nuxl-gui/openms/src/openms/source/FORMAT/HANDLERS/XMLHandler.cpp";

    /// A corrupt mzML: the place in the file comes before OpenMS' error, and neither path of the machine that
    /// built OpenNuXL is shown.
    #[test]
    fn a_file_that_cannot_be_read_says_where() {
        let location = format!("{CI}(67): While loading '/data/truncated.mzML': input ended before all started tags were ended; last tag started is 'spectrum'( in line 4303 column 2)");
        let error = format!("Error: Unable to read file (- due to that error of type Parse Error in: {CI}@68-void OpenMS::Internal::XMLHandler::fatalError(ActionMode, const std::string&, OpenMS::UInt, OpenMS::UInt) const)");
        let d = digest(&[
            &location,
            "Too few PSMs for score recalibration. Skipped.",
            &error,
        ]);
        assert_eq!(
            d.message(false),
            "Error: Unable to read file (Parse Error). While loading '/data/truncated.mzML': input ended before all \
             started tags were ended; last tag started is 'spectrum' (in line 4303 column 2)"
        );
        // an OpenMS error without a location: as it is, without its empty "in: "
        let fasta = digest(&["Error: Unable to read file (Error while parsing FASTA file! Only 1280 proteins could be read. Parsing next record failed. Please check the file! in: )"]);
        assert_eq!(
            fasta.message(false),
            "Error: Unable to read file (Error while parsing FASTA file! Only 1280 proteins could be read. Parsing next record failed. Please check the file!)"
        );
        let empty = digest(&[
            "Cannot read input file given from parameter '-in'!",
            "Error: File empty (the file '/data/empty.mzML' is empty)",
        ]);
        assert_eq!(
            empty.message(false),
            "Error: File empty (the file '/data/empty.mzML' is empty)"
        );
    }

    /// An InvalidValue of OpenNuXL (a preset's configuration it refuses): its own words lead, not "Unexpected
    /// internal error" and OpenMS' "the value ... was used but is not valid".
    #[test]
    fn a_refused_configuration_is_told_in_opennuxls_words() {
        let d = digest(&["Error: Unexpected internal error (the value 's' was used but is not valid; Standalone nucleotides need a NuXL:target_nucleotides entry, NuXL:modifications and NuXL:fragment_adducts, and must be listed in NuXL:can_cross_link.)"]);
        assert_eq!(
            d.message(false),
            "Error: Standalone nucleotides need a NuXL:target_nucleotides entry, NuXL:modifications and \
             NuXL:fragment_adducts, and must be listed in NuXL:can_cross_link. (the value: s)"
        );
        assert_eq!(
            clean_line("Invalid parameter values (InvalidValue): the value 'x' was used but is not valid; Unknown localization method (valid: 'fragments', 'NHS').. Aborting!"),
            "Invalid parameter values (InvalidValue): Unknown localization method (valid: 'fragments', 'NHS').. Aborting! (the value: x)"
        );
    }

    /// A full disk: the first line that says so.
    #[test]
    fn a_full_disk_is_named() {
        let d = digest(&[
            "Error: Unable to write file (the file '/s/1-0.partial/nuxl/1__a_perc_1.0000_XLs.idXML' could not be created. writing the file failed (e.g. disk full or I/O error))",
            "Standard output: ",
        ]);
        assert_eq!(
            d.message(false),
            "Error: Unable to write file (the file '/s/1-0.partial/nuxl/1__a_perc_1.0000_XLs.idXML' could not be created. writing the file failed (e.g. disk full or I/O error))"
        );
        let space = digest(&[
            "Progress of 'Post-processing PSMs... (annotation)':",
            "Could not write /s/1-0.partial/nuxl/1__a.tsv: No space left on device",
        ]);
        assert_eq!(
            space.message(false),
            "Could not write /s/1-0.partial/nuxl/1__a.tsv: No space left on device"
        );
    }

    /// A value OpenNuXL refuses: its line, not the last line of the help it prints after it.
    #[test]
    fn a_refused_value_is_named_and_not_the_help() {
        let mut lines = vec![
            "Invalid parameter values (ConversionError): Could not convert string '3000000000' to an integer value. Aborting!".to_string(),
            "stty: 'standard input': Inappropriate ioctl for device".to_string(),
        ];
        for k in 0..200 {
            lines.push(format!(
                "  -NuXL:option{k} <number>   An option (default: '1')"
            ));
        }
        lines.push("  --helphelp                                               Shows all options (including advanced)".to_string());
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let d = digest(&refs);
        assert_eq!(
            d.message(false),
            "Invalid parameter values (ConversionError): Could not convert string '3000000000' to an integer value. Aborting!"
        );
        assert_eq!(d.tail.len(), super::STDERR_TAIL);
    }

    /// Killed (signal 9) during the scoring: its last line would only mislead.
    #[test]
    fn a_killed_tool_without_an_error_has_no_message() {
        let d = digest(&["Too few PSMs for score recalibration. Skipped.", "Split 3:"]);
        assert_eq!(d.message(true), "");
        // ended with an exit code: its last line is all there is
        assert_eq!(d.message(false), "Split 3:");
    }

    /// The warnings of a run that go into its outputs.json, and the rest that does not.
    #[test]
    fn the_notes_of_a_run_are_opennuxls_warnings_worth_showing() {
        for line in [
            "Too few PSMs for score recalibration. Skipped.",
            "Score recalibration failed.",
            "NuXL:rescoring: the delta score needs slow scoring (NuXL:scoring slow) and is not annotated.",
            "autotune: too few non-cross-linked peptides found. Will keep parameters as-is.",
        ] {
            assert_eq!(note_of(&format!("  {line} ")).as_deref(), Some(line));
        }
        for line in ["Running percolator.", "Score recalibration", "", "done."] {
            assert_eq!(note_of(line), None, "{line}");
        }
        // the mz view's warnings (kept only when the view is missing), not its progress
        assert_eq!(
            note_of("Warning: -out_qpx: the spectra of a.raw cannot be read (no such file)")
                .as_deref(),
            Some("-out_qpx: the spectra of a.raw cannot be read (no such file)")
        );
        for line in [
            "-out_qpx: reading spectra",
            "-out_qpx: writing /s/nuxl/runs/1__a.mz.parquet",
            "-out_qpx: wrote /s/nuxl/runs/1__a.mz.parquet (12 spectra, 900 of 1500 peaks)",
        ] {
            assert_eq!(note_of(line), None, "{line}");
        }
    }

    /// A 300 MB line (fake_longline) is cut where it is read, and shown shorter still.
    #[test]
    fn long_lines_are_cut() {
        let long = format!(
            "Error: {}\nnext\n{}",
            "x".repeat(3 * MAX_LINE),
            "y".repeat(10)
        );
        let mut lines = Vec::new();
        read_lines(long.as_bytes(), |l| lines.push(l.to_string()));
        assert_eq!(lines.len(), 3);
        assert!(
            lines[0].ends_with('…') && lines[0].len() <= MAX_LINE + '…'.len_utf8(),
            "{}",
            lines[0].len()
        );
        assert_eq!(lines[1], "next");
        assert_eq!(lines[2], "yyyyyyyyyy", "a last line without a line end");
        let d = digest(&[&lines[0]]);
        assert_eq!(d.message(false).chars().count(), MAX_SHOWN + 1);
        assert_eq!(d.tail[0].chars().count(), MAX_SHOWN + 1);
        // CRLF line ends and invalid UTF-8
        let mut crlf = Vec::new();
        read_lines(&b"a\r\nb\xff\n"[..], |l| crlf.push(l.to_string()));
        assert_eq!(crlf, vec!["a".to_string(), "b\u{fffd}".to_string()]);
    }

    /// OpenMS' progress updates end with `\r`, not a line end: each is a line of its own, the `\n\r` and `\r\n`
    /// around them one break (also across the reader's buffers), a blank line stays.
    #[test]
    fn a_carriage_return_ends_a_line() {
        let text = "Progress of 'Scoring peptide models against spectra...':\n\r0.00 %    \r12.34 %    \r-- done [took 1 s] -- \n\nnext";
        let mut lines = Vec::new();
        read_lines(text.as_bytes(), |l| lines.push(l.to_string()));
        assert_eq!(
            lines,
            [
                "Progress of 'Scoring peptide models against spectra...':",
                "0.00 %    ",
                "12.34 %    ",
                "-- done [took 1 s] -- ",
                "",
                "next"
            ]
        );
        // one byte at a time: a \r at the end of one read and the \n at the start of the next
        struct Trickle<'a>(&'a [u8]);
        impl std::io::Read for Trickle<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0.is_empty() || buf.is_empty() {
                    return Ok(0);
                }
                buf[0] = self.0[0];
                self.0 = &self.0[1..];
                Ok(1)
            }
        }
        let mut trickled = Vec::new();
        read_lines(
            std::io::BufReader::with_capacity(1, Trickle(text.as_bytes())),
            |l| trickled.push(l.to_string()),
        );
        assert_eq!(trickled, lines);
    }
}

#[cfg(all(test, windows))]
mod tests_windows {
    use super::how_it_ended;
    use std::os::windows::process::ExitStatusExt;
    use std::process::ExitStatus;

    #[test]
    fn how_a_tool_ended_leads_its_failure() {
        assert_eq!(how_it_ended(&ExitStatus::from_raw(0)), None);
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(3)).as_deref(),
            Some("OpenNuXL ended with exit code 3")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(0xC000_0005)).as_deref(),
            Some("OpenNuXL crashed (exception 0xC0000005)")
        );
        assert!(how_it_ended(&ExitStatus::from_raw(0xC000_0135))
            .unwrap()
            .starts_with("OpenNuXL could not start (0xC0000135, STATUS_DLL_NOT_FOUND: a DLL it needs is missing;"));
    }
}

#[cfg(unix)]
mod sys {
    use std::os::raw::c_int;

    extern "C" {
        fn kill(pid: c_int, sig: c_int) -> c_int;
        #[cfg(target_os = "linux")]
        fn prctl(option: c_int, ...) -> c_int;
    }

    const SIGKILL: c_int = 9;
    const SIGTERM: c_int = 15;

    /// The tool's process group: the tool is started as the leader of one (`prepare`).
    pub struct Group {
        pid: u32,
    }

    impl Group {
        pub fn new(child: &std::process::Child) -> Group {
            Group { pid: child.id() }
        }

        pub fn pid(&self) -> u32 {
            self.pid
        }

        /// Signals every process of the group.
        fn signal(&self, signal: c_int) {
            if self.pid > 0 && self.pid <= i32::MAX as u32 {
                // SAFETY: kill(2) with a negative pid signals a process group; it has no memory effects.
                unsafe { kill(-(self.pid as c_int), signal) };
            }
        }

        /// Asks the group to end (SIGTERM).
        pub fn terminate(&self) {
            self.signal(SIGTERM);
        }

        /// Ends the group (SIGKILL).
        pub fn kill(&self) {
            self.signal(SIGKILL);
        }
    }

    pub fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
        std::os::unix::process::ExitStatusExt::signal(status)
    }

    /// Own process group; on Linux killed with the app.
    pub fn prepare(command: &mut std::process::Command) {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        #[cfg(target_os = "linux")]
        // SAFETY: only prctl(2) runs between fork and exec, which is async-signal-safe.
        unsafe {
            command.pre_exec(|| {
                const PR_SET_PDEATHSIG: c_int = 1;
                prctl(PR_SET_PDEATHSIG, SIGKILL as std::os::raw::c_ulong);
                Ok(())
            });
        }
    }

    pub fn link_input(original: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(original, link)
    }
}

#[cfg(windows)]
mod sys {
    //! The tool's processes as a job object: every process the tool starts joins the job, which
    //! `TerminateJobObject` ends at once, and which ends with the app (`KILL_ON_JOB_CLOSE`: the app's
    //! handle is the only one, and Windows closes it when the app ends, however it ends).
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};

    type Handle = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io_info: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *mut c_void, length: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    /// The exit code of a tool ended by cancel.
    const KILLED: u32 = 1;

    /// A job with the tool in it; without one (it could not be made) the tool's tree is ended with
    /// `taskkill /T /F`.
    pub struct Group {
        pid: u32,
        job: Option<Handle>,
    }

    // SAFETY: a job handle is a kernel handle, usable from any thread; it is closed only in Drop.
    unsafe impl Send for Group {}
    unsafe impl Sync for Group {}

    /// A job that ends its processes when its last handle is closed.
    fn new_job() -> Option<Handle> {
        // SAFETY: plain Win32 calls with valid pointers; the handle is closed on failure.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info = ExtendedLimitInformation::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&mut info as *mut ExtendedLimitInformation).cast(),
                std::mem::size_of::<ExtendedLimitInformation>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job)
        }
    }

    impl Group {
        /// Puts the child into a job of its own. (The child runs from its start; a process it starts
        /// before it is assigned, within microseconds, would not be in the job. OpenNuXL starts PercolatorAdapter
        /// only at the end of its run, long after.)
        pub fn new(child: &std::process::Child) -> Group {
            let job = new_job().filter(|job| {
                // SAFETY: the child's process handle is valid while `child` lives.
                let assigned =
                    unsafe { AssignProcessToJobObject(*job, child.as_raw_handle() as Handle) };
                if assigned == 0 {
                    // SAFETY: the job was made above and is not used elsewhere.
                    unsafe { CloseHandle(*job) };
                }
                assigned != 0
            });
            Group {
                pid: child.id(),
                job,
            }
        }

        pub fn pid(&self) -> u32 {
            self.pid
        }

        /// Windows has no request to end for a console tool without a console: ends the job.
        pub fn terminate(&self) {
            self.kill();
        }

        /// Ends every process of the job.
        pub fn kill(&self) {
            match self.job {
                // SAFETY: the job handle is open until Drop.
                Some(job) => unsafe {
                    TerminateJobObject(job, KILLED);
                },
                None => {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
        }
    }

    impl Drop for Group {
        fn drop(&mut self) {
            if let Some(job) = self.job.take() {
                // SAFETY: the handle was opened by `new_job` and is closed once.
                unsafe { CloseHandle(job) };
            }
        }
    }

    pub fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
        None
    }

    /// (The console window is suppressed for every run of the tool: `tool::command`.)
    pub fn prepare(_command: &mut std::process::Command) {}

    /// Only `Placement::HardLink` reaches the folder on Windows; a symbolic link needs a privilege.
    pub fn link_input(original: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(original, link)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The job is made and its limit set (else cancel falls back to taskkill unnoticed): the
        /// structure has the size Windows expects (JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64: 144 bytes).
        #[test]
        fn a_job_object_that_ends_its_processes_is_made_and_holds_the_tool() {
            assert_eq!(std::mem::size_of::<ExtendedLimitInformation>(), 144);
            let job = new_job().expect("a job object with KILL_ON_JOB_CLOSE");
            // SAFETY: the handle was just made.
            unsafe { CloseHandle(job) };
            let mut child = Command::new("cmd")
                .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let group = Group::new(&child);
            assert!(group.job.is_some(), "the child is in a job");
            group.kill();
            let status = child.wait().unwrap();
            assert_eq!(status.code(), Some(KILLED as i32), "ended by the job");
        }
    }
}

/// Lines of a stream, lossily decoded, without the line end; a line longer than [`MAX_LINE`] bytes is cut
/// there (and ends with "…"), the rest of it dropped unread into memory. A line ends at `\n` or at `\r`:
/// OpenMS' progress updates end with `\r` alone (`ProgressLogger`), and each is a line of its own. A `\n`
/// right after a `\r` (Windows' line end) ends nothing more, and nothing between a line end and a `\r` (the
/// `\n\r` of a progress update after its label) is no line.
fn read_lines(stream: impl Read, mut each: impl FnMut(&str)) {
    let mut reader = BufReader::new(stream);
    let mut line: Vec<u8> = Vec::new();
    let mut cut = false;
    // the last byte read was a `\r` (also at the end of the reader's buffer)
    let mut after_cr = false;
    let mut emit = |line: &mut Vec<u8>, cut: &mut bool| {
        let text = String::from_utf8_lossy(line);
        if *cut {
            each(&format!("{text}…"));
        } else {
            each(&text);
        }
        line.clear();
        *cut = false;
    };
    loop {
        let buffer = match reader.fill_buf() {
            Ok([]) => break,
            Ok(buffer) => buffer,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let (taken, end) = match buffer.iter().position(|&b| b == b'\n' || b == b'\r') {
            Some(at) => (at + 1, Some(buffer[at])),
            None => (buffer.len(), None),
        };
        let content = taken - usize::from(end.is_some());
        let room = MAX_LINE.saturating_sub(line.len());
        line.extend_from_slice(&buffer[..content.min(room)]);
        cut |= content > room;
        reader.consume(taken);
        match end {
            // the \n of a \r\n
            Some(b'\n') if after_cr && line.is_empty() && !cut => after_cr = false,
            Some(b'\n') => {
                emit(&mut line, &mut cut);
                after_cr = false;
            }
            Some(_) => {
                if !line.is_empty() || cut {
                    emit(&mut line, &mut cut);
                }
                after_cr = true;
            }
            None => {
                if content > 0 {
                    after_cr = false;
                }
            }
        }
    }
    if !line.is_empty() {
        emit(&mut line, &mut cut);
    }
}

fn is_noise(line: &str) -> bool {
    line.trim().is_empty() || line.starts_with("Schema error") || line.starts_with("Warning:")
}

/// Where a file could not be parsed (OpenMS' XML handlers: "While loading '<file>': ... (in line 4303 column 2)").
fn is_location(line: &str) -> bool {
    line.starts_with("While loading '")
}

/// A line that tells of an error: TOPPBase's "Error: ..." of a tool that stops and its refusals of the command
/// line ("Invalid parameter values (...)", "Unknown option(s) ..."), and OpenMS' lines of a file that cannot be
/// written or read.
fn is_error(line: &str) -> bool {
    const STARTS: &[&str] = &[
        "Error",
        "Invalid parameter",
        "Internal error",
        "Unknown option",
        "Trailing text argument",
        "Cannot ",
        "Could not ",
        "Unable to ",
        "Failed to ",
        "terminate called",
    ];
    const HAS: &[&str] = &[
        "No space left on device",
        "Disk quota exceeded",
        "File too large",
        "Read-only file system",
        "Permission denied",
        "std::bad_alloc",
        "could not be created",
        "could not be written",
    ];
    STARTS.iter().any(|s| line.starts_with(s)) || HAS.iter().any(|s| line.contains(s))
}

/// OpenMS' InvalidValue ("the value 'X' was used but is not valid; M"), as OpenNuXL raises it for a configuration
/// it refuses: "M (the value: X)"; inside TOPPBase's "Error: Unexpected internal error (...)", which is the
/// user's configuration here, not an internal error: "Error: M (the value: X)".
fn invalid_value(text: &str) -> Option<String> {
    const START: &str = "the value '";
    const MIDDLE: &str = "' was used but is not valid; ";
    let at = text.find(START)?;
    let value_end = at + START.len() + text[at + START.len()..].find(MIDDLE)?;
    let value = &text[at + START.len()..value_end];
    let message = &text[value_end + MIDDLE.len()..];
    const INTERNAL: &str = "Error: Unexpected internal error (";
    if text.starts_with(INTERNAL) && at == INTERNAL.len() {
        let message = message.strip_suffix(')').unwrap_or(message).trim_end();
        return Some(format!("Error: {message} (the value: {value})"));
    }
    Some(format!(
        "{}{} (the value: {value})",
        &text[..at],
        message.trim_end()
    ))
}

/// A line of the tool's stderr as a failure shows it: without OpenMS' source locations (paths of the
/// machine that built OpenNuXL) and exception boilerplate, and at most [`MAX_SHOWN`] characters.
fn clean_line(line: &str) -> String {
    let mut text = line.trim().to_string();
    // "/home/runner/.../XMLHandler.cpp(67): While loading ...": the source location of a message
    if let Some(at) = text.find("): ") {
        let head = &text[..at];
        if !head.contains(' ')
            && [".cpp(", ".h(", ".hpp(", ".cc("]
                .iter()
                .any(|e| head.contains(e))
        {
            text = text[at + 3..].to_string();
        }
    }
    // OpenMS' exceptions: "<message> (- due to that error of type Parse Error in: <source>@<line>-<function>)"
    if let Some(at) = text.find("due to that error of type ") {
        let kind = &text[at + "due to that error of type ".len()..];
        let kind = kind
            .split(" in:")
            .next()
            .unwrap_or(kind)
            .trim_end_matches(')')
            .trim();
        let head = text[..at]
            .trim_end_matches([' ', '-'])
            .trim_end_matches('(')
            .trim_end();
        text = format!("{head} ({kind})");
    } else if let Some(at) = text.rfind(" in: ") {
        // "... Please check the file! in: )", "... in: <source>@<line>-<function>": the location only
        let after = text[at + 5..].trim();
        if after.is_empty() || after == ")" || after.contains('@') {
            let head = &text[..at];
            let open = head.matches('(').count() > head.matches(')').count();
            text = format!(
                "{head}{}",
                if open && after.ends_with(')') {
                    ")"
                } else {
                    ""
                }
            );
        }
    }
    text = text.replace("( in line ", " (in line ");
    if let Some(rewritten) = invalid_value(&text) {
        text = rewritten;
    }
    if text.chars().count() > MAX_SHOWN {
        text = format!("{}…", text.chars().take(MAX_SHOWN).collect::<String>());
    }
    text
}

/// The warnings of OpenNuXL worth showing with a run's results (its `outputs.json`'s `notes`): that Percolator
/// was skipped or failed (the results then carry NuXL's own scores), that a rescoring option could not work with
/// the other settings, that the autotune kept the tolerances. As OpenNuXL writes them (stdout or stderr).
/// OpenNuXL's warning that a run has fewer than 1000 PSMs, which it gives whether or not Percolator was asked for
/// (OpenNuXL.cpp: the `else` of `recalibrate && sufficient_PSMs_for_score_recalibration`).
const TOO_FEW_PSMS: &str = "Too few PSMs for score recalibration.";

const NOTES: &[&str] = &[
    TOO_FEW_PSMS,
    "Score recalibration failed.",
    "NuXL:rescoring:",
    "autotune: too few non-cross-linked peptides found.",
];

/// The note of a line of a run, if it is one ([`NOTES`]), or a warning of the mz view (`-out_qpx: <why>`, not its
/// progress; OpenMS may put `Warning: ` before it), which `supervise` keeps only when the view is missing.
fn note_of(line: &str) -> Option<String> {
    let line = line.trim();
    let qpx = line.strip_prefix("Warning: ").unwrap_or(line);
    if qpx.starts_with(OUT_QPX) {
        return (!is_mz_view_progress(qpx)).then(|| qpx.to_string());
    }
    NOTES
        .iter()
        .any(|n| line.starts_with(n))
        .then(|| line.to_string())
}

/// What a failure is told with, gathered from the tool's stderr as it comes: its last lines (the details)
/// and the lines a message is made of.
#[derive(Default)]
struct StderrDigest {
    /// The last [`STDERR_TAIL`] lines (not noise), each at most [`MAX_SHOWN`] characters.
    tail: VecDeque<String>,
    /// The first [`ERROR_LINES`] error lines ([`is_error`]), cleaned ([`clean_line`]).
    errors: Vec<String>,
    /// The last "Error..." line, with the parse location ([`is_location`]) that came last before it.
    fatal: Option<(String, Option<String>)>,
    location: Option<String>,
}

impl StderrDigest {
    fn feed(&mut self, line: &str) {
        if is_noise(line) {
            return;
        }
        if self.tail.len() == STDERR_TAIL {
            self.tail.pop_front();
        }
        let shown: String = if line.chars().count() > MAX_SHOWN {
            format!("{}…", line.chars().take(MAX_SHOWN).collect::<String>())
        } else {
            line.to_string()
        };
        self.tail.push_back(shown);
        let clean = clean_line(line);
        if clean.starts_with("Error") {
            self.fatal = Some((clean.clone(), self.location.clone()));
        } else if is_location(&clean) {
            self.location = Some(clean.clone());
        }
        if is_error(&clean) && self.errors.len() < ERROR_LINES {
            self.errors.push(clean);
        }
    }

    /// The message of a failure: OpenMS' last "Error..." line (one of reading a file with the place in the
    /// file before it), else the first error line the tool wrote (the cause; the next ones are its
    /// consequences), else, for a tool that ended with an exit code, its last line. Empty for a tool killed by a
    /// signal without an error: its last line would only mislead.
    fn message(&self, signalled: bool) -> String {
        if let Some((error, location)) = &self.fatal {
            return match location {
                Some(location) if error.contains("Unable to read") => {
                    format!("{error}. {location}")
                }
                _ => error.clone(),
            };
        }
        if let Some(error) = self.errors.first() {
            return error.clone();
        }
        if signalled {
            return String::new();
        }
        self.tail.back().map(|l| clean_line(l)).unwrap_or_default()
    }
}

/// The name of a signal that ends a process (Linux and macOS agree on these numbers).
fn signal_name(signal: i32) -> Option<&'static str> {
    Some(match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        4 => "SIGILL",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        15 => "SIGTERM",
        // the system's limits of a process (ulimit -t, -f)
        24 => "SIGXCPU",
        25 => "SIGXFSZ",
        _ => return None,
    })
}

/// How OpenNuXL ended when it did not succeed ([`how_tool_ended`]).
pub fn how_it_ended(status: &ExitStatus) -> Option<String> {
    how_tool_ended("OpenNuXL", status)
}

/// What a Windows status (NTSTATUS) a process ended with says when Windows could not start the program at all: a
/// DLL missing, damaged or refused while it was being loaded. Its name and what it means, for the statuses a user can
/// act on (reinstall, look at the antivirus program); None for any other (a crash while the program ran).
pub fn windows_start_failure(code: u32) -> Option<&'static str> {
    Some(match code {
        0xC000_0135 => {
            "STATUS_DLL_NOT_FOUND: a DLL it needs is missing; an antivirus program may have removed it, and \
             reinstalling NuXL brings it back"
        }
        0xC000_0139 => {
            "STATUS_ENTRYPOINT_NOT_FOUND: its DLLs do not fit together, as after an incomplete update; reinstalling \
             NuXL replaces them"
        }
        0xC000_007B => {
            "STATUS_INVALID_IMAGE_FORMAT: one of its DLLs is damaged or for another kind of computer; reinstalling \
             NuXL replaces it"
        }
        0xC000_0142 => "STATUS_DLL_INIT_FAILED: one of its DLLs failed to start",
        0xC000_0022 => {
            "STATUS_ACCESS_DENIED: Windows denied it one of its files; an antivirus program or a policy of the \
             computer's administrators may block it"
        }
        0xC000_0428 => {
            "STATUS_INVALID_IMAGE_HASH: Windows refused one of its files for its signature; Smart App Control or a \
             policy of the computer's administrators may block it"
        }
        _ => return None,
    })
}

/// How the tool `tool` ended on Windows with the status `code` (an error, 0xC…): "OpenNuXL could not start
/// (0xC0000135, STATUS_DLL_NOT_FOUND: a DLL it needs is missing; ...)" when Windows could not start it
/// ([`windows_start_failure`]), else "OpenNuXL crashed (exception 0xC0000005)".
pub fn windows_ending(tool: &str, code: u32) -> String {
    match windows_start_failure(code) {
        Some(why) => format!("{tool} could not start (0x{code:08X}, {why})"),
        None => format!("{tool} crashed (exception 0x{code:08X})"),
    }
}

/// How the tool `tool` (its name) ended when it did not succeed, the lead of its failure: "OpenNuXL crashed (signal
/// 11, SIGSEGV)" (SIGKILL: the system may have ended it for lack of memory), on Windows for an error status
/// [`windows_ending`] ("OpenNuXL could not start (0xC0000135, STATUS_DLL_NOT_FOUND: ...)", "OpenNuXL crashed
/// (exception 0xC0000005)"), else "OpenNuXL ended with exit code 3"; None for success.
pub fn how_tool_ended(tool: &str, status: &ExitStatus) -> Option<String> {
    if status.success() {
        return None;
    }
    if let Some(signal) = sys::exit_signal(status) {
        let name = signal_name(signal)
            .map(|n| format!(", {n}"))
            .unwrap_or_default();
        let oom = match signal {
            9 => "; the system may have ended it for lack of memory",
            24 => "; it used more CPU time than the system allows it",
            25 => "; a file grew larger than the system allows, or the disk is full",
            _ => "",
        };
        return Some(format!("{tool} crashed (signal {signal}{name}{oom})"));
    }
    Some(match status.code() {
        // an NTSTATUS error (0xC…): a DLL missing at the start, an access violation, a stack overflow, ...
        Some(code) if cfg!(windows) && (code as u32) >= 0xC000_0000 => {
            windows_ending(tool, code as u32)
        }
        Some(code) => format!("{tool} ended with exit code {code}"),
        None => format!("{tool} ended unexpectedly"),
    })
}

/// Keeps the log of a failed search ([`LOG_FILE`] of its partial folder) as `<app data>/logs/`
/// [`LAST_FAILURE_LOG`], replacing the one before; the path, or None if there is none.
fn keep_failure_log(partial: &Path) -> Option<PathBuf> {
    let logs = partial.parent()?.parent()?.join("logs");
    fs::create_dir_all(&logs).ok()?;
    let kept = logs.join(LAST_FAILURE_LOG);
    fs::copy(partial.join(LOG_FILE), &kept).ok()?;
    Some(kept)
}

/// Removes the partial folder of a search that failed or was cancelled. A folder that cannot be removed
/// stays for the sweep of the app's next start (`history::sweep`); that is said on stderr and in the kept
/// log of the failure (`kept`), so that the folder's disk space is not lost unnoticed.
fn discard_partial(lock: Option<fs::File>, partial: &Path, kept: Option<&Path>) {
    let Err(e) = remove_partial(lock, partial) else {
        return;
    };
    let note = format!(
        "The search folder {} could not be removed ({e}); the next start of the app removes it.",
        partial.display()
    );
    eprintln!("{note}");
    if let Some(kept) = kept {
        if let Ok(mut file) = fs::OpenOptions::new().append(true).open(kept) {
            let _ = writeln!(file, "{note}");
        }
    }
}

/// Everything the supervising thread needs.
struct Job {
    id: String,
    tool: PathBuf,
    /// The command line of each input's run, in order.
    runs: SearchRuns,
    partial: PathBuf,
    done_dir: PathBuf,
    records: Vec<InputRecord>,
    placements: Vec<Placement>,
    cutoffs: Cutoffs,
    /// The request's `rescore` (`-percolator_backend builtin`, else `none`).
    rescore: bool,
    /// The shim's notes of the search, for every input's `outputs.json` (the database's decoys left out).
    notes: Vec<String>,
    sink: Sink,
    handle: Arc<Handle>,
    /// The lock of the partial folder (see `history::lock_partial`), held until the folder is renamed
    /// or removed.
    lock: Option<fs::File>,
}

impl Searches {
    /// Searches whose inputs reach the tool as `links` says (the default: this platform's way).
    pub fn with_links(links: InputLinks) -> Searches {
        Searches {
            running: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            links,
            watchdog: None,
        }
    }

    /// The same, each run's tool watched by `exe --watch-search` ([`crate::watchdog`]; Unix): the app's
    /// own executable on macOS, where nothing else ends the tool with the app.
    pub fn with_watchdog(mut self, exe: PathBuf) -> Searches {
        self.watchdog = Some(exe);
        self
    }

    fn new_id(&self, dir: &Path) -> String {
        loop {
            let millis = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let n = self.counter.fetch_add(1, Ordering::Relaxed);
            let id = format!("{millis}-{n}");
            if !dir.join(&id).exists() && !dir.join(format!("{id}.partial")).exists() {
                return id;
            }
        }
    }

    /// Checks the request, makes the search folder and starts the first run of the tool; returns the search
    /// id. The events go to `sink`. `crap` is the contaminant FASTA, needed if the request asks for them. Each run
    /// writes the QPX mz view of its PSMs' spectra for the PSM view ([`take_mz_view`]).
    pub fn start(
        self: &Arc<Self>,
        tool_path: &Path,
        searches_dir: &Path,
        crap: Option<&Path>,
        request: SearchRequest,
        sink: Sink,
    ) -> Result<String, String> {
        if request.contaminants && crap.is_none() {
            return Err(
                "The contaminant database (cRAP) is not available in this installation."
                    .to_string(),
            );
        }
        fs::create_dir_all(searches_dir).map_err(|e| {
            format!(
                "The searches folder {} cannot be made ({e}).",
                searches_dir.display()
            )
        })?;
        let id = self.new_id(searches_dir);
        let partial = searches_dir.join(format!("{id}.partial"));
        let done_dir = searches_dir.join(&id);
        // everything that can be wrong with the request is found before a folder exists
        let plan = plan_database(&request)?;
        let runs = build_search_with(&request, &partial, self.links, &plan)?;

        fs::create_dir(&partial).map_err(|e| {
            format!(
                "The search folder {} cannot be made ({e}).",
                partial.display()
            )
        })?;
        let lock = match lock_partial(&partial) {
            Ok(lock) => lock,
            Err(e) => {
                discard_partial(None, &partial, None);
                return Err(format!("The search folder cannot be locked ({e})."));
            }
        };
        let records = input_records_with(&request, self.links, &partial);
        let placements = input_placements(&request, self.links, &partial);
        let notes = match prepare_folder(&partial, &request, &records, &placements, &plan, crap) {
            Ok(notes) => notes,
            Err(e) => {
                discard_partial(Some(lock), &partial, None);
                return Err(e);
            }
        };

        let handle = Arc::new(Handle {
            group: Mutex::new(None),
            cancelled: AtomicBool::new(false),
            finished: Mutex::new(false),
            changed: Condvar::new(),
        });
        self.running
            .lock()
            .unwrap()
            .insert(id.clone(), handle.clone());
        let job = Job {
            id: id.clone(),
            tool: tool_path.to_path_buf(),
            runs,
            partial: partial.clone(),
            done_dir,
            records,
            placements,
            cutoffs: Cutoffs {
                peptide: request.settings.peptide_fdr,
                xl: request.settings.xl_fdr,
            },
            rescore: request.settings.rescore,
            notes,
            sink,
            handle,
            lock: Some(lock),
        };
        let (started_tx, started_rx) = mpsc::channel();
        let searches = self.clone();
        let spawned = thread::Builder::new()
            .name(format!("nuxl-{id}"))
            .spawn(move || supervise(searches, job, started_tx));
        let result = match spawned {
            Ok(_) => started_rx.recv().unwrap_or_else(|_| {
                Err("The search thread ended before the tool started.".to_string())
            }),
            Err(e) => Err(format!("The search thread cannot be started ({e}).")),
        };
        if let Err(e) = result {
            self.running.lock().unwrap().remove(&id);
            // (the thread has ended and released the lock)
            discard_partial(None, &partial, None);
            return Err(e);
        }
        Ok(id)
    }

    /// Stops a search: its current run's process group gets SIGTERM, and SIGKILL if it is still there after a
    /// few seconds (Windows: its job is terminated at once); no further run starts. Returns when the process is
    /// gone and the partial folder is removed. A search that is not running (finished, or never existed) is not
    /// an error.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let Some(handle) = self.running.lock().unwrap().get(id).cloned() else {
            return Ok(());
        };
        // (before the group is read: a run that starts after this sees it and does not start; see `start_run`)
        handle.cancelled.store(true, Ordering::SeqCst);
        let group = handle.group();
        if let Some(group) = &group {
            group.terminate();
        }
        if handle.wait_finished(GRACE) {
            return Ok(());
        }
        // (the run of then, or one that was starting as cancel came)
        let group = handle.group().or(group);
        if let Some(group) = &group {
            group.kill();
        }
        if handle.wait_finished(KILL_WAIT) {
            Ok(())
        } else {
            let pid = group.map(|g| g.pid()).unwrap_or(0);
            Err(format!("The search's tool (process {pid}) did not stop."))
        }
    }

    /// Whether a search is running (its tool has not ended yet).
    pub fn any_running(&self) -> bool {
        !self.running.lock().unwrap().is_empty()
    }

    /// Cancels every running search (the app is closing).
    pub fn cancel_all(&self) {
        let handles: Vec<Arc<Handle>> = self.running.lock().unwrap().values().cloned().collect();
        let running: Vec<(Arc<Handle>, Option<Arc<sys::Group>>)> = handles
            .into_iter()
            .map(|h| {
                h.cancelled.store(true, Ordering::SeqCst);
                let group = h.group();
                if let Some(group) = &group {
                    group.terminate();
                }
                (h, group)
            })
            .collect();
        for (handle, group) in running {
            if !handle.wait_finished(GRACE) {
                if let Some(group) = handle.group().or(group) {
                    group.kill();
                }
                handle.wait_finished(KILL_WAIT);
            }
        }
    }
}

/// The links, `inputs.json`, the database (`database.fasta`, or `database.json` with the user's path) and the
/// outputs' folder `nuxl/`. Returns the shim's notes of the search.
fn prepare_folder(
    dir: &Path,
    request: &SearchRequest,
    records: &[InputRecord],
    placements: &[Placement],
    plan: &DatabasePlan,
    crap: Option<&Path>,
) -> Result<Vec<String>, String> {
    for ((file, record), placement) in request.files.iter().zip(records).zip(placements) {
        // (the record's path: the user's without trailing separators, a `.d` folder's own)
        let original =
            fs::canonicalize(&record.path).unwrap_or_else(|_| PathBuf::from(&record.path));
        let link = dir.join(&record.link);
        match placement {
            Placement::OwnPath => {}
            Placement::Symlink => sys::link_input(&original, &link).map_err(|e| {
                format!(
                    "The input {} cannot be linked into the search folder ({e}).",
                    file.path
                )
            })?,
            // (Windows) a hard link works on the folder's own volume only; nothing is ever copied
            Placement::HardLink => fs::hard_link(&original, &link)
                .map_err(|e| hard_link_refused(dir, records, record, &file.path, &e))?,
        }
    }
    let json = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    fs::write(dir.join("inputs.json"), json)
        .map_err(|e| format!("inputs.json cannot be written ({e})."))?;
    let mut notes = Vec::new();
    if plan.copy {
        let crap =
            if request.contaminants {
                Some(crap.ok_or(
                    "The contaminant database (cRAP) is not available in this installation.",
                )?)
            } else {
                None
            };
        let copy = write_database(
            Path::new(&request.database),
            crap,
            plan.decoys.as_ref(),
            &dir.join(DATABASE_FILE),
        )
        .map_err(|e| match e.kind() {
            // (the user's database: the message says what is wrong with it)
            std::io::ErrorKind::InvalidData => e.to_string(),
            _ => format!("The database for OpenNuXL cannot be written ({e})."),
        })?;
        if let (Some(marker), true) = (&plan.decoys, copy.decoys_left_out > 0) {
            notes.push(format!(
                "The database's own {} decoys ({}) were left out: OpenNuXL generates its decoys itself.",
                copy.decoys_left_out,
                marker.describe()
            ));
        }
    } else {
        // the one file outside the folder that the results reader may read (files::resolve_search_file)
        let record = serde_json::json!({ "path": request.database }).to_string();
        fs::write(dir.join(DATABASE_RECORD), record)
            .map_err(|e| format!("{DATABASE_RECORD} cannot be written ({e})."))?;
    }
    fs::create_dir(dir.join(OUTPUT_DIR))
        .map_err(|e| format!("The folder of OpenNuXL's results cannot be made ({e})."))?;
    Ok(notes)
}

/// Why an input that needs a hard link (Windows) could not have one, in words that say what to do.
fn hard_link_refused(
    dir: &Path,
    records: &[InputRecord],
    record: &InputRecord,
    path: &str,
    e: &std::io::Error,
) -> String {
    let data = dir.parent().unwrap_or(dir).display();
    // (a name too long for OpenNuXL's outputs in the search folder: its link's name is shortened)
    if !record.link.ends_with(&record.name) {
        return format!(
            "The name of {} is too long for OpenNuXL's result files in the app's data folder ({data}), which are \
             named after the file. The app links such a file into the search folder under a shorter name, but \
             Windows can make that link only on the drive of the app's data and on NTFS. {path} cannot be linked \
             there ({e}). Rename the file to a shorter name and start the search again.",
            record.name
        );
    }
    let same = records
        .iter()
        .filter(|r| r.name.to_lowercase() == record.name.to_lowercase())
        .count();
    if same > 1 {
        return format!(
            "Two inputs are named {}. OpenNuXL's result files are named after the files, so files of one name \
             are searched together only through links in the search folder, which Windows can make only on the \
             drive of the app's data ({data}) and on NTFS; {path} cannot be linked there ({e}). Rename one of the \
             files and start the search again.",
            record.name
        );
    }
    format!(
        "The result files of {} would be confused with those of another input whose name starts the same way \
         (e.g. a.mzML and a_perc.mzML: OpenNuXL names its files after the input and adds endings such as _perc). \
         The app links such files into the search folder under other names, but Windows can make that link only \
         on the drive of the app's data ({data}) and on NTFS; {path} cannot be linked there ({e}). Rename one of \
         the files and start the search again.",
        record.name
    )
}

/// A threshold of OpenNuXL's derived file names, `StringUtils::number(q, 4)`: digits, a point and four
/// decimals (`1.0000`, `0.0100`).
fn threshold(text: &str) -> Option<f64> {
    let (whole, decimals) = text.split_once('.')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (digits(whole) && decimals.len() == 4 && digits(decimals))
        .then(|| text.parse().ok())
        .flatten()
}

/// The files of one kind among `names` (the names in `nuxl/`): those that are `<head><q><tail>`, with their
/// threshold `q`.
fn with_threshold<'a>(names: &'a [String], head: &str, tail: &str) -> Vec<(f64, &'a str)> {
    names
        .iter()
        .filter_map(|n| {
            let middle = n.strip_prefix(head)?.strip_suffix(tail)?;
            Some((threshold(middle)?, n.as_str()))
        })
        .collect()
}

/// The outputs of the input of stem `stem` among the files `names` of `nuxl/` (design §2): the derived files are
/// OpenNuXL's names after `-out` without `.idXML` and `_` (NuXLFDR.cpp: `<out>_<q>_peptides.idXML`,
/// `<out>_<q>_XLs.idXML`, `<out>_proteins<q>_XLs.tsv`), after Percolator with `_perc_` (and the report
/// `<out_tsv>_perc.tsv`). Percolator's are taken when there are any of its cross-link files.
fn find_outputs(names: &[String], stem: &str) -> (bool, [Option<String>; 5]) {
    let path = |name: &str| format!("{OUTPUT_DIR}/{name}");
    let has = |name: String| names.contains(&name).then(|| path(&name));
    let plain = format!("{stem}_");
    let perc = format!("{stem}_perc_");
    let percolator = !with_threshold(names, &perc, "_XLs.idXML").is_empty();
    let base = if percolator { &perc } else { &plain };
    // the file of the highest threshold, `rank` ordering them
    let highest = |files: Vec<(f64, &str)>, rank: fn(f64) -> f64| {
        files
            .into_iter()
            .max_by(|a, b| rank(a.0).total_cmp(&rank(b.0)))
            .map(|(_, n)| path(n))
    };
    // A cross-link threshold of 0 is never "no filter": NuXLFDR turns 0 into 1 before it names any file, so
    // `_0.0000_XLs` is a positive threshold below 0.00005 (`%.4f`), filtered next to the `_1.0000_` one.
    let xls = highest(with_threshold(names, base, "_XLs.idXML"), |q| q);
    // (the peptides' threshold 0 is no filter, as 1: the most of all)
    let peptides = highest(with_threshold(names, base, "_peptides.idXML"), |q| {
        if q == 0.0 {
            1.0
        } else {
            q
        }
    });
    let proteins = with_threshold(names, &format!("{base}proteins"), "_XLs.tsv")
        .into_iter()
        .filter(|(q, _)| *q <= crate::args::MAX_PROTEIN_REPORT_FDR)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, n)| path(n));
    let report = if percolator {
        has(format!("{stem}_perc.tsv"))
    } else {
        has(format!("{stem}.tsv"))
    };
    let all = has(format!("{stem}.idXML"));
    (percolator, [all, xls, peptides, proteins, report])
}

/// Writes `nuxl/<stem>.outputs.json` of input `index` in the search folder `dir`, from what its run left in
/// `nuxl/`.
fn record_outputs(
    dir: &Path,
    record: &InputRecord,
    cutoffs: Cutoffs,
    notes: Vec<String>,
    seconds: f64,
    mz: Option<String>,
) -> Result<InputOutputs, String> {
    let folder = dir.join(OUTPUT_DIR);
    let names: Vec<String> = fs::read_dir(&folder)
        .map_err(|e| format!("The folder of OpenNuXL's results cannot be read ({e})."))?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let (percolator, [all, xls, peptides, proteins, report]) = find_outputs(&names, &record.stem);
    let outputs = InputOutputs {
        input: record.index,
        all,
        xls,
        peptides,
        proteins,
        report,
        percolator,
        mz,
        notes,
        seconds: (seconds * 10.0).round() / 10.0,
        fdr: cutoffs,
    };
    let json = serde_json::to_string_pretty(&outputs).map_err(|e| e.to_string())?;
    let target = dir.join(outputs_record(&record.stem));
    fs::write(&target, json).map_err(|e| {
        format!(
            "The record of the results of {} ({}) cannot be written ({e}).",
            record.name,
            outputs_record(&record.stem)
        )
    })?;
    Ok(outputs)
}

/// How one run ended.
enum RunEnd {
    /// It succeeded; its notes.
    Done(Vec<String>),
    Cancelled,
    /// The search's first run could not start: `start` returns why.
    NotStarted,
    /// It failed (or a later run could not start): the event to send.
    Failed(SearchEvent),
}

/// What a run needs of its search.
struct RunContext<'a> {
    id: &'a str,
    partial: &'a Path,
    records: &'a [InputRecord],
    sink: &'a Sink,
    handle: &'a Handle,
    #[cfg_attr(not(unix), allow(dead_code))]
    watchdog: Option<&'a Path>,
    log: Option<&'a Arc<Mutex<fs::File>>>,
}

/// One run of a tool: OpenNuXL's of an input.
struct ToolRun<'a> {
    /// The executable.
    exe: &'a Path,
    /// Its name in messages ("OpenNuXL").
    name: &'a str,
    args: &'a [OsString],
    /// Whether its stdout is OpenNuXL's: its progress ([`ProgressTracker::feed`]) and its notes ([`note_of`]).
    opennuxl: bool,
}

/// Starts `run` unless the search is cancelled: the process is spawned, and its group set, while the handle's
/// group lock is held, so that a cancel either comes first (the run does not start) or finds the group to end.
/// `None`: cancelled.
fn start_run(
    context: &RunContext,
    run: &ToolRun,
) -> Option<Result<(Child, Arc<sys::Group>), String>> {
    let mut slot = context.handle.group.lock().unwrap();
    if context.handle.cancelled.load(Ordering::SeqCst) {
        return None;
    }
    let mut command = tool::command(run.exe);
    command
        .args(run.args)
        .current_dir(context.partial)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::prepare(&mut command);
    Some(match command.spawn() {
        Ok(child) => {
            let group = Arc::new(sys::Group::new(&child));
            *slot = Some(group.clone());
            Ok((child, group))
        }
        Err(e) => Err(format!(
            "{} ({}) cannot be started ({e}).",
            run.name,
            run.exe.display()
        )),
    })
}

/// Runs `run` to its end, passing on its progress: the log (`$ <command line>`, then its output), the readers of
/// its output, the watchdog. `announce` gives the progress of its start (once it has started). `started` hears of
/// the search's first run's start (or why it could not).
fn run_tool(
    context: &RunContext,
    run: &ToolRun,
    tracker: &mut ProgressTracker,
    announce: impl FnOnce(&mut ProgressTracker) -> crate::progress::ProgressUpdate,
    started: Option<&mpsc::Sender<Result<(), String>>>,
) -> RunEnd {
    let (mut child, group) = match start_run(context, run) {
        None => return RunEnd::Cancelled,
        Some(Ok(started_run)) => started_run,
        Some(Err(message)) => {
            if let Some(started) = started {
                let _ = started.send(Err(message));
                return RunEnd::NotStarted;
            }
            return RunEnd::Failed(failed(context.id, message, tracker, Failure::default()));
        }
    };
    // (macOS) the tool ends with the app, through a watchdog of its own
    #[cfg(unix)]
    let mut watchdog = context
        .watchdog
        .and_then(|exe| crate::watchdog::start(exe, group.pid()));
    if let Some(started) = started {
        let _ = started.send(Ok(()));
    }
    let emit = |p: crate::progress::ProgressUpdate| {
        (context.sink)(SearchEvent::Progress(ProgressEvent {
            search_id: context.id.to_string(),
            label: p.label,
            file: p.file,
            fraction: p.fraction,
        }))
    };
    emit(announce(tracker));
    if let Some(log) = context.log {
        let _ = writeln!(
            log.lock().unwrap(),
            "$ {} {}",
            run.exe.display(),
            run.args
                .iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
        );
    }

    let notes: Arc<Mutex<Vec<String>>> = Arc::default();
    let note = {
        let notes = notes.clone();
        let opennuxl = run.opennuxl;
        move |line: &str| {
            if !opennuxl {
                return;
            }
            if let Some(n) = note_of(line) {
                let mut notes = notes.lock().unwrap();
                if !notes.contains(&n) && notes.len() < MAX_NOTES {
                    notes.push(n);
                }
            }
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let digest = thread::scope(|scope| {
        let err_reader = {
            let (log, note) = (context.log, note.clone());
            scope.spawn(move || {
                let mut digest = StderrDigest::default();
                if let Some(stderr) = stderr {
                    read_lines(stderr, |line| {
                        if line.starts_with("Schema error") {
                            return;
                        }
                        if let Some(log) = log {
                            let _ = writeln!(log.lock().unwrap(), "{line}");
                        }
                        note(line);
                        digest.feed(line);
                    });
                }
                digest
            })
        };
        if let Some(stdout) = stdout {
            read_lines(stdout, |line| {
                if let Some(log) = context.log {
                    let _ = writeln!(log.lock().unwrap(), "{line}");
                }
                note(line);
                if run.opennuxl {
                    if let Some(p) = tracker.feed(line) {
                        emit(p);
                    }
                }
            });
        }
        // (stdout is at its end: the tool has ended or closed it; its stderr goes on to its end)
        err_reader.join().unwrap_or_default()
    });
    let status = child.wait();
    // whatever the tool left running goes with it (and holds no pipe open for the readers)
    group.kill();
    #[cfg(unix)]
    if let Some(watchdog) = watchdog.as_mut() {
        let _ = watchdog.kill();
        let _ = watchdog.wait();
    }
    // the run is over: cancel signals no group any more until the next run's (Windows: closing the job ends
    // anything still in it; the process's own handle goes too, so that it is gone from the process list when
    // cancel returns)
    context.handle.group.lock().unwrap().take();
    drop(group);
    drop(child);
    let notes = std::mem::take(&mut *notes.lock().unwrap());
    if context.handle.cancelled.load(Ordering::SeqCst) {
        return RunEnd::Cancelled;
    }
    match status {
        Ok(status) if status.success() => RunEnd::Done(notes),
        Ok(status) => {
            // a crash: a signal, or on Windows an exception's status (how_tool_ended)
            let signalled = sys::exit_signal(&status).is_some()
                || (cfg!(windows) && status.code().is_some_and(|c| (c as u32) >= 0xC000_0000));
            let message = humanize(&digest.message(signalled), context.partial, context.records);
            let detail = (!digest.tail.is_empty()).then(|| {
                let lines: Vec<&str> = digest.tail.iter().map(String::as_str).collect();
                humanize(&lines.join("\n"), context.partial, context.records)
            });
            RunEnd::Failed(failed(
                context.id,
                message,
                tracker,
                Failure {
                    ended: how_tool_ended(run.name, &status),
                    detail,
                    log: None,
                },
            ))
        }
        Err(e) => RunEnd::Failed(failed(
            context.id,
            format!("Waiting for {} failed ({e}).", run.name),
            tracker,
            Failure::default(),
        )),
    }
}

/// The debug table OpenNuXL writes in every run beside its `-in`, `<-in>.ambiguous_masses.csv`
/// (`calculateNucleotideTags_`: `File::path(in) + '/' + File::basename(in) + ".ambiguous_masses.csv"`, of the input
/// without trailing separators: beside a `.d` folder, not in it), for the input of `record` placed as `placement`
/// in the search folder `partial`.
fn ambiguous_masses_csv(partial: &Path, record: &InputRecord, placement: Placement) -> PathBuf {
    let input = match placement {
        Placement::OwnPath => PathBuf::from(&record.path),
        Placement::Symlink | Placement::HardLink => partial.join(&record.link),
    };
    let mut name = input.file_name().map(OsString::from).unwrap_or_default();
    name.push(AMBIGUOUS_MASSES_SUFFIX);
    input.with_file_name(name)
}

/// The end of the name of OpenNuXL's debug table beside its input ([`ambiguous_masses_csv`]).
const AMBIGUOUS_MASSES_SUFFIX: &str = ".ambiguous_masses.csv";

/// The beginning of OpenNuXL's lines about the QPX mz view (`-out_qpx`): its progress (`-out_qpx: reading spectra`,
/// `-out_qpx: writing <path>`, `-out_qpx: wrote <path> (...)`) and its warnings when it could not write it.
const OUT_QPX: &str = "-out_qpx:";

/// Whether a line of a run is OpenNuXL's progress of the mz view (not a warning).
fn is_mz_view_progress(line: &str) -> bool {
    line.strip_prefix(OUT_QPX).is_some_and(|rest| {
        let rest = rest.trim_start();
        rest.starts_with("reading spectra")
            || rest.starts_with("writing ")
            || rest.starts_with("wrote ")
    })
}

/// The note of an input whose mz view OpenNuXL did not write: its warnings (`-out_qpx: <why>`) say why.
fn mz_view_note(record: &InputRecord, warnings: &[String]) -> String {
    let why: Vec<&str> = warnings
        .iter()
        .map(|w| w.strip_prefix(OUT_QPX).unwrap_or(w).trim())
        .filter(|w| !w.is_empty())
        .collect();
    let why = if why.is_empty() {
        "OpenNuXL wrote no QPX mz view".to_string()
    } else {
        why.join("; ")
    };
    format!(
        "The PSM view shows the annotated peaks only: the spectra of {} could not be kept ({why}).",
        record.name
    )
}

/// Moves the QPX mz view of input `record`'s run, which OpenNuXL wrote into `nuxl/runs/` (named after its `-in`), to
/// `nuxl/<stem>.mz.parquet` ([`mz_view_output`]); `runs/` is then removed when empty. Each run's view is moved before
/// the next run starts, so the one mz view in `runs/` is this run's. None: there is none (OpenNuXL warned why), or
/// it cannot be moved (it is removed then: an mz view of no record is no input's).
pub fn take_mz_view(partial: &Path, record: &InputRecord) -> Option<String> {
    let runs = partial.join(OUTPUT_DIR).join(QPX_RUNS_DIR);
    let written: Vec<PathBuf> = fs::read_dir(&runs)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| e.file_name().to_string_lossy().ends_with(MZ_VIEW_SUFFIX))
        .map(|e| e.path())
        .collect();
    let target = mz_view_output(&record.stem);
    let moved = match written.as_slice() {
        [one] => with_backoff(|| fs::rename(one, partial.join(&target))).is_ok(),
        _ => false,
    };
    // (none, several, or one that could not be moved: nothing of this run stays in runs/)
    if !moved {
        for file in &written {
            let _ = with_backoff(|| fs::remove_file(file));
        }
    }
    let _ = fs::remove_dir(&runs);
    moved.then_some(target)
}

/// Runs the inputs one after the other, passes on their progress, moves each one's mz view into place, records each
/// one's outputs, and settles the folder. Runs on the thread that starts the
/// tools, which is what ties them to the app on Linux (`PR_SET_PDEATHSIG`).
fn supervise(searches: Arc<Searches>, job: Job, started: mpsc::Sender<Result<(), String>>) {
    let Job {
        id,
        tool: tool_path,
        runs: SearchRuns { runs },
        partial,
        done_dir,
        records,
        placements,
        cutoffs,
        rescore,
        notes: search_notes,
        sink,
        handle,
        mut lock,
    } = job;
    let log = fs::File::create(partial.join(LOG_FILE))
        .ok()
        .map(|f| Arc::new(Mutex::new(f)));
    let context = RunContext {
        id: &id,
        partial: &partial,
        records: &records,
        sink: &sink,
        handle: &handle,
        watchdog: searches.watchdog.as_deref(),
        log: log.as_ref(),
    };
    let mut tracker = ProgressTracker::new(records.iter().map(|r| r.name.clone()).collect());
    let mut end = None;
    for (k, ((args, record), placement)) in runs.iter().zip(&records).zip(&placements).enumerate() {
        let started_run = Instant::now();
        let first = (k == 0).then_some(&started);
        let debris = ambiguous_masses_csv(&partial, record, *placement);
        let debris_existed = debris.exists();
        let run = ToolRun {
            exe: &tool_path,
            name: "OpenNuXL",
            args,
            opennuxl: true,
        };
        let ended = run_tool(&context, &run, &mut tracker, |t| t.start_run(k), first);
        // OpenNuXL's debug table beside `-in`: in the search folder (a link), or beside the user's file (Windows,
        // the file's own path), where only the one this run created is removed
        if !debris_existed {
            let _ = with_backoff(|| fs::remove_file(&debris));
        }
        match ended {
            // `start` heard why, and removes the folder
            RunEnd::NotStarted => return,
            RunEnd::Done(mut notes) => {
                // (OpenNuXL warns of too few PSMs for Percolator also when the rescoring is off)
                if !rescore {
                    notes.retain(|n| !n.starts_with(TOO_FEW_PSMS));
                }
                let seconds = started_run.elapsed().as_secs_f64();
                // the spectra of its PSMs for the PSM view: OpenNuXL's mz view, or a note of why there is none
                let (warnings, mut notes): (Vec<String>, Vec<String>) =
                    notes.into_iter().partition(|n| n.starts_with(OUT_QPX));
                let mz = take_mz_view(&partial, record);
                if mz.is_none() {
                    // (the paths of the warnings as the folder will be: the partial one is gone then)
                    let (from, to) = (partial.to_string_lossy(), done_dir.to_string_lossy());
                    let warnings: Vec<String> =
                        warnings.iter().map(|w| w.replace(&*from, &to)).collect();
                    notes.push(mz_view_note(record, &warnings));
                }
                notes.extend(search_notes.iter().cloned());
                if let Err(message) = record_outputs(&partial, record, cutoffs, notes, seconds, mz)
                {
                    end = Some(RunEnd::Failed(failed(
                        &id,
                        message,
                        &tracker,
                        Failure::default(),
                    )));
                    break;
                }
            }
            other => {
                end = Some(other);
                break;
            }
        }
    }
    drop(log);

    // the hard links to the inputs (Windows) have served: they do not belong to the search, and would
    // keep a file the user deletes on the disk
    for (record, placement) in records.iter().zip(&placements) {
        if *placement == Placement::HardLink {
            let _ = with_backoff(|| fs::remove_file(partial.join(&record.link)));
        }
    }
    let outcome = match end {
        Some(RunEnd::Cancelled) | Some(RunEnd::NotStarted) => {
            discard_partial(lock.take(), &partial, None);
            None
        }
        Some(RunEnd::Failed(SearchEvent::Failed(mut f))) => {
            let log = keep_failure_log(&partial);
            discard_partial(lock.take(), &partial, log.as_deref());
            f.log = log.map(|p| p.to_string_lossy().into_owned());
            Some(SearchEvent::Failed(f))
        }
        Some(RunEnd::Failed(other)) => Some(other),
        Some(RunEnd::Done(_)) | None => match finish_partial(lock.take(), &partial, &done_dir) {
            Ok(()) => Some(SearchEvent::Done(DoneEvent {
                search_id: id.clone(),
                folder: done_dir.to_string_lossy().into_owned(),
            })),
            Err(e) => {
                let log = keep_failure_log(&partial);
                discard_partial(None, &partial, log.as_deref());
                Some(failed(
                    &id,
                    format!("The search folder cannot be finished ({e})."),
                    &tracker,
                    Failure {
                        log,
                        ..Failure::default()
                    },
                ))
            }
        },
    };
    searches.running.lock().unwrap().remove(&id);
    if let Some(event) = outcome {
        (sink)(event);
    }
    handle.finish();
}

/// What a failure says beyond its message (see [`FailedEvent`]).
#[derive(Default)]
struct Failure {
    ended: Option<String>,
    detail: Option<String>,
    log: Option<PathBuf>,
}

fn failed(id: &str, message: String, tracker: &ProgressTracker, more: Failure) -> SearchEvent {
    SearchEvent::Failed(FailedEvent {
        search_id: id.to_string(),
        message,
        stage: tracker.label().to_string(),
        file: tracker.file(),
        ended: more.ended,
        detail: more.detail,
        log: more.log.map(|p| p.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod output_tests {
    use super::{find_outputs, threshold};

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn the_thresholds_of_the_derived_names_have_four_decimals() {
        assert_eq!(threshold("1.0000"), Some(1.0));
        assert_eq!(threshold("0.0100"), Some(0.01));
        for text in [
            "1.0",
            "1",
            "perc_1.0000",
            "0.01000",
            "-0.0100",
            ".0100",
            "1.00a0",
        ] {
            assert_eq!(threshold(text), None, "{text}");
        }
    }

    #[test]
    fn the_outputs_of_a_run_are_found_by_their_names() {
        // a run without Percolator (too few PSMs), beside another input's files whose stem begins the same
        let plain = names(&[
            "1__a.idXML",
            "1__a.tsv",
            "1__a_0.0000_peptides.idXML",
            "1__a_1.0000_XLs.idXML",
            "1__a_0.0100_XLs.idXML",
            "1__a_proteins0.0100_XLs.tsv",
            "1__a_sse_perc_in.idXML",
            "11__a_1.0000_XLs.idXML",
            "1__a.outputs.json",
        ]);
        let (percolator, [all, xls, peptides, proteins, report]) = find_outputs(&plain, "1__a");
        assert!(!percolator);
        assert_eq!(all.as_deref(), Some("nuxl/1__a.idXML"));
        assert_eq!(
            xls.as_deref(),
            Some("nuxl/1__a_1.0000_XLs.idXML"),
            "the highest threshold"
        );
        assert_eq!(peptides.as_deref(), Some("nuxl/1__a_0.0000_peptides.idXML"));
        assert_eq!(
            proteins.as_deref(),
            Some("nuxl/1__a_proteins0.0100_XLs.tsv")
        );
        assert_eq!(report.as_deref(), Some("nuxl/1__a.tsv"));

        // after Percolator: its files, though the plain ones are there too
        let mut rescored = plain.clone();
        rescored.extend(names(&[
            "1__a_perc.idXML",
            "1__a_perc.tsv",
            "1__a_perc_0.0000_peptides.idXML",
            "1__a_perc_1.0000_XLs.idXML",
            "1__a_perc_0.0100_XLs.idXML",
            "1__a_perc_proteins0.0100_XLs.tsv",
            "1__a_perc_proteins0.0500_XLs.tsv",
            "1__a.weights",
        ]));
        let (percolator, [all, xls, peptides, proteins, report]) = find_outputs(&rescored, "1__a");
        assert!(percolator);
        assert_eq!(all.as_deref(), Some("nuxl/1__a.idXML"));
        assert_eq!(xls.as_deref(), Some("nuxl/1__a_perc_1.0000_XLs.idXML"));
        assert_eq!(
            peptides.as_deref(),
            Some("nuxl/1__a_perc_0.0000_peptides.idXML")
        );
        assert_eq!(
            proteins.as_deref(),
            Some("nuxl/1__a_perc_proteins0.0100_XLs.tsv"),
            "the lowest threshold"
        );
        assert_eq!(report.as_deref(), Some("nuxl/1__a_perc.tsv"));

        // a cross-link FDR above 10 %: no protein report; nothing at all: all null
        let (_, found) = find_outputs(&names(&["b.idXML", "b_1.0000_XLs.idXML"]), "b");
        assert_eq!(found[3], None);
        let (percolator, found) = find_outputs(&[], "c");
        assert!(!percolator && found.iter().all(Option::is_none));
    }

    /// `-report:xlFDR 1.0 1e-05` (a cross-link FDR of 0.001 %): NuXLFDR names the second file with `%.4f`, so
    /// it is `_0.0000_XLs`, filtered at 1e-5 (a 0 threshold is 1 by then, never "no filter"). `xls` is the
    /// `_1.0000_` file whatever the order of the folder's listing.
    #[test]
    fn a_cross_link_threshold_that_rounds_to_zero_is_not_the_unfiltered_file() {
        let files = [
            "1__a.idXML",
            "1__a_0.0000_peptides.idXML",
            "1__a_1.0000_XLs.idXML",
            "1__a_0.0000_XLs.idXML",
            "1__a_proteins0.0000_XLs.tsv",
        ];
        for order in [files.to_vec(), files.iter().rev().copied().collect()] {
            let (_, [_, xls, peptides, proteins, _]) = find_outputs(&names(&order), "1__a");
            assert_eq!(
                xls.as_deref(),
                Some("nuxl/1__a_1.0000_XLs.idXML"),
                "{order:?}"
            );
            assert_eq!(peptides.as_deref(), Some("nuxl/1__a_0.0000_peptides.idXML"));
            assert_eq!(
                proteins.as_deref(),
                Some("nuxl/1__a_proteins0.0000_XLs.tsv")
            );
        }
    }
}
