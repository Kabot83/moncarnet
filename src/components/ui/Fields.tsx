import { Star } from 'lucide-react'
import { type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, forwardRef, useEffect, useId, useRef } from 'react'

export function Field({ label, hint, error, children, htmlFor }: { label?: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      {label && (
        <label className="label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  )
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: ReactNode
  error?: string | null
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput({ label, hint, error, className = '', id, ...rest }, ref) {
  const auto = useId()
  const fid = id ?? auto
  return (
    <Field label={label} hint={hint} error={error} htmlFor={fid}>
      <input ref={ref} id={fid} className={`field ${error ? '!border-danger' : ''} ${className}`} aria-invalid={!!error || undefined} {...rest} />
    </Field>
  )
})

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: ReactNode
  /** Agrandit automatiquement la zone selon le contenu. */
  autoGrow?: boolean
}

export function TextArea({ label, hint, className = '', id, autoGrow = true, ...rest }: TextAreaProps) {
  const auto = useId()
  const fid = id ?? auto
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !autoGrow) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight + 2, 480)}px`
  }, [rest.value, autoGrow])
  return (
    <Field label={label} hint={hint} htmlFor={fid}>
      <textarea ref={ref} id={fid} rows={3} className={`field resize-none leading-relaxed ${className}`} {...rest} />
    </Field>
  )
}

/** Champ numérique tolérant (« 1,5 », vide = null). */
export function NumberInput({
  label,
  value,
  onChange,
  suffix,
  min = 0,
  step,
  placeholder,
  hint,
  className = '',
}: {
  label?: string
  value: number | null
  onChange: (v: number | null) => void
  suffix?: string
  min?: number
  step?: number
  placeholder?: string
  hint?: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <div className="relative">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step ?? 'any'}
          placeholder={placeholder}
          className={`field ${suffix ? 'pr-14' : ''} ${className}`}
          value={value ?? ''}
          onChange={(e) => {
            const v = e.target.value === '' ? null : Number(e.target.value.replace(',', '.'))
            onChange(v == null || Number.isNaN(v) ? null : Math.max(min, v))
          }}
        />
        {suffix && <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-sm text-faint">{suffix}</span>}
      </div>
    </Field>
  )
}

export function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode }) {
  const id = useId()
  return (
    <div className="flex items-center gap-4 py-2">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[15px] font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-sm text-muted">{description}</span>}
      </label>
      <button
        id={id}
        role="switch"
        type="button"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 ${checked ? 'bg-sage' : 'bg-line'}`}
      >
        <span className={`absolute top-0.5 left-0.5 size-6 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

export function Chip({
  active,
  onClick,
  children,
  icon,
  className = '',
}: {
  active?: boolean
  onClick?: () => void
  children: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors ${
        active ? 'border-terra bg-terra text-white dark:text-[#1b1916]' : 'border-line bg-paper text-ink hover:border-faint'
      } ${className}`}
    >
      {icon}
      {children}
    </button>
  )
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; icon?: ReactNode }[]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-sunken p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          type="button"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-all ${
            value === o.value ? 'bg-paper text-ink shadow-sm' : 'text-muted'
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Note sur cinq étoiles, affichage ou saisie. */
export function Stars({ value, onChange, size = 16, label = 'Note' }: { value: number; onChange?: (v: number) => void; size?: number; label?: string }) {
  if (!onChange) {
    if (!value) return null
    return (
      <span className="inline-flex items-center gap-0.5 text-gold" aria-label={`${label} : ${value} sur 5`} role="img">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} size={size} strokeWidth={1.5} fill={i <= Math.round(value) ? 'currentColor' : 'none'} className={i <= Math.round(value) ? '' : 'opacity-35'} />
        ))}
      </span>
    )
  }
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center gap-1 text-gold">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={value === i}
          aria-label={`${i} étoile${i > 1 ? 's' : ''}`}
          onClick={() => onChange(value === i ? 0 : i)}
          className="grid size-10 place-items-center rounded-full active:scale-90"
        >
          <Star size={size} strokeWidth={1.5} fill={i <= value ? 'currentColor' : 'none'} className={i <= value ? '' : 'opacity-40'} />
        </button>
      ))}
    </div>
  )
}
