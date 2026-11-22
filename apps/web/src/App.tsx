import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { FullScreenLoader } from './components/FullScreenLoader';
import { AppShell } from './features/shell/AppShell';
import { ChatsPage } from './features/chat/ChatsPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SessionGate } from './session/session';

const ViewerPage = lazy(() => import('./features/files/ViewerPage'));
const ApprovalsPage = lazy(() => import('./features/approvals/ApprovalsPage'));
const SettingsPage = lazy(() => import('./features/settings/SettingsPage'));
const AdminPage = lazy(() => import('./features/admin/AdminPage'));
const VerifyPage = lazy(() => import('./pages/VerifyPage'));
const ConsultationsPage = lazy(() => import('./features/consultations/ConsultationsPage'));

export function App() {
  return (
    <Suspense fallback={<FullScreenLoader />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/verify/:fileId/:code" element={<VerifyPage />} />
        <Route
          element={
            <SessionGate>
              <AppShell />
            </SessionGate>
          }
        >
          <Route index element={<ChatsPage />} />
          <Route path="chats" element={<ChatsPage />} />
          <Route path="chats/:channelId" element={<ChatsPage />} />
          <Route path="files/:fileId" element={<ViewerPage />} />
          <Route path="consultations" element={<ConsultationsPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="admin/*" element={<AdminPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
