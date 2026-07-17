use std::path::{Component, Path, PathBuf};

/// Returns the directory that contains this exe — i.e. the "Mod Manager" folder.
/// In production:  <game_dir>/Mod Manager/
/// In `tauri dev`:  cargo target dir / debug or similar — still valid for path math.
pub fn app_dir() -> PathBuf {
    std::env::current_exe()
        .expect("cannot locate current exe")
        .parent()
        .expect("exe has no parent directory")
        .to_owned()
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

#[tauri::command]
pub fn get_framework_root() -> String {
    framework_root().to_string_lossy().replace('\\', "/")
}

#[tauri::command]
pub fn get_app_dir() -> String {
    app_dir().to_string_lossy().replace('\\', "/")
}
