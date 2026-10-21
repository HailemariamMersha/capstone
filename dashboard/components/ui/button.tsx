import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
const variants = cva(
  'inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-50 disabled:pointer-events-none min-h-11 px-4 py-2',
  {
    variants: {
      variant: {
        default: 'bg-teal-800 text-white hover:bg-teal-900',
        outline: 'border border-slate-300 bg-white hover:bg-slate-100',
        ghost: 'hover:bg-slate-100',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
export function Button({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof variants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp className={cn(variants({ variant, className }))} {...props} />;
}
