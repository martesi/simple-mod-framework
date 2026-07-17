use crate::paths;
use serde::Serialize;
use std::{fs, io};

#[derive(Serialize)]
pub struct WalkEntry {
    pub path: String,
}

#[tauri::command]
pub fn fs_read_text(path: String) -> Result<String, String> {
    fs::read_to_string(paths::resolve(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_text(path: String, data: String) -> Result<(), String> {
    let resolved = paths::resolve(&path);
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(resolved, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    paths::resolve(&path).exists()
}

#[tauri::command]
pub fn fs_is_file(path: String) -> bool {
    paths::resolve(&path).is_file()
}

#[tauri::command]
pub fn fs_read_dir(path: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(paths::resolve(&path)).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    Ok(names)
}

#[tauri::command]
pub fn fs_copy(src: String, dest: String) -> Result<(), String> {
    copy_dir_all(&paths::resolve(&src), &paths::resolve(&dest)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_copy_file(src: String, dest: String) -> Result<(), String> {
    let dest_path = paths::resolve(&dest);
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(paths::resolve(&src), dest_path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_remove(path: String) -> Result<(), String> {
    let resolved = paths::resolve(&path);
    if !resolved.exists() {
        return Ok(());
    }
    if resolved.is_dir() {
        fs::remove_dir_all(resolved).map_err(|e| e.to_string())
    } else {
        fs::remove_file(resolved).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn fs_empty_dir(path: String) -> Result<(), String> {
    let resolved = paths::resolve(&path);
    if resolved.exists() {
        fs::remove_dir_all(&resolved).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_ensure_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(paths::resolve(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn klaw_walk(path: String, nodir: bool, depth_limit: i32) -> Result<Vec<WalkEntry>, String> {
    let mut results = Vec::new();
    walk_dir(&paths::resolve(&path), &mut results, nodir, 0, depth_limit)?;
    Ok(results)
}

fn walk_dir(
    dir: &std::path::Path,
    results: &mut Vec<WalkEntry>,
    nodir: bool,
    current_depth: i32,
    depth_limit: i32,
) -> Result<(), String> {
    if depth_limit >= 0 && current_depth > depth_limit {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let is_dir = path.is_dir();
        if !is_dir || !nodir {
            results.push(WalkEntry {
                path: path.to_string_lossy().replace('\\', "/"),
            });
        }
        if is_dir {
            walk_dir(&path, results, nodir, current_depth + 1, depth_limit)?;
        }
    }
    Ok(())
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}
