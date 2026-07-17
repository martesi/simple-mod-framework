<script lang="ts">
	import { onMount } from "svelte"
	import { page } from "$app/stores"
	import { goto } from "$app/navigation"

	import { marked } from "marked"
	import * as shiki from "shiki"

	import { Button, InlineLoading } from "carbon-components-svelte"

	import ArrowLeft from "carbon-icons-svelte/lib/ArrowLeft.svelte"
	import Home from "carbon-icons-svelte/lib/Home.svelte"

	import { fs as nativeFs, path as nativePath } from "$lib/native"

	shiki.setCDN("/shiki/")

	marked.setOptions({
		renderer: new marked.Renderer(),
		highlight: function (code, language, callback) {
			;(async () => {
				try {
					callback!(
						null,
						(await shiki.getHighlighter({ theme: "one-dark-pro" })).codeToHtml(code, { lang: language })
					)
				} catch {
					callback!(null, code)
				}
			})()
		},
		pedantic: false,
		gfm: true,
		breaks: false,
		sanitize: false,
		smartLists: true,
		smartypants: false,
		xhtml: false
	})

	let pageContent = ""
	let loading = true

	async function loadPage(pageName: string) {
		loading = true
		try {
			const docsFolder = (await nativeFs.existsSync(nativePath.join("..", "docs"))) ? "docs" : "Info"
			const raw = await nativeFs.readFileSync(nativePath.join("..", docsFolder, pageName), "utf-8")
			pageContent = await new Promise<string>((resolve, reject) => {
				marked.parse(raw, undefined, (err, result) => {
					if (err) reject(err)
					else resolve(result as string)
				})
			})
		} catch (e) {
			pageContent = `<p class="text-red-400">Couldn't load page: ${e}</p>`
		}
		loading = false
	}

	$: if ($page.params.page) loadPage($page.params.page)

	onMount(() => {
		if ($page.params.page) loadPage($page.params.page)
	})
</script>

<div class="h-[90vh] pr-4 overflow-y-auto">
	<div class="flex gap-4 items-center">
		<h1 class="flex-grow">{$page.params.page.split(".")[0]}</h1>
		<div>
			{#if loading}
				<InlineLoading />
			{:else}
				<Button on:click={() => window.history.back()} icon={ArrowLeft}>Back</Button>
				<Button on:click={() => goto("/docs/Index.md")} icon={Home}>Go to Index</Button>
			{/if}
		</div>
	</div>
	{@html pageContent}
</div>

<style global>
	.shiki {
		@apply rounded-md p-4 pt-6;
	}

	.line {
		@apply block -mt-2;
	}

	:not(pre) > code {
		@apply bg-neutral-900 text-orange-200 rounded-md text-sm;
		padding: 0.2rem 0.4rem !important;
	}

	code {
		font-family: "Fira Code", "IBM Plex Mono", "Menlo", "DejaVu Sans Mono", "Bitstream Vera Sans Mono", Courier, monospace !important;
	}

	p {
		padding: 0.2rem 0rem !important;
	}

	h1, h2, h3, h4, h5, h6 {
		@apply mt-4;
	}
</style>
