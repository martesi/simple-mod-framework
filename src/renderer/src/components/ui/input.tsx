import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'h-9 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-text outline-none placeholder:text-text-3 focus-visible:ring-2 focus-visible:ring-accent/40',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'
