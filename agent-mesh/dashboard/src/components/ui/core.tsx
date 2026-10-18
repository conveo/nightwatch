import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@radix-ui/react-slot"
import * as React from "react"
import type { AgentStatus } from "@/lib/api"
import { cn } from "@/lib/utils"

// ── Button ────────────────────────────────────────────────────────────────
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-[background,color,box-shadow,border-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 cursor-default select-none",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70 border border-border/60",
        outline: "border border-border bg-transparent hover:bg-accent/60 hover:border-border",
        ghost: "hover:bg-accent/60 text-foreground/80 hover:text-foreground",
        destructive: "bg-destructive/15 text-destructive border border-destructive/30 hover:bg-destructive/25",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        default: "h-8 px-3",
        icon: "size-8",
        iconSm: "size-7",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
)

// forwardRef is required so radix triggers (Popover/Tooltip/Collapsible with
// asChild) can attach their anchor ref — without it the popper never positions.
export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }
>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
})
Button.displayName = "Button"

// ── Input / Textarea ──────────────────────────────────────────────────────
export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-8 w-full rounded-md border border-border bg-background/60 px-2.5 text-sm text-foreground placeholder:text-muted-foreground/70 outline-none transition-colors focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/30",
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "min-h-[72px] w-full rounded-md border border-border bg-background/60 px-2.5 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/70 outline-none transition-colors focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/30",
        className,
      )}
      {...props}
    />
  )
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-xs font-medium text-muted-foreground select-none", className)} {...props} />
}

// ── Badge ─────────────────────────────────────────────────────────────────
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] font-medium leading-tight",
  {
    variants: {
      variant: {
        outline: "border-border/70 bg-muted/40 text-muted-foreground",
        primary: "border-primary/30 bg-primary/15 text-primary",
        accent: "border-border/60 bg-accent text-accent-foreground",
      },
    },
    defaultVariants: { variant: "outline" },
  },
)
export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />
}

export function Separator({ className, orientation = "horizontal" }: { className?: string; orientation?: "horizontal" | "vertical" }) {
  return (
    <div
      className={cn("shrink-0 bg-border/70", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
    />
  )
}

// ── Status semantics ──────────────────────────────────────────────────────
export const STATUS_COLOR: Record<AgentStatus, string> = {
  online: "var(--status-online)",
  dead: "var(--status-dead)",
  stale: "var(--status-stale)",
  offline: "var(--status-offline)",
}

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span
      className={cn("relative inline-flex size-2 shrink-0 rounded-full", status === "online" && "animate-meshpulse", className)}
      style={{ backgroundColor: STATUS_COLOR[status], boxShadow: `0 0 0 3px color-mix(in oklch, ${STATUS_COLOR[status]} 18%, transparent)` }}
      title={status}
    />
  )
}
