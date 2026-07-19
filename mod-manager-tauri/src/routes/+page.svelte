<script lang="ts">
	import { fade } from "svelte/transition"
	import { onMount } from "svelte"

	import { Button, InlineLoading, Modal, ProgressBar } from "carbon-components-svelte"

	import {
		getAllMods,
		getConfig,
		getManifestFromModID,
		modIsFramework,
		getModFolder,
		mergeConfig,
		FrameworkVersion,
		clearModCache
	} from "$lib/utils"
	import type { Config, Manifest } from "../../../src/types"

	import { v4 } from "uuid"
	import { marked } from "marked"
	import sanitizeHtml from "sanitize-html"

	import semver from "semver"
	import json5 from "json5"

	import * as native from "$lib/native"

	import List from "carbon-icons-svelte/lib/List.svelte"
	import Settings from "carbon-icons-svelte/lib/Settings.svelte"
	import Info from "carbon-icons-svelte/lib/Information.svelte"
	import Checkmark from "carbon-icons-svelte/lib/Checkmark.svelte"
	import Download from "carbon-icons-svelte/lib/Download.svelte"
	import Edit from "carbon-icons-svelte/lib/Edit.svelte"
	import Asterisk from "carbon-icons-svelte/lib/Asterisk.svelte"

	let ready = false
	let config: Config | null = null

	let cannotFindConfig = false
	let cannotFindRuntime = false
	let cannotFindRetail = false
	let cannotFindGameConfig = false
	let cannotFindHITMAN3 = false
	let errorReportingPrompt = false
	let developerModePrompt = false

	let invalidModOpen = false
	let invalidModText = ""

	let fileInModFolder = false

	type GithubRelease = { release: any; releases: any[] }
	let latestGithubRelease: Promise<GithubRelease> = new Promise(() => {})
	let githubReleaseMarkdownBody = ""
	let canAutomaticallyUpdate = false

	type ModUpdateObj = { version: string; changelog: string; url: string; check_url: string }
	type ModUpdateEntry = {
		modID: string
		manifest: Manifest
		update: ModUpdateObj | false
	}
	function getUpdate(e: ModUpdateEntry): ModUpdateObj { return e.update as ModUpdateObj }
	function markStr(text: string): string { return marked(text, { gfm: true }) as string }
	let modUpdates: Promise<ModUpdateEntry[]> = new Promise(() => {})

	let updatingMod: { id: string; version: string; url: string; changelog: string } | null = null
	let modDownloadProgress = 0
	let modDownloadSize = 0
	let modExtracting = false

	let updatingFramework = false

	const trustedHosts = new Set([
		"github.com",
		"raw.githubusercontent.com",
		"dropbox.com",
		"dl.dropboxusercontent.com",
		"drive.google.com",
		"hitman-resources.netlify.app"
	])

	onMount(async () => {
		// load and validate config
		try {
			config = await getConfig()
		} catch {
			cannotFindConfig = true
			ready = true
			return
		}

		if (typeof config.retailPath === "undefined") {
			config = await mergeConfig({ retailPath: "..\\Retail" })
		}

		if (!await native.fs.existsSync(native.path.join("..", config.runtimePath))) {
			const retailRuntime = native.path.join("..", config.retailPath, "Runtime", "chunk0.rpkg")
			if (await native.fs.existsSync(retailRuntime) && config.runtimePath === "..\\Runtime") {
				config = await mergeConfig({ runtimePath: "..\\Retail\\Runtime" })
				await native.fs.copyFileSync(
					native.path.join("..", "cleanMicrosoftThumbs.dat"),
					native.path.join("..", "cleanThumbs.dat")
				)
			} else {
				cannotFindRuntime = true
			}
		} else {
			if (!await native.fs.existsSync(native.path.join("..", config.retailPath))) {
				cannotFindRetail = true
			} else {
				const chunk0 = native.path.join("..", config.retailPath, "Runtime", "chunk0.rpkg")
				const hitman3exe = native.path.join("..", config.retailPath, "HITMAN3.exe")
				if (!await native.fs.existsSync(chunk0) && !await native.fs.existsSync(hitman3exe)) {
					cannotFindHITMAN3 = true
				}
				if (await native.fs.existsSync(chunk0) &&
					!await native.fs.existsSync(native.path.join("..", config.retailPath, "..", "MicrosoftGame.Config"))) {
					cannotFindGameConfig = true
				}
			}
		}

		if (!cannotFindRuntime && !cannotFindRetail && !cannotFindGameConfig && !cannotFindHITMAN3) {
			if (typeof config.knownMods === "undefined") {
				config = await mergeConfig({ knownMods: [] })
			}
			if (typeof config.reportErrors === "undefined") {
				errorReportingPrompt = true
			}
			if (typeof config.developerMode === "undefined") {
				developerModePrompt = true
			}
		}

		// check for files directly in Mods folder (should be subfolders)
		try {
			const modsEntries = await native.fs.readdirSync(native.path.join("..", "Mods"))
			const filtered = modsEntries.filter(a => a !== "Managed by SMF, do not touch")
			const isFileChecks = await Promise.all(
				filtered.map(a => native.isFile(native.path.join("..", "Mods", a)))
			)
			fileInModFolder = isFileChecks.some(Boolean)
		} catch {
			// Mods folder missing — ignore
		}

		// check for invalid mod (missing id in manifest)
		if (!fileInModFolder) {
			try {
				const mods = await getAllMods()
				for (const mod of mods) {
					if (await modIsFramework(mod)) await getManifestFromModID(mod)
				}
			} catch {
				try {
					const modsEntries = await native.fs.readdirSync(native.path.join("..", "Mods"))
					for (const entry of modsEntries.filter(a => a !== "Managed by SMF, do not touch")) {
						const manifestPath = native.path.join("..", "Mods", entry, "manifest.json")
						if (await native.fs.existsSync(manifestPath)) {
							const mf = json5.parse(await native.fs.readFileSync(manifestPath, "utf8"))
							if (!mf.id) {
								invalidModText = entry
								break
							}
						}
					}
				} catch {}
				invalidModOpen = true
			}
		}

		ready = true

		// kick off async checks
		latestGithubRelease = checkForUpdates()
		modUpdates = checkForModUpdates()
	})

	async function checkForUpdates(): Promise<GithubRelease> {
		const release = await (
			await fetch("https://api.github.com/repos/atampy25/simple-mod-framework/releases/latest", {
				headers: { Accept: "application/vnd.github.v3+json" }
			})
		).json()
		const releases = await (
			await fetch("https://api.github.com/repos/atampy25/simple-mod-framework/releases", {
				headers: { Accept: "application/vnd.github.v3+json" }
			})
		).json()

		if (semver.lt(FrameworkVersion, release.tag_name)) {
			const allNewReleases = releases
				.filter((a: any) => semver.lt(FrameworkVersion, a.tag_name))
				.map((a: any) => a.body)
			allNewReleases.reverse()

			const sections: Record<string, string[]> = { "": [] }
			let currentSection = ""
			for (const item of allNewReleases) {
				for (const line of item.split("\n")) {
					if (line.trim() !== "") {
						if (line.trim().startsWith("##")) {
							sections[line.trim()] ??= []
							currentSection = line.trim()
						} else {
							sections[currentSection].push(line.trim())
						}
					}
				}
			}

			githubReleaseMarkdownBody = marked(
				Object.entries(sections)
					.map(([a, b]) => a + "\n" + b.join("\n"))
					.join("\n"),
				{ gfm: true }
			) as string

			canAutomaticallyUpdate =
				!githubReleaseMarkdownBody.includes("CANNOT AUTOMATICALLY UPDATE")
		}

		return { release, releases }
	}

	async function checkForModUpdates(): Promise<ModUpdateEntry[]> {
		const results: ModUpdateEntry[] = []
		let mods: string[] = []
		try {
			mods = await getAllMods()
		} catch {
			return results
		}

		for (const mod of mods) {
			if (!await modIsFramework(mod)) continue
			const manifest = await getManifestFromModID(mod)
			if (!manifest.updateCheck) continue

			try {
				const updateJSON = await (
					await fetch(manifest.updateCheck + "?t=" + Date.now())
				).json()

				let changelog = updateJSON.changelog

				const ghMatch = manifest.updateCheck.match(
					"https://github.com/(.*)/releases/latest/download/updates.json"
				)
				if (ghMatch) {
					const releases = await (
						await fetch(
							`https://api.github.com/repos/${ghMatch[1]}/releases`,
							{ headers: { Accept: "application/vnd.github.v3+json" } }
						)
					).json()

					const allNew = releases
						.filter((a: any) => semver.lt(manifest.version, a.tag_name))
						.map((a: any) => a.body)
					allNew.reverse()

					const sections: Record<string, string[]> = { "": [] }
					let currentSection = ""
					for (const item of allNew) {
						for (const line of item.split("\n")) {
							if (
								line.trim() !== "" &&
								!line.includes("hitman-resources.netlify.app/smf-install-link")
							) {
								if (line.trim().startsWith("##")) {
									sections[line.trim()] ??= []
									currentSection = line.trim()
								} else {
									sections[currentSection].push(line.trim())
								}
							}
						}
					}

					changelog = Object.entries(sections)
						.map(([a, b]) => a + "\n" + b.join("\n"))
						.join("\n")
				}

				if (!changelog || !updateJSON.url || !semver.valid(updateJSON.version, { loose: false })) {
					throw new Error()
				}

				results.push({
					modID: mod,
					manifest,
					update: { ...updateJSON, changelog, check_url: manifest.updateCheck }
				})
			} catch {
				results.push({ modID: mod, manifest, update: false })
			}
		}

		return results
	}

	async function startModUpdate() {
		let chunksAll: Uint8Array

		try {
			const response = await fetch(updatingMod!.url)
			const reader = response.body!.getReader()
			modDownloadSize = +response.headers.get("Content-Length")!

			let receivedLength = 0
			const chunks: Uint8Array[] = []
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				chunks.push(value)
				receivedLength += value.length
				modDownloadProgress = receivedLength
			}

			chunksAll = new Uint8Array(receivedLength)
			let position = 0
			for (const chunk of chunks) {
				chunksAll.set(chunk, position)
				position += chunk.length
			}
		} catch (e) {
			alert("Couldn't download the mod update! Check your internet connection, or contact the mod author for help.\n\n" + e)
			updatingMod = null
			return
		}

		try {
			modExtracting = true
			await native.fs.emptyDirSync("./staging")
			await native.writeTempBytes("./tempArchive", chunksAll)
			await native.extractArchive("./tempArchive", "./staging")

			if ((await native.klaw("./staging", { depthLimit: 0, nodir: true })).length) {
				alert("Error: mod update ZIP has files in the root!")
				throw new Error("Mod update ZIP has files in the root!")
			}

			const modFolder = await getModFolder(updatingMod!.id)
			await native.fs.removeSync(modFolder)
			await native.fs.copySync("./staging", "../Mods")
			await native.fs.removeSync("./staging")
			await native.fs.removeSync("./tempArchive")
		} catch (e) {
			alert("Couldn't extract and apply the mod update! Contact the mod author for help.\n\n" + e)
			updatingMod = null
			return
		}

		updatingMod = null
		clearModCache()
		window.location.reload()
	}
