//! The new-version check's two parts in Rust (the check itself is the page's: `src/lib/update/`): whether the
//! automatic check at start may run ([`check_at_start`]), and the release page of a version opened in the system's
//! browser ([`release_page_url`], [`open_url`]). The page names a version, never a URL: the URL is built here, for
//! a version of digits and dots only, on this repository's releases.

use std::ffi::OsStr;
use std::process::{Command, Stdio};

/// The releases of the app: a release's page is `<RELEASES>desktop-native-v<version>`.
pub const RELEASES: &str = "https://github.com/timosachsenberg/nuxl-gui/releases/tag/";

/// The tag prefix of a release (`desktop-native-v0.3.0`).
pub const TAG_PREFIX: &str = "desktop-native-v";

/// The variable that turns the automatic check at start off (any value but empty): for the end-to-end specs, and
/// for computers that are not to contact GitHub at all. The check of "Check for updates" still runs when asked.
pub const NO_CHECK_VARIABLE: &str = "NUXL_NO_UPDATE_CHECK";

/// A version as the releases have it: `major.minor.patch`, each part 1 to 6 digits.
pub fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// The page of the release of `version` on GitHub, or None for anything that is not a version.
pub fn release_page_url(version: &str) -> Option<String> {
    valid_version(version).then(|| format!("{RELEASES}{TAG_PREFIX}{version}"))
}

/// Whether the automatic check at start may run, given the value of [`NO_CHECK_VARIABLE`].
pub fn check_at_start_with(no_check: Option<&OsStr>) -> bool {
    no_check.is_none_or(|v| v.is_empty())
}

/// Whether the automatic check at start may run (the user's setting is the page's).
pub fn check_at_start() -> bool {
    check_at_start_with(std::env::var_os(NO_CHECK_VARIABLE).as_deref())
}

/// Variables an AppImage's AppRun (and its GTK hook) sets for the app's own libraries, GTK and GIO modules: the
/// browser that `xdg-open` starts must not inherit them (it would load the AppImage's libraries, or none of its own
/// modules). Removed when the app runs as an AppImage (`APPIMAGE` set).
pub const APPIMAGE_VARIABLES: &[&str] = &[
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GDK_BACKEND",
    "GTK_PATH",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GTK_THEME",
    "GSETTINGS_SCHEMA_DIR",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
];

/// The command that opens `url` in the system's browser: `xdg-open` (Linux and other Unix), `open` (macOS),
/// `rundll32 url.dll,FileProtocolHandler` (Windows: no shell, so nothing of the URL is interpreted). The URL is one
/// argument; [`release_page_url`]'s have only letters, digits, `.`, `-`, `/` and `:`. (Also a folder's path, which
/// the file manager opens: [`open_target`].)
pub fn opener(url: impl AsRef<OsStr>, appimage: bool) -> Command {
    let mut command = if cfg!(target_os = "macos") {
        Command::new("open")
    } else if cfg!(windows) {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    } else {
        Command::new("xdg-open")
    };
    command.arg(url);
    if appimage {
        for name in APPIMAGE_VARIABLES {
            command.env_remove(name);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

/// Opens `url` in the system's browser. The opener is waited for on a thread of its own (it may wait for the
/// browser), so that it leaves no zombie behind; only a failure to start it is an error.
pub fn open_url(url: &str) -> Result<(), String> {
    open_target(OsStr::new(url))
        .map_err(|e| format!("The browser could not be opened ({e}). The page: {url}"))
}

/// Opens `target` (a URL, or a folder's path: the file manager) with the system's opener ([`opener`]), as
/// [`open_url`] does.
pub fn open_target(target: &OsStr) -> Result<(), std::io::Error> {
    let appimage = std::env::var_os("APPIMAGE").is_some_and(|v| !v.is_empty());
    let mut child = opener(target, appimage).spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_three_numbers() {
        for ok in ["0.3.0", "1.2.3", "10.20.30", "0.0.1", "123456.0.0"] {
            assert!(valid_version(ok), "{ok}");
        }
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "1..3",
            ".1.2",
            "1.2.",
            "v1.2.3",
            "1.2.3-beta",
            "1.2.3 ",
            " 1.2.3",
            "1.2.x",
            "1234567.0.0",
            "1/2/3",
            "1.2.3/../../evil",
            "1.2.3?x=1",
            "1.2.3#a",
            "1.2.3&calc",
            "1.2.3\" & calc",
            "１.２.３",
            "https://evil.example/",
        ] {
            assert!(!valid_version(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_release_page_is_built_from_the_version() {
        assert_eq!(
            release_page_url("0.4.0").as_deref(),
            Some("https://github.com/timosachsenberg/nuxl-gui/releases/tag/desktop-native-v0.4.0")
        );
        assert_eq!(release_page_url("0.4"), None);
        assert_eq!(release_page_url("https://evil.example/0.4.0"), None);
        assert_eq!(release_page_url("0.4.0 --new-window"), None);
    }

    #[test]
    fn the_check_at_start_is_off_with_the_variable() {
        assert!(check_at_start_with(None));
        assert!(check_at_start_with(Some(OsStr::new(""))));
        assert!(!check_at_start_with(Some(OsStr::new("1"))));
        assert!(!check_at_start_with(Some(OsStr::new("anything"))));
    }

    #[test]
    fn the_opener_gets_the_url_as_one_argument() {
        let url = release_page_url("1.2.3").unwrap();
        let command = opener(&url, false);
        let args: Vec<_> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args.last(), Some(&url));
        if cfg!(windows) {
            assert_eq!(command.get_program(), "rundll32");
            assert_eq!(args, vec!["url.dll,FileProtocolHandler".to_string(), url]);
        } else if cfg!(target_os = "macos") {
            assert_eq!(command.get_program(), "open");
        } else {
            assert_eq!(command.get_program(), "xdg-open");
            assert_eq!(args, vec![url]);
        }
        // nothing of the environment is changed outside an AppImage
        assert_eq!(command.get_envs().count(), 0);
    }

    #[test]
    fn from_an_appimage_the_browser_gets_the_systems_libraries() {
        let command = opener(release_page_url("1.2.3").unwrap(), true);
        let removed: Vec<_> = command
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        for name in ["LD_LIBRARY_PATH", "GIO_MODULE_DIR", "GTK_PATH", "APPIMAGE"] {
            assert!(removed.iter().any(|r| r == name), "{name} kept");
        }
    }
}
