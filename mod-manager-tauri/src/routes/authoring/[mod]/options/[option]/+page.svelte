<script lang="ts">
	type ArrayElement<A> = A extends readonly (infer T)[] ? T : never

	import { scale } from "svelte/transition"
	import { onMount } from "svelte"
	import { page } from "$app/stores"
	import { goto } from "$app/navigation"

	import tippy from "svelte-tippy"
	import "tippy.js/dist/tippy.css"

	import { convertFileSrc } from "@tauri-apps/api/core"

	import { FrameworkVersion, getManifestFromModID, getModFolder, setModManifest } from "$lib/utils"
	import ModManifestInterface from "$lib/ModManifestInterface.svelte"
	import TextInputModal from "$lib/TextInputModal.svelte"
	import type { Manifest } from "../../../../../../../src/types"
	import { Language, OptionType, Platform } from "../../../../../../../src/types"

	import { Button, Checkbox, RadioButton, RadioButtonGroup } from "carbon-components-svelte"
	import Edit from "carbon-icons-svelte/lib/Edit.svelte"
	import CloseOutline from "carbon-icons-svelte/lib/CloseOutline.svelte"

	import { openImageDialog, path as nativePath } from "$lib/native"
	import isEqual from "lodash.isequal"
	import merge from "lodash.mergewith"

	const emptyManifest: Manifest = {
		version: "1.0.0", id: "Example.Example", name: "Loading...",
		description: "", authors: [], contentFolders: ["content"], frameworkVersion: FrameworkVersion
	} as Manifest

	let manifest: Manifest = { ...emptyManifest }
	let modFolder = ""
	let option: ArrayElement<Manifest["options"]> = {} as ArrayElement<Manifest["options"]>

	function findOption(m: Manifest, optParam: string): ArrayElement<Manifest["options"]> {
		const [groupPart, namePart] = optParam.split("$|$")
		return m.options!.find(a =>
			groupPart === "-"
				? (a.type === "checkbox" || a.type === "conditional") && a.name === namePart
				: a.type === "select" && a.group === groupPart && a.name === namePart
		)! ?? ({} as ArrayElement<Manifest["options"]>)
	}

	async function loadMod(modId: string, optParam: string) {
		try {
			manifest = await getManifestFromModID(modId)
			modFolder = await getModFolder(modId)
			option = findOption(manifest, optParam)
		} catch {}
	}

	$: if ($page.params.mod && $page.params.option) loadMod($page.params.mod, $page.params.option)
	onMount(() => { if ($page.params.mod && $page.params.option) loadMod($page.params.mod, $page.params.option) })

	async function reload() {
		manifest = await getManifestFromModID(manifest.id)
		option = findOption(manifest, $page.params.option)
	}

	// ─── option-level mutation helpers ──────────────────────────────────────────

	async function alterOption(data: Partial<ArrayElement<Manifest["options"]>>) {
		const m = await getManifestFromModID(manifest.id)
		const idx = m.options!.findIndex(a => findOption({ ...m, options: [a] } as any, $page.params.option)?.name === a.name && findOption({ ...m, options: [a] } as any, $page.params.option)?.group === a.group)
		if (idx === -1) return
		merge(m.options![idx], data, (orig: any, src: any) => Array.isArray(orig) ? src : undefined)
		await setModManifest(manifest.id, m)
		await reload()
	}

	async function getOption(): Promise<ArrayElement<Manifest["options"]>> {
		const m = await getManifestFromModID(manifest.id)
		return findOption(m, $page.params.option)
	}

	async function setOption(data: ArrayElement<Manifest["options"]>) {
		const m = await getManifestFromModID(manifest.id)
		const [groupPart, namePart] = $page.params.option.split("$|$")
		const idx = m.options!.findIndex(a =>
			groupPart === "-"
				? (a.type === "checkbox" || a.type === "conditional") && a.name === namePart
				: a.type === "select" && a.group === groupPart && a.name === namePart
		)
		if (idx === -1) return
		m.options![idx] = data
		await setModManifest(manifest.id, m)
		await reload()
	}

	let optionNameInputModal: TextInputModal
	let optionNameInputModalOpen = false
	let groupInputModal: TextInputModal
	let groupInputModalOpen = false
	let tooltipInputModal: TextInputModal
	let tooltipInputModalOpen = false
	let conditionInputModal: TextInputModal
	let conditionInputModalOpen = false

	async function changeOptionType(newType: string) {
		const opt = await getOption()
		opt.type = newType as any
		delete opt.enabledByDefault
		delete opt.group
		delete opt.tooltip
		delete opt.image
		delete (opt as any).mods
		delete (opt as any).condition
		await setOption(opt)
	}

	async function setCondition(value: string) {
		await alterOption({ condition: value } as any)
	}

	$: optionGroup = (option as any).group ?? ""
	$: optionCondition = (option as any).condition ?? ""
