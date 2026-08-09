import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react"
import { Locate, Search } from "lucide-react"
import { Trans, useLingui } from "@lingui/react/macro"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAppStore } from "@/store/app-store"
import { useVirtualList } from "@/lib/useVirtualList"
import { cn } from "@/lib/utils"
import { OptionType, type ManifestOption, type ModEntry } from "@/lib/manifest-types"
import { openImageViewer, closeImageViewer, type PreviewableOption, type LocateTarget } from "./imageViewer"
import { HoverImagePreview } from "./HoverImagePreview"
import { clampHoverPosition } from "./hover-image-preview-utils"

/** How long the cursor must stay on a thumbnail before the larger hover preview appears - short enough to feel responsive, long enough that scanning across many thumbnails doesn't flash a popup on every one. */
const HOVER_PREVIEW_DELAY_MS = 250

/** A pending "scroll to and flash this row" request, dispatched by ModSettingsDrawer's `locate()` and consumed once by the target list's own effect. `nonce` guarantees re-locating the same row twice still re-triggers that effect even though the rest of the object would otherwise look identical. */
interface LocateRequest {
  rowIndex: number
  key: string
  nonce: number
}

/** How long a located row stays visually flashed before reverting to its normal (or selected-highlight) background - must match the `row-flash` keyframe's duration in globals.css. */
const FLASH_DURATION_MS = 1100

/**
 * Fixed row heights for the checkbox list and each select group's option list - see
 * useVirtualList.ts's doc comment for why these need to be a single fixed number rather than each
 * row's own natural height (same constraint MOD_ROW_HEIGHT has in ModRow.tsx). Both rows already
 * reserve space for a 32px (h-8) thumbnail whether or not `option.image` is actually set, so every
 * row in a given list is genuinely this height regardless of content - nothing here has to shrink
 * for image-less options.
 */
const CHECKBOX_ROW_HEIGHT = 40
const RADIO_ROW_HEIGHT = 48

/**
 * A small thumbnail button that opens the full-screen viewer (ImageViewerDialog) at this option's
 * index - no click position/event needed at all, unlike the old floating-popover version this
 * replaced. Hovering it for HOVER_PREVIEW_DELAY_MS shows a larger, uncropped HoverImagePreview
 * near the cursor without needing the full-screen viewer at all; clicking still opens that viewer
 * as before, independent of hover.
 */
