import { useMemo } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useAppStore } from "@/store/app-store"
import { OptionType, type ModEntry } from "@/lib/manifest-types"

export function ModSettingsDrawer({ mod, onClose }: { mod: ModEntry | null; onClose(): void }) {
  const config = useAppStore((s) => s.config)
  const setCheckboxOption = useAppStore((s) => s.setCheckboxOption)
  const setSelectOption = useAppStore((s) => s.setSelectOption)

  const { checkboxes, groups } = useMemo(() => {
    const options = mod?.manifest?.options ?? []
    const checkboxes = options.filter((o) => o.type === OptionType.checkbox)
    const selects = options.filter((o) => o.type === OptionType.select)
    const groupNames = [...new Set(selects.map((o) => (o.type === OptionType.select ? o.group : "")))]
    const groups = groupNames.map((name) => ({ name, options: selects.filter((o) => o.type === OptionType.select && o.group === name) }))
    return { checkboxes, groups }
  }, [mod])

  const enabledList = (mod && config?.modOptions[mod.id]) || []

  return (
    <Sheet open={!!mod} onOpenChange={(open) => !open && onClose()}>
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
            return (
              <label key={option.name} className="flex cursor-pointer items-center gap-2.5">
                <Checkbox checked={checked} onCheckedChange={(v) => mod && setCheckboxOption(mod.id, option.name, v === true)} />
                <span className="text-[13.5px] text-text">{option.name}</span>
                {option.tooltip && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-text-3">ⓘ</span>
                    </TooltipTrigger>
                    <TooltipContent>{option.tooltip}</TooltipContent>
                  </Tooltip>
                )}
              </label>
            )
          })}

          {groups.map((group) => {
            const selected = enabledList.find((o) => o.startsWith(`${group.name}:`))?.split(":")[1]
            return (
              <div key={group.name}>
                <div className="mb-2 text-[12px] font-semibold text-text-2">{group.name}</div>
                <RadioGroup
                  value={selected}
                  onValueChange={(value) => mod && setSelectOption(mod.id, group.name, value)}
                  className="max-h-[216px] overflow-y-auto rounded-md border border-border bg-surface-2"
                >
                  {group.options.map((option) => (
                    <label
                      key={option.name}
                      className="flex cursor-pointer items-center gap-2.5 border-b border-border px-2.5 py-2 last:border-b-0"
                      style={{ background: selected === option.name ? "var(--accent-soft)" : "transparent" }}
                    >
                      <RadioGroupItem value={option.name} />
                      <span className="truncate text-[13px]" style={{ fontWeight: selected === option.name ? 600 : 400 }}>
                        {option.name}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </div>
            )
          })}
        </div>

        <SheetFooter>
          <Button className="w-full" onClick={onClose}>
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
