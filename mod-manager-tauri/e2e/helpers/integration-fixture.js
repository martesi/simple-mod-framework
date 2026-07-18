/**
 * Integration fixture: wires the app binary into a *real* SMF game install so
 * the e2e suite can drive the full install → enable → deploy → Output/ pipeline
 * against the real Deploy.exe.  Unlike helpers/fixture.js (which fabricates a
 * throwaway game under e2e/.runtime/), this mutates as little as possible of an
 * existing install and restores everything on teardown.
 *
 * What it touches, and how it is undone:
 *   - <frameworkRoot>/Mod Manager/mod-manager   ← app binary (backed up/removed)
 *   - <frameworkRoot>/config.json               ← flips outputToSeparateDirectory
 *                                                  (original restored verbatim)
 *   - <frameworkRoot>/Deploy.exe                 ← only if `deployExe` override is
 *                                                  given (original restored)
 *   - <frameworkRoot>/Mods/<installed mods>      ← removed on teardown
 *   - <frameworkRoot>/Output                     ← Deploy.exe's output dir;
 *                                                  removed on teardown (any
 *                                                  pre-existing one restored)
 *
 * The game's Runtime/ and Retail/ are never written to.  outputToSeparateDirectory
 * guarantees Deploy.exe writes to Output/ rather than patching Runtime/ in place.
 */
import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import json5 from "json5"

const e2eDir = dirname(dirname(fileURLToPath(import.meta.url)))
const projectDir = dirname(e2eDir)

// Opt-in config; gitignored, so it's never accidentally committed.
const integrationConfigPath = join(e2eDir, "integration.json")

/**
 * Load the integration config.  Returns null when it's absent so the suite can
 * self-skip (see INTEGRATION.md — integration tests are opt-in).  Relative paths
 * in the config are resolved against the mod-manager-tauri dir.
 */
export function loadIntegrationConfig() {
	if (!existsSync(integrationConfigPath)) return null
	const raw = json5.parse(readFileSync(integrationConfigPath, "utf8"))
	const configPath = integrationConfigPath
	if (!raw.gamePath) throw new Error(`${basename(configPath)}: missing required 'gamePath'`)
	if (!Array.isArray(raw.mods) || raw.mods.length === 0) throw new Error(`${basename(configPath)}: 'mods' must be a non-empty array`)

	const abs = (p) => (p ? (isAbsolute(p) ? p : resolve(projectDir, p)) : p)
	return {
		...raw,
		gamePath: abs(raw.gamePath),
		frameworkPath: abs(raw.frameworkPath),
		deployExe: abs(raw.deployExe),
		mods: raw.mods.map(abs),
		// startup/UI waits: a real install on a slow mount (e.g. WSL /mnt drvfs)
		// can take ~45s to first render as getConfig walks the whole load order
		startupTimeoutMs: raw.startupTimeoutMs ?? 120_000,
		deployTimeoutMs: raw.deployTimeoutMs ?? 300_000
	}
}

/**
 * Find the framework root inside gamePath: the directory that directly contains
 * both config.json and Deploy.exe.  Honours an explicit `frameworkPath` from the
 * config; otherwise scans gamePath's immediate children (real installs name it
 * "Simple Mod Framework").
 */
