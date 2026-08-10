import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-foreground shadow-sm hover:bg-accent-hover',
        outline: 'border border-border bg-surface text-text hover:bg-surface-hover',
        ghost: 'text-text hover:bg-surface-hover',
        secondary: 'bg-surface-2 text-text-2 hover:bg-surface-hover',
        destructive: 'bg-danger text-white hover:opacity-90',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3',
        icon: 'h-8 w-8 rounded-lg',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

// Note: no asChild/Slot here - Base UI (which replaced Radix as this app's
// headless primitive layer) uses a `render` prop on its own components
// instead of a generic Slot wrapper. Where a Button needs to compose with a
// Base UI trigger (e.g. wrapped in a Tooltip), pass it via that component's
// `render` prop rather than an asChild flag here - see ModRow.tsx.
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  )
)
Button.displayName = 'Button'
