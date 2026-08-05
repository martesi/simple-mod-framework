import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger

export const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Popup>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup> & { hideClose?: boolean }>(
  ({ className, children, hideClose, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-100 bg-black/45 animate-fade-in" />
      <DialogPrimitive.Popup
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-101 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface shadow-md animate-fade-in",
          className
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 text-text-2 hover:text-text">
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
)
DialogContent.displayName = "DialogContent"

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 pt-5 pb-1", className)} {...props} />
}

export function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-[16px] font-bold text-text", className)} {...props} />
}

export function DialogDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-[12.5px] text-text-2 mt-0.5", className)} {...props} />
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex justify-end gap-2 px-6 py-4 border-t border-border", className)} {...props} />
}
