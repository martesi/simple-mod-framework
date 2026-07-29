import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "@/lib/utils"

export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export const TooltipContent = React.forwardRef<React.ElementRef<typeof TooltipPrimitive.Popup>, React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Popup> & { sideOffset?: number }>(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          ref={ref}
          className={cn("z-[110] max-w-[220px] rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text shadow-md animate-fade-in", className)}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
)
TooltipContent.displayName = "TooltipContent"
