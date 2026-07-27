import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger

export const SheetContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Popup>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup>>(
  ({ className, children, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-black/35 animate-fade-in" />
      <DialogPrimitive.Popup
        ref={ref}
        className={cn("fixed right-0 top-0 z-[91] flex h-full w-[400px] max-w-[90vw] flex-col border-l border-border bg-surface shadow-md", className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-5 top-5 text-text-2 hover:text-text">
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
)
SheetContent.displayName = "SheetContent"

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-start justify-between border-b border-border px-[22px] py-5", className)} {...props} />
}

export function SheetTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-[16px] font-bold text-text", className)} {...props} />
}

export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-t border-border px-[22px] py-4", className)} {...props} />
}
