import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva("inline-flex items-center rounded-[5px] border px-[7px] py-[2px] text-[10.5px] font-semibold whitespace-nowrap", {
  variants: {
    variant: {
      default: "border-border bg-surface-2 text-text-2",
      warning: "border-transparent bg-(--warning-soft) text-warning",
      accent: "border-transparent bg-accent-soft text-accent"
    }
  },
  defaultVariants: { variant: "default" }
})

export function Badge({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant, className }))} {...props} />
}
