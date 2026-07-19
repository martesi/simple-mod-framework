use crate::paths;
use std::{
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::Emitter;

/// Builds the not-yet-spawned deploy command. In release builds this is the
/// packaged `Deploy.exe` sitting at the framework root, same as always. In
/// debug builds (`tauri dev`) there is no `Deploy.exe` to run against — it's
/// a separate, slower packaging step (`npm run build:exe:win`, pkg) — so we
/// run the CLI straight out of `build/compiled/main.js` with `node` instead.
/// That's the same code Deploy.exe would run, just unpacked, and it only
/// needs `npm run build:cli` (not the full `build:win`) to be up to date,
/// and works cross-platform since it isn't a Windows PE binary.
fn deploy_command() -> Result<Command, String> {
    let root = paths::framework_root();

    if cfg!(debug_assertions) {
        let main_js = root.join("compiled").join("main.js");
        if !main_js.is_file() {
            return Err(format!(
                "{} not found — run `npm run build:cli` at the repo root \
                 (dev mode runs the CLI from build/compiled/main.js via node, \
                 not the packaged Deploy.exe).",
                main_js.display()
            ));
        }

        let mut cmd = Command::new("node");
        cmd.arg("--enable-source-maps")
            .arg(&main_js)
            .args(["--doNotPause", "--colors"]);
        Ok(cmd)
    } else {
        let deploy_exe = root.join("Deploy.exe");
        let mut cmd = Command::new(&deploy_exe);
        cmd.args(["--doNotPause", "--colors"]);
        Ok(cmd)
    }
}

#[tauri::command]
pub async fn run_deploy(app: tauri::AppHandle) -> Result<(), String> {
    let mut child = deploy_command()?
        .current_dir(paths::framework_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start deploy process: {e}"))?;

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
