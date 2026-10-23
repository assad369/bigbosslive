import { useMemo, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Avatar,
  Button,
  Drawer,
  Dropdown,
  Grid,
  Layout,
  Menu,
  Space,
  Tag,
  Typography,
  type MenuProps,
} from 'antd';
import {
  AlertOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BankOutlined,
  BellOutlined,
  CrownOutlined,
  DashboardOutlined,
  FireOutlined,
  GiftOutlined,
  LogoutOutlined,
  MenuOutlined,
  NotificationOutlined,
  PictureOutlined,
  SettingOutlined,
  ShopOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  TrophyOutlined,
  UserOutlined,
  VideoCameraOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useAuth } from '../auth/useAuth';
import { brand } from '../theme';
import { Logo } from '../components/Logo';

const { Sider, Header, Content } = Layout;

interface NavItem {
  key: string;
  label: string;
  icon: ReactNode;
  permission: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { key: '/', label: 'Dashboard', icon: <DashboardOutlined />, permission: 'dashboard.view' },
    ],
  },
  {
    label: 'Community',
    items: [
      { key: '/users', label: 'Users', icon: <UserOutlined />, permission: 'users.read' },
      { key: '/live', label: 'Live rooms', icon: <VideoCameraOutlined />, permission: 'live.read' },
      { key: '/pk', label: 'PK battles', icon: <ThunderboltOutlined />, permission: 'live.read' },
      {
        key: '/feed',
        label: 'Feed moderation',
        icon: <FireOutlined />,
        permission: 'feed.moderate',
      },
      { key: '/reports', label: 'Reports', icon: <AlertOutlined />, permission: 'reports.read' },
      {
        key: '/devices',
        label: 'Device bans',
        icon: <AppstoreOutlined />,
        permission: 'devices.ban',
      },
    ],
  },
  {
    label: 'Economy',
    items: [
      {
        key: '/recharges',
        label: 'Recharges',
        icon: <WalletOutlined />,
        permission: 'wallet.read',
      },
      {
        key: '/gift-transactions',
        label: 'Gift history',
        icon: <GiftOutlined />,
        permission: 'wallet.read',
      },
      {
        key: '/withdrawals',
        label: 'Withdrawals',
        icon: <BankOutlined />,
        permission: 'withdrawals.read',
      },
      { key: '/agents', label: 'Agents', icon: <ShopOutlined />, permission: 'agents.manage' },
      {
        key: '/agencies',
        label: 'Host agencies',
        icon: <TeamOutlined />,
        permission: 'agencies.manage',
      },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { key: '/gifts', label: 'Gifts', icon: <GiftOutlined />, permission: 'catalog.manage' },
      {
        key: '/store',
        label: 'VIP & store',
        icon: <CrownOutlined />,
        permission: 'catalog.manage',
      },
      { key: '/levels', label: 'Levels', icon: <TrophyOutlined />, permission: 'catalog.manage' },
      {
        key: '/packages',
        label: 'Recharge packages',
        icon: <ShopOutlined />,
        permission: 'catalog.manage',
      },
      { key: '/games', label: 'Games', icon: <AppstoreOutlined />, permission: 'games.read' },
    ],
  },
  {
    label: 'Engagement',
    items: [
      {
        key: '/announcements',
        label: 'Announcements',
        icon: <NotificationOutlined />,
        permission: 'notifications.send',
      },
      { key: '/banners', label: 'Banners', icon: <PictureOutlined />, permission: 'config.manage' },
    ],
  },
  {
    label: 'System',
    items: [
      {
        key: '/settings',
        label: 'Settings',
        icon: <SettingOutlined />,
        permission: 'config.manage',
      },
      { key: '/admins', label: 'Admin team', icon: <CrownOutlined />, permission: 'admins.manage' },
      { key: '/audit', label: 'Audit log', icon: <AuditOutlined />, permission: 'audit.read' },
    ],
  },
];

export function AdminLayout() {
  const { me, can, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const [drawer, setDrawer] = useState(false);
  const mobile = !screens.lg;

  const items: MenuProps['items'] = useMemo(
    () =>
      NAV.map((g) => ({
        type: 'group' as const,
        label: g.label,
        children: g.items
          .filter((i) => can(i.permission))
          .map((i) => ({ key: i.key, icon: i.icon, label: i.label })),
      })).filter((g) => g.children.length),
    [can],
  );

  const selected = useMemo(() => {
    const all = NAV.flatMap((g) => g.items.map((i) => i.key));
    const match = all
      .filter((k) => (k === '/' ? location.pathname === '/' : location.pathname.startsWith(k)))
      .sort((a, b) => b.length - a.length)[0];
    return match ? [match] : [];
  }, [location.pathname]);

  const menu = (
    <Menu
      theme="dark"
      mode="inline"
      items={items}
      selectedKeys={selected}
      onClick={({ key }) => {
        navigate(key);
        setDrawer(false);
      }}
      style={{ borderInlineEnd: 0, paddingBottom: 24 }}
    />
  );

  const brandBlock = (
    <Link
      to="/"
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 20px 12px' }}
    >
      <Logo size={34} />
      <div style={{ lineHeight: 1.1 }}>
        <div
          style={{
            fontFamily: brand.typography.display,
            fontSize: 18,
            fontWeight: 700,
            background: brand.gradients.gold,
            WebkitBackgroundClip: 'text',
            color: 'transparent',
          }}
        >
          BigBoss Live
        </div>
        <div
          style={{
            fontSize: 11,
            color: brand.palette.inkSubtle,
            letterSpacing: 1.5,
            textTransform: 'uppercase',
          }}
        >
          Admin
        </div>
      </div>
    </Link>
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {!mobile && (
        <Sider
          width={248}
          style={{
            position: 'sticky',
            top: 0,
            height: '100vh',
            overflow: 'auto',
            borderRight: `1px solid ${brand.palette.goldDeep}33`,
          }}
        >
          {brandBlock}
          {menu}
        </Sider>
      )}
      {mobile && (
        <Drawer
          open={drawer}
          onClose={() => setDrawer(false)}
          placement="left"
          size={264}
          styles={{
            body: { padding: 0, background: brand.palette.ink },
            header: { display: 'none' },
          }}
        >
          {brandBlock}
          {menu}
        </Drawer>
      )}
      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: `1px solid ${brand.palette.border}`,
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <Space>
            {mobile && (
              <Button
                type="text"
                icon={<MenuOutlined />}
                onClick={() => setDrawer(true)}
                aria-label="Open menu"
              />
            )}
            <div
              style={{ height: 4, width: 48, borderRadius: 4, background: brand.gradients.gold }}
            />
          </Space>
          <Space size="middle">
            <Button
              type="text"
              icon={<BellOutlined />}
              onClick={() => navigate('/reports')}
              aria-label="Reports"
            />
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: 'Sign out',
                    onClick: () => void signOut(),
                  },
                ],
              }}
            >
              <Space style={{ cursor: 'pointer' }}>
                <Avatar
                  src={me?.avatarUrl ?? undefined}
                  style={{ background: brand.gradients.gold }}
                >
                  {me?.displayName?.[0]?.toUpperCase()}
                </Avatar>
                {!mobile && (
                  <div style={{ lineHeight: 1.2 }}>
                    <Typography.Text strong>{me?.displayName}</Typography.Text>
                    <br />
                    <Tag color="gold" style={{ marginTop: 2 }}>
                      {me?.role}
                    </Tag>
                  </div>
                )}
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content
          style={{ padding: mobile ? 16 : 24, maxWidth: 1480, width: '100%', margin: '0 auto' }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
