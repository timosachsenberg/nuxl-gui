fn main() {
    // `resources/prose` (the bundled ProSE, a resource in tauri.conf.json) is made by
    // native/scripts/bundle-prose.sh and is not in git. Tauri refuses a resource path that does not
    // exist, so a build without the bundle (development, the unit tests) gets an empty folder; the app
    // then finds the tool through PROSE_BIN or the PATH.
    std::fs::create_dir_all("resources/prose").expect("cannot create src-tauri/resources/prose");
    // the same for the third-party notices, which scripts/third-party-notices.mjs makes when the packages
    // are built (native/scripts/package-*.sh)
    std::fs::create_dir_all("resources/notices")
        .expect("cannot create src-tauri/resources/notices");
    tauri_build::build()
}
