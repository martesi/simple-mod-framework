import type * as React from "react"
import { useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAppStore } from "@/store/app-store"
import { OptionType, type ModEntry } from "@/lib/manifest-types"

interface ActivePreview {
  key: string
  name: string
  image: string
  top: number
  left: number
}

/** A small thumbnail button that, on click, opens a floating preview popover positioned near the click - mirrors togglePreview() in new-ui/Mod Manager.dc.html. */
function PreviewThumb({ image, active, onToggle }: { image: string; active: boolean; onToggle(e: React.MouseEvent): void }) {
  return (
    <button
      type="button"
      title="Click to preview"
      onClick={(e) => {
        e.stopPropagation()
        onToggle(e)
      }}
      data-active={active || undefined}
      className="h-8 w-8 shrink-0 overflow-hidden rounded-md border border-border"
    >
      <img src={image} alt="" className="h-full w-full object-cover" />
    </button>
  )
}

export function ModSettingsDrawer({ mod, onClose }: { mod: ModEntry | null; onClose(): void }) {
  const config = useAppStore((s) => s.config)
  const setCheckboxOption = useAppStore((s) => s.setCheckboxOption)
  const setSelectOption = useAppStore((s) => s.setSelectOption)
  const [preview, setPreview] = useState<ActivePreview | null>(null)

  const { checkboxes, groups } = useMemo(() => {
    const options = mod?.manifest?.options ?? []
    const checkboxes = options.filter((o) => o.type === OptionType.checkbox)
    const selects = options.filter((o) => o.type === OptionType.select)
    const groupNames = [...new Set(selects.map((o) => (o.type === OptionType.select ? o.group : "")))]
    const groups = groupNames.map((name) => ({ name, options: selects.filter((o) => o.type === OptionType.select && o.group === name) }))
    return { checkboxes, groups }
  }, [mod])

  const enabledList = (mod && config?.modOptions[mod.id]) || []

  function togglePreview(key: string, name: string, image: string, e: React.MouseEvent) {
    setPreview((current) => {
      if (current?.key === key) return null
      const rect = e.currentTarget.getBoundingClientRect()
      const left = Math.min(rect.left, window.innerWidth - 216)
      return { key, name, image, top: rect.bottom + 6, left }
    })
  }

  function close() {
    onClose()
    setPreview(null)
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
              const checked = enabledList.includes(option.name)
              const key = `cb-${option.name}`
              return (
                <div key={option.name} className="flex items-center gap-2.5">
                  {option.image && <PreviewThumb image={option.image} active={preview?.key === key} onToggle={(e) => togglePreview(key, option.name, option.image!, e)} />}
                  <label className="flex flex-1 cursor-pointer items-center gap-2.5">
                    <Checkbox checked={checked} onCheckedChange={(v) => mod && setCheckboxOption(mod.id, option.name, v === true)} />
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
              const selected = enabledList.find((o) => o.startsWith(`${group.name}:`))?.split(":")[1]
              const selectedOption = group.options.find((o) => o.name === selected)
              const hasImages = group.options.some((o) => o.image)
              return (
                <div key={group.name}>
                  <div className="mb-2 text-[12px] font-semibold text-text-2">{group.name}</div>

                  {hasImages && (
                    <div className="mb-2.5 flex h-[140px] w-full items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2">
                      {selectedOption?.image ? (
                        <img src={selectedOption.image} alt={selectedOption.name} className="h-full w-full object-cover" />
                      ) : (
                        <span className="px-2 text-center text-[12px] text-text-3">{selected ?? ""}</span>
                      )}
                    </div>
                  )}

                  <RadioGroup
                    value={selected}
                    onValueChange={(value) => mod && setSelectOption(mod.id, group.name, String(value))}
                    className="max-h-[216px] overflow-y-auto rounded-md border border-border bg-surface-2"
                  >
                    {group.options.map((option) => {
                      const key = `${group.name}-${option.name}`
                      return (
                        <div
                          key={option.name}
                          className="flex items-center gap-2.5 border-b border-border px-2.5 py-2 last:border-b-0"
                          style={{ background: selected === option.name ? "var(--accent-soft)" : "transparent" }}
                        >
                          {option.image && <PreviewThumb image={option.image} active={preview?.key === key} onToggle={(e) => togglePreview(key, option.name, option.image!, e)} />}
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

      {preview &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[95]" onClick={() => setPreview(null)} />
            <div
              className="fixed z-[96] w-[200px] animate-fade-in rounded-md border border-border bg-surface p-2 shadow-md"
              style={{ top: preview.top, left: preview.left }}
            >
              <img src={preview.image} alt={preview.name} className="h-[130px] w-full rounded object-cover" />
              <div className="mt-1.5 text-center text-[11.5px] text-text-2">{preview.name}</div>
            </div>
          </>,
          document.body
        )}
    </>
  )
}
