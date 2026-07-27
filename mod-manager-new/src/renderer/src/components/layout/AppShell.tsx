import type { ReactNode } from "react"
import { NavRail } from "./NavRail"

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-app-bg font-sans text-text">
      <NavRail />
      <div className="min-w-0 flex-1 overflow-y-auto px-11 py-9">{children}</div>
    </div>
  )
}
