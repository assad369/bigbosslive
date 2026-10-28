import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Progress,
  Radio,
  Row,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CrownFilled,
  DollarOutlined,
  EditOutlined,
  StopOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { SHORT_ID_PATTERN, VIP_TIERS, vipTierLabel } from '@bigboss/shared';
import { get, newIdempotencyKey, send } from '../../lib/api';
import { ago, dateTime, duration, num } from '../../lib/format';
import { ActionButton, Money, PageHeader, StatusTag } from '../../components/common';
import { FormModal } from '../../components/FormModal';
import { useAuth } from '../../auth/useAuth';
import { brand } from '../../theme';
import type { AdminUser } from './UsersPage';

interface Detail {
  user: AdminUser & { bio: string };
  devices: { deviceId: string; platform: string | null; firstSeenAt: string; lastSeenAt: string }[];
  agencyMember: { agencyId: string; periodBeans: number; periodLiveSeconds: number } | null;
  levelProgress: {
    level: number;
    points: number;
    currentLevelPoints: number;
    nextLevelPoints: number | null;
    isMaxLevel: boolean;
  };
  liveRoom: { _id: string; title: string; viewerCount: number } | null;
}

interface LedgerRow {
  id: string;
  currency: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  refId: string | null;
  createdAt: string;
}

type Modal = 'ban' | 'recharge' | 'adjust' | 'vip' | 'shortId' | 'edit' | null;

