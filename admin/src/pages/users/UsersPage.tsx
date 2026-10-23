import { useState } from 'react';
import { Input, Select, Space, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { Money, PageHeader, StatusTag, UserCell } from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { ago } from '../../lib/format';

export interface AdminUser {
  _id: string;
  shortId: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  isAgent: boolean;
  adminRole: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  wallet: { diamonds: number; beans: number; agentStock: number };
  level: { level: number; points: number };
  vip: { tier: number; expiresAt: string | null };
  stats: {
    followers: number;
    following: number;
    totalRecharged: number;
    totalReceived: number;
    totalSent: number;
    liveSeconds: number;
  };
  ban: { reason: string; until: string | null; by: string; at: string } | null;
  agencyId: string | null;
  liveRoomId: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export function UsersPage({ agentsOnly = false }: { agentsOnly?: boolean }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | undefined>();
  const [sort, setSort] = useState('new');

  return (
    <>
      <PageHeader
        title={agentsOnly ? 'Agents' : 'Users'}
        subtitle={
          agentsOnly
            ? 'Resellers who recharge users from their diamond stock'
            : 'Search by name, short ID, uid, email or phone'
        }
      />
      <ServerTable<AdminUser>
        queryKey="users"
        url="/admin/users"
        filters={{ q, status, sort, agent: agentsOnly ? 'true' : undefined }}
        rowKey="_id"
        toolbar={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="Search users"
              prefix={<SearchOutlined />}
              onSearch={setQ}
              style={{ width: 260 }}
            />
            <Select
              allowClear
              placeholder="Status"
              value={status}
              onChange={setStatus}
              style={{ width: 130 }}
              options={['active', 'banned', 'deleted'].map((s) => ({ value: s, label: s }))}
            />
            <Select
              value={sort}
              onChange={setSort}
              style={{ width: 150 }}
              options={[
                { value: 'new', label: 'Newest' },
                { value: 'level', label: 'Highest level' },
                { value: 'diamonds', label: 'Most diamonds' },
                { value: 'beans', label: 'Most beans' },
              ]}
            />
          </Space>
        }
        columns={[
          {
            title: 'User',
            key: 'user',
            render: (_, u) => (
              <UserCell
                user={{
                  id: u._id,
                  shortId: u.shortId,
                  displayName: u.displayName,
                  avatarUrl: u.avatarUrl,
                  level: u.level.level,
                  vipTier: u.vip.tier,
                }}
              />
            ),
          },
          {
            title: 'Status',
            key: 'status',
            render: (_, u) => (
              <Space size={4} wrap>
                <StatusTag status={u.status} />
                {u.isAgent && <Tag color="purple">agent</Tag>}
                {u.adminRole && <Tag color="gold">{u.adminRole}</Tag>}
                {u.liveRoomId && <Tag color="volcano">live</Tag>}
              </Space>
            ),
          },
          {
            title: 'Diamonds',
            key: 'd',
            align: 'right',
            render: (_, u) => <Money value={u.wallet.diamonds} unit="diamonds" />,
          },
          {
            title: 'Beans',
            key: 'b',
            align: 'right',
            render: (_, u) => <Money value={u.wallet.beans} unit="beans" />,
          },
          ...(agentsOnly
            ? [
                {
                  title: 'Agent stock',
                  key: 'stock',
                  align: 'right' as const,
                  render: (_: unknown, u: AdminUser) => (
                    <Money value={u.wallet.agentStock} unit="diamonds" />
                  ),
                },
              ]
            : []),
          { title: 'Country', dataIndex: 'country', render: (c: string | null) => c ?? '—' },
          { title: 'Joined', dataIndex: 'createdAt', render: ago },
          { title: 'Last seen', dataIndex: 'lastSeenAt', render: ago },
        ]}
      />
    </>
  );
}
