'use client';

import { cn } from '@/lib/utils';

export interface CheckboxProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function Checkbox({ checked, onCheckedChange, disabled, className, id }: CheckboxProps) {
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'h-4 w-4 shrink-0 rounded border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? 'bg-purple-600 border-purple-600 text-white'
          : 'border-zinc-600 bg-zinc-900',
        className
      )}
    >
      {checked && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3 w-3"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  );
}
