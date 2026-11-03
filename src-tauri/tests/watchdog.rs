//! The watchdog of a search (macOS's way of ending the tool with the app, `src/watchdog.rs`): the same code
//! on every Unix, so it is tested here on Linux too, with the app's executable as the watchdog.
#![cfg(unix)]

use prose_desktop_lib::watchdog::{from_args, FLAG};
use std::ffi::OsString;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const APP: &str = env!("CARGO_BIN_EXE_prose-desktop");

/// The "tool": a process group of its own, as the shim starts ProSE.
fn tool(seconds: u32) -> Child {
    Command::new("sleep")
        .arg(seconds.to_string())
        .process_group(0)
        .spawn()
        .unwrap()
}

fn ended_within(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

#[test]
fn the_watchdog_ends_the_tools_group_when_the_app_is_gone() {
    let mut tool = tool(300);
    let group = tool.id();
    // the "app": a shell that starts the watchdog as its child, then becomes a long sleep (same pid)
    let mut app = Command::new("sh")
        .arg("-c")
        .arg(format!("'{APP}' {FLAG} $$ {group} & exec sleep 300"))
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    // while the app lives, the tool runs
    std::thread::sleep(Duration::from_millis(2500));
    assert!(tool.try_wait().unwrap().is_none(), "the tool still runs");
    // the app dies, as an app that is killed or crashes: nothing of its own runs any more
    app.kill().unwrap();
    app.wait().unwrap();
    let status = ended_within(&mut tool, Duration::from_secs(10))
        .expect("the watchdog ended the tool within a few seconds of the app's end");
    assert_eq!(status.signal(), Some(9), "SIGKILL: {status:?}");
}

#[test]
fn the_watchdog_ends_itself_when_the_search_is_over() {
    let mut tool = tool(1);
    let mut watchdog = Command::new(APP)
        .args([
            FLAG,
            &std::process::id().to_string(),
            &tool.id().to_string(),
        ])
        .spawn()
        .unwrap();
    // the search ends (the shim reaps the tool): the group is gone, and the watchdog with it
    tool.wait().unwrap();
    let status = ended_within(&mut watchdog, Duration::from_secs(10))
        .expect("the watchdog ended when its group did");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn a_command_line_without_the_flag_is_the_apps() {
    let args = |a: &[&str]| a.iter().map(OsString::from).collect::<Vec<_>>();
    assert_eq!(from_args(&args(&["prose-desktop"])), None);
    assert_eq!(from_args(&args(&["prose-desktop", "--smoke-test"])), None);
    // the flag with what is not a pid: refused, and never a group of 1 or below (kill(-1) is everyone's)
    for bad in [
        &["prose-desktop", FLAG][..],
        &["prose-desktop", FLAG, "12"],
        &["prose-desktop", FLAG, "x", "12"],
        &["prose-desktop", FLAG, "12", "1"],
        &["prose-desktop", FLAG, "12", "0"],
        &["prose-desktop", FLAG, "12", "-5"],
    ] {
        assert_eq!(from_args(&args(bad)), Some(2), "{bad:?}");
    }
}
