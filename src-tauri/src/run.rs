//! Running a search: the search folder, the process, its progress, and cancel.
//!
//! A search lives in `<searches>/<id>.partial/` while it runs. Beside the tool's outputs it holds
//!
//! - the inputs as links `<n>__<name>` to the user's files (never copies) and `inputs.json`, the
//!   mapping from link to the user's path (see [`crate::args::InputRecord`]). On Windows, where a
//!   symbolic link needs a privilege, ProSE gets the user's paths themselves when the inputs' names
//!   differ, and hard links only for inputs that share a name, removed again when the search ends
//!   ([`crate::args::InputLinks`]);
//! - `database.fasta`, the user's FASTA with the contaminants, if they were asked for;
//! - `prose.log`, the tool's output.
//!
//! The folder holds `.lock`, locked exclusively (`history::lock_partial`) for as long as the search
//! lives, so that the startup sweep of any app instance can tell a live folder from a stale one.
//!
//! On success the folder is renamed to `<searches>/<id>/` and `done` is sent; on failure or cancel it is
//! removed (a failure sends `failed`, a cancel nothing: `cancel` returns when the process is gone). The
//! log of a failed search is kept, as `<app data>/logs/last-failure.log` ([`LAST_FAILURE_LOG`]; the
//! searches folder's sibling), replacing the one before.
//!
//! The tool runs in a process group of its own, started from a thread of its own that waits for it.
//! Cancel signals the group (SIGTERM, then SIGKILL after a grace period), and the group is swept with
//! SIGKILL after the tool has ended, so nothing it started outlives it. If the app dies:
//! - Linux: the tool gets SIGKILL (`PR_SET_PDEATHSIG`; the thread that starts it lives as long as it runs);
//! - Windows: the group is a job object, closed with the app, which ends whatever is still in it (cancel
//!   terminates the job: Windows has no SIGTERM for a console tool);
//! - macOS has no death signal: a watchdog process per search (the app's own executable, started with
//!   `--watch-search`: [`crate::watchdog`]) ends the tool's group within a second of the app's end. Without
//!   it (it could not be started) the tool would end at its next write to stdout or stderr, whose reading
//!   ends died with the app (SIGPIPE, at its default in the child: `Command` resets it, and OpenMS sets no
//!   handler), at the end of its current step; a later start of the app sweeps the folder.

use crate::args::{
    build_args_with, humanize, input_placements, input_records_with, reserved_stem,
    with_contaminants, InputLinks, InputRecord, Placement, SearchRequest, DATABASE_FILE,
    DATABASE_RECORD,
};
use crate::decoys::DecoyRules;
use crate::history::{finish_partial, lock_partial, remove_partial, with_backoff};
use crate::progress::{ProgressTracker, STARTING};
use crate::tool;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    /// The input of the last progress report; absent outside the files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<i32>,
    /// How the tool ended, when it ended badly: "ProSE crashed (signal 11, SIGSEGV)", "ProSE ended with
    /// exit code 3" ([`how_it_ended`]); the message leads with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended: Option<String>,
    /// The last lines the tool wrote to stderr (the user's names for the inputs), for the details.
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