function resolveFrameworkRoot(cfg) {
	const looksLikeRoot = (dir) => existsSync(join(dir, "config.json")) && existsSync(join(dir, "Deploy.exe"))

	if (cfg.frameworkPath) {
		if (!looksLikeRoot(cfg.frameworkPath)) {
			throw new Error(`frameworkPath ${cfg.frameworkPath} does not contain config.json + Deploy.exe`)
		}
		return cfg.frameworkPath
	}

	// gamePath itself may be the framework root, or hold it as a child dir
	if (looksLikeRoot(cfg.gamePath)) return cfg.gamePath
	for (const entry of readdirSync(cfg.gamePath, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		const candidate = join(cfg.gamePath, entry.name)
		if (looksLikeRoot(candidate)) return candidate
	}
	throw new Error(`could not locate a framework root (config.json + Deploy.exe) under ${cfg.gamePath}; set 'frameworkPath' explicitly`)
}

function extractArchive(archive, dest) {
	// 7z handles .zip/.7z/.rar; fall back to unzip for plain .zip.
	const attempts = [
		["7z", ["x", "-y", `-o${dest}`, archive]],
		["7zz", ["x", "-y", `-o${dest}`, archive]],
		["unzip", ["-o", archive, "-d", dest]]
	]
	let lastErr
	for (const [bin, args] of attempts) {
		try {
			execFileSync(bin, args, { stdio: "ignore" })
			return
		} catch (e) {
			lastErr = e
		}
	}
	throw new Error(`failed to extract ${archive} (need 7z/7zz or unzip on PATH): ${lastErr}`)
}

/**
 * Install one mod archive into <frameworkRoot>/Mods, mirroring the app's own
 * installFrameworkMod / installRPKGMod.  Returns descriptors for the mods it
 * created so the test can assert on names/ids and teardown can clean up.
 *
 *   { id, name, folder } for framework mods (id/name from manifest.json)
 *   { id, name, folder } for rpkg mods      (id === name === folder basename)
 */
function installMod(frameworkRoot, archive) {
	const modsDir = join(frameworkRoot, "Mods")
	mkdirSync(modsDir, { recursive: true })

	if (extname(archive).toLowerCase() === ".rpkg") {
		const name = basename(archive, extname(archive))
		const chunk = (basename(archive).match(/chunk[0-9]*/) ?? ["chunk0"])[0]
		const dest = join(modsDir, name, chunk)
		mkdirSync(dest, { recursive: true })
		copyFileSync(archive, join(dest, basename(archive)))
		return [{ id: name, name, folder: name }]
	}

	const staging = mkdtempSync(join(tmpdir(), "smf-int-"))
	try {
		extractArchive(archive, staging)

		const topLevel = readdirSync(staging, { withFileTypes: true }).filter((e) => e.isDirectory())
		const installed = []
		for (const entry of topLevel) {
			const manifestPath = join(staging, entry.name, "manifest.json")
			if (!existsSync(manifestPath)) {
				throw new Error(`${archive}: top-level folder '${entry.name}' has no manifest.json — not a framework mod`)
			}
			const manifest = json5.parse(readFileSync(manifestPath, "utf8"))
			const destFolder = join(modsDir, entry.name)
			cpSync(join(staging, entry.name), destFolder, { recursive: true })
			installed.push({ id: manifest.id, name: manifest.name ?? manifest.id, folder: entry.name })
		}
		if (installed.length === 0) throw new Error(`${archive}: no mod folders found after extraction`)
		return installed
	} finally {
		rmSync(staging, { recursive: true, force: true })
	}
}

/**
 * Prepare the integration fixture.  Returns a handle with the placed app binary
 * path, resolved paths, the mods that were installed, and a teardown() that
 * restores the install to its original state.
 */
export function createIntegrationFixture(appBinary, cfg) {
	const frameworkRoot = resolveFrameworkRoot(cfg)
	const gamePath = cfg.gamePath
	const runtimeChunk = join(gamePath, "Runtime", "chunk0.rpkg")

	// Deploy.exe always writes to <cwd>/Output, and run_deploy sets cwd to the
	// framework root — so the deploy output lands at <frameworkRoot>/Output.
	// The teardown below deletes it (restoring any pre-existing Output/).
	const outputDir = join(frameworkRoot, "Output")

	const undo = [] // teardown steps, run in reverse

	// ── app binary → <frameworkRoot>/Mod Manager/mod-manager ────────────────────
	const appDir = join(frameworkRoot, "Mod Manager")
	mkdirSync(appDir, { recursive: true })
	const app = join(appDir, "mod-manager")
	const appBackup = existsSync(app) ? `${app}.e2e-bak` : null
	if (appBackup) renameSync(app, appBackup)
	cpSync(appBinary, app)
	chmodSync(app, 0o755)
	undo.push(() => {
		rmSync(app, { force: true })
		if (appBackup) renameSync(appBackup, app)
	})

	// ── optional Deploy.exe override ────────────────────────────────────────────
	if (cfg.deployExe) {
		const deployPath = join(frameworkRoot, "Deploy.exe")
		const deployBackup = existsSync(deployPath) ? `${deployPath}.e2e-bak` : null
		if (deployBackup) renameSync(deployPath, deployBackup)
		cpSync(cfg.deployExe, deployPath)
		chmodSync(deployPath, 0o755)
		undo.push(() => {
			rmSync(deployPath, { force: true })
			if (deployBackup) renameSync(deployBackup, deployPath)
		})
	}

	// ── install mods, remembering folders for cleanup ───────────────────────────
	const mods = []
	for (const archive of cfg.mods) {
		if (!existsSync(archive)) throw new Error(`mod archive not found: ${archive}`)
		for (const installed of installMod(frameworkRoot, archive)) {
			mods.push(installed)
			const modFolder = join(frameworkRoot, "Mods", installed.folder)
			undo.push(() => rmSync(modFolder, { recursive: true, force: true }))
		}
	}

	// ── config.json → flip outputToSeparateDirectory, preserve original ─────────
	// Merge the freshly-installed mod ids into knownMods so the app doesn't flag
	// them as "extracted" and pop a blocking dialog over the mod list.
	const configPath = join(frameworkRoot, "config.json")
	const originalConfigRaw = readFileSync(configPath, "utf8")
	const config = json5.parse(originalConfigRaw)
	config.outputToSeparateDirectory = true
	config.knownMods = [...new Set([...(config.knownMods ?? []), ...mods.map((m) => m.id)])]
	// A real install's config uses Windows-style backslash separators (e.g.
	// "..\\Runtime"). A Linux Deploy.exe treats "\" as a literal character and
	// mis-resolves the path ("dist/Retail/HITMAN3.exe" instead of the game's
	// Retail/), so normalize the separators for the deploy.
	for (const key of ["runtimePath", "retailPath"]) {
		if (typeof config[key] === "string") config[key] = config[key].replace(/\\/g, "/")
	}
	writeFileSync(configPath, JSON.stringify(config, null, "\t"))
	undo.push(() => writeFileSync(configPath, originalConfigRaw))

	// move any pre-existing <frameworkRoot>/Output aside; restore it on teardown
	// so a prior real deploy's output isn't clobbered or mistaken for ours
	const outputBackup = existsSync(outputDir) ? `${outputDir}.e2e-bak` : null
	if (outputBackup) renameSync(outputDir, outputBackup)
	undo.push(() => {
		rmSync(outputDir, { recursive: true, force: true }) // this run's Output
		if (outputBackup) renameSync(outputBackup, outputDir)
	})

	function teardown() {
		for (const step of undo.reverse()) {
			try {
				step()
			} catch {
				// best-effort cleanup: keep unwinding even if one step fails
			}
		}
	}

	return {
		app,
		frameworkRoot,
		gamePath,
		configPath,
		outputDir,
		runtimeChunk,
		mods,
		startupTimeoutMs: cfg.startupTimeoutMs ?? 120_000,
		deployTimeoutMs: cfg.deployTimeoutMs ?? 300_000,
		teardown
	}
}

/** config.json is rewritten by the app as JSON5, so parse it as JSON5. */
export function readConfig(configPath) {
	return json5.parse(readFileSync(configPath, "utf8"))
}

/** mtime (ms) of a file, or null if it doesn't exist. */
export function mtimeMs(path) {
	return existsSync(path) ? statSync(path).mtimeMs : null
}

/** true if any file directly in `dir` matches a chunk*patch<N>.rpkg name. */
export function hasPatchRpkg(dir) {
	if (!existsSync(dir)) return false
	return readdirSync(dir).some((name) => /chunk[0-9]*patch[0-9]+\.rpkg$/i.test(name))
}