</script>

{#if ready}
	<div class="w-full h-full overflow-y-auto flex items-center justify-center gap-96">
		<div>
			<h1 in:fade>Welcome to the Simple Mod Framework</h1>
			<br />
			<div class="inline" in:fade={{ delay: 400 }}>
				<Button kind="primary" icon={List} href="/modList">Enable/disable mods</Button>
			</div>
			<div class="inline" in:fade={{ delay: 800 }}>
				<Button kind="primary" icon={Settings} href="/settings">Configure mods</Button>
			</div>
			{#if config?.developerMode}
				<div class="inline" in:fade={{ delay: 800 }}>
					<Button kind="primary" icon={Edit} href="/authoring">Author mods</Button>
				</div>
			{/if}
			<div class="inline" in:fade={{ delay: config?.developerMode ? 1200 : 800 }}>
				<Button kind="primary" icon={Info} href="/info">More information</Button>
			</div>
			<p class="mt-4" in:fade={{ delay: 1600 }}>Need help using mods? Consult the pinned post on the Nexus Mods page.</p>
			<p class="mt-2" in:fade={{ delay: 2000 }}>Need help making mods? There's extensive documentation available in the Info folder.</p>

			<div class="mt-4 bg-neutral-900 rounded-md p-4" in:fade={{ delay: 2400 }}>
				{#await latestGithubRelease}
					<div class="flex items-center">
						<p class="flex-grow">Checking for framework updates...</p>
						<div><InlineLoading /></div>
					</div>
				{:then { release }}
					{#if semver.lt(FrameworkVersion, release.tag_name)}
						<div class="flex items-center">
							<h3 class="flex-grow">
								{{ patch: "Patch update available", minor: "Feature update available", major: "Major update available" }[semver.diff(FrameworkVersion, release.tag_name)] || "Update available"}
							</h3>
							<p>{FrameworkVersion} → {release.tag_name}</p>
						</div>
						<hr class="bg-gray-500 border-none h-px" />
						<div class="mt-2 markdown">{@html githubReleaseMarkdownBody}</div>
						<br />
						{#if canAutomaticallyUpdate}
							<p class="text-neutral-400 text-sm">
								An update is available. Download the latest release from GitHub and replace the executable to update.
							</p>
						{/if}
					{:else}
						<div class="flex items-center">
							<p class="flex-grow">The framework is up to date (version {FrameworkVersion})</p>
							<Checkmark />
						</div>
					{/if}
				{:catch}
					<div class="flex items-center">
						<p class="flex-grow">Couldn't check for framework updates</p>
						<div><InlineLoading status="error" /></div>
					</div>
				{/await}
			</div>

			<div class="mt-4 bg-neutral-900 rounded-md p-4" in:fade={{ delay: 2800 }}>
				{#await modUpdates}
					<div class="flex items-center">
						<p class="flex-grow">Checking for mod updates...</p>
						<div><InlineLoading /></div>
					</div>
				{:then updates}
					{@const upToDateEntries = updates.filter(e => e.update && !semver.lt(e.manifest.version, getUpdate(e).version))}

					{#each updates.filter(e => !e.update) as entry (entry.modID)}
						<div class="flex items-center">
							<p class="flex-grow">Couldn't check {entry.manifest.name} for updates</p>
							<div><InlineLoading status="error" /></div>
						</div>
					{/each}

					{#each updates.filter(e => e.update && (
						!(trustedHosts.has(new URL(getUpdate(e).check_url).hostname) || new URL(getUpdate(e).check_url).hostname.split(".").slice(1).join(".") === "github.io") ||
						!(trustedHosts.has(new URL(getUpdate(e).url).hostname) || new URL(getUpdate(e).url).hostname.split(".").slice(1).join(".") === "github.io")
					)) as entry}
						<div class="flex items-center">
							<p class="flex-grow">The author of {entry.manifest.name} may be able to find which IPs have their mod downloaded</p>
							<Asterisk />
						</div>
					{/each}

					{#if upToDateEntries.length < 6}
						{#each upToDateEntries as entry (entry.modID)}
							<div class="flex items-center">
								<p class="flex-grow">{entry.manifest.name} is up to date</p>
								<Checkmark />
							</div>
						{/each}
					{:else}
						<div class="flex items-center">
							<p class="flex-grow">{upToDateEntries.length !== updates.length ? upToDateEntries.length : "All"} mods are up to date</p>
							<Checkmark />
						</div>
					{/if}

					{#each updates.filter(e => e.update && semver.lt(e.manifest.version, getUpdate(e).version)) as entry (entry.modID)}
						{@const upd = getUpdate(entry)}
						<div class="my-4">
							<div class="flex items-center">
								<h3 class="flex-grow">{entry.manifest.name}</h3>
								<p>{entry.manifest.version} → {upd.version}</p>
							</div>
							<hr class="bg-gray-500 border-none h-px" />
							<div class="mt-2 markdown">{@html sanitizeHtml(markStr(upd.changelog))}</div>
							<br />
							<Button
								kind="primary"
								icon={Download}
								on:click={() => {
									updatingMod = { id: entry.modID, ...upd }
									startModUpdate()
								}}
							>
								Update
							</Button>
						</div>
					{/each}
				{:catch}
					<div class="flex items-center">
						<p class="flex-grow">Couldn't check for mod updates</p>
						<div><InlineLoading status="error" /></div>
					</div>
				{/await}
			</div>
		</div>
	</div>
{/if}

<Modal alert bind:open={cannotFindConfig} modalHeading="Can't find config.json" primaryButtonText="OK" on:submit={() => (cannotFindConfig = false)}>
	<p>The framework wasn't installed correctly. Please re-read the installation instructions.</p>
</Modal>

<Modal alert bind:open={cannotFindRuntime} modalHeading="Can't find Runtime" primaryButtonText="OK" on:submit={() => (cannotFindRuntime = false)}>
	<p>The framework wasn't installed correctly. Please re-read the installation instructions.</p>
</Modal>

<Modal alert bind:open={cannotFindRetail} modalHeading="Can't find Retail" primaryButtonText="OK" on:submit={() => (cannotFindRetail = false)}>
	<p>The framework wasn't installed correctly. Please re-read the installation instructions.</p>
</Modal>

<Modal alert bind:open={cannotFindGameConfig} modalHeading="Can't find the game config" primaryButtonText="OK" on:submit={() => (cannotFindGameConfig = false)}>
	<p>The framework wasn't installed correctly. Please re-read the installation instructions.</p>
</Modal>

<Modal alert bind:open={cannotFindHITMAN3} modalHeading="Can't find HITMAN3.exe" primaryButtonText="OK" on:submit={() => (cannotFindHITMAN3 = false)}>
	<p>The framework wasn't installed correctly. Please re-read the installation instructions.</p>
</Modal>

<Modal alert bind:open={fileInModFolder} modalHeading="File in Mods folder" primaryButtonText="OK" on:submit={() => (fileInModFolder = false)}>
	<p>
		There's a file in the Mods folder. You should be using the Add a Mod button in the mod manager to manage your mods - not doing so exposes you to several risks, including your computer's
		security.
	</p>
</Modal>

<Modal alert bind:open={invalidModOpen} modalHeading="Invalid mod" primaryButtonText="OK" on:submit={() => (invalidModOpen = false)}>
	<p>The mod {invalidModText} is broken. Ensure it has all of the required keys in the manifest (see the documentation), and if that fails, contact Atampy26 on Hitman Forum.</p>
</Modal>

<Modal
	bind:open={errorReportingPrompt}
	modalHeading="Error and performance reporting"
	primaryButtonText="Yes"
	secondaryButtonText="No"
	on:click:button--secondary={async () => {
		await mergeConfig({ reportErrors: false, errorReportingID: undefined })
		errorReportingPrompt = false
	}}
	on:submit={async () => {
		await mergeConfig({ reportErrors: true, errorReportingID: v4() })
		errorReportingPrompt = false
	}}
>
	<p>
		Would you like to send anonymous performance and error reporting data to the internet to improve the framework?
		<br />
		This can be changed later in the information page.
		<br /><br />
		It is recommended you enable this; it helps with resolving problems and improving the framework's features.
	</p>
</Modal>

<Modal
	bind:open={developerModePrompt}
	modalHeading="Developer mode"
	primaryButtonText="I'm a mod developer"
	secondaryButtonText="I'm a mod user"
	on:click:button--secondary={async () => {
		await mergeConfig({ developerMode: false })
		developerModePrompt = false
	}}
	on:submit={async () => {
		await mergeConfig({ developerMode: true })
		developerModePrompt = false
	}}
>
	<p>
		Would you like to enable developer mode? Developer mode improves the experience if you're planning on creating mods; otherwise, you can leave it disabled.
		<br />
		This can be changed later in the information page.
	</p>
</Modal>

<Modal passiveModal open={!!updatingMod} modalHeading={updatingMod ? "Updating " + updatingMod.id : "Updating the mod"} preventCloseOnClickOutside>
	<div class="mb-2 markdown">
		{#if updatingMod}{@html sanitizeHtml(markStr(updatingMod.changelog))}{/if}
	</div>
	<br />
	{#if !modExtracting}
		<ProgressBar kind="inline" value={modDownloadProgress} max={modDownloadSize} labelText="Downloading..." />
	{:else}
		<p>Extracting files...</p>
	{/if}
</Modal>

<style>
	:global(.markdown h2) {
		font-size: 1.5rem;
		font-weight: 300;
		margin-bottom: 0.25rem;
	}

	:global(.markdown li) {
		margin-bottom: 0.5rem;
		list-style-position: inside;
		list-style-type: disclosure-closed;
	}

	:global(.bx--modal-close) {
		display: none;
	}
</style>