/// A running search, as `cancel` sees it.
struct Handle {
    /// The tool's process group (see `sys::Group`); set before `start` returns, taken when the search
    /// is over.
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
    /// The executable that watches each search's tool ([`crate::watchdog`]; macOS: the app's own), or
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
    use super::how_it_ended;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    /// (wait statuses: a signal in the low seven bits, an exit code in the next byte)
    #[test]
    fn how_a_tool_ended_leads_its_failure() {
        assert_eq!(how_it_ended(&ExitStatus::from_raw(0)), None);
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(3 << 8)).as_deref(),
            Some("ProSE ended with exit code 3")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(11)).as_deref(),
            Some("ProSE crashed (signal 11, SIGSEGV)")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(6)).as_deref(),
            Some("ProSE crashed (signal 6, SIGABRT)")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(9)).as_deref(),
            Some("ProSE crashed (signal 9, SIGKILL; the system may have ended it for lack of memory)")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(31)).as_deref(),
            Some("ProSE crashed (signal 31)")
        );
        // the system's limits (ulimit -f, -t): a run with ulimit -f 50 ended with "signal 25" alone
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(25)).as_deref(),
            Some("ProSE crashed (signal 25, SIGXFSZ; a file grew larger than the system allows, or the disk is full)")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(24)).as_deref(),
            Some("ProSE crashed (signal 24, SIGXCPU; it used more CPU time than the system allows it)")
        );
    }

    /// A partial folder that cannot be removed is said in the kept log of the failure.
    #[test]
    fn a_folder_that_cannot_be_removed_is_noted_in_the_failure_log() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("prose-discard-{}", std::process::id()));
        let searches = base.join("searches");
        let partial = searches.join("1-0.partial");
        std::fs::create_dir_all(partial.join("qpx")).unwrap();
        std::fs::write(partial.join("qpx/a.parquet"), "x").unwrap();
        let kept = base.join("last-failure.log");
        std::fs::write(&kept, "$ ProSE ...\n").unwrap();
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
    use super::{clean_line, read_lines, StderrDigest, MAX_LINE, MAX_SHOWN};

    fn digest(lines: &[&str]) -> StderrDigest {
        let mut d = StderrDigest::default();
        for l in lines {
            d.feed(l);
        }
        d
    }

    const CI: &str = "/home/runner/work/prose-gui/prose-gui/openms/src/openms/source/FORMAT/HANDLERS/XMLHandler.cpp";

    /// A corrupt mzML (in_truncated_mzML, multi_one_corrupt): the place in the file comes before OpenMS'
    /// error, and neither path of the machine that built ProSE is shown.
    #[test]
    fn a_file_that_cannot_be_read_says_where() {
        let location = format!("{CI}(67): While loading '/data/truncated.mzML': input ended before all started tags were ended; last tag started is 'spectrum'( in line 4303 column 2)");
        let error = format!("Error: Unable to read file (- due to that error of type Parse Error in: {CI}@68-void OpenMS::Internal::XMLHandler::fatalError(ActionMode, const std::string&, OpenMS::UInt, OpenMS::UInt) const)");
        let d = digest(&[
            &location,
            "[ProSE] Ion priors: 0 and 0 confident training PSMs in the two halves of the spectra, fewer than 100; the ion_prior_* features are 0 for this file.",
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

    /// A full disk (devfull): the first line that says so, not ProSE's closing summary.
    #[test]
    fn a_full_disk_is_named() {
        let d = digest(&[
            "Progress of 'Predicting fragment intensities and retention times...':",
            "-- done [took 0.02 s (CPU), 0.00 s (Wall)] -- ",
            "Omitted writing of 4 peptide identifications due to empty hits.",
            "ArrowIOHelpers: Failed to write /s/1-0.partial/qpx/runs/1__a.psm.parquet: IOError: Error writing bytes to file. Detail: [errno 28] No space left on device",
            "Failed to write the QPX psm view -> /s/1-0.partial/qpx/runs/1__a.psm.parquet",
            "ArrowIOHelpers: Failed to write /s/1-0.partial/qpx/quantms.psm.parquet: IOError: Error writing bytes to file. Detail: [errno 28] No space left on device",
            "Failed to write the QPX psm view -> /s/1-0.partial/qpx/quantms.psm.parquet",
            "ProSE finished with 1 file(s) failing out of 1.",
        ]);
        assert_eq!(
            d.message(false),
            "Failed to write /s/1-0.partial/qpx/runs/1__a.psm.parquet: IOError: Error writing bytes to file. Detail: [errno 28] No space left on device"
        );
        let idxml = digest(&[
            "Skipping Percolator rescoring for /data/a.mzML: Only 6 PSMs, Percolator rescoring needs at least 100. Keeping the search engine scores.",
            "Percolator rescoring is on (Search:rescore) but no input file could be rescored; all outputs carry the search engine scores.",
            "Failed to write idXML output for /data/a.mzML -> /s/search.idXML: the file '/s/search.idXML' could not be created. writing the file failed (e.g. disk full or I/O error) (writing '/s/search.idXML' did not complete: a partial file may remain)",
            "ProSE finished with 1 file(s) failing out of 1.",
        ]);
        assert!(
            idxml
                .message(false)
                .starts_with("Failed to write idXML output for /data/a.mzML"),
            "{}",
            idxml.message(false)
        );
        // without a line that says more, ProSE's summary
        let summary = digest(&[
            "Omitted writing of 31 peptide identifications due to empty hits.",
            "ProSE finished with 1 file(s) failing out of 1.",
        ]);
        assert_eq!(
            summary.message(false),
            "ProSE finished with 1 file(s) failing out of 1."
        );
    }

    /// Percolator rescored one of two files: the merged idXML cannot be written. In the app's words.
    #[test]
    fn a_partial_rescoring_is_told_in_the_apps_words() {
        let d = digest(&[
            "-qpx_extended: no NCE selected for /s/1-4.partial/2__small.mzML; the predicted_* columns are null.",
            "Cannot write the merged output -> /s/1-4.partial/merged.idXML: Percolator rescored only some of the input files (see the warnings above), and their PSMs cannot be pooled with the search engine scores of the others. Per-file outputs were written. Use '-Search:rescore false', or leave out the files that could not be rescored. (the value '1 of 2 files rescored' was used but is not valid; Percolator rescored only some of the input files, and their PSMs cannot be pooled with the search engine scores of the others.)",
            "ProSE failed to write the merged idXML output -> /s/1-4.partial/merged.idXML.",
        ]);
        let message = d.message(false);
        assert!(
            message.starts_with("Percolator could rescore only some of the files"),
            "{message}"
        );
        assert!(
            message.contains("Turn off Percolator rescoring"),
            "{message}"
        );
        assert!(
            !message.contains("-Search:") && !message.contains("partial"),
            "{message}"
        );
        assert_eq!(
            clean_line("[ProSE] Not pooling the identifications of the input files: Percolator rescored only some of them, and runs of different search engines are not merged. Set 'rescore' to 'false' to pool them with ProSE's scores."),
            "[ProSE] Not pooling the identifications of the input files: Percolator rescored only some of them, and runs of different search engines are not merged. Turn off Percolator rescoring to pool them with ProSE's scores."
        );
    }

    /// A value ProSE refuses: its line, not the last line of the help it prints after it.
    #[test]
    fn a_refused_value_is_named_and_not_the_help() {
        let mut lines = vec![
            "Invalid parameter values (ConversionError): Could not convert string '3000000000' to an integer value. Aborting!".to_string(),
            "stty: 'standard input': Inappropriate ioctl for device".to_string(),
        ];
        for k in 0..200 {
            lines.push(format!(
                "  -Search:option{k} <number>   An option (default: '1')"
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

    /// Killed (signal 9) during Percolator: its last line ("Split 3:") would only mislead.
    #[test]
    fn a_killed_tool_without_an_error_has_no_message() {
        let d = digest(&[
            "Selecting Cneg by cross-validation.",
            "Split 1:\tSelected feature 15 as initial direction. Could separate 51 training set positives with q<0.01 in that direction.",
            "Split 3:",
        ]);
        assert_eq!(d.message(true), "");
        // ended with an exit code: its last line is all there is
        assert_eq!(d.message(false), "Split 3:");
        // the Percolator note before a SIGXFSZ (fsize_50) is no error either
        let note = digest(&["Percolator rescoring of /data/a.mzML: Percolator's sanity check rejected the learned model (on the held-out folds it found no target PSM at q < 0.01, or fewer than the best single feature; typical for blank runs and runs with few confident PSMs), so the PSMs are scored with that feature alone."]);
        assert_eq!(note.message(true), "");
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
            Some("ProSE ended with exit code 3")
        );
        assert_eq!(
            how_it_ended(&ExitStatus::from_raw(0xC000_0005)).as_deref(),
            Some("ProSE crashed (exception 0xC0000005)")
        );
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
        /// before it is assigned, within microseconds, would not be in the job. ProSE starts none.)
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
/// there (and ends with "…"), the rest of it dropped unread into memory.
fn read_lines(stream: impl Read, mut each: impl FnMut(&str)) {
    let mut reader = BufReader::new(stream);
    let mut line: Vec<u8> = Vec::new();
    let mut cut = false;
    let mut emit = |line: &mut Vec<u8>, cut: &mut bool| {
        let text = String::from_utf8_lossy(line);
        let text = text.trim_end_matches(['\n', '\r']);
        if *cut {
            each(&format!("{text}…"));
        } else {
            each(text);
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
        let (taken, ends) = match buffer.iter().position(|&b| b == b'\n') {
            Some(at) => (at + 1, true),
            None => (buffer.len(), false),
        };
        let room = MAX_LINE.saturating_sub(line.len());
        line.extend_from_slice(&buffer[..taken.min(room)]);
        cut |= taken > room;
        reader.consume(taken);
        if ends {
            emit(&mut line, &mut cut);
        }
    }
    if !line.is_empty() {
        emit(&mut line, &mut cut);
    }
}

fn is_noise(line: &str) -> bool {
    line.trim().is_empty() || line.starts_with("Schema error") || line.starts_with("Warning:")
}

/// ProSE's own summary of failed files: the last resort of a message.
fn is_summary(line: &str) -> bool {
    line.starts_with("ProSE finished with") || line.starts_with("ProSE failed to write")
}

/// Where a file could not be parsed (OpenMS' XML handlers: "While loading '<file>': ... (in line 4303 column 2)").
fn is_location(line: &str) -> bool {
    line.starts_with("While loading '")
}

/// A line that tells of an error: OpenMS' "Error: ..." of a tool that stops, and ProSE's and OpenMS' error
/// lines of a step that failed (a file that cannot be written or read, a value that is not valid).
fn is_error(line: &str) -> bool {
    const STARTS: &[&str] = &[
        "Error",
        "Invalid parameter",
        "Cannot ",
        "Unable to ",
        "Failed to ",
        "refusing ",
        "terminate called",
        "Percolator could rescore only some",
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
    !is_summary(line)
        && (STARTS.iter().any(|s| line.starts_with(s)) || HAS.iter().any(|s| line.contains(s)))
}

/// ProSE's hints in command-line words, in the app's (the app has no command line).
const HINTS: &[(&str, &str)] = &[
    (
        "Use '-Search:rescore false', or",
        "Turn off Percolator rescoring, or",
    ),
    ("Set 'rescore' to 'false'", "Turn off Percolator rescoring"),
    (
        "Set -Search:decoy_prefix to",
        "Set the decoy prefix (decoy_prefix) to",
    ),
    ("Use '-Search:decoys ignore'", "Set decoys to ignore"),
    ("Use '-Search:decoys generate'", "Set decoys to generate"),
];

/// A line of the tool's stderr as a failure shows it: without OpenMS' source locations (paths of the
/// machine that built ProSE) and exception boilerplate, ProSE's command-line hints in the app's words, and
/// at most [`MAX_SHOWN`] characters.
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
    if let Some(rest) = text.strip_prefix("ArrowIOHelpers: ") {
        text = rest.to_string();
    }
    // the merged idXML of a search that Percolator could rescore only in part (ProSE.cpp): in plain words
    if text.contains("Percolator rescored only some of the input files")
        && text.starts_with("Cannot write the merged output")
    {
        text = "Percolator could rescore only some of the files, and their PSMs cannot be pooled with the search \
                engine scores of the others. Turn off Percolator rescoring, or leave out the files that could not \
                be rescored."
            .to_string();
    }
    // an InvalidValue's repetition of the message: "(the value '1 of 2 files rescored' was used but is not valid; ...)"
    if let Some(at) = text.find(" (the value '") {
        if text[at..].contains("' was used but is not valid") {
            text.truncate(at);
        }
    }
    for (from, to) in HINTS {
        text = text.replace(from, to);
    }
    if text.chars().count() > MAX_SHOWN {
        text = format!("{}…", text.chars().take(MAX_SHOWN).collect::<String>());
    }
    text
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
    /// ProSE's last summary of failed files.
    summary: Option<String>,
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
        } else if is_summary(&clean) {
            self.summary = Some(clean.clone());
        }
        if is_error(&clean) && self.errors.len() < ERROR_LINES {
            self.errors.push(clean);
        }
    }

    /// The message of a failure: OpenMS' last "Error..." line (one of reading a file with the place in the
    /// file before it), else the first error line ProSE wrote (the cause; the next ones are its consequences),
    /// else ProSE's summary ("ProSE finished with 1 file(s) failing out of 1."), else, for a tool that ended
    /// with an exit code, its last line. Empty for a tool killed by a signal without an error: its last line
    /// (Percolator's "Split 3:") would only mislead.
    fn message(&self, signalled: bool) -> String {
        if let Some((error, location)) = &self.fatal {
            return match location {
                Some(location) if error.contains("Unable to read") => {
                    format!("{error}. {location}")
                }
                _ => error.clone(),
            };
        }
        if let Some(error) = self.errors.first().or(self.summary.as_ref()) {
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

/// How a tool that did not succeed ended, the lead of its failure: "ProSE crashed (signal 11, SIGSEGV)"
/// (SIGKILL: the system may have ended it for lack of memory), on Windows "ProSE crashed (exception
/// 0xC0000005)" for an exception's status, else "ProSE ended with exit code 3"; None for success.
pub fn how_it_ended(status: &ExitStatus) -> Option<String> {
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
        return Some(format!("ProSE crashed (signal {signal}{name}{oom})"));
    }
    Some(match status.code() {
        // an NTSTATUS error (0xC…): an access violation, a stack overflow, ...
        Some(code) if cfg!(windows) && (code as u32) >= 0xC000_0000 => {
            format!("ProSE crashed (exception 0x{:08X})", code as u32)
        }
        Some(code) => format!("ProSE ended with exit code {code}"),
        None => "ProSE ended unexpectedly".to_string(),
    })
}

/// Keeps the log of a failed search (`prose.log` of its partial folder) as `<app data>/logs/`
/// [`LAST_FAILURE_LOG`], replacing the one before; the path, or None if there is none.
fn keep_failure_log(partial: &Path) -> Option<PathBuf> {
    let logs = partial.parent()?.parent()?.join("logs");
    fs::create_dir_all(&logs).ok()?;
    let kept = logs.join(LAST_FAILURE_LOG);
    fs::copy(partial.join("prose.log"), &kept).ok()?;
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
    args: Vec<std::ffi::OsString>,
    partial: PathBuf,
    done_dir: PathBuf,
    records: Vec<InputRecord>,
    placements: Vec<Placement>,
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

    /// The same, each search's tool watched by `exe --watch-search` ([`crate::watchdog`]; Unix): the app's
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

    /// Checks the request, makes the search folder and starts the tool; returns the search id. The
    /// events go to `sink`. `crap` is the contaminant FASTA, needed if the request asks for them.
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
        let args = build_args_with(&request, &partial, self.links)?;

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
        if let Err(e) = prepare_folder(&partial, &request, &records, &placements, crap) {
            discard_partial(Some(lock), &partial, None);
            return Err(e);
        }

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
            args,
            partial: partial.clone(),
            done_dir,
            records,
            placements,
            sink,
            handle,
            lock: Some(lock),
        };
        let (started_tx, started_rx) = mpsc::channel();
        let searches = self.clone();
        let spawned = thread::Builder::new()
            .name(format!("prose-{id}"))
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

    /// Stops a search: its process group gets SIGTERM, and SIGKILL if it is still there after a few
    /// seconds (Windows: its job is terminated at once). Returns when the process is gone and the
    /// partial folder is removed. A search that is not running (finished, or never existed) is not an
    /// error.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let Some(handle) = self.running.lock().unwrap().get(id).cloned() else {
            return Ok(());
        };
        handle.cancelled.store(true, Ordering::SeqCst);
        let group = handle.group();
        if let Some(group) = &group {
            group.terminate();
        }
        if handle.wait_finished(GRACE) {
            return Ok(());
        }
        if let Some(group) = &group {
            group.kill();
        }
        if handle.wait_finished(KILL_WAIT) {
            Ok(())
        } else {
            let pid = group.map(|g| g.pid()).unwrap_or(0);
            Err(format!("ProSE (process {pid}) did not stop."))
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
                if let Some(group) = &group {
                    group.kill();
                }
                handle.wait_finished(KILL_WAIT);
            }
        }
    }
}

/// The links, `inputs.json` and, with contaminants, `database.fasta`.
fn prepare_folder(
    dir: &Path,
    request: &SearchRequest,
    records: &[InputRecord],
    placements: &[Placement],
    crap: Option<&Path>,
) -> Result<(), String> {
    for ((file, record), placement) in request.files.iter().zip(records).zip(placements) {
        let original = fs::canonicalize(&file.path).unwrap_or_else(|_| PathBuf::from(&file.path));
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
            Placement::HardLink => fs::hard_link(&original, &link).map_err(|e| {
                // (a name too long for ProSE's outputs in the search folder: its link's name is shortened)
                if !record.link.ends_with(&record.name) && !reserved_stem(&record.name) {
                    return format!(
                        "The name of {} is too long for ProSE's result files in the app's data folder ({}), whose \
                         names and paths it makes from the file's name. The app links such a file into the search \
                         folder under a shorter name, but Windows can make that link only on the drive of the app's \
                         data and on NTFS. {} cannot be linked there ({e}). Rename the file to a shorter name and \
                         start the search again.",
                        record.name,
                        dir.parent().unwrap_or(dir).display(),
                        file.path
                    );
                }
                if reserved_stem(&record.name) {
                    return format!(
                        "ProSE cannot search a file named {} under that name, because its own result files are \
                         called quantms. The app links such a file into the search folder under another name, but \
                         Windows can make that link only on the drive of the app's data ({}) and on NTFS. {} cannot \
                         be linked there ({e}). Rename the file and start the search again.",
                        record.name,
                        dir.parent().unwrap_or(dir).display(),
                        file.path
                    );
                }
                format!(
                    "Two inputs are named {}. ProSE names its results after the files, so files of one \
                     name are searched together only through links in the search folder, which Windows \
                     can make only on the drive of the app's data ({}) and on NTFS; {} cannot be linked \
                     there ({e}). Rename one of the files and start the search again.",
                    record.name,
                    dir.parent().unwrap_or(dir).display(),
                    file.path
                )
            })?,
        }
    }
    let json = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    fs::write(dir.join("inputs.json"), json)
        .map_err(|e| format!("inputs.json cannot be written ({e})."))?;
    if request.contaminants {
        let crap =
            crap.ok_or("The contaminant database (cRAP) is not available in this installation.")?;
        let rules = DecoyRules::of(&request.settings.parameters);
        with_contaminants(
            Path::new(&request.database),
            crap,
            &dir.join(DATABASE_FILE),
            &rules,
        )
        .map_err(|e| match e.kind() {
            // (the user's database: the message says what is wrong with it)
            std::io::ErrorKind::InvalidData => e.to_string(),
            _ => format!("The database with contaminants cannot be written ({e})."),
        })?;
    } else {
        // the one file outside the folder that the results reader may read (files::resolve_search_file)
        let record = serde_json::json!({ "path": request.database }).to_string();
        fs::write(dir.join(DATABASE_RECORD), record)
            .map_err(|e| format!("{DATABASE_RECORD} cannot be written ({e})."))?;
    }
    Ok(())
}

/// Runs the tool, passes on its progress, and settles the folder. Runs on the thread that started the
/// tool, which is what ties the tool to the app on Linux (`PR_SET_PDEATHSIG`).
fn supervise(searches: Arc<Searches>, job: Job, started: mpsc::Sender<Result<(), String>>) {
    let Job {
        id,
        tool: tool_path,
        args,
        partial,
        done_dir,
        records,
        placements,
        sink,
        handle,
        mut lock,
    } = job;
    let mut command = tool::command(&tool_path);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    sys::prepare(&mut command);
    let mut child: Child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            let _ = started.send(Err(format!(
                "The ProSE tool {} cannot be started ({e}).",
                tool_path.display()
            )));
            return;
        }
    };
    let group = Arc::new(sys::Group::new(&child));
    *handle.group.lock().unwrap() = Some(group.clone());
    // (macOS) the tool ends with the app, through a watchdog of its own
    #[cfg(unix)]
    let mut watchdog = searches
        .watchdog
        .as_deref()
        .and_then(|exe| crate::watchdog::start(exe, group.pid()));
    let _ = started.send(Ok(()));
    let emit = |event: SearchEvent| (sink)(event);
    emit(SearchEvent::Progress(ProgressEvent {
        search_id: id.clone(),
        label: STARTING.to_string(),
        file: -1,
        fraction: 0.0,
    }));

    let log = fs::File::create(partial.join("prose.log"))
        .ok()
        .map(|f| Arc::new(Mutex::new(f)));
    if let Some(log) = &log {
        let _ = writeln!(
            log.lock().unwrap(),
            "$ {} {}",
            tool_path.display(),
            args.iter()
                .map(|a| a.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ")
        );
    }

    let names: Vec<String> = records.iter().map(|r| r.name.clone()).collect();
    let stdout = child.stdout.take();
    let out_reader = {
        let (sink, id, log) = (sink.clone(), id.clone(), log.clone());
        thread::spawn(move || {
            let mut tracker = ProgressTracker::new(names);
            if let Some(stdout) = stdout {
                read_lines(stdout, |line| {
                    if let Some(log) = &log {
                        let _ = writeln!(log.lock().unwrap(), "{line}");
                    }
                    if let Some(p) = tracker.feed(line) {
                        sink(SearchEvent::Progress(ProgressEvent {
                            search_id: id.clone(),
                            label: p.label,
                            file: p.file,
                            fraction: p.fraction,
                        }));
                    }
                });
            }
            tracker
        })
    };
    let stderr = child.stderr.take();
    let err_reader = {
        let log = log.clone();
        thread::spawn(move || {
            let mut digest = StderrDigest::default();
            if let Some(stderr) = stderr {
                read_lines(stderr, |line| {
                    if line.starts_with("Schema error") {
                        return;
                    }
                    if let Some(log) = &log {
                        let _ = writeln!(log.lock().unwrap(), "{line}");
                    }
                    digest.feed(line);
                });
            }
            digest
        })
    };

    let status = child.wait();
    // whatever the tool left running goes with it (and holds no pipe open for the readers)
    group.kill();
    #[cfg(unix)]
    if let Some(watchdog) = watchdog.as_mut() {
        let _ = watchdog.kill();
        let _ = watchdog.wait();
    }
    let tracker = out_reader
        .join()
        .unwrap_or_else(|_| ProgressTracker::new(Vec::new()));
    let digest = err_reader.join().unwrap_or_default();
    drop(log);

    // the hard links to the inputs (Windows) have served: they do not belong to the search, and would
    // keep a file the user deletes on the disk
    for (record, placement) in records.iter().zip(&placements) {
        if *placement == Placement::HardLink {
            let _ = with_backoff(|| fs::remove_file(partial.join(&record.link)));
        }
    }
    let outcome = if handle.cancelled.load(Ordering::SeqCst) {
        discard_partial(lock.take(), &partial, None);
        None
    } else {
        match status {
            Ok(status) if status.success() => {
                match finish_partial(lock.take(), &partial, &done_dir) {
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
                }
            }
            Ok(status) => {
                // a crash: a signal, or on Windows an exception's status (how_it_ended)
                let signalled = sys::exit_signal(&status).is_some()
                    || (cfg!(windows) && status.code().is_some_and(|c| (c as u32) >= 0xC000_0000));
                let message = humanize(&digest.message(signalled), &partial, &records);
                let detail = (!digest.tail.is_empty()).then(|| {
                    let lines: Vec<&str> = digest.tail.iter().map(String::as_str).collect();
                    humanize(&lines.join("\n"), &partial, &records)
                });
                let log = keep_failure_log(&partial);
                discard_partial(lock.take(), &partial, log.as_deref());
                Some(failed(
                    &id,
                    message,
                    &tracker,
                    Failure {
                        ended: how_it_ended(&status),
                        detail,
                        log,
                    },
                ))
            }
            Err(e) => {
                let log = keep_failure_log(&partial);
                discard_partial(lock.take(), &partial, log.as_deref());
                Some(failed(
                    &id,
                    format!("Waiting for ProSE failed ({e})."),
                    &tracker,
                    Failure {
                        log,
                        ..Failure::default()
                    },
                ))
            }
        }
    };
    searches.running.lock().unwrap().remove(&id);
    // (Windows: closing the job ends anything still in it; the process's own handle goes too, so that
    // it is gone from the process list when cancel returns)
    handle.group.lock().unwrap().take();
    drop(group);
    drop(child);
    if let Some(event) = outcome {
        emit(event);
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
