import * as React from "react"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { cn } from "@/lib/utils"

export const RadioGroup = React.forwardRef<React.ElementRef<typeof RadioGroupPrimitive>, React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive>>(
  ({ className, ...props }, ref) => <RadioGroupPrimitive ref={ref} className={cn("grid gap-1", className)} {...props} />
)
RadioGroup.displayName = "RadioGroup"

export const RadioGroupItem = React.forwardRef<React.ElementRef<typeof RadioPrimitive.Root>, React.ComponentPropsWithoutRef<typeof RadioPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <RadioPrimitive.Root
      ref={ref}
      className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-text-3 data-[checked]:border-accent", className)}
      {...props}
    >
      <RadioPrimitive.Indicator className="h-2 w-2 rounded-full bg-accent" />
    </RadioPrimitive.Root>
  )
)
RadioGroupItem.displayName = "RadioGroupItem"
