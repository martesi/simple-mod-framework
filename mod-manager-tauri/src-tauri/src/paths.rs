use std::path::{Component, Path, PathBuf};

/// Returns the directory that contains this exe — i.e. the "Mod Manager" folder.
/// In production:  <game_dir>/Mod Manager/
/// In `tauri dev` / debug builds, the compiled binary lives deep under
/// `src-tauri/target/debug/`, nowhere near the real on-disk framework layout —
/// so `current_exe()`-based resolution would point at garbage. Debug builds
/// instead anchor to the *source tree* via `CARGO_MANIFEST_DIR` (baked in at
/// compile time) and point at the repo's top-level `build/` folder, the same
/// folder `npm run build:win` at the repo root produces (Deploy.exe, Mods/,
/// Third-Party/, config.json). That lets `tauri dev` exercise the real CLI
/// build directly with no manual staging.
pub fn app_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        dev_app_dir()
    } else {
        std::env::current_exe()
            .expect("cannot locate current exe")
            .parent()
            .expect("exe has no parent directory")
            .to_owned()
    }
}

/// Dev-only: `<repo root>/build/Mod Manager`. This directory doesn't need to
/// exist on disk — it's purely a lexical anchor so relative paths like
/// `"../config.json"` resolve the same way they do in production (one level
/// below the framework root). It's `framework_root()`, its parent, that
/// actually needs to exist — see `debug_check_layout()` below.
fn dev_app_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo root>/mod-manager-tauri/src-tauri
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent() // mod-manager-tauri/
        .and_then(Path::parent) // <repo root>
        .expect("CARGO_MANIFEST_DIR has an unexpected shape")
        .to_owned();
    repo_root.join("build").join("Mod Manager")
}

/// The framework root is one level above the app dir:  <game_dir>/
pub fn framework_root() -> PathBuf {
    app_dir()
        .parent()
        .expect("app_dir has no parent")
        .to_owned()
}

/// Resolve a path string (possibly relative, like "../Mods") to an absolute PathBuf.
/// Relative paths are anchored to app_dir(), matching the Electron CWD behaviour.
pub fn resolve(rel_path: &str) -> PathBuf {
    let p = Path::new(rel_path);
    let joined = if p.is_absolute() {
        p.to_owned()
    } else {
        app_dir().join(p)
    };
    normalize(joined)
}

/// Lexically normalize a path: collapse `..` and `.` without touching the FS.
pub fn normalize(path: PathBuf) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            c => result.push(c),
        }
    }
    result
}

/// Dev-only sanity check — call once at startup (see `lib.rs::run()`).
/// Verifies `framework_root()` resolves to a real, populated `build/` folder
/// *before* any command handler tries to use it, so a missing/half-built CLI
/// fails loudly at launch with a fix-it message instead of surfacing later as
/// a confusing "file not found" three clicks into the UI. `debug_assert!`
/// (and this whole function, via `#[cfg(debug_assertions)]`) compiles out
/// entirely in release builds.
#[cfg(debug_assertions)]
pub fn debug_check_layout() {
    let root = framework_root();

    debug_assert!(
        root.is_dir(),
        "framework_root() does not resolve to a real directory: {}\n\
         → run `npm install && npm run build:win` at the repo root to produce \
         build/ (Deploy.exe, Mods/, Third-Party/, config.json) before `tauri dev`.",
        root.display()
    );

    for rel in ["Deploy.exe", "Mods", "Third-Party", "config.json"] {
        let p = root.join(rel);
        debug_assert!(
            p.exists(),
            "expected \"{}\" under framework_root ({}) but it's missing — \
             the build/ folder looks incomplete. Re-run `npm run build:win` \
             (and `npm run setup` if Third-Party/ tools are what's missing).",
            rel,
            root.display()
        );
    }

    let seven_zip = root.join("Third-Party").join("7z.exe");
    debug_assert!(
        seven_zip.exists(),
        "Third-Party/7z.exe is missing under {} — archive extraction (mod \
         install) will fail until it's present. It's fetched by \
         `npm run setup` (scripts/fetch-third-party.js) at the repo root, \
         which only auto-downloads it on Windows; on Linux/WSL place a build \
         at \"For Build/Fetched Third-Party/7z.exe\" by hand.",
        root.display()
    );
}

#[tauri::command]
pub fn get_framework_root() -> String {
    framework_root().to_string_lossy().replace('\\', "/")
}

#[tauri::command]
pub fn get_app_dir() -> String {
    app_dir().to_string_lossy().replace('\\', "/")
}
