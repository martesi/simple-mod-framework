import type { ReactNode } from "react"
import { X } from "lucide-react"

import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/store/app-store"
import { cn } from "@/lib/utils"
import { LANGUAGES } from "@/lib/languages"
import { WIZARD_STEPS } from "@/lib/wizard-steps"
import { PathInputRow } from "./PathInputRow"

function WizardPathStep({
  title,
  description,
  value,
  placeholder,
  onChange,
  onBrowse
}: {
  title: string
  description: string
  value: string
  placeholder: string
  onChange(value: string): void
  onBrowse?: () => void
}) {
  return (
    <>
      <div className="mb-1 text-[14px] font-bold text-text">{title}</div>
      <div className="mb-3.5 text-[13px] leading-relaxed text-text-2">{description}</div>
      <PathInputRow value={value} placeholder={placeholder} onChange={onChange} onBrowse={onBrowse} size="lg" />
    </>
  )
}

/**
 * First-run onboarding, reachable any time from Settings via "Run setup
 * wizard" - mirrors the wizard in new-ui/Mod Manager.dc.html step for step.
 */
export function SetupWizard() {
  const config = useAppStore((s) => s.config)
  const wizard = useAppStore((s) => s.wizard)
  const closeWizard = useAppStore((s) => s.closeWizard)
  const wizardBack = useAppStore((s) => s.wizardBack)
  const wizardNext = useAppStore((s) => s.wizardNext)
  const setGamePath = useAppStore((s) => s.setGamePath)
  const setCachePath = useAppStore((s) => s.setCachePath)
  const setModPath = useAppStore((s) => s.setModPath)
  const setLanguage = useAppStore((s) => s.setLanguage)
  const browseGamePath = useAppStore((s) => s.browseGamePath)
  const browseCachePath = useAppStore((s) => s.browseCachePath)
  const browseModPath = useAppStore((s) => s.browseModPath)

  if (!config) return null

  const step = WIZARD_STEPS[wizard.step] ?? "welcome"
  const isLast = wizard.step === WIZARD_STEPS.length - 1
  const isSecondLast = wizard.step === WIZARD_STEPS.length - 2
  const nextLabel = isLast ? "Finish" : isSecondLast ? "Save & finish" : "Next"

  let body: ReactNode = null
  switch (step) {
    case "welcome":
      body = (
        <>
          <div className="mb-2 text-[18px] font-bold text-text">Welcome to Simple Mod Framework</div>
          <div className="text-[13.5px] leading-relaxed text-text-2">
            This wizard walks you through pointing the mod manager at your game install and choosing where mods and cache files live. You can change any of this later in Settings.
          </div>
        </>
      )
      break
    case "game":
      body = (
        <WizardPathStep
          title="Game path"
          description="Point to the folder that contains the game's Retail executable."
          value={config.gamePath}
          placeholder="C:\Program Files\HITMAN3\Retail"
          onChange={setGamePath}
          onBrowse={browseGamePath}
        />
      )
      break
    case "cache":
      body = (
        <WizardPathStep
          title="Cache path"
          description="Where extracted RPKG data and intermediate build files are stored."
          value={config.cachePath}
          placeholder="C:\Users\you\AppData\Local\Simple Mod Framework\cache"
          onChange={setCachePath}
          onBrowse={browseCachePath}
        />
      )
      break
    case "mod":
      body = (
        <WizardPathStep
          title="Mod path"
          description="The folder the manager scans for mods to load."
          value={config.modPath}
          placeholder="C:\Users\you\Documents\SMF Mods"
          onChange={setModPath}
          onBrowse={browseModPath}
        />
      )
      break
    case "language":
      body = (
        <>
          <div className="mb-1 text-[14px] font-bold text-text">Language</div>
          <div className="mb-3.5 text-[13px] leading-relaxed text-text-2">Sets the in-game text language mods will target.</div>
          <select
            value={config.language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[13px] text-text outline-none"
          >
            {LANGUAGES.map((lo) => (
              <option key={lo.code} value={lo.code}>
                {lo.label}
              </option>
            ))}
          </select>
        </>
      )
      break
    case "done":
      body = (
        <>
          <div className="mb-3.5 flex h-11 w-11 items-center justify-center rounded-full bg-success text-[20px] font-bold text-white">✓</div>
          <div className="mb-2 text-[18px] font-bold text-text">You're all set</div>
          <div className="text-[13.5px] leading-relaxed text-text-2">Your paths and language are saved. You can revisit this wizard any time from Settings.</div>
        </>
      )
      break
  }

  return (
    <Dialog open={wizard.open} onOpenChange={(open) => !open && closeWizard()}>
      <DialogContent hideClose className="flex max-h-[80vh] w-[480px] max-w-[90vw] flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-[22px] py-[18px]">
          <div className="text-[15px] font-bold text-text">Setup wizard</div>
          <button onClick={closeWizard} className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-surface-hover">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex gap-1.5 px-[22px] pt-4">
          {WIZARD_STEPS.map((key, i) => (
            <div key={key} className={cn("h-1 flex-1 rounded-full", i <= wizard.step ? "bg-accent" : "bg-border")} />
          ))}
        </div>

        <div className="min-h-[220px] flex-1 overflow-y-auto px-[22px] py-6">{body}</div>

        <div className="flex items-center justify-between border-t border-border px-[22px] py-4">
          <button onClick={wizardBack} className={cn("text-[13px] font-semibold text-text-2", wizard.step === 0 && "invisible")}>
            Back
          </button>
          <Button onClick={wizardNext}>{nextLabel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
