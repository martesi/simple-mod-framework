import type { ReactNode } from "react"
import { NavRail } from "./NavRail"
import { DeployToast } from "@/components/mods/DeployToast"

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-app-bg font-sans text-text">
      <NavRail />
      <div className="min-w-0 flex-1 overflow-y-auto px-11 py-9">{children}</div>
      {/* Sibling of the scrollable content pane (not nested inside it) so it
          stays pinned to the window corner instead of scrolling/clipping with
          the mods list, and stays visible across screens - matches
          new-ui/Mod Manager.dc.html, where the toast sits in the app root
          outside either screen's sc-if. */}
      <DeployToast />
    </div>
  )
}
