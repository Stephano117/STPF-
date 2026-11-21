// Composants d'interface de base (approche shadcn/ui : primitives Radix + classes Tailwind,
// code détenu par le projet).

import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2, X, type LucideIcon } from 'lucide-react';
import { ContextMenu as RContext, Dialog as RDialog, DropdownMenu as RDropdown } from 'radix-ui';
import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/format';

// ───────────────────────────── Bouton ─────────────────────────────

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap select-none',
  {
    variants: {
      variant: {
        primary: 'bg-petrol text-white hover:bg-petrol-dark',
        secondary: 'bg-white text-ink border border-line hover:bg-surface',
        ghost: 'text-ink hover:bg-black/5',
        danger: 'bg-danger text-white hover:bg-danger/90',
      },
      size: { md: 'h-10 px-4', sm: 'h-8 px-3 text-[13px]', icon: 'h-9 w-9' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, type, ...props }, ref) => (
  <button ref={ref} type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
    {children}
  </button>
));
Button.displayName = 'Button';

// ───────────────────────────── Champs ─────────────────────────────

const fieldClass =
  'h-10 w-full rounded-lg border border-line bg-white px-3 text-sm text-ink placeholder:text-muted/70 focus:border-petrol focus:outline-none focus:ring-2 focus:ring-petrol/20 disabled:bg-surface disabled:text-muted aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldClass, className)} {...props} />
));
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(fieldClass, 'pr-8', className)} {...props}>
    {children}
  </select>
));
Select.displayName = 'Select';

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

// ───────────────────────────── Divers ─────────────────────────────

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-petrol', className)} role="status" aria-label="Chargement" />;
}

export function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

const badgeVariants = cva('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-black/5 text-ink',
      petrol: 'bg-petrol-soft text-petrol',
      ok: 'bg-ok-soft text-ok',
      warn: 'bg-warn-soft text-warn',
      danger: 'bg-danger-soft text-danger',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
export function Badge({ tone, className, children }: VariantProps<typeof badgeVariants> & { className?: string; children: ReactNode }) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-petrol-soft text-petrol">
        <Icon className="h-7 w-7" aria-hidden />
      </div>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {text && <p className="mt-1 max-w-sm text-sm text-muted">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger">
      <span>{message}</span>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  );
}

export function ProgressBar({ value, tone = 'petrol' }: { value: number; tone?: 'petrol' | 'warn' | 'danger' }) {
  const color = tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-petrol';
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full transition-[width] duration-300', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-line bg-white', className)}>{children}</div>;
}

// ───────────────────────────── Dialogue ─────────────────────────────

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const width = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-5xl' }[size];
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="anim-overlay fixed inset-0 z-40 bg-deep/40 backdrop-blur-[1px]" />
        <RDialog.Content
          className={cn('anim-pop fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white shadow-xl', width)}
          aria-describedby={description ? undefined : undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <RDialog.Title className="truncate text-base font-semibold text-ink">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-sm text-muted">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Fermer" className="-mr-2 -mt-1 shrink-0">
                <X className="h-4 w-4" />
              </Button>
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-wrap justify-end gap-2">{children}</div>;
}

/** Confirmation d'une action sensible. `requireReason` impose un motif (suppressions administratives). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  text,
  confirmLabel,
  danger,
  requireReason,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  text: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)} title={title} size="sm">
      <div className="text-sm text-ink">{text}</div>
      {requireReason && (
        <div className="mt-4">
          <Field label="Motif (consigné au journal)" htmlFor="confirm-reason">
            <Input id="confirm-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. : document obsolète" autoFocus />
          </Field>
        </div>
      )}
      <DialogFooter>
        <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
          Annuler
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          loading={busy}
          disabled={requireReason && reason.trim().length < 5}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm(reason.trim());
              onOpenChange(false);
              setReason('');
            } catch {
              /* l'appelant affiche l'erreur */
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ───────────────────────────── Menus ─────────────────────────────

export interface MenuAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
  separatorBefore?: boolean;
}

const menuContentClass = 'anim-pop z-50 min-w-52 rounded-xl border border-line bg-white p-1 shadow-lg';
const menuItemClass = (danger?: boolean) =>
  cn(
    'flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface',
    danger ? 'text-danger data-[highlighted]:bg-danger-soft' : 'text-ink',
  );

function renderItems(actions: MenuAction[], Item: typeof RDropdown.Item | typeof RContext.Item, Separator: typeof RDropdown.Separator | typeof RContext.Separator) {
  return actions
    .filter((a) => !a.hidden)
    .map((a) => (
      <div key={a.label}>
        {a.separatorBefore && <Separator className="my-1 h-px bg-line" />}
        <Item className={menuItemClass(a.danger)} onSelect={a.onSelect}>
          <a.icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
          {a.label}
        </Item>
      </div>
    ));
}

export function ActionMenu({ actions, children, align = 'end' }: { actions: MenuAction[]; children: ReactNode; align?: 'start' | 'end' }) {
  return (
    <RDropdown.Root>
      <RDropdown.Trigger asChild>{children}</RDropdown.Trigger>
      <RDropdown.Portal>
        <RDropdown.Content align={align} sideOffset={4} className={menuContentClass}>
          {renderItems(actions, RDropdown.Item, RDropdown.Separator)}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  );
}

/** Menu contextuel (clic droit) autour d'un élément. */
export function ActionContext({ actions, children }: { actions: MenuAction[]; children: ReactNode }) {
  return (
    <RContext.Root>
      <RContext.Trigger asChild>{children}</RContext.Trigger>
      <RContext.Portal>
        <RContext.Content className={menuContentClass}>{renderItems(actions, RContext.Item, RContext.Separator)}</RContext.Content>
      </RContext.Portal>
    </RContext.Root>
  );
}
