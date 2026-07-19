<script lang="ts">
	import { scale, fade } from "svelte/transition"
	import { flip } from "svelte/animate"
	import { onMount, onDestroy } from "svelte"

	import json5 from "json5"
	import { Button, CodeSnippet, InlineNotification, Modal, ProgressBar, Search } from "carbon-components-svelte"
	import AnsiToHTML from "ansi-to-html"
	function throttle<T extends (...args: any[]) => void>(fn: T, wait: number): T {
		let last = 0
		return ((...args: any[]) => { const now = Date.now(); if (now - last >= wait) { last = now; fn(...args) } }) as T
	}
	import sanitizeHtml from "sanitize-html"
	import { marked } from "marked"

	const convertAnsi = new AnsiToHTML({
		newline: true,
		escapeXML: true,
		colors: {
			"0": "#101010", "1": "#EFA6A2", "2": "#80C990", "3": "#C8C874",
			"4": "#A3B8EF", "5": "#E6A3DC", "6": "#50CACD", "7": "#808080",
			"8": "#878787", "9": "#E0AF85", "10": "#5ACCAF", "11": "#C8C874",
			"12": "#CCACED", "13": "#F2A1C2", "14": "#74C3E4", "15": "#C0C0C0"
		},
		fg: "#f4f4f4",
		bg: "#262626"
	})

	import {
		getAllMods, getConfig, mergeConfig, getManifestFromModID, modIsFramework,
		getModFolder, sortMods, validateModFolder, clearModCache
	} from "$lib/utils"
	import type { Config, Manifest } from "../../../../src/types"
	import { OptionType } from "../../../../src/types"
	import Mod from "$lib/Mod.svelte"
	import TextInputModal from "$lib/TextInputModal.svelte"
	import { page } from "$app/stores"
	import SortableList from "$lib/SortableList.svelte"

	import * as native from "$lib/native"
	import { onDeployOutput, onDeployFinished, runDeploy, openModFileDialog, writeTempBytes, extractArchive, klaw, fs as nativeFs, path as nativePath } from "$lib/native"

	import Add from "carbon-icons-svelte/lib/Add.svelte"
	import AddAlt from "carbon-icons-svelte/lib/AddAlt.svelte"
	import SubtractAlt from "carbon-icons-svelte/lib/SubtractAlt.svelte"
	import Rocket from "carbon-icons-svelte/lib/Rocket.svelte"
	import Settings from "carbon-icons-svelte/lib/Settings.svelte"
	import TrashCan from "carbon-icons-svelte/lib/TrashCan.svelte"
	import Close from "carbon-icons-svelte/lib/Close.svelte"
	import CloudUpload from "carbon-icons-svelte/lib/CloudUpload.svelte"
	import Filter from "carbon-icons-svelte/lib/Filter.svelte"

	// ─── state ──────────────────────────────────────────────────────────────────

	let config: Config | null = null
	let allMods: string[] = []
	let manifestCache: Map<string, Manifest> = new Map()

	let enabledMods: { value: string }[] = []
	let disabledMods: { value: string }[] = []

	let changed = false
	let showDropHint = false

	let deleteModModalOpen = false
	let deleteModInProgress = ""

	let dependencyCycleModalOpen = false
	let frameworkDeployModalOpen = false
	let deployOutput = ""
	let deployOutputHTML = ""
	let deployDiagnostics: string[] = []
	let deployFinished = false

	let modNameInputModal: TextInputModal
	let modNameInputModalOpen = false

	let rpkgModExtractionInProgress = false
	let frameworkModExtractionInProgress = false

	let invalidFrameworkZipModalOpen = false
	let invalidModModalOpen = false
	let invalidFrameworkModModalOpen = false
	let modValidationError = ""

	let modFilePath = ""
	let rpkgsToInstall: { path: string; chunk: string }[] = []
	let rpkgModName = ""

	let frameworkModScriptsWarningOpen = false
	let frameworkModPeacockPluginsWarningOpen = false

	let displayExtractedModsDialog = false
	let extractedMods: string[] = []

	let uploadedLogURL = ""
	let uploadLogModalOpen = false
	let uploadLogFailedModalOpen = false

	let availableModFilter = ""
	let enabledModFilter = ""

	let autoInstallDownloading = false
	let autoInstallDownloadProgress = 0
	let autoInstallDownloadSize = 0
	let autoInstallModName = ""
	let autoInstallModalOpen = false

	let cleanupFns: (() => void)[] = []

	// ─── derived lists (reactive from config/allMods) ───────────────────────────

	$: if (config) {
		enabledMods = config.loadOrder.map(a => ({ value: a }))
	}

	$: if (config && allMods) {
		disabledMods = allMods
			.filter(a => !config!.loadOrder.includes(a))
			.sort((a, b) => {
				const nameA = manifestCache.get(a)?.name ?? a
				const nameB = manifestCache.get(b)?.name ?? b
				return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" })
			})
			.map(a => ({ value: a }))
	}

	// ─── deploy output ───────────────────────────────────────────────────────────

	const convertOutputToHTML = throttle(() => {
		deployOutputHTML = convertAnsi.toHtml(deployOutput)
		if (deployDiagnostics.length < 20) {
			deployDiagnostics = deployOutput.split(/\r?\n/).filter(a => a.match(/.*WARN.*?\t/) || a.match(/.*ERROR.*?\t/))
		}
		setTimeout(() => {
			document.getElementById("deployOutputElement")?.children[0].scrollIntoView(false)
		}, 100)
	}, 500)

	// ─── mount ──────────────────────────────────────────────────────────────────

	onMount(async () => {
		await refreshLists()

		// deploy events
		const unlistenOutput = await onDeployOutput(output => {
			deployOutput = output
			convertOutputToHTML()
		})
		const unlistenFinished = await onDeployFinished(() => {
			deployFinished = true
		})
		cleanupFns.push(unlistenOutput, unlistenFinished)

		// file drag-drop via Tauri window events
		const { getCurrentWindow } = await import("@tauri-apps/api/window")
		const unlistenDrop = await getCurrentWindow().onDragDropEvent(event => {
			if (event.payload.type === "drop" && event.payload.paths.length > 0) {
				showDropHint = false
				modFilePath = event.payload.paths[0]
				addMod()
			} else if (event.payload.type === "enter") {
				showDropHint = true
			} else if (event.payload.type === "leave") {
				showDropHint = false
			}
		})
		cleanupFns.push(unlistenDrop)

		// deep-link install via URL search param (set by deep-link handler)
		const urlScheme = $page.url.searchParams.get("urlScheme")
		if (urlScheme) {
			await handleAutoInstall(urlScheme)
		}
	})

	onDestroy(() => cleanupFns.forEach(f => f()))

	// ─── helpers ─────────────────────────────────────────────────────────────────

	async function refreshLists() {
		clearModCache()
		config = await getConfig()
		allMods = await getAllMods()
		manifestCache = new Map()
		for (const mod of allMods) {
			if (await modIsFramework(mod)) {
				try {
					manifestCache.set(mod, await getManifestFromModID(mod))
				} catch {}
			}
		}
		enabledMods = config.loadOrder.map(a => ({ value: a }))
		disabledMods = allMods
			.filter(a => !config!.loadOrder.includes(a))
			.sort((a, b) => {
				const nameA = manifestCache.get(a)?.name ?? a
				const nameB = manifestCache.get(b)?.name ?? b
				return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" })
			})
			.map(a => ({ value: a }))

		// developer mode: flag mods installed by extraction (not via Add a Mod)
		if (!config.developerMode) {
			if (config.knownMods.length === 0) {
				config = await mergeConfig({ knownMods: allMods })
			}
			for (const mod of allMods) {
				if (!config.knownMods.includes(mod)) {
					const manifest = manifestCache.get(mod)
					extractedMods.push(manifest?.name ?? mod)
					displayExtractedModsDialog = true
					config = await mergeConfig({ knownMods: [...config.knownMods, mod] })
				}
			}
		}
	}

	// ─── add mod ─────────────────────────────────────────────────────────────────

	async function addMod() {
		if (!modFilePath) return

		if (modFilePath.endsWith(".rpkg")) {
			const result = [...modFilePath.matchAll(/(chunk[0-9]*)/g)]
			const chunk = result.length ? result[0][1] : "chunk0"
			rpkgsToInstall = [{ path: modFilePath, chunk }]
			modNameInputModalOpen = true
			return
		}

		// zip/7z/rar → extract to staging
		await nativeFs.emptyDirSync("./staging")
		await extractArchive(modFilePath, "./staging")

		const stagingContents = await nativeFs.readdirSync("./staging")
		const stagingFileList = await klaw("./staging", { nodir: true })

		// check if it's a framework mod (all top-level entries have manifest.json)
		const manifestChecks = await Promise.all(
			stagingContents.map(a => nativeFs.existsSync(nativePath.join("./staging", a, "manifest.json")))
		)
		const isFrameworkMod = manifestChecks.every(Boolean)

		if (isFrameworkMod) {
			frameworkModExtractionInProgress = true

			// no files in root of zip
			if ((await klaw("./staging", { depthLimit: 0, nodir: true })).length) {
				frameworkModExtractionInProgress = false
				invalidFrameworkZipModalOpen = true
				return
			}

			// all manifests must be valid JSON
			try {
				for (const a of stagingContents) {
					json5.parse(await nativeFs.readFileSync(nativePath.join("./staging", a, "manifest.json"), "utf8"))
				}
			} catch {
				frameworkModExtractionInProgress = false
				invalidModModalOpen = true
				return
			}

			// validate each mod folder
			for (const folder of stagingContents.map(a => nativePath.join("./staging", a))) {
				const [ok, err] = await validateModFolder(folder)
				if (!ok) {
					frameworkModExtractionInProgress = false
					invalidFrameworkModModalOpen = true
					modValidationError = err
					return
				}
			}

			// scripts warning
			let hasScripts = false
			let hasPeacockPlugins = false
			for (const a of stagingContents) {
				const mf = json5.parse(await nativeFs.readFileSync(nativePath.join("./staging", a, "manifest.json"), "utf8"))
				if (mf.scripts || mf.options?.some(b => b.scripts)) hasScripts = true
				if (mf.peacockPlugins || mf.options?.some(b => b.peacockPlugins)) hasPeacockPlugins = true
			}

			frameworkModExtractionInProgress = false

			if (hasScripts) {
				frameworkModScriptsWarningOpen = true
			} else if (hasPeacockPlugins) {
				frameworkModPeacockPluginsWarningOpen = true
			} else {
				await installFrameworkMod(stagingContents)
			}
		} else {
			rpkgsToInstall = []
			if (stagingFileList.some(a => a.path.endsWith(".rpkg"))) {
				for (const file of stagingFileList.filter(a => a.path.endsWith(".rpkg"))) {
					const result = [...file.path.matchAll(/(chunk[0-9]*)/g)]
					const chunk = result.length ? result[0][1] : "chunk0"
					rpkgsToInstall.push({ path: file.path, chunk })
				}
				modNameInputModalOpen = true
			} else {
				invalidModModalOpen = true
			}
		}
	}

	async function installFrameworkMod(stagingContents: string[]) {
		await nativeFs.copySync("./staging", "../Mods")

		const firstManifest = json5.parse(
			await nativeFs.readFileSync(
				nativePath.join("../Mods", (await nativeFs.readdirSync("./staging"))[0], "manifest.json"),
				"utf8"
			)
		)
		config = await mergeConfig({
			knownMods: [...(config?.knownMods ?? []), firstManifest.id]
		})

		await nativeFs.removeSync("./staging")
		await refreshLists()
	}

	async function installRPKGMod() {
		rpkgModExtractionInProgress = true
		for (const file of rpkgsToInstall) {
			await nativeFs.ensureDirSync(nativePath.join("..", "Mods", rpkgModName, file.chunk))
			await nativeFs.copyFileSync(
				file.path,
				nativePath.join("..", "Mods", rpkgModName, file.chunk, nativePath.basename(file.path))
			)
		}
		config = await mergeConfig({ knownMods: [...(config?.knownMods ?? []), rpkgModName] })
		await nativeFs.removeSync("./staging")
		rpkgModExtractionInProgress = false
		await refreshLists()
	}

	async function openAddModDialog() {
		const filePath = await openModFileDialog()
		if (!filePath) return
		modFilePath = filePath
		await addMod()
	}

	// ─── auto-install (deep link) ─────────────────────────────────────────────

	async function handleAutoInstall(url: string) {
		let chunksAll: Uint8Array
		try {
			autoInstallDownloading = true
			const response = await fetch(url)
			const reader = response.body!.getReader()
			autoInstallDownloadSize = +response.headers.get("Content-Length")!

			let receivedLength = 0
			const chunks: Uint8Array[] = []
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				chunks.push(value)
				receivedLength += value.length
				autoInstallDownloadProgress = receivedLength
			}
			chunksAll = new Uint8Array(receivedLength)
			let pos = 0
			for (const c of chunks) { chunksAll.set(c, pos); pos += c.length }
		} catch (e) {
			alert("Couldn't download the mod! Check your internet connection, or contact the mod author for help.\n\n" + e)
			autoInstallDownloading = false
			return
		}

		await writeTempBytes("./tempArchive", chunksAll)
		await nativeFs.emptyDirSync("./staging")
		await extractArchive("./tempArchive", "./staging")
		autoInstallDownloading = false

		const stagingFirst = (await nativeFs.readdirSync("./staging"))[0]
		const firstManifest = json5.parse(
			await nativeFs.readFileSync(nativePath.join("./staging", stagingFirst, "manifest.json"), "utf8")
		)
		autoInstallModName = firstManifest.name
		autoInstallModalOpen = true
	}
