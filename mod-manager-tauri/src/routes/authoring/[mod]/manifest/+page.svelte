<script lang="ts">
	import { scale } from "svelte/transition"
	import { onMount } from "svelte"
	import { page } from "$app/stores"

	import { alterModManifest, FrameworkVersion, getManifestFromModID, getModFolder, setModManifest } from "$lib/utils"
	import ModManifestInterface from "$lib/ModManifestInterface.svelte"
	import type { Manifest } from "../../../../../../src/types"
	import { Language, Platform } from "../../../../../../src/types"

	import isEqual from "lodash.isequal"

	const emptyManifest: Manifest = {
		version: "1.0.0", id: "Example.Example", name: "Loading...",
		description: "", authors: [], contentFolders: ["content"], frameworkVersion: FrameworkVersion
	} as Manifest

	let manifest: Manifest = { ...emptyManifest }
	let modFolder = ""

	async function loadMod(modId: string) {
		try {
			manifest = await getManifestFromModID(modId)
			modFolder = await getModFolder(modId)
		} catch {
			manifest = { ...emptyManifest, name: "Error loading mod" }
		}
	}

	$: if ($page.params.mod) loadMod($page.params.mod)
	onMount(() => { if ($page.params.mod) loadMod($page.params.mod) })

	// Shared helper: reload manifest after any mutation
	async function reload() { manifest = await getManifestFromModID(manifest.id) }
</script>

<div class="flex gap-4 items-center justify-center">
	<h1 class="text-center" transition:scale>{manifest.name}</h1>
</div>

<div class="flex gap-4 items-center justify-center">
	<h4 class="text-center" transition:scale>
		<a href="/authoring/{$page.params.mod}">← Back</a>
	</h4>
</div>

<br />

