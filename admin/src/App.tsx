import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Result, Spin } from 'antd';
import { useAuth } from './auth/useAuth';
import { AdminLayout } from './layout/AdminLayout';
import { LoginPage } from './pages/LoginPage';

// Route-level code splitting keeps the first load small.
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const UsersPage = lazy(() =>
  import('./pages/users/UsersPage').then((m) => ({ default: m.UsersPage })),
);
const UserDetailPage = lazy(() =>
  import('./pages/users/UserDetailPage').then((m) => ({ default: m.UserDetailPage })),
);
const LivePage = lazy(() => import('./pages/live/LivePage').then((m) => ({ default: m.LivePage })));
const moderation = () => import('./pages/moderation/ModerationPages');
const ReportsPage = lazy(() => moderation().then((m) => ({ default: m.ReportsPage })));
const FeedModerationPage = lazy(() =>
  moderation().then((m) => ({ default: m.FeedModerationPage })),
);
const DeviceBansPage = lazy(() => moderation().then((m) => ({ default: m.DeviceBansPage })));
const PkBattlesPage = lazy(() => moderation().then((m) => ({ default: m.PkBattlesPage })));
const economy = () => import('./pages/economy/EconomyPages');
const RechargesPage = lazy(() => economy().then((m) => ({ default: m.RechargesPage })));
const GiftTransactionsPage = lazy(() =>
  economy().then((m) => ({ default: m.GiftTransactionsPage })),
);
const WithdrawalsPage = lazy(() => economy().then((m) => ({ default: m.WithdrawalsPage })));
const AgenciesPage = lazy(() => economy().then((m) => ({ default: m.AgenciesPage })));
const AgencyDetailPage = lazy(() => economy().then((m) => ({ default: m.AgencyDetailPage })));
const catalog = () => import('./pages/catalog/CatalogPages');
const GiftsPage = lazy(() => catalog().then((m) => ({ default: m.GiftsPage })));
const StorePage = lazy(() => catalog().then((m) => ({ default: m.StorePage })));
const LevelsPage = lazy(() => catalog().then((m) => ({ default: m.LevelsPage })));
const PackagesPage = lazy(() => catalog().then((m) => ({ default: m.PackagesPage })));
const GamesPage = lazy(() =>
  import('./pages/games/GamesPage').then((m) => ({ default: m.GamesPage })),
);
const engagement = () => import('./pages/engagement/EngagementPages');
const AnnouncementsPage = lazy(() => engagement().then((m) => ({ default: m.AnnouncementsPage })));
const BannersPage = lazy(() => engagement().then((m) => ({ default: m.BannersPage })));
const system = () => import('./pages/system/SystemPages');
const SettingsPage = lazy(() => system().then((m) => ({ default: m.SettingsPage })));
const AdminsPage = lazy(() => system().then((m) => ({ default: m.AdminsPage })));
const AuditPage = lazy(() => system().then((m) => ({ default: m.AuditPage })));

const Loading = () => (
  <div style={{ display: 'grid', placeItems: 'center', minHeight: 320 }}>
    <Spin size="large" />
  </div>
);

function Guard({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission))
    return (
      <Result status="403" title="No access" subTitle="Your role does not include this section." />
    );
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

const routes: { path: string; permission: string; element: ReactNode }[] = [
  { path: '/', permission: 'dashboard.view', element: <DashboardPage /> },
  { path: '/users', permission: 'users.read', element: <UsersPage /> },
  { path: '/users/:uid', permission: 'users.read', element: <UserDetailPage /> },
  { path: '/agents', permission: 'agents.manage', element: <UsersPage agentsOnly /> },
  { path: '/live', permission: 'live.read', element: <LivePage /> },
  { path: '/pk', permission: 'live.read', element: <PkBattlesPage /> },
  { path: '/feed', permission: 'feed.moderate', element: <FeedModerationPage /> },
  { path: '/reports', permission: 'reports.read', element: <ReportsPage /> },
  { path: '/devices', permission: 'devices.ban', element: <DeviceBansPage /> },
  { path: '/recharges', permission: 'wallet.read', element: <RechargesPage /> },
  { path: '/gift-transactions', permission: 'wallet.read', element: <GiftTransactionsPage /> },
  { path: '/withdrawals', permission: 'withdrawals.read', element: <WithdrawalsPage /> },
  { path: '/agencies', permission: 'agencies.manage', element: <AgenciesPage /> },
  { path: '/agencies/:id', permission: 'agencies.manage', element: <AgencyDetailPage /> },
  { path: '/gifts', permission: 'catalog.manage', element: <GiftsPage /> },
  { path: '/store', permission: 'catalog.manage', element: <StorePage /> },
  { path: '/levels', permission: 'catalog.manage', element: <LevelsPage /> },
  { path: '/packages', permission: 'catalog.manage', element: <PackagesPage /> },
  { path: '/games', permission: 'games.read', element: <GamesPage /> },
  { path: '/announcements', permission: 'notifications.send', element: <AnnouncementsPage /> },
  { path: '/banners', permission: 'config.manage', element: <BannersPage /> },
  { path: '/settings', permission: 'config.manage', element: <SettingsPage /> },
  { path: '/admins', permission: 'admins.manage', element: <AdminsPage /> },
  { path: '/audit', permission: 'audit.read', element: <AuditPage /> },
];

export function App() {
  const { status } = useAuth();
  if (status === 'loading') return <Loading />;
  if (status !== 'ready') return <LoginPage />;
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AdminLayout />}>
          {routes.map((r) => (
            <Route
              key={r.path}
              path={r.path}
              element={<Guard permission={r.permission}>{r.element}</Guard>}
            />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