</script>

<div class="flex gap-8 items-center">
	<h4 class="text-center" transition:scale>
		<a href="/authoring/{$page.params.mod}">← Back</a>
	</h4>

	<div>
		<h1 transition:scale>{manifest.name}</h1>
		<div class="flex gap-4 items-center justify-center">
			<h3 transition:scale>{option.name}</h3>
			<Button kind="ghost" size="field" icon={Edit} iconDescription="Edit option name" on:click={() => (optionNameInputModalOpen = true)} />
		</div>
	</div>

	<div class="flex-grow" />

	<div>
		<RadioButtonGroup
			selected={option.type}
			on:change={async ({ detail }) => changeOptionType(detail)}
			legendText="Type of option"
		>
			{#each Object.keys(OptionType).filter(a => typeof a === "string") as optionType (optionType)}
				<RadioButton value={optionType} labelText={optionType.slice(0, 1).toUpperCase() + optionType.slice(1)} />
			{/each}
		</RadioButtonGroup>
	</div>

	{#if option.type === "select"}
		<div>
			<Button icon={Edit} on:click={() => (groupInputModalOpen = true)}>Set group</Button>
		</div>
	{/if}

	{#if option.type === "checkbox" || option.type === "select"}
		<div>
			<Checkbox
				checked={option.enabledByDefault}
				labelText="Enabled by default"
				on:change={async ({ target: { checked } }) => alterOption({ enabledByDefault: checked })}
			/>
		</div>
		<div>
			<div
				use:tippy={option?.tooltip
					? { content: () => { const e = document.createElement("span"); e.innerText = option.tooltip ?? ""; return e }, placement: "left" }
					: { content: undefined, delay: 9999999999 }}
				class="inline"
			>
				<Button icon={Edit} on:click={() => (tooltipInputModalOpen = true)}>Set tooltip</Button>
			</div>
			{#if option.tooltip}
				<Button kind="ghost" icon={CloseOutline} iconDescription="Remove tooltip" on:click={async () => {
					const opt = await getOption()
					delete opt.tooltip
					await setOption(opt)
				}} />
			{/if}

			<div class="ml-4 inline" />

			<div
				use:tippy={option?.image
					? { content: () => { const e = document.createElement("div"); const img = document.createElement("img"); img.src = convertFileSrc(nativePath.join(modFolder, option.image || "")); e.appendChild(img); return e }, placement: "left" }
					: { content: undefined, delay: 9999999999 }}
				class="inline"
			>
				<Button icon={Edit} on:click={async () => {
					const imgPath = await openImageDialog()
					if (imgPath) {
						await alterOption({ image: nativePath.relative(modFolder, imgPath) })
					}
				}}>Set thumbnail</Button>
			</div>
			{#if option.image}
				<Button kind="ghost" icon={CloseOutline} iconDescription="Remove thumbnail" on:click={async () => {
					const opt = await getOption()
					delete opt.image
					await setOption(opt)
				}} />
			{/if}
		</div>
	{/if}

	{#if option.type === "conditional"}
		<div>
			<Button icon={Edit} on:click={() => (conditionInputModalOpen = true)}>Set condition</Button>
		</div>
	{/if}

	<div />
</div>

<br />

<div class="{window.screen.height <= 1080 ? 'h-[83vh]' : 'h-[86vh]'} overflow-y-auto overflow-x-hidden pr-4">
	<ModManifestInterface
		source={option}
		{modFolder}
		on:contentFolder-define={async ({ detail }) => { await alterOption({ contentFolders: detail.split(", ") }) }}
		on:contentFolder-undefine={async () => { const o = await getOption(); delete o["contentFolders"]; await setOption(o) }}
		on:blobsFolder-define={async ({ detail }) => { await alterOption({ blobsFolders: detail.split(", ") }) }}
		on:blobsFolder-undefine={async () => { const o = await getOption(); delete o["blobsFolders"]; await setOption(o) }}
		on:localisationValue-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["localisation"]) await alterOption({ localisation: Object.fromEntries(Object.keys(Language).filter(a => typeof a === "string").map(a => [a, {}])) })
			await alterOption({ localisation: { [detail.language]: { [detail.key]: detail.value } } })
		}}
		on:localisationValue-undefine={async ({ detail }) => {
			const o = await getOption()
			delete o["localisation"][detail.language][detail.key]
			if (isEqual(o["localisation"], Object.fromEntries(Object.keys(Language).filter(a => typeof a === "string").map(a => [a, {}])))) delete o["localisation"]
			await setOption(o)
		}}
		on:localisationOverrideValue-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["localisationOverrides"]) await alterOption({ localisationOverrides: {} })
			if (!(await getOption())["localisationOverrides"]?.[detail.hash]) await alterOption({ localisationOverrides: { [detail.hash]: Object.fromEntries(Object.keys(Language).filter(a => typeof a === "string").map(a => [a, {}])) } })
			await alterOption({ localisationOverrides: { [detail.hash]: { [detail.language]: { [detail.key]: detail.value } } } })
		}}
		on:localisationOverrideValue-undefine={async ({ detail }) => {
			const o = await getOption()
			delete o["localisationOverrides"][detail.hash][detail.language][detail.key]
			if (isEqual(o["localisationOverrides"][detail.hash], Object.fromEntries(Object.keys(Language).filter(a => typeof a === "string").map(a => [a, {}])))) delete o["localisationOverrides"][detail.hash]
			if (isEqual(o["localisationOverrides"], {})) delete o["localisationOverrides"]
			await setOption(o)
		}}
		on:localisedLine-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["localisedLines"]) await alterOption({ localisedLines: {} })
			await alterOption({ localisedLines: { [detail.key]: detail.value } })
		}}
		on:localisedLine-undefine={async ({ detail }) => {
			const o = await getOption()
			delete o["localisedLines"][detail.key]
			if (isEqual(o["localisedLines"], {})) delete o["localisedLines"]
			await setOption(o)
		}}
		on:pdefPartition-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["packagedefinition"]) await alterOption({ packagedefinition: [] })
			const pdef = (await getOption()).packagedefinition || []
			const idx = pdef.findIndex(a => a.name === detail.partition.split("$:$")[0])
			const original = idx !== -1 ? pdef.splice(idx, 1)[0] : { type: "partition", name: detail.partition.split("$:$")[0], parent: "super", partitionType: "standard" }
			pdef.push({ ...original, [detail.key]: detail.value })
			await alterOption({ packagedefinition: pdef })
		}}
		on:pdefPartition-undefine={async ({ detail }) => {
			const o = await getOption()
			const idx = o.packagedefinition?.findIndex(a => a.name === detail.partition.split("$:$")[0]) ?? -1
			if (idx !== -1) o.packagedefinition?.splice(idx, 1)
			if (isEqual(o["packagedefinition"], [])) delete o["packagedefinition"]
			await setOption(o)
		}}
		on:pdefEntity-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["packagedefinition"]) await alterOption({ packagedefinition: [] })
			const pdef = (await getOption()).packagedefinition || []
			const [ePart, ePath] = detail.entity.split("$:$")[0].split("|")
			const idx = pdef.findIndex(a => a.partition === ePart && a.path === ePath)
			const original = idx !== -1 ? pdef.splice(idx, 1)[0] : { type: "entity", partition: ePart, path: ePath }
			pdef.push({ ...original, [detail.key]: detail.value })
			await alterOption({ packagedefinition: pdef })
		}}
		on:pdefEntity-undefine={async ({ detail }) => {
			const o = await getOption()
			const [ePart, ePath] = detail.entity.split("$:$")[0].split("|")
			const idx = o.packagedefinition?.findIndex(a => a.partition === ePart && a.path === ePath) ?? -1
			if (idx !== -1) o.packagedefinition?.splice(idx, 1)
			if (isEqual(o["packagedefinition"], [])) delete o["packagedefinition"]
			await setOption(o)
		}}
		on:dependency-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["dependencies"]) await alterOption({ dependencies: [] })
			const deps = ((await getOption()).dependencies || []).map(a => typeof a === "string" ? { runtimeID: a, toChunk: 0, portFromChunk1: false } : a)
			const idx = deps.findIndex(a => a.toChunk === detail.origToChunk && a.runtimeID === detail.origRuntimeID && a.portFromChunk1 === detail.origPortFromChunk1)
			const original = idx !== -1 ? deps.splice(idx, 1)[0] : { toChunk: detail.origToChunk, runtimeID: detail.origRuntimeID, portFromChunk1: detail.origPortFromChunk1 }
			if (detail.type === "defineToChunk") deps.push({ ...original, toChunk: detail.newToChunk })
			else if (detail.type === "defineRuntimeID") deps.push({ ...original, runtimeID: detail.newRuntimeID })
			else if (detail.type === "definePortFromChunk1") deps.push({ ...original, portFromChunk1: detail.newPortFromChunk1 })
			await alterOption({ dependencies: deps.map(a => a.toChunk === 0 && !a.portFromChunk1 ? a.runtimeID : a) })
		}}
		on:dependency-undefine={async ({ detail }) => {
			const o = await getOption()
			const deps = (o.dependencies || []).map(a => typeof a === "string" ? { runtimeID: a, toChunk: 0, portFromChunk1: false } : a)
			const idx = deps.findIndex(a => a.toChunk === detail.toChunk && a.runtimeID === detail.runtimeID)
			if (idx !== -1) deps.splice(idx, 1)
			o.dependencies = deps.map(a => a.toChunk === 0 && !a.portFromChunk1 ? a.runtimeID : a)
			if (isEqual(o["dependencies"], [])) delete o["dependencies"]
			await setOption(o)
		}}
		on:thumbs-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["thumbs"]) await alterOption({ thumbs: [] })
			const thumbs = (await getOption()).thumbs || []
			const idx = thumbs.findIndex(a => a === detail.original)
			if (idx !== -1) thumbs.splice(idx, 1)
			thumbs.push(detail.new)
			await alterOption({ thumbs })
		}}
		on:thumbs-undefine={async ({ detail }) => {
			const o = await getOption()
			const idx = (o.thumbs || []).findIndex(a => a === detail.value)
			if (idx !== -1) o.thumbs?.splice(idx, 1)
			if (isEqual(o["thumbs"], [])) delete o["thumbs"]
			await setOption(o)
		}}
		on:supportedPlatforms-alter={async ({ detail }) => {
			const allPlatforms = Object.keys(Platform).filter(a => typeof a === "string")
			const o = await getOption()
			if (detail.value) {
				if (!o["supportedPlatforms"]) await alterOption({ supportedPlatforms: [] })
				const sp = (await getOption()).supportedPlatforms || []
				if (!sp.includes(detail.platform)) sp.push(detail.platform)
				await alterOption({ supportedPlatforms: sp })
			} else {
				o.supportedPlatforms = o.supportedPlatforms || allPlatforms
				const idx = o.supportedPlatforms.findIndex(a => a === detail.platform)
				if (idx !== -1) o.supportedPlatforms.splice(idx, 1)
				if (isEqual(o["supportedPlatforms"], [])) delete o["supportedPlatforms"]
				await setOption(o)
			}
			const y = await getOption()
			if (allPlatforms.every(a => y["supportedPlatforms"]?.includes(a))) {
				delete y["supportedPlatforms"]
				await setOption(y)
			}
		}}
		on:requirements-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["requirements"]) await alterOption({ requirements: [] })
			const reqs = (await getOption()).requirements || []
			const idx = reqs.findIndex(a => a === detail.original)
			if (idx !== -1) reqs.splice(idx, 1)
			reqs.push(detail.new)
			await alterOption({ requirements: reqs })
		}}
		on:requirements-undefine={async ({ detail }) => {
			const o = await getOption()
			const idx = (o.requirements || []).findIndex(a => a === detail.value)
			if (idx !== -1) o.requirements?.splice(idx, 1)
			if (isEqual(o["requirements"], [])) delete o["requirements"]
			await setOption(o)
		}}
		on:loadBefore-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["loadBefore"]) await alterOption({ loadBefore: [] })
			const lb = (await getOption()).loadBefore || []
			const idx = lb.findIndex(a => a === detail.original)
			if (idx !== -1) lb.splice(idx, 1)
			lb.push(detail.new)
			await alterOption({ loadBefore: lb })
		}}
		on:loadBefore-undefine={async ({ detail }) => {
			const o = await getOption()
			const idx = (o.loadBefore || []).findIndex(a => a === detail.value)
			if (idx !== -1) o.loadBefore?.splice(idx, 1)
			if (isEqual(o["loadBefore"], [])) delete o["loadBefore"]
			await setOption(o)
		}}
		on:loadAfter-define={async ({ detail }) => {
			const o = await getOption()
			if (!o["loadAfter"]) await alterOption({ loadAfter: [] })
			const la = (await getOption()).loadAfter || []
			const idx = la.findIndex(a => a === detail.original)
			if (idx !== -1) la.splice(idx, 1)
			la.push(detail.new)
			await alterOption({ loadAfter: la })
		}}
		on:loadAfter-undefine={async ({ detail }) => {
			const o = await getOption()
			const idx = (o.loadAfter || []).findIndex(a => a === detail.value)
			if (idx !== -1) o.loadAfter?.splice(idx, 1)
			if (isEqual(o["loadAfter"], [])) delete o["loadAfter"]
			await setOption(o)
		}}
	/>
