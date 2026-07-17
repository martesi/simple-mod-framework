<script lang="ts">
	import { scale } from "svelte/transition"
	import { onMount } from "svelte"

	import { Button, ClickableTile, InlineNotification, TextInput } from "carbon-components-svelte"
	import { page } from "$app/stores"

	import {
		alterModManifest, FrameworkVersion, getManifestFromModID, getModFolder,
		setModManifest, validateModFolder
	} from "$lib/utils"
	import TextInputModal from "$lib/TextInputModal.svelte"
	import type { Manifest } from "../../../../../src/types"

	import Edit from "carbon-icons-svelte/lib/Edit.svelte"
	import CloseOutline from "carbon-icons-svelte/lib/CloseOutline.svelte"
	import AddAlt from "carbon-icons-svelte/lib/AddAlt.svelte"
	import Code from "carbon-icons-svelte/lib/Code.svelte"
	import CheckboxChecked from "carbon-icons-svelte/lib/CheckboxChecked.svelte"
	import RadioButtonChecked from "carbon-icons-svelte/lib/RadioButtonChecked.svelte"
	import Asterisk from "carbon-icons-svelte/lib/Asterisk.svelte"

	import { valid } from "semver"

	const emptyManifest: Manifest = {
		version: "1.0.0", id: "Example.Example", name: "Loading...",
		description: "Extremely good description", authors: ["Example"],
		contentFolders: ["content"], frameworkVersion: FrameworkVersion
	} as Manifest

	let manifest: Manifest = { ...emptyManifest }
	let modValidation: [boolean, string] = [true, ""]

	let modNameInputModal: TextInputModal
	let modNameInputModalOpen = false
	let modDescriptionInputModal: TextInputModal
	let modDescriptionInputModalOpen = false
	let modAuthorInputModal: TextInputModal
	let modAuthorInputModalOpen = false

	let versionInput: HTMLInputElement
	let frameworkVersionInput: HTMLInputElement
	let updateURLInput: HTMLInputElement
	let versionInputChanged = false
	let frameworkVersionInputChanged = false
	let updateURLInputChanged = false

	async function loadMod(modId: string) {
		try {
			manifest = await getManifestFromModID(modId)
			const folder = await getModFolder(modId)
			modValidation = await validateModFolder(folder)
		} catch {
			manifest = { ...emptyManifest, name: "Error loading mod" }
		}
	}

	$: if ($page.params.mod) loadMod($page.params.mod)

	onMount(() => {
		if ($page.params.mod) loadMod($page.params.mod)
	})
</script>

<div class="flex gap-4 items-center justify-center">
	<h1 class="text-center" transition:scale>{manifest.name}</h1>
	<Button kind="ghost" icon={Edit} iconDescription="Edit mod name" on:click={() => (modNameInputModalOpen = true)} />
</div>

<br />

<div class="flex gap-4 items-center justify-center">
	<h4 class="text-center whitespace-pre-line" transition:scale>{manifest.description}</h4>
	<Button kind="ghost" size="field" icon={Edit} iconDescription="Edit mod description" on:click={() => (modDescriptionInputModalOpen = true)} />
</div>

<br />

