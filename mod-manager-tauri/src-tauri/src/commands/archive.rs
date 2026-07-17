use crate::paths;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::process::Command;

#[tauri::command]
pub fn extract_archive(archive_path: String, dest_dir: String) -> Result<(), String> {
    let archive = paths::resolve(&archive_path);
    let dest = paths::resolve(&dest_dir);

    // 7z.exe lives in Third-Party/ relative to the framework root
    let seven_zip = paths::framework_root().join("Third-Party").join("7z.exe");

    let dest_arg = format!("-o{}", dest.display());

    let output = Command::new(&seven_zip)
        .args([
            "x",
            archive.to_str().unwrap_or_default(),
            "-aoa",
            "-y",
            &dest_arg,
        ])
        .output()
        .map_err(|e| format!("Failed to run 7z: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "7z failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Accept binary data as a base64 string and write it to disk.
/// Used for the one case where the frontend fetches an archive over the
/// network into memory and needs to persist it before extraction.
#[tauri::command]
pub fn write_temp_bytes(path: String, data_base64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    let resolved = paths::resolve(&path);
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(resolved, bytes).map_err(|e| e.to_string())
}