</div>

<TextInputModal
	bind:this={optionNameInputModal}
	bind:showingModal={optionNameInputModalOpen}
	modalText="Edit the option name"
	modalPlaceholder={option.name ?? ""}
	modalInitialText={option.name ?? ""}
	on:close={async () => {
		if (optionNameInputModal.value?.length) {
			await alterOption({ name: optionNameInputModal.value })
			goto(`/authoring/${$page.params.mod}/options/${$page.params.option.split("$|$")[0]}$|$${optionNameInputModal.value}`)
		}
	}}
/>

<TextInputModal
	bind:this={groupInputModal}
	bind:showingModal={groupInputModalOpen}
	modalText="Edit the option group"
	modalPlaceholder={optionGroup}
	modalInitialText={optionGroup}
	on:close={async () => {
		if (groupInputModal.value?.length) {
			await alterOption({ group: groupInputModal.value })
			goto(`/authoring/${$page.params.mod}/options/${groupInputModal.value}$|$${$page.params.option.split("$|$")[1]}`)
		}
	}}
/>

<TextInputModal
	bind:this={tooltipInputModal}
	bind:showingModal={tooltipInputModalOpen}
	modalText="Edit the option tooltip"
	modalPlaceholder={option.tooltip ?? ""}
	modalInitialText={option.tooltip ?? ""}
	multiline
	on:close={async () => {
		if (tooltipInputModal.value?.length) await alterOption({ tooltip: tooltipInputModal.value })
	}}
/>

<TextInputModal
	bind:this={conditionInputModal}
	bind:showingModal={conditionInputModalOpen}
	modalText="Edit the option condition"
	modalPlaceholder={optionCondition}
	modalInitialText={optionCondition}
	on:close={async () => {
		if (conditionInputModal.value?.length) await setCondition(conditionInputModal.value)
	}}
/>

<div class="mb-[100vh]" />