<div class="flex gap-4 items-center justify-center">
	By:
	{#each (manifest.authors ?? []) as author (author)}
		<div class="inline-flex gap-3 items-center pl-3 bg-neutral-700">
			{author}
			<Button
				kind="ghost" size="small" icon={CloseOutline} iconDescription="Remove author"
				on:click={async () => {
					await alterModManifest(manifest.id, { authors: manifest.authors.filter(a => a !== author) })
					await loadMod(manifest.id)
				}}
			/>
		</div>
	{/each}
	{#if !(manifest.authors ?? []).length}Nobody?{/if}
	<Button kind="ghost" size="small" icon={AddAlt} iconDescription="Add an author" on:click={() => (modAuthorInputModalOpen = true)} />
</div>

<br />

<div class="grid grid-cols-3 gap-4">
	<div>
		<TextInput
			labelText="Mod version"
			placeholder={manifest.version}
			invalid={versionInputChanged && !valid(versionInput?.value)}
			invalidText="Invalid version"
			bind:ref={versionInput}
			on:input={() => { versionInputChanged = !!versionInput.value.length }}
		/>
		{#if versionInputChanged && valid(versionInput?.value)}
			<br />
			<Button icon={Edit} on:click={async () => {
				await alterModManifest(manifest.id, { version: versionInput.value })
				versionInputChanged = false; versionInput.value = ""
				await loadMod(manifest.id)
			}}>Save</Button>
		{/if}
	</div>
	<div>
		<TextInput
			labelText="Targeted framework version"
			placeholder={manifest.frameworkVersion + " - you're currently looking at version " + FrameworkVersion}
			invalid={frameworkVersionInputChanged && !valid(frameworkVersionInput?.value)}
			invalidText="Invalid version"
			bind:ref={frameworkVersionInput}
			on:input={() => { frameworkVersionInputChanged = !!frameworkVersionInput.value.length }}
		/>
		{#if frameworkVersionInputChanged && valid(frameworkVersionInput?.value)}
			<br />
			<Button icon={Edit} on:click={async () => {
				await alterModManifest(manifest.id, { frameworkVersion: frameworkVersionInput.value })
				frameworkVersionInputChanged = false; frameworkVersionInput.value = ""
				await loadMod(manifest.id)
			}}>Save</Button>
		{/if}
	</div>
	<div>
		<TextInput
			labelText="Update check URL"
			placeholder={manifest.updateCheck || "Not defined"}
			bind:ref={updateURLInput}
			on:input={() => { updateURLInputChanged = !!updateURLInput.value.length }}
		/>
		<br />
		{#if manifest.updateCheck}
			<Button kind="ghost" icon={CloseOutline} on:click={async () => {
				const x = await getManifestFromModID(manifest.id)
				delete x["updateCheck"]
				await setModManifest(manifest.id, x)
				updateURLInputChanged = false; updateURLInput.value = ""
				await loadMod(manifest.id)
			}}>
				Disable updates <span class="mr-2" />
			</Button>
		{/if}
		{#if updateURLInputChanged}
			<Button icon={Edit} on:click={async () => {
				await alterModManifest(manifest.id, { updateCheck: updateURLInput.value })
				updateURLInputChanged = false; updateURLInput.value = ""
				await loadMod(manifest.id)
			}}>Save</Button>
		{/if}
	</div>
</div>

<br />

<div class="flex flex-row justify-center items-center mt-8">
	<div class="flex flex-row gap-8 items-center mt-8 pb-4 max-w-[80vw] overflow-x-auto">
		<div transition:scale>
			<ClickableTile href="/authoring/{$page.params.mod}/manifest" style="width: 10vw; height: 8vw">
				<div class="w-full h-full flex justify-center items-center text-xl font-light">
					<div>
						<div class="flex justify-center mb-2"><Code size={64} /></div>
						<div class="flex justify-center">Manifest</div>
					</div>
				</div>
			</ClickableTile>
		</div>
		{#each manifest.options || [] as option (option.group + option.name)}
			<div transition:scale>
				<ClickableTile href="/authoring/{$page.params.mod}/options/{(option.group || '-') + '$|$' + option.name}" style="width: 10vw; height: 8vw">
					<div class="w-full h-full flex justify-center items-center text-xl font-light">
						<div>
							<div class="flex justify-center mb-2">
								{#if option.type === "checkbox"}<CheckboxChecked size={64} />
								{:else if option.type === "select"}<RadioButtonChecked size={64} />
								{:else if option.type === "conditional"}<Asterisk size={64} />
								{/if}
							</div>
							<div class="flex justify-center">
								<div class="text-center">
									{#if option.type === "group"}{option.group} →{/if}
									{option.name}
								</div>
							</div>
						</div>
					</div>
				</ClickableTile>
			</div>
		{/each}
	</div>
</div>

<br />

<div class="flex items-center justify-center w-full mt-8">
	<div>
		<div class="{window.screen.height <= 1080 ? 'max-h-[42vh]' : 'max-h-[45vh]'} pr-4 overflow-y-auto">
			{#if !modValidation[0]}
				<InlineNotification hideCloseButton lowContrast kind="error">
					<div slot="title" class="text-lg">Invalid mod</div>
					<div slot="subtitle">{modValidation[1]}</div>
				</InlineNotification>
			{/if}
		</div>
	</div>
</div>

<div class="mb-[100vh]" />

<TextInputModal
	bind:this={modNameInputModal}
	bind:showingModal={modNameInputModalOpen}
	modalText="Edit the mod name"
	modalPlaceholder={manifest.name}
	modalInitialText={manifest.name}
	on:close={async () => {
		if (modNameInputModal.value?.length) {
			await alterModManifest(manifest.id, { name: modNameInputModal.value })
			await loadMod(manifest.id)
		}
	}}
/>

<TextInputModal
	bind:this={modDescriptionInputModal}
	bind:showingModal={modDescriptionInputModalOpen}
	modalText="Edit the mod description"
	modalPlaceholder={manifest.description}
	modalInitialText={manifest.description}
	multiline
	on:close={async () => {
		if (modDescriptionInputModal.value?.length) {
			await alterModManifest(manifest.id, { description: modDescriptionInputModal.value })
			await loadMod(manifest.id)
		}
	}}
/>

<TextInputModal
	bind:this={modAuthorInputModal}
	bind:showingModal={modAuthorInputModalOpen}
	modalText="Add a mod author"
	modalPlaceholder="EpicModMaker123"
	on:close={async () => {
		if (modAuthorInputModal.value?.length) {
			await alterModManifest(manifest.id, { authors: [...(manifest.authors ?? []), modAuthorInputModal.value] })
			await loadMod(manifest.id)
		}
	}}
/>

<style>
	:global(.bx--btn--ghost) { color: inherit; @apply bg-neutral-900; }
	:global(.bx--btn--ghost:hover, .bx--btn--ghost:active) { color: inherit; }
	:global(.bx--inline-notification) { width: 70vh; }
	:global(.bx--inline-notification__text-wrapper) { display: block; }
	:global(.bx--inline-notification__icon) { margin-top: 1.2rem; }
	:global(.bx--inline-notification__subtitle) { line-height: 1.5; }
</style>
