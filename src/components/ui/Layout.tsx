import { ArrowLeft, ImageOff } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePhotoUrl } from '@/hooks/usePhotoUrl'
import { IconButton } from './Button'

/** En-tête de page collant, avec retour. */
export function TopBar({
  title,
  back,
  actions,
  transparent,
  subtitle,
  asHeading = true,
}: {
  title?: ReactNode
  back?: boolean | string
  actions?: ReactNode
  transparent?: boolean
  subtitle?: ReactNode
  /** `false` quand la page affiche déjà son propre titre principal. */
  asHeading?: boolean
}) {
  const TitleTag = asHeading ? 'h1' : 'p'
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  const goBack = () => {
    const state = window.history.state as { idx?: number; mcOverlay?: string } | null
    if (typeof back === 'string' && !state?.idx) navigate(back)
    // history.back() plutôt que navigate(-1) : les entrées de panneaux fermés sont sautées automatiquement.
    else if (state?.idx || state?.mcOverlay) window.history.back()
    else navigate(typeof back === 'string' ? back : '/')
  }
  return (
    <header
      data-solid={!transparent || scrolled}
      className={`group/top safe-top sticky top-0 z-30 transition-colors duration-200 ${
        transparent && !scrolled ? 'bg-transparent' : 'border-b border-line/60 bg-bg/90 backdrop-blur-lg'
      }`}
    >
      <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-2">
        {back && (
          <IconButton label="Retour" onClick={goBack} tone={transparent && !scrolled ? 'glass' : 'plain'}>
            <ArrowLeft size={22} strokeWidth={1.75} />
          </IconButton>
        )}
        <div className={`min-w-0 flex-1 ${back ? '' : 'pl-3'}`}>
          {title && (
            <TitleTag
              aria-hidden={asHeading ? undefined : true}
              className={`truncate font-serif text-lg font-semibold transition-opacity ${transparent && !scrolled ? 'opacity-0' : 'opacity-100'}`}
            >
              {title}
            </TitleTag>
          )}
          {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-0.5">{actions}</div>
      </div>
    </header>
  )
}

export function Page({ children, className = '', wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <main className={`mx-auto w-full ${wide ? 'max-w-5xl' : 'max-w-3xl'} px-4 pb-32 animate-fade ${className}`}>{children}</main>
}

export function SectionTitle({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mt-8 mb-3 flex items-end justify-between gap-3">
      <h2 id={id} className="font-serif text-[1.35rem] leading-tight font-semibold">
        {children}
      </h2>
      {action}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center animate-fade-up">
      {icon && <div className="mb-4 grid size-16 place-items-center rounded-full bg-terra-soft text-terra">{icon}</div>}
      <h3 className="font-serif text-xl font-semibold">{title}</h3>
      {children && <div className="mt-2 max-w-sm text-[15px] text-muted">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  )
}

/** Photo stockée localement, avec repli élégant. */
export function Photo({
  id,
  alt,
  variant = 'thumb',
  className = '',
  fallback,
}: {
  id: string | null | undefined
  alt: string
  variant?: 'thumb' | 'full'
  className?: string
  fallback?: ReactNode
}) {
  const url = usePhotoUrl(id, variant)
  const [loaded, setLoaded] = useState(false)
  if (!id) return <>{fallback ?? <PhotoPlaceholder className={className} />}</>
  return (
    <div className={`relative overflow-hidden bg-sunken ${className}`}>
      {url && (
        <img
          src={url}
          alt={alt}
          decoding="async"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className={`size-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
    </div>
  )
}

export function PhotoPlaceholder({ className = '', title }: { className?: string; title?: string }) {
  // Initiale du titre sur fond chaud : jamais de trou disgracieux dans les cartes.
  const letter = title?.trim().charAt(0).toUpperCase()
  return (
    <div className={`grid place-items-center bg-gradient-to-br from-terra-soft to-sage-soft text-terra/70 ${className}`} aria-hidden="true">
      {letter ? <span className="font-serif text-5xl font-semibold opacity-70">{letter}</span> : <ImageOff size={28} strokeWidth={1.25} />}
    </div>
  )
}
