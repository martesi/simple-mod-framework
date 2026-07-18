/**
 * Helpers for the WSL interop e2e test suite.
 *
 * Provides:
 *   - wslInteropAvailable()  — detect WSL2 + binfmt interop enabled
 *   - findMingwGcc()         — locate x86_64-w64-mingw32-gcc on PATH
 *   - buildStubDeployExe()   — cross-compile a minimal Windows PE stub
 *
 * The stub emits the same SMF-style tab-separated output as the shell-script
 * fixture stub, but is a real PE binary that WSL interop routes to Windows.
 */
import { execFileSync, execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Returns true when running in WSL2 with binfmt PE interop enabled. */
export function wslInteropAvailable() {
	try {
		const version = readFileSync("/proc/version", "utf8")
		if (!version.toLowerCase().includes("microsoft")) return false
		// binfmt_misc entry exists and is active
		const interop = readFileSync("/proc/sys/fs/binfmt_misc/WSLInterop", "utf8")
		return interop.includes("enabled")
	} catch {
		return false
	}
}

/** Returns the path to x86_64-w64-mingw32-gcc, or null if not found. */
export function findMingwGcc() {
	try {
		return execSync("which x86_64-w64-mingw32-gcc", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim()
	} catch {
		return null
	}
}

// C source for the stub: prints two SMF-style INFO lines with a 700 ms pause
// so the final line lands after the UI's 500 ms output-render throttle.
const STUB_C = `\
#include <stdio.h>
#include <windows.h>
int main(void) {
    printf("INFO\\tLoading mods\\n");
    fflush(stdout);
    Sleep(700);
    printf("INFO\\tDone in 0.71s\\n");
    fflush(stdout);
    return 0;
}
`

/**
 * Cross-compile the stub Deploy.exe and write it to destPath.
 * Requires x86_64-w64-mingw32-gcc (provided by `nix develop`).
 */
export function buildStubDeployExe(destPath) {
	const gcc = findMingwGcc()
	if (!gcc) throw new Error("x86_64-w64-mingw32-gcc not found — run inside `nix develop`")

	const srcPath = join(tmpdir(), "smf-wsl-stub-deploy.c")
	writeFileSync(srcPath, STUB_C)
	execFileSync(gcc, ["-o", destPath, srcPath], { stdio: "inherit" })
}
