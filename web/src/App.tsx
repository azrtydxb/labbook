import { Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import { AdminPage } from './pages/Admin';
import { ComparePage } from './pages/Compare';
import { DashboardPage } from './pages/Dashboard';
import { LoginPage } from './pages/Login';
import { RunDetailPage } from './pages/RunDetail';
import { RunsPage } from './pages/Runs';
import { SetDetailPage } from './pages/SetDetail';
import { SetsPage } from './pages/Sets';
import { TypeDetailPage } from './pages/TypeDetail';
import { TypeEditorPage } from './pages/TypeEditor';
import { TypesPage } from './pages/Types';

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Opening labbook" />;
  if (!user) return <LoginPage />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/types" element={<TypesPage />} />
        <Route path="/types/:slug" element={<TypeDetailPage />} />
        <Route path="/types/:slug/edit" element={<TypeEditorPage />} />
        <Route path="/new-type" element={<TypeEditorPage />} />
        <Route path="/sets" element={<SetsPage />} />
        <Route path="/sets/:slug" element={<SetDetailPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route
          path="*"
          element={
            <div className="py-20 text-center">
              <h1 className="text-xl font-semibold">Page not found</h1>
              <p className="mt-2 text-sm text-ink-2">The address does not match any page in labbook.</p>
            </div>
          }
        />
      </Routes>
    </Layout>
  );
}
