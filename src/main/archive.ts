import { execFile } from "node:child_process"
import { join } from "node:path"
import type { AppPaths } from "./paths"
import { wineArgv } from "./wineExec"

/**
 * Extracts an archive with the bundled 7z.exe - same tool the old
 * `Mod Manager/src/routes/**` used via `window.child_process.execSync`, but:
 *
 *   - runs in the main process (never reachable from the renderer at all -
 *     that's the point of LEI-134), and
 *   - uses `execFile` with an argument array instead of `execSync` with a
 *     hand-interpolated shell string, so a mod filename containing shell
 *     metacharacters (backticks, `&&`, quotes, ...) can't do anything but
 *     name a file - the old code's
 *     `` execSync(`"..\\Third-Party\\7z.exe" x "${modFilePath}" ...`) ``
 *     was one crafted filename away from shell injection.
 *
 * On non-win32, {@link wineArgv} runs 7z.exe under Wine instead - see wineExec.ts. Nothing here
 * needs to know that; it always gets back a ready-to-run command/args pair.
 */
export function extractArchive(paths: AppPaths, archivePath: string, destDir: string): Promise<void> {
  const sevenZip = join(paths.toolsRoot, "Third-Party", "7z.exe")
  const { command, args, env } = wineArgv(sevenZip, ["x", archivePath, "-aoa", "-y", `-o${destDir}`], paths.toolsRoot)

  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true, env }, (error) => {
      if (error) reject(error)
      else resolvePromise()
    })
  })
}
