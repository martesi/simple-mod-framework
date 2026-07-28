import { useEffect, useMemo, useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAppStore } from "@/store/app-store"
import { OptionType, type ModEntry } from "@/lib/manifest-types"
import { ImageViewerDialog, type PreviewableOption } from "./ImageViewerDialog"

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

            {checkboxes.map((option) => {
              const checked = draft.includes(option.name)
              const key = `cb-${option.name}`
              return (
                <div key={option.name} className="flex items-center gap-2.5">
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

            {groups.map((group) => {
              const selected = draft.find((o) => o.startsWith(`${group.name}:`))?.split(":")[1]
              const selectedOption = group.options.find((o) => o.name === selected)
              const hasImages = group.options.some((o) => o.image)
              return (
                <div key={group.name}>
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

                  <RadioGroup value={selected} onValueChange={(value) => setSelect(group.name, String(value))} className="max-h-[216px] overflow-y-auto rounded-md border border-border bg-surface-2">
                    {group.options.map((option) => {
                      const key = `${group.name}-${option.name}`
                      return (
                        <div
                          key={option.name}
                          className="flex items-center gap-2.5 border-b border-border px-2.5 py-2 last:border-b-0"
                          style={{ background: selected === option.name ? "var(--accent-soft)" : "transparent" }}
                        >
                          {option.image && <PreviewThumb image={option.image} active={previewable[previewIndex ?? -1]?.key === key} onClick={() => openPreview(key)} />}
                          <label className="flex flex-1 cursor-pointer items-center gap-2.5 min-w-0">
                            <RadioGroupItem value={option.name} />
                            <span className="truncate text-[13px]" style={{ fontWeight: selected === option.name ? 600 : 400 }}>
                              {option.name}
                            </span>
                          </label>
                        </div>
                      )
                    })}
                  </RadioGroup>
                </div>
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
