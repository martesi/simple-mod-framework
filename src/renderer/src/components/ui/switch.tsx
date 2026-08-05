import * as React from "react"
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn("peer inline-flex h-[22px] w-10 shrink-0 cursor-pointer items-center rounded-full bg-border transition-colors data-[checked]:bg-accent", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-[18px] w-[18px] translate-x-0.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.3)] transition-transform data-checked:translate-x-[19px]" />
    </SwitchPrimitive.Root>
  )
)
Switch.displayName = "Switch"
