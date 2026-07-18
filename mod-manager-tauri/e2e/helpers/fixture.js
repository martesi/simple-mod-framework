/**
 * Builds a throwaway on-disk layout mimicking a real SMF install:
 *
 *   e2e/.runtime/game/            ← the HITMAN 3 game directory
 *     Runtime/chunk0.rpkg
 *     Retail/HITMAN3.exe
 *     framework/                  ← the framework root ("Simple Mod Framework")
 *       config.json
 *       Deploy.exe                ← stub script (or real PE binary via deployBinary)
 *       Mods/…                    ← one framework mod, one RPKG-only mod
 *       Mod Manager/mod-manager   ← the app binary under test; the app derives
 *                                   the framework root from its own exe path
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import json5 from "json5"

const e2eDir = dirname(dirname(fileURLToPath(import.meta.url)))

export const TEST_MOD_ID = "dev.e2e.test-mod"
export const TEST_MOD_NAME = "E2E Test Mod"
export const TEST_RPKG_MOD_NAME = "E2E RPKG Mod"

/**
 * @param {string} appBinary - path to the compiled app binary
 * @param {{ deployBinary?: string, appFilename?: string }} [opts]
 *   deployBinary: a pre-built Deploy.exe to copy into the fixture instead of
 *                 the default shell-script stub (required for Windows .exe tests
 *                 since Windows can't exec a shell script)
 *   appFilename:  filename to use inside "Mod Manager/" (default "mod-manager");
 *                 pass "mod-manager-tauri.exe" for the Windows cross-compiled build
 */
export function createFixture(appBinary, { deployBinary, appFilename = "mod-manager" } = {}) {
	const gameDir = join(e2eDir, ".runtime", "game")
	rmSync(gameDir, { recursive: true, force: true })

	const root = join(gameDir, "framework")

	// game files the startup screen checks for
	mkdirSync(join(gameDir, "Runtime"), { recursive: true })
	writeFileSync(join(gameDir, "Runtime", "chunk0.rpkg"), "")
	mkdirSync(join(gameDir, "Retail"), { recursive: true })
	writeFileSync(join(gameDir, "Retail", "HITMAN3.exe"), "")

	// the app binary; framework root is resolved as the exe's grandparent dir
	const appDir = join(root, "Mod Manager")
	mkdirSync(appDir, { recursive: true })
	const app = join(appDir, appFilename)
	cpSync(appBinary, app)
	chmodSync(app, 0o755)

	const configPath = join(root, "config.json")
	writeFileSync(
		configPath,
		JSON.stringify(
			{
				runtimePath: "..\\Runtime",
				retailPath: "..\\Retail",
				skipIntro: false,
				outputToSeparateDirectory: false,
				loadOrder: [],
				modOptions: {},
				outputConfigToAppDataOnDeploy: true,
				// pre-seed so the app doesn't prompt or flag the fixture mods
				knownMods: [TEST_MOD_ID, TEST_RPKG_MOD_NAME],
				reportErrors: false,
				developerMode: false
			},
			null,
			"\t"
		)
	)

	// a minimal valid framework mod
	const modDir = join(root, "Mods", "E2E Test Mod")
	mkdirSync(modDir, { recursive: true })
	writeFileSync(
		join(modDir, "manifest.json"),
		JSON.stringify(
			{
				id: TEST_MOD_ID,
				name: TEST_MOD_NAME,
				description: "A minimal mod used by the end-to-end tests.",
				authors: ["e2e"],
				version: "1.0.0",
				frameworkVersion: "2.33.40"
			},
			null,
			"\t"
		)
	)

	// an RPKG-only mod: no manifest, contains a .rpkg file
	const rpkgDir = join(root, "Mods", TEST_RPKG_MOD_NAME, "chunk0")
	mkdirSync(rpkgDir, { recursive: true })
	writeFileSync(join(rpkgDir, "e2e.rpkg"), "not a real rpkg")

	// Deploy.exe stub: either a pre-built PE binary (deployBinary option, used by
	// the WSL interop test) or a shell script that emits SMF-style output.
	// The sleep must exceed the UI's 500 ms output-render throttle.
	const deploy = join(root, "Deploy.exe")
	if (deployBinary) {
		cpSync(deployBinary, deploy)
		chmodSync(deploy, 0o755)
	} else {
		writeFileSync(deploy, "#!/bin/sh\nprintf 'INFO\\tLoading mods\\n'\nsleep 0.7\nprintf 'INFO\\tDone in 0.71s\\n'\n")
		chmodSync(deploy, 0o755)
	}

	return { gameDir, root, app, configPath }
}

/** config.json is rewritten by the app as JSON5, so parse it as JSON5. */
export function readFixtureConfig(fixture) {
	return json5.parse(readFileSync(fixture.configPath, "utf8"))
}