</script>

<div class="grid grid-cols-2 gap-4 w-full mb-16">
	<div class="w-full">
		<div class="flex gap-4 items-center justify-center" transition:scale>
			<h1 class="flex-grow">Available Mods</h1>
			<div>
				<Search icon={Filter} placeholder="Filter available mods" bind:value={availableModFilter} />
			</div>
			<Button kind="primary" icon={Add} on:click={openAddModDialog}>Add a Mod</Button>
		</div>
		<br />
		<div class="h-[90vh] overflow-y-auto">
			{#each disabledMods.filter(a => {
				const name = manifestCache.has(a.value) ? (manifestCache.get(a.value)?.name ?? a.value) : a.value
				const desc = manifestCache.get(a.value)?.description ?? ""
				return (name + desc).toLowerCase().includes(availableModFilter.toLowerCase())
			}) as item (item.value)}
				<div animate:flip={{ duration: 300 }}>
					<div transition:scale>
						<Mod
							isFrameworkMod={manifestCache.has(item.value)}
							manifest={manifestCache.get(item.value)}
							rpkgModName={!manifestCache.has(item.value) ? item.value : undefined}
							{config}
						>
							<Button
								kind="primary"
								icon={AddAlt}
								on:click={async () => {
									config = await mergeConfig({ loadOrder: [...(config?.loadOrder ?? []), item.value] })
									changed = true
								}}
							>
								Enable
							</Button>
							<Button
								kind="danger"
								icon={TrashCan}
								on:click={() => { deleteModInProgress = item.value; deleteModModalOpen = true }}
							>
								Delete
							</Button>
						</Mod>
					</div>
					<br />
				</div>
			{/each}
		</div>
	</div>

	<div class="w-full">
		<div class="flex gap-4 items-center justify-center" transition:scale>
			<h1 class="flex-grow">{changed && !deployFinished ? "To Be Applied" : "Enabled Mods"}</h1>
			<div>
				<Search icon={Filter} placeholder="Filter enabled mods" bind:value={enabledModFilter} />
			</div>
			<Button
				kind="primary"
				style={changed && !deployFinished ? "background-color: green" : ""}
				icon={Rocket}
				on:click={async () => {
					await sortMods()
					config = await getConfig()
					deployOutput = ""
					deployOutputHTML = ""
					deployFinished = false
					frameworkDeployModalOpen = true
					try {
						await runDeploy()
					} catch (e) {
						alert("Failed to start deploy: " + e)
						frameworkDeployModalOpen = false
					}
				}}
			>
				Apply
			</Button>
		</div>
		<br />
		<div class="h-[90vh] overflow-y-auto">
			<SortableList
				list={enabledMods}
				key="value"
				on:sort={async event => {
					config = await mergeConfig({ loadOrder: event.detail.map(a => a.value) })
					changed = true
				}}
				let:item
			>
				<div class="cursor-grab">
					<Mod
						isFrameworkMod={manifestCache.has(item.value)}
						manifest={manifestCache.get(item.value)}
						rpkgModName={!manifestCache.has(item.value) ? item.value : undefined}
						darken={!((manifestCache.get(item.value)?.name ?? item.value) + (manifestCache.get(item.value)?.description ?? ""))
							.toLowerCase()
							.includes(enabledModFilter.toLowerCase())}
						{config}
					>
						{#if manifestCache.has(item.value) && (manifestCache.get(item.value)?.options ?? []).filter(a => a.type !== OptionType.conditional).length}
							<Button
								kind="ghost"
								icon={Settings}
								iconDescription="Adjust this mod's settings"
								href={`/settings?mod=${manifestCache.get(item.value)?.id}`}
							/>
						{/if}
						<Button
							kind="danger"
							icon={SubtractAlt}
							on:click={async () => {
								config = await mergeConfig({ loadOrder: (config?.loadOrder ?? []).filter(a => a !== item.value) })
								changed = true
							}}
						>
							Disable
						</Button>
					</Mod>
					<br />
				</div>
			</SortableList>
		</div>
	</div>
</div>

{#if showDropHint}
	<div transition:fade={{ duration: 100 }} class="w-screen h-screen absolute top-0 left-0 bg-black/90 flex flex-col gap-4 justify-center items-center">
		<h1 class="font-bold">Drop to install</h1>
	</div>
{/if}

<!-- delete mod -->
<Modal
	danger
	bind:open={deleteModModalOpen}
	modalHeading="Delete mod"
	primaryButtonText="Delete the mod"
	secondaryButtonText="Cancel"
	on:click:button--secondary={() => (deleteModModalOpen = false)}
	on:submit={async () => {
		const folder = await getModFolder(deleteModInProgress)
		await nativeFs.removeSync(folder)
		config = await mergeConfig({ knownMods: (config?.knownMods ?? []).filter(a => a !== deleteModInProgress) })
		deleteModModalOpen = false
		await refreshLists()
	}}
	shouldSubmitOnEnter={false}
>
	<p>
		{#if deleteModInProgress}
			Are you sure you want to permanently remove the <i>{manifestCache.get(deleteModInProgress)?.name ?? deleteModInProgress}</i>
			mod from the Mods folder? You cannot undo this.
		{/if}
	</p>
</Modal>

<Modal alert bind:open={dependencyCycleModalOpen} modalHeading="Dependency cycle (couldn't sort mods)" primaryButtonText="OK" shouldSubmitOnEnter={false}>
	<p>The framework couldn't sort your mods! Ask the developer of whichever mod you most recently installed to investigate this. Also, report this to Atampy26 on Hitman Forum or Discord.</p>
</Modal>

<!-- deploy output -->
<Modal passiveModal open={frameworkDeployModalOpen} modalHeading="Applying your mods" preventCloseOnClickOutside>
	Your mods are being deployed. This may take a while - grab a coffee or something.
	<br />
	<pre
		class="mt-2 h-[10vh] overflow-y-auto whitespace-pre-wrap bg-neutral-800 p-2"
		style="font-family: 'Fira Code', 'IBM Plex Mono', 'Menlo', 'DejaVu Sans Mono', 'Bitstream Vera Sans Mono', Courier, monospace; color-scheme: dark"
		id="deployOutputElement">{@html deployOutputHTML}</pre>
	{#if deployOutput.split(/\r?\n/).some(a => a.match(/.*WARN.*?\t/)) || deployOutput.split(/\r?\n/).some(a => a.match(/.*ERROR.*?\t/))}
		<br />
		<div class="flex flex-row gap-2 flex-wrap max-h-[15vh] overflow-y-auto">
			{#each deployDiagnostics as line}
				<InlineNotification hideCloseButton lowContrast kind={line.includes("WARN") ? "warning" : "error"}>
					<div slot="title" class="-mt-1 text-lg">{line.includes("WARN") ? "Warning" : "Error"}</div>
					<div slot="subtitle">{line.replace(/.*WARN.*?\t/, "").replace(/.*ERROR.*?\t/, "")}</div>
				</InlineNotification>
			{/each}
		</div>
	{/if}

	{#if deployFinished}
		<br />
		<div class="flex gap-4 items-center">
			{#if deployOutput.split(/\r?\n/).map(a => a.trim()).filter(a => a.length).at(-1)?.match(/\tDone in .*/) && !deployOutput.split(/\r?\n/).some(a => a.match(/.*WARN.*?\t/))}
				<Button kind="primary" icon={Close} on:click={() => (frameworkDeployModalOpen = false)}>Close</Button>
				<span class="text-green-300">Deploy successful</span>
			{:else if deployOutput.split(/\r?\n/).map(a => a.trim()).filter(a => a.length).at(-1)?.match(/\tDone in .*/) && deployOutput.split(/\r?\n/).some(a => a.match(/.*WARN.*?\t/))}
				<Button kind="primary" icon={Close} on:click={() => (frameworkDeployModalOpen = false)}>Close</Button>
				<span class="text-yellow-300">Potential issues in deployment</span>
			{:else}
				<Button kind="primary" icon={Close} on:click={() => (frameworkDeployModalOpen = false)}>Close</Button>
				<Button
					kind="primary"
					icon={CloudUpload}
					on:click={async () => {
						const req = await fetch("http://hitman-resources.netlify.app/.netlify/functions/upload-smf-log", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ content: "Config:\n" + JSON.stringify(config) + "\n\nDeploy log:\n" + deployOutput })
						})
						if (req.status === 200) {
							uploadedLogURL = await req.text()
							frameworkDeployModalOpen = false
							uploadLogModalOpen = true
						} else {
							uploadLogFailedModalOpen = true
						}
					}}
				>
					Upload mod list and log
				</Button>
				<span class="text-red-300">Deploy unsuccessful</span>
			{/if}
		</div>
	{/if}
</Modal>

<!-- rpkg mod name input -->
<TextInputModal
	bind:this={modNameInputModal}
	bind:showingModal={modNameInputModalOpen}
	modalText="Mod name"
	modalPlaceholder="Amazing RPKG Mod"
	on:close={async () => {
		modNameInputModalOpen = false
		rpkgModName = modNameInputModal.value

		if (!rpkgModName.match(/^(?!(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.[^.]*)?$)[^<>:"\/\\|?*\x00-\x1F]*[^<>:"\/\\|?*\x00-\x1F .]$/iu)) {
			alert("That's not a valid folder name and so cannot be used for an RPKG mod name. Please try another.")
			setTimeout(() => (modNameInputModalOpen = true), 100)
		} else {
			await installRPKGMod()
		}
	}}
/>

<Modal passiveModal open={rpkgModExtractionInProgress} modalHeading="Installing {rpkgModName}" preventCloseOnClickOutside>
	The mod is being installed - please wait.
</Modal>

<Modal passiveModal open={frameworkModExtractionInProgress} modalHeading="Installing the mod" preventCloseOnClickOutside>
	The mod is being installed - please wait.
</Modal>

<Modal alert bind:open={invalidFrameworkZipModalOpen} modalHeading="Invalid framework ZIP" primaryButtonText="OK" shouldSubmitOnEnter={false} on:submit={() => (invalidFrameworkZipModalOpen = false)}>
	<p>The framework ZIP file contains files in the root directory. Contact the mod author.</p>
</Modal>

<Modal alert bind:open={invalidModModalOpen} modalHeading="Not a mod" primaryButtonText="OK" shouldSubmitOnEnter={false} on:submit={() => (invalidModModalOpen = false)}>
	<p>This doesn't look like a mod? Make sure you select a mod ZIP, and that the mod is either a framework mod or RPKG mod.</p>
</Modal>

<Modal alert bind:open={invalidFrameworkModModalOpen} modalHeading="Invalid mod" primaryButtonText="OK" shouldSubmitOnEnter={false} on:submit={() => (invalidFrameworkModModalOpen = false)}>
	<p>The mod you're trying to install is invalid. Contact the mod author.</p>
	<span class="mt-1 text-xs text-neutral-300">{modValidationError}</span>
</Modal>

<Modal
	danger
	bind:open={frameworkModScriptsWarningOpen}
	modalHeading="Mod contains scripts"
	primaryButtonText="I'm sure"
	secondaryButtonText="Cancel"
	shouldSubmitOnEnter={false}
	on:click:button--secondary={() => (frameworkModScriptsWarningOpen = false)}
	on:click:button--primary={async () => {
		const stagingContents = await nativeFs.readdirSync("./staging")
		let hasPeacock = false
		for (const a of stagingContents) {
			const mf = json5.parse(await nativeFs.readFileSync(nativePath.join("./staging", a, "manifest.json"), "utf8"))
			if (mf.peacockPlugins || mf.options?.some(b => b.peacockPlugins)) hasPeacock = true
		}
		frameworkModScriptsWarningOpen = false
		if (hasPeacock) {
			frameworkModPeacockPluginsWarningOpen = true
		} else {
			await installFrameworkMod(stagingContents)
		}
	}}
>
	<p>
		This mod contains scripts; that means it is able to execute its own code and effectively has complete control over your PC whenever you apply your mods. Scripts can do cool things and make a
		lot of mods possible, but they can also do bad things like installing malware on your computer. Make sure you trust whoever developed this mod, and wherever you downloaded it from. Are you
		sure you want to add this mod?
	</p>
</Modal>

<Modal
	danger
	bind:open={frameworkModPeacockPluginsWarningOpen}
	modalHeading="Mod contains Peacock plugins"
	primaryButtonText="I'm sure"
	secondaryButtonText="Cancel"
	shouldSubmitOnEnter={false}
	on:click:button--secondary={() => (frameworkModPeacockPluginsWarningOpen = false)}
	on:click:button--primary={async () => {
		const stagingContents = await nativeFs.readdirSync("./staging")
		frameworkModPeacockPluginsWarningOpen = false
		await installFrameworkMod(stagingContents)
	}}
>
	<p>
		This mod contains Peacock plugins; if you use the Peacock server emulator after applying this mod, the mod's plugins will have complete control over your PC. Make sure you trust whoever
		developed this mod, and wherever you downloaded it from. Are you sure you want to add this mod?
	</p>
</Modal>

<Modal
	alert
	bind:open={displayExtractedModsDialog}
	modalHeading="Incorrectly installed mod{extractedMods.length > 1 ? 's' : ''}"
	primaryButtonText="OK"
	shouldSubmitOnEnter={false}
	on:submit={() => (displayExtractedModsDialog = false)}
>
	<p>
		The mod{extractedMods.length > 1 ? "s" : ""}
		{extractedMods.slice(0, -1).length ? extractedMods.slice(0, -1).join(", ") + " and " + extractedMods[extractedMods.length - 1] : extractedMods[0]}
		{extractedMods.length > 1 ? "were" : "was"} installed by extracting the ZIP file directly to the Mods folder. That's not how you're meant to install mods; use the Add a Mod button instead.
		This message won't be shown again for {extractedMods.length > 1 ? "these mods" : "this mod"}.
		<br /><br />
		If you're seeing this after creating a new mod yourself, you should enable developer mode in the information page.
	</p>
</Modal>

<Modal alert bind:open={uploadLogFailedModalOpen} modalHeading="Couldn't upload log" primaryButtonText="OK" shouldSubmitOnEnter={false} on:submit={() => (uploadLogFailedModalOpen = false)}>
	<p>Your log couldn't be uploaded. Make sure you're connected to the Internet.</p>
</Modal>

<Modal alert bind:open={uploadLogModalOpen} modalHeading="Log uploaded" primaryButtonText="OK" shouldSubmitOnEnter={false} on:submit={() => (uploadLogModalOpen = false)}>
	<p class="mb-2">Your deploy log has been anonymously uploaded to the Internet.</p>
	<CodeSnippet code={uploadedLogURL} />
	<br />
	<div class="mb-6" />
</Modal>

<Modal passiveModal open={autoInstallDownloading} modalHeading="Downloading the mod" preventCloseOnClickOutside>
	<div class="mb-2">The mod is currently being downloaded - please wait.</div>
	<br />
	<ProgressBar kind="inline" value={autoInstallDownloadProgress} max={autoInstallDownloadSize} labelText="Downloading..." />
</Modal>

<Modal
	bind:open={autoInstallModalOpen}
	modalHeading="Installing {autoInstallModName}"
	primaryButtonText="OK"
	secondaryButtonText="Cancel"
	shouldSubmitOnEnter={false}
	on:click:button--secondary={() => (autoInstallModalOpen = false)}
	on:click:button--primary={async () => {
		autoInstallModalOpen = false
		modFilePath = "./tempArchive"
		await addMod()
	}}
>
	<p>The mod {autoInstallModName} has been downloaded via a link - would you like to install it?</p>
</Modal>

<style>
	:global(.bx--btn--ghost) {
		color: inherit;
		@apply bg-neutral-800;
	}

	:global(.bx--btn--ghost:hover, .bx--btn--ghost:active) {
		color: inherit;
	}

	:global(li) {
		border: inherit !important;
		transition: inherit !important;
	}

	:global(.over) {
		border-color: inherit !important;
	}

	:global(.bx--modal-close) {
		display: none;
	}

	:global(.bx--inline-notification__icon) {
		display: none;
	}

	:global(.bx--snippet.bx--snippet--single) {
		background-color: #262626;
	}
</style>