<div class="{window.screen.height <= 1080 ? 'h-[88vh]' : 'h-[90vh]'} overflow-y-auto overflow-x-hidden pr-4">
	<ModManifestInterface
		source={manifest}
		{modFolder}
		on:contentFolder-define={async ({ detail }) => {
			await alterModManifest(manifest.id, { contentFolders: detail.split(", ") })
			await reload()
		}}
		on:contentFolder-undefine={async () => {
			const x = await getManifestFromModID(manifest.id)
			delete x["contentFolders"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:blobsFolder-define={async ({ detail }) => {
			await alterModManifest(manifest.id, { blobsFolders: detail.split(", ") })
			await reload()
		}}
		on:blobsFolder-undefine={async () => {
			const x = await getManifestFromModID(manifest.id)
			delete x["blobsFolders"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:localisationValue-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["localisation"])
				await alterModManifest(manifest.id, { localisation: Object.fromEntries(Object.keys(Language).filter(a => typeof a === "string").map(a => [a, {}])) })
			await alterModManifest(manifest.id, { localisation: { [detail.language]: { [detail.key]: detail.value } } })
			await reload()
		}}
		on:localisationValue-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			delete x["localisation"][detail.language][detail.key]
			if (isEqual(x["localisation"], Object.fromEntries(Object.keys(Language).filter(a => typeof a === "string").map(a => [a, {}])))) delete x["localisation"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:localisationOverrideValue-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["localisationOverrides"]) await alterModManifest(manifest.id, { localisationOverrides: {} })
			if (!x["localisationOverrides"]?.[detail.hash]) await alterModManifest(manifest.id, { localisationOverrides: { [detail.hash]: Object.fromEntries(Object.keys(Language).filter(a => typeof a === "string").map(a => [a, {}])) } })
			await alterModManifest(manifest.id, { localisationOverrides: { [detail.hash]: { [detail.language]: { [detail.key]: detail.value } } } })
			await reload()
		}}
		on:localisationOverrideValue-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			delete x["localisationOverrides"][detail.hash][detail.language][detail.key]
			if (isEqual(x["localisationOverrides"][detail.hash], Object.fromEntries(Object.keys(Language).filter(a => typeof a === "string").map(a => [a, {}])))) delete x["localisationOverrides"][detail.hash]
			if (isEqual(x["localisationOverrides"], {})) delete x["localisationOverrides"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:localisedLine-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["localisedLines"]) await alterModManifest(manifest.id, { localisedLines: {} })
			await alterModManifest(manifest.id, { localisedLines: { [detail.key]: detail.value } })
			await reload()
		}}
		on:localisedLine-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			delete x["localisedLines"][detail.key]
			if (isEqual(x["localisedLines"], {})) delete x["localisedLines"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:pdefPartition-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["packagedefinition"]) await alterModManifest(manifest.id, { packagedefinition: [] })
			const pdef = (await getManifestFromModID(manifest.id)).packagedefinition || []
			const origIdx = pdef.findIndex(a => a.name === detail.partition.split("$:$")[0])
			const original = origIdx !== -1 ? pdef.splice(origIdx, 1)[0] : { type: "partition", name: detail.partition.split("$:$")[0], parent: "super", partitionType: "standard" }
			pdef.push({ ...original, [detail.key]: detail.value })
			await alterModManifest(manifest.id, { packagedefinition: pdef })
			await reload()
		}}
		on:pdefPartition-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			const idx = x.packagedefinition?.findIndex(a => a.name === detail.partition.split("$:$")[0]) ?? -1
			if (idx !== -1) x.packagedefinition?.splice(idx, 1)
			if (isEqual(x["packagedefinition"], [])) delete x["packagedefinition"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:pdefEntity-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["packagedefinition"]) await alterModManifest(manifest.id, { packagedefinition: [] })
			const pdef = (await getManifestFromModID(manifest.id)).packagedefinition || []
			const [ePart, ePath] = detail.entity.split("$:$")[0].split("|")
			const origIdx = pdef.findIndex(a => a.partition === ePart && a.path === ePath)
			const original = origIdx !== -1 ? pdef.splice(origIdx, 1)[0] : { type: "entity", partition: ePart, path: ePath }
			pdef.push({ ...original, [detail.key]: detail.value })
			await alterModManifest(manifest.id, { packagedefinition: pdef })
			await reload()
		}}
		on:pdefEntity-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			const [ePart, ePath] = detail.entity.split("$:$")[0].split("|")
			const idx = x.packagedefinition?.findIndex(a => a.partition === ePart && a.path === ePath) ?? -1
			if (idx !== -1) x.packagedefinition?.splice(idx, 1)
			if (isEqual(x["packagedefinition"], [])) delete x["packagedefinition"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:dependency-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["dependencies"]) await alterModManifest(manifest.id, { dependencies: [] })
			const deps = ((await getManifestFromModID(manifest.id)).dependencies || []).map(a => typeof a === "string" ? { runtimeID: a, toChunk: 0, portFromChunk1: false } : a)
			const origIdx = deps.findIndex(a => a.toChunk === detail.origToChunk && a.runtimeID === detail.origRuntimeID && a.portFromChunk1 === detail.origPortFromChunk1)
			const original = origIdx !== -1 ? deps.splice(origIdx, 1)[0] : { toChunk: detail.origToChunk, runtimeID: detail.origRuntimeID, portFromChunk1: detail.origPortFromChunk1 }
			if (detail.type === "defineToChunk") deps.push({ ...original, toChunk: detail.newToChunk })
			else if (detail.type === "defineRuntimeID") deps.push({ ...original, runtimeID: detail.newRuntimeID })
			else if (detail.type === "definePortFromChunk1") deps.push({ ...original, portFromChunk1: detail.newPortFromChunk1 })
			await alterModManifest(manifest.id, { dependencies: deps.map(a => a.toChunk === 0 && !a.portFromChunk1 ? a.runtimeID : a) })
			await reload()
		}}
		on:dependency-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			const deps = (x.dependencies || []).map(a => typeof a === "string" ? { runtimeID: a, toChunk: 0, portFromChunk1: false } : a)
			const idx = deps.findIndex(a => a.toChunk === detail.toChunk && a.runtimeID === detail.runtimeID && a.portFromChunk1 === detail.portFromChunk1)
			if (idx !== -1) deps.splice(idx, 1)
			x.dependencies = deps.map(a => a.toChunk === 0 && !a.portFromChunk1 ? a.runtimeID : a)
			if (isEqual(x["dependencies"], [])) delete x["dependencies"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:thumbs-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["thumbs"]) await alterModManifest(manifest.id, { thumbs: [] })
			const thumbs = (await getManifestFromModID(manifest.id)).thumbs || []
			const idx = thumbs.findIndex(a => a === detail.original)
			if (idx !== -1) thumbs.splice(idx, 1)
			thumbs.push(detail.new)
			await alterModManifest(manifest.id, { thumbs })
			await reload()
		}}
		on:thumbs-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			const idx = (x.thumbs || []).findIndex(a => a === detail.value)
			if (idx !== -1) x.thumbs?.splice(idx, 1)
			if (isEqual(x["thumbs"], [])) delete x["thumbs"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:supportedPlatforms-alter={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			const allPlatforms = Object.keys(Platform).filter(a => typeof a === "string")
			if (detail.value) {
				if (!x["supportedPlatforms"]) await alterModManifest(manifest.id, { supportedPlatforms: [] })
				const sp = (await getManifestFromModID(manifest.id)).supportedPlatforms || []
				if (!sp.includes(detail.platform)) sp.push(detail.platform)
				await alterModManifest(manifest.id, { supportedPlatforms: sp })
			} else {
				x.supportedPlatforms = x.supportedPlatforms || allPlatforms
				const idx = x.supportedPlatforms.findIndex(a => a === detail.platform)
				if (idx !== -1) x.supportedPlatforms.splice(idx, 1)
				if (isEqual(x["supportedPlatforms"], [])) delete x["supportedPlatforms"]
				await setModManifest(manifest.id, x)
			}
			const y = await getManifestFromModID(manifest.id)
			if (allPlatforms.every(a => y["supportedPlatforms"]?.includes(a))) {
				delete y["supportedPlatforms"]
				await setModManifest(manifest.id, y)
			}
			await reload()
		}}
		on:requirements-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["requirements"]) await alterModManifest(manifest.id, { requirements: [] })
			const reqs = (await getManifestFromModID(manifest.id)).requirements || []
			const idx = reqs.findIndex(a => a === detail.original)
			if (idx !== -1) reqs.splice(idx, 1)
			reqs.push(detail.new)
			await alterModManifest(manifest.id, { requirements: reqs })
			await reload()
		}}
		on:requirements-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			const idx = (x.requirements || []).findIndex(a => a === detail.value)
			if (idx !== -1) x.requirements?.splice(idx, 1)
			if (isEqual(x["requirements"], [])) delete x["requirements"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:loadBefore-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["loadBefore"]) await alterModManifest(manifest.id, { loadBefore: [] })
			const lb = (await getManifestFromModID(manifest.id)).loadBefore || []
			const idx = lb.findIndex(a => a === detail.original)
			if (idx !== -1) lb.splice(idx, 1)
			lb.push(detail.new)
			await alterModManifest(manifest.id, { loadBefore: lb })
			await reload()
		}}
		on:loadBefore-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			const idx = (x.loadBefore || []).findIndex(a => a === detail.value)
			if (idx !== -1) x.loadBefore?.splice(idx, 1)
			if (isEqual(x["loadBefore"], [])) delete x["loadBefore"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
		on:loadAfter-define={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			if (!x["loadAfter"]) await alterModManifest(manifest.id, { loadAfter: [] })
			const la = (await getManifestFromModID(manifest.id)).loadAfter || []
			const idx = la.findIndex(a => a === detail.original)
			if (idx !== -1) la.splice(idx, 1)
			la.push(detail.new)
			await alterModManifest(manifest.id, { loadAfter: la })
			await reload()
		}}
		on:loadAfter-undefine={async ({ detail }) => {
			const x = await getManifestFromModID(manifest.id)
			const idx = (x.loadAfter || []).findIndex(a => a === detail.value)
			if (idx !== -1) x.loadAfter?.splice(idx, 1)
			if (isEqual(x["loadAfter"], [])) delete x["loadAfter"]
			await setModManifest(manifest.id, x)
			await reload()
		}}
	/>
</div>

<div class="mb-[100vh]" />
