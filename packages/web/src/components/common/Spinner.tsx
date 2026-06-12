import { Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';

interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

/** Indeterminate spinner (running state). Uses the running semantic color. */
export function Spinner({ size = 16, className, label = 'Loading' }: SpinnerProps) {
  return (
    <Loader2
      size={size}
      strokeWidth={2}
      aria-label={label}
      className={cn('animate-spin text-running', className)}
    />
  );
}
