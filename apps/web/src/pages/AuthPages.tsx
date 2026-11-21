import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { z } from 'zod';
import { Logo } from '@/components/Layout';
import { Button, Field, Input } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { meQuery } from '@/lib/auth';
import { passwordProblem, stretchPassword } from '@/lib/password';

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-full bg-surface">
      {/* Panneau illustré — carte de la Haute Matsiatra */}
      <aside className="relative hidden w-[46%] shrink-0 overflow-hidden bg-deep lg:flex lg:flex-col lg:justify-between">
        <img
          src="/carte-haute-matsiatra.webp"
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full scale-105 object-cover opacity-70 mix-blend-screen [mask-image:radial-gradient(72%_62%_at_50%_50%,#000_50%,transparent_100%)]"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-deep via-deep/20 to-deep/60" />
        <div className="relative p-12">
          <Logo light large />
        </div>
        <div className="relative p-12">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-white/60">Région Haute Matsiatra</p>
          <h2 className="mt-2 text-3xl font-semibold leading-tight text-white">Vos documents, au même endroit.</h2>
        </div>
      </aside>

      {/* Formulaire */}
      <main className="relative flex flex-1 items-center justify-center overflow-hidden p-6">
        <img
          src="/carte-haute-matsiatra.webp"
          alt=""
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-[420px] w-[420px] object-contain opacity-[0.07] lg:hidden"
        />
        <div className="anim-pop relative w-full max-w-[400px]">
          <div className="mb-8 flex justify-center lg:hidden">
            <Logo />
          </div>
          <div className="rounded-3xl border border-line bg-white/90 p-8 shadow-[0_18px_50px_-24px_rgba(18,61,74,0.45)] backdrop-blur-sm">
            <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
            <div className="mt-6">{children}</div>
          </div>
          <p className="mt-6 text-center text-sm text-muted">{footer}</p>
        </div>
      </main>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'danger' | 'warn' | 'info'; children: ReactNode }) {
  const cls = tone === 'danger' ? 'bg-danger-soft text-danger' : tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-petrol-soft text-petrol';
  return <div role="alert" className={`mb-4 rounded-lg px-3 py-2.5 text-sm ${cls}`}>{children}</div>;
}

const loginSchema = z.object({ email: z.email('Adresse e-mail invalide.'), password: z.string().min(1, 'Mot de passe requis.') });

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const state = location.state as { from?: string; expired?: boolean } | null;
  const me = useQuery({ ...meQuery, retry: false });
  const [error, setError] = useState<{ tone: 'danger' | 'warn'; text: string } | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(loginSchema) });
  if (me.data) return <Navigate to={state?.from ?? '/'} replace />;

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { email, authKey: await stretchPassword(email, password) } });
      qc.clear();
      navigate(state?.from ?? '/', { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError({ tone: code === 'ACCOUNT_PENDING' ? 'warn' : 'danger', text: errorMessage(err) });
    }
  });

  return (
    <AuthShell title="Connexion" footer={<>Pas encore de compte ? <Link to="/inscription" className="font-medium text-petrol hover:underline">Demander un accès</Link></>}>
      {state?.expired && !error && <Notice tone="info">Votre session a expiré. Reconnectez-vous.</Notice>}
      {error && <Notice tone={error.tone}>{error.text}</Notice>}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="E-mail professionnel" error={errors.email?.message} htmlFor="email">
          <Input id="email" type="email" autoComplete="username" autoFocus aria-invalid={!!errors.email} {...register('email')} />
        </Field>
        <Field label="Mot de passe" error={errors.password?.message} htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register('password')} />
        </Field>
        <Button type="submit" className="mt-1 h-11 w-full rounded-xl" loading={isSubmitting}>Se connecter</Button>
      </form>
    </AuthShell>
  );
}

const registerSchema = z
  .object({
    firstName: z.string().trim().min(1, 'Prénom requis.').max(80),
    lastName: z.string().trim().min(1, 'Nom requis.').max(80),
    email: z.email('Adresse e-mail invalide.'),
    password: z.string().refine((p) => passwordProblem(p) === null, { error: (iss) => passwordProblem(String(iss.input)) ?? '' }),
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, { path: ['confirm'], error: 'Les mots de passe ne correspondent pas.' });

export function RegisterPage() {
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(registerSchema) });

  const onSubmit = handleSubmit(async ({ password, confirm: _confirm, ...data }) => {
    setError('');
    try {
      await api('/auth/register', { method: 'POST', body: { ...data, authKey: await stretchPassword(data.email, password) } });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  if (done) {
    return (
      <AuthShell title="Demande envoyée" footer={<Link to="/connexion" className="font-medium text-petrol hover:underline">Retour à la connexion</Link>}>
        <div className="flex flex-col items-center py-4 text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-ok-soft text-ok"><CheckCircle2 className="h-7 w-7" /></div>
          <p className="text-sm text-ink">Votre demande a bien été enregistrée.</p>
          <p className="mt-2 flex items-center gap-2 text-sm text-muted"><Clock className="h-4 w-4" />Un administrateur doit valider votre compte avant votre première connexion.</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Demander un accès" subtitle="Compte activé après validation par un administrateur." footer={<>Déjà inscrit ? <Link to="/connexion" className="font-medium text-petrol hover:underline">Se connecter</Link></>}>
      {error && <Notice tone="danger">{error}</Notice>}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Prénom" error={errors.firstName?.message} htmlFor="firstName"><Input id="firstName" autoComplete="given-name" autoFocus {...register('firstName')} /></Field>
          <Field label="Nom" error={errors.lastName?.message} htmlFor="lastName"><Input id="lastName" autoComplete="family-name" {...register('lastName')} /></Field>
        </div>
        <Field label="E-mail professionnel" error={errors.email?.message} htmlFor="email"><Input id="email" type="email" autoComplete="username" {...register('email')} /></Field>
        <Field label="Mot de passe" error={errors.password?.message} hint="12 caractères minimum, avec lettres et chiffres." htmlFor="password">
          <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
        </Field>
        <Field label="Confirmer le mot de passe" error={errors.confirm?.message} htmlFor="confirm"><Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} /></Field>
        <Button type="submit" className="mt-1 h-11 w-full rounded-xl" loading={isSubmitting}>Envoyer ma demande</Button>
      </form>
    </AuthShell>
  );
}
