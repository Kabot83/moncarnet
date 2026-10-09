import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from 'react'
import { Spinner } from './Spinner'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft' | 'sage'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-terra text-white dark:text-[#1b1916] shadow-[0_6px_16px_-8px_rgb(184_92_56/.8)] hover:bg-terra-strong active:scale-[.98]',
  secondary: 'bg-paper text-ink border border-line hover:border-faint active:scale-[.98]',
  ghost: 'text-ink hover:bg-sunken',
  danger: 'bg-danger-soft text-danger hover:brightness-95 active:scale-[.98]',
  soft: 'bg-terra-soft text-terra-strong hover:brightness-[.98] active:scale-[.98]',
  sage: 'bg-sage-soft text-sage hover:brightness-[.98] active:scale-[.98]',
}
const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-sm gap-1.5 rounded-full',
  md: 'h-12 px-5 text-[15px] gap-2 rounded-full',
  lg: 'h-14 px-6 text-base gap-2.5 rounded-full',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  loading?: boolean
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon, loading, block, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center font-semibold transition-all duration-150 select-none disabled:opacity-50 disabled:pointer-events-none ${VARIANTS[variant]} ${SIZES[size]} ${block ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {loading ? <Spinner size={18} /> : icon}
      {children && <span className="truncate">{children}</span>}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'sm' | 'md' | 'lg'
  tone?: 'plain' | 'paper' | 'terra' | 'glass'
}

const ICON_SIZES = { sm: 'size-9', md: 'size-11', lg: 'size-14' }
const TONES = {
  plain: 'text-ink hover:bg-sunken',
  paper: 'bg-paper text-ink shadow-[var(--shadow-card)]',
  terra: 'bg-terra text-white dark:text-[#1b1916]',
  glass: 'bg-black/35 text-white backdrop-blur-md group-data-[solid=true]/top:bg-transparent group-data-[solid=true]/top:text-ink group-data-[solid=true]/top:backdrop-blur-none',
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', tone = 'plain', className = '', children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-all duration-150 active:scale-95 disabled:opacity-40 ${ICON_SIZES[size]} ${TONES[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
})
