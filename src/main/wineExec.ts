import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Bundled Third-Party tools under extra/Third-Party/ are all Windows binaries. On win32 they run
 * natively. On Linux (used only for e2e-testing this app itself under `nix develop .#e2e` - see
 * flake.nix's devShells.e2e comment - and as a best-effort path for anyone who happens to have
 * Wine on PATH, e.g. Proton users) they need `wine` prefixed. This is the one place that decision
 * gets made, instead of a per-binary wrapper-script hack (see git history for the old approach,
 * kept only for 7z.exe and never extended to the other 8 tools).
 *
 * Env defaults mirror what the old 7z.exe wrapper script hardcoded - same WINEPREFIX location
 * (colocated with the tools themselves, since the e2e sandbox has no reliable $HOME), same
 * XDG_RUNTIME_DIR/WINEDLLOVERRIDES/WINEDEBUG rationale. Still overridable via already-set env vars.
 */
function wineEnv(toolsRoot: string): NodeJS.ProcessEnv {
  const wineprefix = process.env.WINEPREFIX || join(toolsRoot, 'Third-Party', '.wineprefix')
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR || join(wineprefix, '.xdg-runtime')
  mkdirSync(xdgRuntimeDir, { recursive: true })

  return {
    ...process.env,
    WINEPREFIX: wineprefix,
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    // Disables the Mono/Gecko install prompts Wine would otherwise try to throw up (and hang on,
    // headless) the first time anything touches .NET or an embedded web control.
    WINEDLLOVERRIDES: process.env.WINEDLLOVERRIDES || 'mscoree,mshtml=',
    // Silences Wine's fixme:/err: diagnostic spam so it doesn't look like a real failure on stderr.
    WINEDEBUG: process.env.WINEDEBUG || '-all',
  }
}

/** For exec/execSync-style shell command strings (the various execCommand() helpers) - a no-op on win32. */
export function wineCommand(
  command: string,
  toolsRoot: string
): { command: string; env: NodeJS.ProcessEnv } {
  if (process.platform === 'win32') return { command, env: process.env }
  return { command: `wine ${command}`, env: wineEnv(toolsRoot) }
}

/** For execFile/spawn-style argv-array invocations - a no-op on win32. */
export function wineArgv(
  exePath: string,
  args: string[],
  toolsRoot: string
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (process.platform === 'win32') return { command: exePath, args, env: process.env }
  return { command: 'wine', args: [exePath, ...args], env: wineEnv(toolsRoot) }
}
