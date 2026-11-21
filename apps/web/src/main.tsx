import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import { AppLayout, ErrorBoundary } from './components/Layout';
import './index.css';
import { ApiError, reportClientError } from './lib/api';
import { RequireAuth } from './lib/auth';
import { AdminPage } from './pages/AdminPage';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { CompanyPage, FavoritesPage, HomePage, PersonalPage, ProfilePage, RecentsPage, SearchPage, TrashPage } from './pages/MainPages';
import { SharedListPage, SharedSpacePage } from './pages/SharedPages';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Nouvelle tentative (avec backoff) uniquement pour les pannes passagères.
      retry: (count, err) => err instanceof ApiError && err.retryable && count < 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
  },
});

window.addEventListener('unhandledrejection', (e) => {
  if (!(e.reason instanceof ApiError)) reportClientError(e.reason);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/connexion" element={<LoginPage />} />
            <Route path="/inscription" element={<RegisterPage />} />
            <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
              <Route index element={<HomePage />} />
              <Route path="entreprise/:folderId?" element={<CompanyPage />} />
              <Route path="partages" element={<SharedListPage />} />
              <Route path="partages/:spaceId/:folderId?" element={<SharedSpacePage />} />
              <Route path="mon-espace/:folderId?" element={<PersonalPage />} />
              <Route path="favoris" element={<FavoritesPage />} />
              <Route path="recents" element={<RecentsPage />} />
              <Route path="corbeille" element={<TrashPage />} />
              <Route path="recherche" element={<SearchPage />} />
              <Route path="profil" element={<ProfilePage />} />
              <Route path="admin/:tab?" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <Toaster position="bottom-center" richColors closeButton duration={3500} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