function PreviewThumb({ image, active, onClick }: { image: string; active: boolean; onClick(): void }) {
  const { t } = useLingui()
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  function handleMouseEnter(e: MouseEvent) {
    const { clientX, clientY } = e
    hoverTimer.current = setTimeout(() => setHoverPos(clampHoverPosition(clientX, clientY)), HOVER_PREVIEW_DELAY_MS)
  }

  function handleMouseLeave() {
    clearTimeout(hoverTimer.current)
    setHoverPos(null)
  }

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  return (
    <button
      type="button"
      title={t`Click to preview`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={(e) => {
        e.stopPropagation()
        clearTimeout(hoverTimer.current)
        setHoverPos(null) // don't leave the hover popup mounted behind the full-screen viewer
        onClick()
      }}
      data-active={active || undefined}
      className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-border"
    >
      {/* Lazy: a mod with dozens of option thumbnails would otherwise fire that many smf-mod://
          requests (each a main-process disk read) the instant the drawer opens. */}
      <img src={image} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      {hoverPos && <HoverImagePreview image={image} x={hoverPos.x} y={hoverPos.y} />}
    </button>
  )
}

function sameOptions(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const as = [...a].sort()
  const bs = [...b].sort()
  return as.every((v, i) => v === bs[i])
}

/**
 * One select group's header, preview box, and its own virtualized option list - pulled out of
 * ModSettingsDrawer's render body because `useVirtualList` is a hook, and `groups` is rendered via
 * `.map()`: calling a hook from inside a loop breaks React's "same hooks in the same order every
 * render" rule the instant a different mod has a different number of groups. A real component per
 * group sidesteps that entirely - each mounted instance gets its own single top-level hook call,
 * which is exactly what the Rules of Hooks require, regardless of how many group instances exist.
 */
function SelectGroupSection({
  group,
  selected,
  onSelect,
  onLocateOption,
  locate,
  onLocateHandled
}: {
  group: { name: string; options: ManifestOption[] }
  selected: string | undefined
  onSelect(optionName: string): void
  /** Routes to ModSettingsDrawer's `locate()` - used both by this group's own row thumbnails (via the viewer's "Locate in list" button) and by the inline Locate button next to the filter input. */
  onLocateOption(target: LocateTarget): void
  /** Set by ModSettingsDrawer's `locate()` when the user clicks "Locate" on an option that lives in this group; this component owns clearing its own filter and flashing its own row in response. */
  locate: LocateRequest | null
  /** Called once `locate` has actually been acted on, so the parent can clear it back to null - otherwise it stays "armed" forever and the very next character typed into this group's own search box (which momentarily makes `search` truthy) would immediately be wiped by the effect below, mistaking it for a fresh locate needing its filter cleared. */
  onLocateHandled(): void
}) {
  const { t } = useLingui()
  const selectedOption = group.options.find((o) => o.name === selected)
  const hasImages = group.options.some((o) => o.image)

  // Which row (if any) the full-screen viewer currently has open, for this group's own thumbnails'
  // "active" glow - scoped locally since each group opens its own gallery independently now (see
  // openImageViewer's doc comment for why there's no more single drawer-wide preview index).
  const [activeKey, setActiveKey] = useState<string | null>(null)

  function locateTarget(option: ManifestOption): LocateTarget {
    return {
      key: `${group.name}-${option.name}`,
      section: { type: "group", name: group.name },
      rowIndex: group.options.findIndex((o) => o.name === option.name)
    }
  }

  /** Only meaningful for an option that actually has `image` set - callers must guard for that themselves (see the preview box and row-thumbnail click handlers below). */
  function previewItem(option: ManifestOption): PreviewableOption {
    return { ...locateTarget(option), name: option.name, image: option.image! }
  }

  const [search, setSearch] = useState("")
  const q = search.trim().toLowerCase()
  const filteredOptions = useMemo(() => group.options.filter((o) => !q || o.name.toLowerCase().includes(q)), [group.options, q])

  const [flashKey, setFlashKey] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(flashTimer.current), [])

  // Virtualized the same way ModsScreen.tsx's mod list is - a select group with a large option
  // list (e.g. "pick one of several thousand outfits") otherwise mounts every single option's
  // label/radio/tooltip/thumbnail in one React commit the instant the drawer opens, which is
  // exactly the kind of multi-thousand-node synchronous mount that shows up as a multi-second
  // Interaction to Next Paint on the click that opened it. `filteredOptions` (not the raw
  // `group.options`) is what gets windowed, so the search box above just narrows what's mounted -
  // the hook itself doesn't need to know filtering happened.
  const { containerRef, windowed, topSpacer, bottomSpacer, scrollToIndex } = useVirtualList(filteredOptions, RADIO_ROW_HEIGHT)

  // `locate.rowIndex` is only valid against this group's *unfiltered* `group.options` (see
  // PreviewableOption's doc comment), so a pending request first clears any active search filter
  // and waits for the next render (once `filteredOptions` is back to the full list) before it's
  // safe to scroll - otherwise it could land on the wrong row, or one that's currently hidden.
	useEffect(() => {
		if (!locate) return
		if (search) {
			// eslint-disable-next-line react-hooks/set-state-in-effect
			setSearch("")
      return
    }
    scrollToIndex(locate.rowIndex, { align: "center" })
    clearTimeout(flashTimer.current)
    setFlashKey(locate.key)
    flashTimer.current = setTimeout(() => setFlashKey(null), FLASH_DURATION_MS)
    onLocateHandled()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate, search])

  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold text-text-2">{group.name}</div>

      {hasImages && (
        <div className="mb-2.5 flex h-[140px] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2">
          {selectedOption?.image ? (
            <button type="button" title={t`Click to preview`} onClick={() => openImageViewer([previewItem(selectedOption)], 0, {})} className="h-full w-full">
              <img src={selectedOption.image} alt={selectedOption.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
            </button>
          ) : (
            <span className="px-2 text-center text-[12px] text-text-3">{selected ?? ""}</span>
          )}
        </div>
      )}

      {group.options.length > 8 && (
        <div className="mb-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t`Filter options…`} className="h-8 pl-8 text-[12.5px]" />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={!selectedOption}
            onClick={() => selectedOption && onLocateOption(locateTarget(selectedOption))}
            title={t`Locate current option`}
          >
            <Locate className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <RadioGroup
        ref={containerRef}
        value={selected}
        onValueChange={(value) => onSelect(String(value))}
        className="block max-h-[216px] overflow-y-auto rounded-md border border-border bg-surface-2"
      >
        {filteredOptions.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-text-3">
            <Trans>No options match "{search.trim()}".</Trans>
          </div>
        )}
        {topSpacer > 0 && <div style={{ height: topSpacer }} />}
        {windowed.map((option) => {
          const key = `${group.name}-${option.name}`
          return (
            <div
              key={option.name}
              style={{ height: RADIO_ROW_HEIGHT, boxSizing: "border-box", background: selected === option.name ? "var(--accent-soft)" : "transparent" }}
              className={cn("flex items-center gap-2.5 border-b border-border px-2.5 last:border-b-0", flashKey === key && "row-flash")}
            >
              {option.image && (
                <PreviewThumb
                  image={option.image}
                  active={activeKey === key}
                  onClick={() => {
                    const imageOptions = filteredOptions.filter((o) => o.image)
                    openImageViewer(imageOptions.map(previewItem), imageOptions.findIndex((o) => o.name === option.name), {
                      onLocate: onLocateOption,
                      onActiveChange: setActiveKey
                    })
                  }}
                />
              )}
              <label className="flex flex-1 cursor-pointer items-center gap-2.5 min-w-0">
                <RadioGroupItem value={option.name} />
                <span className="truncate text-[13px] text-text" style={{ fontWeight: selected === option.name ? 600 : 400 }}>
                  {option.name}
                </span>
              </label>
            </div>
          )
        })}
        {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} />}
      </RadioGroup>
    </div>
  )
}

