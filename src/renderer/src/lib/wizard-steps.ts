/** Step order for the setup wizard, matching new-ui/Mod Manager.dc.html's WIZARD_STEPS. */
export const WIZARD_STEPS = ["welcome", "game", "cache", "mod", "language", "done"] as const

export type WizardStepKey = (typeof WIZARD_STEPS)[number]
