import { useEffect, useMemo, useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAppStore } from "@/store/app-store"
import { useVirtualList } from "@/lib/useVirtualList"
import { OptionType, type ManifestOption, type ModEntry } from "@/lib/manifest-types"
import { ImageViewerDialog, type PreviewableOption } from "./ImageViewerDialog"

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

/** A small thumbnail button that opens the full-screen viewer (ImageViewerDialog) at this option's index - no click position/event needed at all, unlike the old floating-popover version this replaced. */
function PreviewThumb({ image, active, onClick }: { image: string; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      title="Click to preview"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      data-active={active || undefined}
      className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-border"
    >
      {/* Lazy: a mod with dozens of option thumbnails would otherwise fire that many smf-mod://
          requests (each a main-process disk read) the instant the drawer opens. */}
      <img src={image} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
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
  previewIndex,
  previewable,
  onOpenPreview
}: {
  group: { name: string; options: ManifestOption[] }
  selected: string | undefined
  onSelect(optionName: string): void
  previewIndex: number | null
  previewable: PreviewableOption[]
  onOpenPreview(key: string): void
}) {
  const selectedOption = group.options.find((o) => o.name === selected)
  const hasImages = group.options.some((o) => o.image)

  // Virtualized the same way ModsScreen.tsx's mod list is - a select group with a large option
  // list (e.g. "pick one of several thousand outfits") otherwise mounts every single option's
  // label/radio/tooltip/thumbnail in one React commit the instant the drawer opens, which is
  // exactly the kind of multi-thousand-node synchronous mount that shows up as a multi-second
  // Interaction to Next Paint on the click that opened it.
  const { containerRef, windowed, topSpacer, bottomSpacer } = useVirtualList(group.options, RADIO_ROW_HEIGHT)

  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold text-text-2">{group.name}</div>

      {hasImages && (
        <div className="mb-2.5 flex h-[140px] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2">
          {selectedOption?.image ? (
            <img src={selectedOption.image} alt={selectedOption.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          ) : (
            <span className="px-2 text-center text-[12px] text-text-3">{selected ?? ""}</span>
          )}
        </div>
      )}

      <RadioGroup
        ref={containerRef}
        value={selected}
        onValueChange={(value) => onSelect(String(value))}
        className="block max-h-[216px] overflow-y-auto rounded-md border border-border bg-surface-2"
      >
        {topSpacer > 0 && <div style={{ height: topSpacer }} />}
        {windowed.map((option) => {
          const key = `${group.name}-${option.name}`
          return (
            <div
              key={option.name}
              style={{ height: RADIO_ROW_HEIGHT, boxSizing: "border-box", background: selected === option.name ? "var(--accent-soft)" : "transparent" }}
              className="flex items-center gap-2.5 border-b border-border px-2.5 last:border-b-0"
            >
              {option.image && <PreviewThumb image={option.image} active={previewable[previewIndex ?? -1]?.key === key} onClick={() => onOpenPreview(key)} />}
              <label className="flex flex-1 cursor-pointer items-center gap-2.5 min-w-0">
                <RadioGroupItem value={option.name} />
                <span className="truncate text-[13px]" style={{ fontWeight: selected === option.name ? 600 : 400 }}>
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
  const config = useAppStore((s) => s.config)
  const commitModOptions = useAppStore((s) => s.commitModOptions)

  // A local draft of this mod's enabled-option list, decoupled from the global `config` until the
  // drawer closes - see commitModOptions()'s doc comment in app-store.ts for why: writing straight
  // to `config` on every checkbox/radio click forced a full mods-list re-render (ModsScreen.tsx
  // subscribes to `config`) on every single click, which is what made "switching an option" feel
  // slow with many mods installed. Toggling this local state instead only re-renders this drawer.
  const [draft, setDraft] = useState<string[]>([])
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  // Re-sync the draft from whatever's actually committed whenever a (possibly different) mod's
  // drawer opens - `mod` goes null -> value each time ModsScreen.tsx opens it, even for the same
  // mod id twice in a row, so this always reflects the latest on-disk state at open time.
  useEffect(() => {
    setDraft(mod ? (config?.modOptions[mod.id] ?? []) : [])
    setPreviewIndex(null)
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

  // Every previewable thumbnail in this drawer, in display order, so the full-screen viewer can
  // step through all of them with prev/next regardless of which section (checkboxes vs. a
  // particular select group) the user clicked into.
  const previewable = useMemo<PreviewableOption[]>(() => {
    const list: PreviewableOption[] = []
    for (const o of checkboxes) if (o.image) list.push({ key: `cb-${o.name}`, name: o.name, image: o.image })
    for (const g of groups) for (const o of g.options) if (o.image) list.push({ key: `${g.name}-${o.name}`, name: o.name, image: o.image })
    return list
  }, [checkboxes, groups])

  // Same virtualization as each select group below (see SelectGroupSection's doc comment) - this
  // one lives at the top level of the component instead of inside a loop because there's only ever
  // one checkbox list per drawer, so calling the hook straight here doesn't violate the Rules of
  // Hooks the way calling it from groups.map() would.
  const checkboxList = useVirtualList(checkboxes, CHECKBOX_ROW_HEIGHT)

  function openPreview(key: string) {
    const index = previewable.findIndex((p) => p.key === key)
    if (index !== -1) setPreviewIndex(index)
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
    setPreviewIndex(null)
  }

  return (
    <>
      <Sheet open={!!mod} onOpenChange={(open) => !open && close()}>
        <SheetContent>
          <SheetHeader>
            <div>
              <div className="mb-0.5 text-[12px] font-semibold text-text-2">Mod settings</div>
              <SheetTitle>{mod?.isFrameworkMod ? mod.manifest?.name : mod?.rpkgModName}</SheetTitle>
            </div>
          </SheetHeader>

          <div className="flex flex-1 flex-col gap-[18px] overflow-y-auto px-[22px] py-5">
            {checkboxes.length === 0 && groups.length === 0 && <div className="text-[13px] text-text-3">This mod has no configurable options.</div>}

            {checkboxes.length > 0 && (
              // Bounded + scrollable (mirrors the select groups' own box below) rather than free-
              // flowing rows, because virtualizing needs a real viewport to measure scrollTop
              // against - see useVirtualList.ts. A handful of checkboxes just renders as a short box
              // that never actually scrolls; a few thousand renders as a real scrollable list
              // instead of a few-thousand-node mount.
              <div ref={checkboxList.containerRef} className="max-h-[320px] overflow-y-auto rounded-md border border-border bg-surface-2">
                {checkboxList.topSpacer > 0 && <div style={{ height: checkboxList.topSpacer }} />}
                {checkboxList.windowed.map((option) => {
                  const checked = draft.includes(option.name)
                  const key = `cb-${option.name}`
                  return (
                    <div
                      key={option.name}
                      style={{ height: CHECKBOX_ROW_HEIGHT, boxSizing: "border-box" }}
                      className="flex items-center gap-2.5 border-b border-border px-2.5 last:border-b-0"
                    >
                      {option.image && <PreviewThumb image={option.image} active={previewable[previewIndex ?? -1]?.key === key} onClick={() => openPreview(key)} />}
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
                {checkboxList.bottomSpacer > 0 && <div style={{ height: checkboxList.bottomSpacer }} />}
              </div>
            )}

            {groups.map((group) => {
              const selected = draft.find((o) => o.startsWith(`${group.name}:`))?.split(":")[1]
              return (
                <SelectGroupSection
                  key={group.name}
                  group={group}
                  selected={selected}
                  onSelect={(optionName) => setSelect(group.name, optionName)}
                  previewIndex={previewIndex}
                  previewable={previewable}
                  onOpenPreview={openPreview}
                />
              )
            })}
          </div>

          <SheetFooter>
            <Button className="w-full" onClick={close}>
              Done
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ImageViewerDialog items={previewable} index={previewIndex} onIndexChange={setPreviewIndex} onClose={() => setPreviewIndex(null)} />
    </>
  )
}
