import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { api, ApiError, errorMessage, setUnauthorizedHandler } from './api';
import type { Me } from './types';
import { ErrorNote, PageLoader } from '@/components/ui';

const AuthContext = createContext<{ me: Me } | null>(null);

export function useAuth(): { me: Me } {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé dans une page protégée.');
  return ctx;
}

export const meQuery = { queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), staleTime: 60_000 } as const;

/** Protège les pages : sans session valide, retour à la connexion. */
export function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ ...meQuery, retry: (count, err) => err instanceof ApiError && err.retryable && count < 2 });

  useEffect(() => {
    // Session expirée en cours d'utilisation : on vide le cache et on redirige.
    setUnauthorizedHandler(() => {
      qc.clear();
      navigate('/connexion', { replace: true, state: { expired: true } });
    });
  }, [qc, navigate]);

  if (me.isLoading) return <div className="flex h-full items-center justify-center"><PageLoader /></div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
    return <div className="mx-auto max-w-md p-8"><ErrorNote message={errorMessage(me.error)} onRetry={() => me.refetch()} /></div>;
  }
  if (admin && me.data!.user.role !== 'ADMIN') return <Navigate to="/" replace />;
  return <AuthContext.Provider value={{ me: me.data! }}>{children}</AuthContext.Provider>;
}