export function UserDetailPage() {
  const { uid = '' } = useParams();
  const { can } = useAuth();
  const [modal, setModal] = useState<Modal>(null);
  const [currency, setCurrency] = useState<string | undefined>();
  const key = ['user', uid];
  const q = useQuery({ queryKey: key, queryFn: () => get<Detail>(`/admin/users/${uid}`) });
  const ledger = useQuery({
    queryKey: ['user-ledger', uid, currency],
    queryFn: () =>
      get<{ items: LedgerRow[] }>(`/admin/users/${uid}/ledger`, { limit: 100, currency }),
    enabled: can('wallet.read'),
  });

  if (q.isLoading) return <Skeleton active />;
  if (q.error) return <Alert type="error" showIcon message={(q.error as Error).message} />;
  const { user, devices, levelProgress, liveRoom, agencyMember } = q.data!;
  const invalidate = [key, ['users'], ['user-ledger', uid]];
  const progressPct =
    levelProgress.isMaxLevel || !levelProgress.nextLevelPoints
      ? 100
      : Math.round(
          ((levelProgress.points - levelProgress.currentLevelPoints) /
            (levelProgress.nextLevelPoints - levelProgress.currentLevelPoints)) *
            100,
        );

  return (
    <>
      <PageHeader
        title={user.displayName}
        subtitle={`ID ${user.shortId} · uid ${user._id}`}
        extra={
          <>
            {can('users.edit') && (
              <Button icon={<EditOutlined />} onClick={() => setModal('edit')}>
                Edit
              </Button>
            )}
            {can('wallet.adjust') && (
              <Button icon={<WalletOutlined />} onClick={() => setModal('recharge')}>
                Recharge
              </Button>
            )}
            {can('wallet.adjust') && (
              <Button icon={<DollarOutlined />} onClick={() => setModal('adjust')}>
                Adjust balance
              </Button>
            )}
            {can('users.moderate') &&
              (user.status === 'banned' ? (
                <ActionButton
                  size="middle"
                  label="Unban"
                  run={() => send('post', `/admin/users/${uid}/unban`)}
                  invalidate={invalidate}
                  confirm="Lift this ban?"
                />
              ) : (
                <Button danger icon={<StopOutlined />} onClick={() => setModal('ban')}>
                  Ban
                </Button>
              ))}
          </>
        }
      />
      {user.status === 'banned' && user.ban && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={`Banned: ${user.ban.reason}`}
          description={`By ${user.ban.by} on ${dateTime(user.ban.at)} · ${user.ban.until ? `until ${dateTime(user.ban.until)}` : 'permanent'}`}
        />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card variant="borderless">
            <Space orientation="vertical" align="center" style={{ width: '100%' }}>
              <Avatar
                size={88}
                src={user.avatarUrl ?? undefined}
                style={{ background: brand.gradients.gold, fontSize: 32 }}
              >
                {user.displayName[0]}
              </Avatar>
              <Space wrap style={{ justifyContent: 'center' }}>
                <StatusTag status={user.status} />
                {user.vip.tier > 0 && (
                  <Tag icon={<CrownFilled />} color="gold">
                    {vipTierLabel(user.vip.tier) ?? `Tier ${user.vip.tier}`}
                  </Tag>
                )}
                {user.isAgent && <Tag color="purple">Agent</Tag>}
                {user.adminRole && <Tag color="gold">{user.adminRole}</Tag>}
                {liveRoom && <Tag color="volcano">Live · {liveRoom.viewerCount} viewers</Tag>}
              </Space>
              <Typography.Text type="secondary">{user.bio || 'No bio'}</Typography.Text>
            </Space>
            <div style={{ marginTop: 20 }}>
              <Typography.Text strong>Level {levelProgress.level}</Typography.Text>
              <Progress
                percent={progressPct}
                strokeColor={{ from: brand.palette.goldLight, to: brand.palette.goldDeep }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {num(levelProgress.points)} pts
                {levelProgress.nextLevelPoints
                  ? ` / next at ${num(levelProgress.nextLevelPoints)}`
                  : ' · max level'}
              </Typography.Text>
            </div>
          </Card>
          <Card variant="borderless" title="Wallet" style={{ marginTop: 16 }}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="Diamonds">
                <Money value={user.wallet.diamonds} unit="diamonds" />
              </Descriptions.Item>
              <Descriptions.Item label="Beans">
                <Money value={user.wallet.beans} unit="beans" />
              </Descriptions.Item>
              <Descriptions.Item label="Agent stock">
                <Money value={user.wallet.agentStock} unit="diamonds" />
              </Descriptions.Item>
              <Descriptions.Item label="Total recharged">
                {num(user.stats.totalRecharged)}
              </Descriptions.Item>
              <Descriptions.Item label="Gifts received">
                {num(user.stats.totalReceived)}
              </Descriptions.Item>
              <Descriptions.Item label="Gifts sent">{num(user.stats.totalSent)}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={16}>
          <Card variant="borderless">
            <Tabs
              items={[
                {
                  key: 'profile',
                  label: 'Profile',
                  children: (
                    <>
                      <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered>
                        <Descriptions.Item label="Email">{user.email ?? '—'}</Descriptions.Item>
                        <Descriptions.Item label="Phone">{user.phone ?? '—'}</Descriptions.Item>
                        <Descriptions.Item label="Country">{user.country ?? '—'}</Descriptions.Item>
                        <Descriptions.Item label="Followers">
                          {num(user.stats.followers)}
                        </Descriptions.Item>
                        <Descriptions.Item label="Following">
                          {num(user.stats.following)}
                        </Descriptions.Item>
                        <Descriptions.Item label="Live time">
                          {duration(user.stats.liveSeconds)}
                        </Descriptions.Item>
                        <Descriptions.Item label="VIP expires">
                          {user.vip.expiresAt ? dateTime(user.vip.expiresAt) : '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="Agency">
                          {agencyMember
                            ? `${agencyMember.agencyId} · ${num(agencyMember.periodBeans)} beans this month`
                            : '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="Joined">
                          {dateTime(user.createdAt)}
                        </Descriptions.Item>
                        <Descriptions.Item label="Last seen">
                          {ago(user.lastSeenAt)}
                        </Descriptions.Item>
                      </Descriptions>
                      <Space wrap style={{ marginTop: 16 }}>
                        {can('users.edit') && (
                          <Button onClick={() => setModal('vip')}>Set VIP</Button>
                        )}
                        {can('users.edit') && (
                          <Button onClick={() => setModal('shortId')}>Change short ID</Button>
                        )}
                        {can('agents.manage') && (
                          <ActionButton
                            size="middle"
                            label={user.isAgent ? 'Remove agent role' : 'Make agent'}
                            run={() =>
                              send('post', `/admin/users/${uid}/agent`, { isAgent: !user.isAgent })
                            }
                            invalidate={invalidate}
                            confirm={
                              user.isAgent
                                ? 'Remove agent status?'
                                : 'Make this user a recharge agent?'
                            }
                          />
                        )}
                        {can('users.edit') && (
                          <ActionButton
                            size="middle"
                            label="Recalculate level"
                            run={() => send('post', `/admin/users/${uid}/level/recalculate`)}
                            invalidate={invalidate}
                          />
                        )}
                      </Space>
                    </>
                  ),
                },
                ...(can('wallet.read')
                  ? [
                      {
                        key: 'ledger',
                        label: 'Ledger',
                        children: (
                          <>
                            <Radio.Group
                              value={currency ?? 'all'}
                              onChange={(e) =>
                                setCurrency(e.target.value === 'all' ? undefined : e.target.value)
                              }
                              style={{ marginBottom: 12 }}
                            >
                              <Radio.Button value="all">All</Radio.Button>
                              <Radio.Button value="diamonds">Diamonds</Radio.Button>
                              <Radio.Button value="beans">Beans</Radio.Button>
                              <Radio.Button value="agent_stock">Agent stock</Radio.Button>
                            </Radio.Group>
                            <Table<LedgerRow>
                              size="small"
                              rowKey="id"
                              loading={ledger.isFetching}
                              dataSource={ledger.data?.items ?? []}
                              pagination={{ pageSize: 20 }}
                              scroll={{ x: 'max-content' }}
                              columns={[
                                { title: 'When', dataIndex: 'createdAt', render: dateTime },
                                {
                                  title: 'Reason',
                                  dataIndex: 'reason',
                                  render: (r: string) => <Tag>{r.replace(/_/g, ' ')}</Tag>,
                                },
                                { title: 'Currency', dataIndex: 'currency' },
                                {
                                  title: 'Change',
                                  dataIndex: 'delta',
                                  align: 'right',
                                  render: (d: number) => (
                                    <span
                                      style={{
                                        color: d < 0 ? brand.palette.danger : brand.palette.success,
                                        fontVariantNumeric: 'tabular-nums',
                                      }}
                                    >
                                      {d > 0 ? '+' : ''}
                                      {num(d)}
                                    </span>
                                  ),
                                },
                                {
                                  title: 'Balance',
                                  dataIndex: 'balanceAfter',
                                  align: 'right',
                                  render: num,
                                },
                                {
                                  title: 'Ref',
                                  dataIndex: 'refId',
                                  render: (r: string | null) => (
                                    <Typography.Text code copyable={Boolean(r)}>
                                      {r ?? '—'}
                                    </Typography.Text>
                                  ),
                                },
                              ]}
                            />
                          </>
                        ),
                      },
                    ]
                  : []),
                {
                  key: 'devices',
                  label: `Devices (${devices.length})`,
                  children: (
                    <Table
                      size="small"
                      rowKey="deviceId"
                      dataSource={devices}
                      pagination={false}
                      columns={[
                        {
                          title: 'Device',
                          dataIndex: 'deviceId',
                          render: (d: string) => (
                            <Typography.Text code copyable>
                              {d}
                            </Typography.Text>
                          ),
                        },
                        { title: 'Platform', dataIndex: 'platform' },
                        { title: 'First seen', dataIndex: 'firstSeenAt', render: dateTime },
                        { title: 'Last seen', dataIndex: 'lastSeenAt', render: ago },
                        ...(can('devices.ban')
                          ? [
                              {
                                title: '',
                                key: 'ban',
                                render: (_: unknown, d: { deviceId: string }) => (
                                  <ActionButton
                                    danger
                                    label="Ban device"
                                    confirm="Ban this device and every account that used it?"
                                    run={() =>
                                      send('post', '/admin/devices/bans', {
                                        deviceId: d.deviceId,
                                        reason: `Banned from user ${user.shortId}`,
                                        cascade: true,
                                      })
                                    }
                                    invalidate={invalidate}
                                  />
                                ),
                              },
                            ]
                          : []),
                      ]}
                    />
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <FormModal<{ reason: string; days: number | null }>
        open={modal === 'ban'}
        title="Ban user"
        onClose={() => setModal(null)}
        okText="Ban"
        initialValues={{ days: 7 }}
        invalidate={invalidate}
        submit={(v) => send('post', `/admin/users/${uid}/ban`, v)}
      >
        {() => (
          <>
            <Form.Item
              name="reason"
              label="Reason (shown to the user)"
              rules={[{ required: true, min: 3 }]}
            >
              <Input.TextArea rows={3} maxLength={300} showCount />
            </Form.Item>
            <Form.Item name="days" label="Duration">
              <Select
                options={[
                  { value: 1, label: '1 day' },
                  { value: 7, label: '7 days' },
                  { value: 30, label: '30 days' },
                  { value: 365, label: '1 year' },
                  { value: null, label: 'Permanent' },
                ]}
              />
            </Form.Item>
          </>
        )}
      </FormModal>

      <FormModal<{ diamonds: number; note: string }>
        open={modal === 'recharge'}
        title="Recharge diamonds"
        onClose={() => setModal(null)}
        okText="Recharge"
        invalidate={invalidate}
        submit={(v) =>
          send('post', `/admin/users/${uid}/recharge`, v, {
            'Idempotency-Key': newIdempotencyKey(),
          })
        }
      >
        {() => (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="Recharges count toward the user's level. Use “Adjust balance” for corrections."
            />
            <Form.Item name="diamonds" label="Diamonds" rules={[{ required: true }]}>
              <InputNumber min={1} max={1_000_000_000} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="note" label="Note / payment reference">
              <Input maxLength={300} />
            </Form.Item>
          </>
        )}
      </FormModal>

      <FormModal<{ currency: string; delta: number; note: string }>
        open={modal === 'adjust'}
        title="Adjust balance"
        onClose={() => setModal(null)}
        initialValues={{ currency: 'diamonds' }}
        invalidate={invalidate}
        submit={(v) => send('post', `/admin/users/${uid}/wallet/adjust`, v)}
      >
        {() => (
          <>
            <Form.Item name="currency" label="Currency" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'diamonds', label: 'Diamonds' },
                  { value: 'beans', label: 'Beans' },
                  { value: 'agent_stock', label: 'Agent stock' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="delta"
              label="Change (negative to deduct)"
              rules={[{ required: true }]}
            >
              <InputNumber style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="note" label="Reason" rules={[{ required: true, min: 3 }]}>
              <Input maxLength={300} />
            </Form.Item>
          </>
        )}
      </FormModal>

      <FormModal<{ tier: number; days: number }>
        open={modal === 'vip'}
        title="Set VIP"
        onClose={() => setModal(null)}
        initialValues={{ tier: user.vip.tier || 1, days: 30 }}
        invalidate={invalidate}
        submit={(v) => send('post', `/admin/users/${uid}/vip`, v)}
      >
        {() => (
          <>
            <Form.Item name="tier" label="Tier" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 0, label: 'None (remove VIP)' },
                  ...VIP_TIERS.map((t) => ({ value: t.tier, label: t.label })),
                ]}
              />
            </Form.Item>
            <Form.Item name="days" label="Days" rules={[{ required: true }]}>
              <InputNumber min={1} max={3650} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}
      </FormModal>

      <FormModal<{ shortId: string }>
        open={modal === 'shortId'}
        title="Change short ID"
        onClose={() => setModal(null)}
        initialValues={{ shortId: user.shortId }}
        invalidate={invalidate}
        submit={(v) => send('post', `/admin/users/${uid}/short-id`, v)}
      >
        {() => (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="If another user holds this ID, the two IDs are swapped."
            />
            <Form.Item
              name="shortId"
              label="Short ID"
              rules={[{ required: true, pattern: SHORT_ID_PATTERN, message: '3–12 digits' }]}
            >
              <Input />
            </Form.Item>
          </>
        )}
      </FormModal>

      <FormModal<{ displayName: string; bio: string }>
        open={modal === 'edit'}
        title="Edit profile"
        onClose={() => setModal(null)}
        initialValues={{ displayName: user.displayName, bio: user.bio }}
        invalidate={invalidate}
        submit={(v) => send('patch', `/admin/users/${uid}`, v)}
      >
        {() => (
          <>
            <Form.Item
              name="displayName"
              label="Display name"
              rules={[{ required: true, min: 2, max: 30 }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="bio" label="Bio">
              <Input.TextArea rows={3} maxLength={160} showCount />
            </Form.Item>
            <ActionButton
              label="Remove avatar"
              danger
              run={() => send('patch', `/admin/users/${uid}`, { avatarUrl: null })}
              invalidate={invalidate}
              confirm="Remove this user's avatar?"
            />
          </>
        )}
      </FormModal>
    </>
  );
}
