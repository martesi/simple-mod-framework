import { NavLink } from "react-router-dom"
import { LayoutList, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"

const items = [
  { to: "/", label: "Mods", icon: LayoutList },
  { to: "/settings", label: "Settings", icon: Settings2 }
]

export function NavRail() {
  return (
    <div className="flex w-[68px] shrink-0 flex-col items-center gap-2 border-r border-border bg-surface py-4">
      <div className="mb-5 flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-accent-foreground">SMF</div>

      {items.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} end title={label} className="relative flex h-10 w-11 items-center justify-center">
          {({ isActive }) => (
            <>
              {isActive && <div className="absolute -left-2 top-1.5 h-7 w-[3px] rounded-sm bg-accent" />}
              <div className={cn("flex h-10 w-11 items-center justify-center rounded-lg", isActive && "bg-surface-hover")}>
                <Icon className="h-[18px] w-[18px] text-text" strokeWidth={1.75} />
              </div>
            </>
          )}
        </NavLink>
      ))}

      <div className="flex-grow" />
    </div>
  )
}
