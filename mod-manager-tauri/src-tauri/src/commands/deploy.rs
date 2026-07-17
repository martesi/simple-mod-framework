use crate::paths;
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::Emitter;

#[tauri::command]
pub async fn run_deploy(app: tauri::AppHandle) -> Result<(), String> {
    let deploy_exe = paths::framework_root().join("Deploy.exe");

    let mut child = Command::new(&deploy_exe)
        .args(["--doNotPause", "--colors"])
        .current_dir(paths::framework_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start Deploy.exe: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Shared accumulator — both threads append to it and each emits the
    // full buffer, matching the Electron behaviour.
    let accumulated = Arc::new(Mutex::new(String::new()));

    let app1 = app.clone();
    let acc1 = Arc::clone(&accumulated);
    let stdout_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                let mut acc = acc1.lock().unwrap();
                acc.push_str(&line);
                acc.push('\n');
                app1.emit("deploy-output", acc.clone()).ok();
            }
        }
    });

    let app2 = app.clone();
    let acc2 = Arc::clone(&accumulated);
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                let mut acc = acc2.lock().unwrap();
                acc.push_str(&line);
                acc.push('\n');
                app2.emit("deploy-output", acc.clone()).ok();
            }
        }
    });

    stdout_thread.join().ok();
    stderr_thread.join().ok();
    child.wait().map_err(|e| e.to_string())?;
    app.emit("deploy-finished", ()).ok();

    Ok(())
}
