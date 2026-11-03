//! The watchdog of a running search (macOS): ends the tool when the app is gone.
//!
//! Linux kills the tool with the app (`PR_SET_PDEATHSIG`) and Windows with its job object; macOS has no
//! such thing. So on macOS the app starts, for each search, its own executable once more with [`FLAG`]: a
//! small process ([`watch`]) that does nothing but look, once a second, whether the app is still its
//! parent (an orphan is taken over by launchd, and its parent pid changes), and ends the tool's process
//! group with SIGKILL when it is not. The app ends the watchdog when the search is over. The code is the
//! same on every Unix (and tested on Linux); only macOS starts it (`lib.rs`, `Searches::with_watchdog`).
//!
//! The watchdog starts before Tauri does anything (`lib.rs`, `run`), so it opens no window and needs
//! nothing of the app's.

use std::ffi::OsString;
use std::os::raw::c_int;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// The command-line flag of the watchdog: `<app> --watch-search <app pid> <process group>`.
pub const FLAG: &str = "--watch-search";
/// How often the watchdog looks.
pub const POLL: Duration = Duration::from_secs(1);

const SIGKILL: c_int = 9;

extern "C" {
    fn getppid() -> c_int;
    fn kill(pid: c_int, sig: c_int) -> c_int;
}

/// Starts the watchdog of the tool's process `group` (the tool's pid: it leads its group), `exe` being the
/// app's executable; None if it cannot be started (the search runs without it).
pub fn start(exe: &Path, group: u32) -> Option<Child> {
    Command::new(exe)
        .arg(FLAG)
        .arg(std::process::id().to_string())
        .arg(group.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

/// The watchdog's work, if the command line (`args`, the program's name first) asks for it: its exit code.
/// None: the command line is the app's.
pub fn from_args(args: &[OsString]) -> Option<i32> {
    let at = args.iter().position(|a| a == FLAG)?;
    let number = |i: usize| -> Option<c_int> {
        args.get(i)?
            .to_str()?
            .parse::<c_int>()
            .ok()
            .filter(|n| *n > 1)
    };
    match (number(at + 1), number(at + 2)) {
        (Some(app), Some(group)) => Some(watch(app, group, POLL)),
        _ => Some(2),
    }
}

/// Looks every `poll` whether the process group `group` still exists (none: the search is over, 0) and
/// whether `app` is still the parent of this process; when it is not, the group is ended with SIGKILL (1).
pub fn watch(app: c_int, group: c_int, poll: Duration) -> i32 {
    loop {
        // SAFETY: kill(2) with signal 0 only checks that the group exists; getppid(2) reads this process's
        // parent. Neither has memory effects.
        if unsafe { kill(-group, 0) } != 0 {
            return 0;
        }
        if unsafe { getppid() } != app {
            // SAFETY: as above; SIGKILL ends every process of the tool's group
            unsafe { kill(-group, SIGKILL) };
            return 1;
        }
        std::thread::sleep(poll);
    }
}