export function ModSettingsDrawer({ mod, onClose }: { mod: ModEntry | null; onClose(): void }) {
  const { t } = useLingui()
  const config = useAppStore((s) => s.config)
  const commitModOptions = useAppStore((s) => s.commitModOptions)

  // A local draft of this mod's enabled-option list, decoupled from the global `config` until the
  // drawer closes - see commitModOptions()'s doc comment in app-store.ts for why: writing straight
  // to `config` on every checkbox/radio click forced a full mods-list re-render (ModsScreen.tsx
  // subscribes to `config`) on every single click, which is what made "switching an option" feel
  // slow with many mods installed. Toggling this local state instead only re-renders this drawer.
  const [draft, setDraft] = useState<string[]>([])

  // Which checkbox row (if any) the full-screen viewer currently has open, for that row's
  // PreviewThumb's "active" glow - each select group tracks its own equivalent locally (see
  // SelectGroupSection), since each section now opens its own gallery independently.
  const [checkboxActiveKey, setCheckboxActiveKey] = useState<string | null>(null)

  // Keyed "checkboxes" / `group:${group.name}` - each section's outer wrapper div registers
  // itself here so locate() can scroll it into view via the browser's own scrollIntoView, which
  // walks and scrolls every scrollable ancestor (including the outer drawer body) without this
  // component needing to measure anything by hand.
  const sectionRefs = useRef(new Map<string, HTMLDivElement>())

  // Just needs to be different on every locate() call so LocateRequest's consuming effects re-fire
  // even for a re-locate of the same row - a ref-mutated counter avoids the impure `Date.now()` call
  // the React Compiler ESLint rule flags when a closure like locate() gets invoked through more than
  // one layer of indirection (e.g. openImageViewer's onLocate callback).
  const locateNonce = useRef(0)

  const [checkboxSearch, setCheckboxSearch] = useState("")
  const [checkboxFlashKey, setCheckboxFlashKey] = useState<string | null>(null)
  const checkboxFlashTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [checkboxLocate, setCheckboxLocate] = useState<LocateRequest | null>(null)
  const [groupLocate, setGroupLocate] = useState<Record<string, LocateRequest | null>>({})

  // Re-sync the draft from whatever's actually committed whenever a (possibly different) mod's
  // drawer opens - `mod` goes null -> value each time ModsScreen.tsx opens it, even for the same
  // mod id twice in a row, so this always reflects the latest on-disk state at open time.
	useEffect(() => {
		// This effect resets transient drawer state when the opened mod changes.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setDraft(mod ? (config?.modOptions[mod.id] ?? []) : [])
    closeImageViewer()
    setCheckboxActiveKey(null)
    setCheckboxSearch("")
    setCheckboxLocate(null)
    setGroupLocate({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod?.id])

  const { checkboxes, groups } = useMemo(() => {
    const options = mod?.manifest?.options ?? []
    const checkboxes = options.filter((o) => o.type === OptionType.checkbox)
    const selects = options.filter((o) => o.type === OptionType.select)
    const groupNames = [...new Set(selects.map((o) => (o.type === OptionType.select ? o.group : "")))]
    const groups = groupNames.map((name) => ({ name, options: selects.filter((o) => o.type === OptionType.select && o.group === name) }))
    return { checkboxes, groups }
  }, [mod])

  const cq = checkboxSearch.trim().toLowerCase()
  const filteredCheckboxes = useMemo(() => checkboxes.filter((o) => !cq || o.name.toLowerCase().includes(cq)), [checkboxes, cq])

  // Same virtualization as each select group below (see SelectGroupSection's doc comment) - this
  // one lives at the top level of the component instead of inside a loop because there's only ever
  // one checkbox list per drawer, so calling the hook straight here doesn't violate the Rules of
  // Hooks the way calling it from groups.map() would. `filteredCheckboxes` (not the raw
  // `checkboxes`) is what actually gets windowed, mirroring SelectGroupSection's own filter-before-
  // virtualize approach.
  const {
    containerRef: checkboxContainerRef,
    windowed: checkboxWindowed,
    topSpacer: checkboxTopSpacer,
    bottomSpacer: checkboxBottomSpacer,
    scrollToIndex: scrollCheckboxToIndex
  } = useVirtualList(filteredCheckboxes, CHECKBOX_ROW_HEIGHT)

  // `checkboxLocate.rowIndex` is only valid against the unfiltered `checkboxes` array, so a
  // pending request clears the checkbox search box first and waits a render for
  // `filteredCheckboxes` to go back to the full list before it's safe to scroll - same two-step
  // pattern as the per-group locate effect in SelectGroupSection, and for the same reason.
	useEffect(() => {
		if (!checkboxLocate) return
		if (checkboxSearch) {
			// eslint-disable-next-line react-hooks/set-state-in-effect
			setCheckboxSearch("")
      return
    }
    scrollCheckboxToIndex(checkboxLocate.rowIndex, { align: "center" })
    clearTimeout(checkboxFlashTimer.current)
    setCheckboxFlashKey(checkboxLocate.key)
    checkboxFlashTimer.current = setTimeout(() => setCheckboxFlashKey(null), FLASH_DURATION_MS)
    // Clear the request once actually handled - otherwise it stays "armed" forever and the next
    // character typed into the checkbox search box (which momentarily makes `checkboxSearch`
    // truthy) would immediately be wiped by this same effect, mistaking it for a fresh locate.
    setCheckboxLocate(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkboxLocate, checkboxSearch])

  useEffect(() => () => clearTimeout(checkboxFlashTimer.current), [])

  // Called from the viewer's "Locate in list" toolbar button, and from SelectGroupSection's own
  // inline Locate button next to its filter input - closes any open viewer, scrolls the option's
  // owning section into view, and dispatches a locate request to whichever list actually owns that
  // row (the checkbox list, or one specific select group) so it can clear its own filter if needed
  // and flash the row once it's back in the DOM. Only ever reads `section`/`rowIndex`/`key`, so a
  // bare LocateTarget (no image required) works just as well as a full PreviewableOption.
  function locate(item: LocateTarget) {
    closeImageViewer()
    const sectionKey = item.section.type === "checkbox" ? "checkboxes" : `group:${item.section.name}`
    sectionRefs.current.get(sectionKey)?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    const request: LocateRequest = { rowIndex: item.rowIndex, key: item.key, nonce: locateNonce.current++ }
    if (item.section.type === "checkbox") {
      setCheckboxLocate(request)
    } else {
      const groupName = item.section.name
      setGroupLocate((prev) => ({ ...prev, [groupName]: request }))
    }
  }

  function setCheckbox(optionName: string, enabled: boolean) {
    setDraft((current) => (enabled ? [...current.filter((o) => o !== optionName), optionName] : current.filter((o) => o !== optionName)))
  }

  function setSelect(group: string, optionName: string) {
    setDraft((current) => [...current.filter((o) => !o.startsWith(`${group}:`)), `${group}:${optionName}`])
  }

  function close() {
    if (mod && !sameOptions(draft, config?.modOptions[mod.id] ?? [])) {
      commitModOptions(mod.id, draft)
    }
    onClose()
    closeImageViewer()
  }

  return (
    <Sheet open={!!mod} onOpenChange={(open) => !open && close()}>
        <SheetContent>
          <SheetHeader>
            <div>
              <div className="mb-0.5 text-[12px] font-semibold text-text-2">
                <Trans>Mod settings</Trans>
              </div>
              <SheetTitle>{mod?.isFrameworkMod ? mod.manifest?.name : mod?.rpkgModName}</SheetTitle>
            </div>
          </SheetHeader>

          <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-[22px] py-5">
            {checkboxes.length === 0 && groups.length === 0 && (
              <div className="text-[13px] text-text-3">
                <Trans>This mod has no configurable options.</Trans>
              </div>
            )}

            {checkboxes.length > 0 && (
              <div
                ref={(el) => {
                  if (el) sectionRefs.current.set("checkboxes", el)
                  else sectionRefs.current.delete("checkboxes")
                }}
              >
                {checkboxes.length > 8 && (
                  <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
                    <Input value={checkboxSearch} onChange={(e) => setCheckboxSearch(e.target.value)} placeholder={t`Filter options…`} className="h-8 pl-8 text-[12.5px]" />
                  </div>
                )}
                {/* Bounded + scrollable (mirrors the select groups' own box below) rather than free-
                    flowing rows, because virtualizing needs a real viewport to measure scrollTop
                    against - see useVirtualList.ts. A handful of checkboxes just renders as a short box
                    that never actually scrolls; a few thousand renders as a real scrollable list
                    instead of a few-thousand-node mount. */}
                <div ref={checkboxContainerRef} className="max-h-[320px] overflow-y-auto rounded-md border border-border bg-surface-2">
                  {filteredCheckboxes.length === 0 && (
                    <div className="px-3 py-6 text-center text-[12px] text-text-3">
                      <Trans>No options match "{checkboxSearch.trim()}".</Trans>
                    </div>
                  )}
                  {checkboxTopSpacer > 0 && <div style={{ height: checkboxTopSpacer }} />}
                  {checkboxWindowed.map((option) => {
                    const checked = draft.includes(option.name)
                    const key = `cb-${option.name}`
                    return (
                      <div
                        key={option.name}
                        style={{ height: CHECKBOX_ROW_HEIGHT, boxSizing: "border-box" }}
                        className={cn("flex items-center gap-2.5 border-b border-border px-2.5 last:border-b-0", checkboxFlashKey === key && "row-flash")}
                      >
                        {option.image && (
                          <PreviewThumb
                            image={option.image}
                            active={checkboxActiveKey === key}
                            onClick={() => {
                              const imageOptions = filteredCheckboxes.filter((o) => o.image)
                              const items: PreviewableOption[] = imageOptions.map((o) => ({
                                key: `cb-${o.name}`,
                                name: o.name,
                                image: o.image!,
                                section: { type: "checkbox" },
                                rowIndex: checkboxes.findIndex((c) => c.name === o.name)
                              }))
                              openImageViewer(items, imageOptions.findIndex((o) => o.name === option.name), { onLocate: locate, onActiveChange: setCheckboxActiveKey })
                            }}
                          />
                        )}
                        <label className="flex flex-1 cursor-pointer items-center gap-2.5">
                          <Checkbox checked={checked} onCheckedChange={(v) => setCheckbox(option.name, v === true)} />
                          <span className="text-[13.5px] text-text">{option.name}</span>
                          {option.tooltip && (
                            <Tooltip>
                              <TooltipTrigger render={<span className="text-text-3" />}>ⓘ</TooltipTrigger>
                              <TooltipContent>{option.tooltip}</TooltipContent>
                            </Tooltip>
                          )}
                        </label>
                      </div>
                    )
                  })}
                  {checkboxBottomSpacer > 0 && <div style={{ height: checkboxBottomSpacer }} />}
                </div>
              </div>
            )}

            {groups.map((group) => {
              const selected = draft.find((o) => o.startsWith(`${group.name}:`))?.split(":")[1]
              return (
                <div
                  key={group.name}
                  ref={(el) => {
                    if (el) sectionRefs.current.set(`group:${group.name}`, el)
                    else sectionRefs.current.delete(`group:${group.name}`)
                  }}
                >
                  <SelectGroupSection
                    group={group}
                    selected={selected}
                    onSelect={(optionName) => setSelect(group.name, optionName)}
                    onLocateOption={locate}
                    locate={groupLocate[group.name] ?? null}
                    onLocateHandled={() => setGroupLocate((prev) => ({ ...prev, [group.name]: null }))}
                  />
                </div>
              )
            })}
          </div>

          <SheetFooter>
            <Button className="w-full" onClick={close}>
              <Trans>Done</Trans>
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
  )
}
