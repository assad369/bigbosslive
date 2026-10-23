import { useState } from 'react';
import {
  Avatar,
  Descriptions,
  Drawer,
  List,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { LiveRoom } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { ago, dateTime, duration, num } from '../../lib/format';
import {
  ActionButton,
  Money,
  PageHeader,
  StatusTag,
  UserCell,
  type Brief,
} from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { useAuth } from '../../auth/useAuth';

type AdminRoom = LiveRoom & { endReason: string | null; giftCount: number; durationSec: number };

interface RoomDetail {
  room: LiveRoom & {
    livekitRoom: string;
    seats: { index: number; user: Brief | null; muted: boolean; locked: boolean }[];
    moderatorIds: string[];
  };
  viewers: Brief[];
  pk: {
    battle: {
      id: string;
      status: string;
      hosts: { uid: string; displayName: string; score: number }[];
    };
  } | null;
}

export function LivePage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<'live' | 'ended'>('live');
  const [type, setType] = useState<string | undefined>();
  const [open, setOpen] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['live-room', open],
    queryFn: () => get<RoomDetail>(`/admin/live/${open}`),
    enabled: Boolean(open),
    refetchInterval: 10_000,
  });

  return (
    <>
      <PageHeader
        title="Live rooms"
        subtitle={
          status === 'live'
            ? 'Rooms broadcasting right now, most-watched first'
            : 'Streaming history across the platform'
        }
      />
      <ServerTable<AdminRoom>
        queryKey="live"
        url="/admin/live"
        filters={{ status, type }}
        rowKey="id"
        toolbar={
          <Space wrap>
            <Segmented
              value={status}
              onChange={(v) => setStatus(v as 'live' | 'ended')}
              options={[
                { label: 'Live now', value: 'live' },
                { label: 'History', value: 'ended' },
              ]}
            />
            <Select
              allowClear
              placeholder="Type"
              value={type}
              onChange={setType}
              style={{ width: 120 }}
              options={[
                { value: 'video', label: 'Video' },
                { value: 'audio', label: 'Audio' },
              ]}
            />
          </Space>
        }
        columns={[
          {
            title: 'Room',
            key: 'room',
            render: (_, r) => (
              <Space>
                <Avatar shape="square" size={44} src={r.coverUrl ?? undefined} />
                <div>
                  <Typography.Text strong>{r.title}</Typography.Text>
                  <br />
                  <Space size={4}>
                    <Tag>{r.type}</Tag>
                    {r.pkBattleId && <Tag color="volcano">PK</Tag>}
                  </Space>
                </div>
              </Space>
            ),
          },
          { title: 'Host', key: 'host', render: (_, r) => <UserCell user={r.host} /> },
          {
            title: status === 'live' ? 'Viewers' : 'Peak',
            key: 'v',
            align: 'right',
            render: (_, r) => num(status === 'live' ? r.viewerCount : r.peakViewers),
          },
          {
            title: 'Earned',
            key: 'beans',
            align: 'right',
            render: (_, r) => <Money value={r.giftBeans} unit="beans" />,
          },
          { title: 'Duration', key: 'dur', render: (_, r) => duration(r.durationSec) },
          {
            title: status === 'live' ? 'Started' : 'Ended',
            key: 't',
            render: (_, r) => (status === 'live' ? ago(r.startedAt) : dateTime(r.endedAt)),
          },
          ...(status === 'ended'
            ? [
                {
                  title: 'End reason',
                  key: 'reason',
                  render: (_: unknown, r: AdminRoom) =>
                    r.endReason ? <StatusTag status={r.endReason} /> : '—',
                },
              ]
            : []),
          {
            title: '',
            key: 'actions',
            render: (_, r) => (
              <Space>
                <a onClick={() => setOpen(r.id)}>
                  <EyeOutlined /> Inspect
                </a>
                {status === 'live' && can('live.moderate') && (
                  <ActionButton
                    danger
                    label="End live"
                    confirm="Force-end this live room?"
                    run={() => send('post', `/admin/live/${r.id}/end`)}
                    invalidate={[['live']]}
                  />
                )}
              </Space>
            ),
          },
        ]}
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        size={520}
        title={detail.data?.room.title ?? 'Room'}
      >
        {detail.data && (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="Status">
                <StatusTag status={detail.data.room.status} />
              </Descriptions.Item>
              <Descriptions.Item label="Host">
                <UserCell user={detail.data.room.host} />
              </Descriptions.Item>
              <Descriptions.Item label="LiveKit room">
                <Typography.Text code copyable>
                  {detail.data.room.livekitRoom}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="Viewers">
                {num(detail.data.room.viewerCount)} (peak {num(detail.data.room.peakViewers)})
              </Descriptions.Item>
              <Descriptions.Item label="Started">
                {dateTime(detail.data.room.startedAt)}
              </Descriptions.Item>
              {detail.data.pk && (
                <Descriptions.Item label="PK">
                  {detail.data.pk.battle.hosts
                    .map((h) => `${h.displayName}: ${num(h.score)}`)
                    .join('  vs  ')}
                </Descriptions.Item>
              )}
            </Descriptions>
            <Typography.Title level={5} style={{ marginTop: 20 }}>
              Seats
            </Typography.Title>
            <List
              size="small"
              dataSource={detail.data.room.seats}
              renderItem={(s) => (
                <List.Item
                  extra={
                    <Space>
                      {s.muted && <Tag>muted</Tag>}
                      {s.locked && <Tag>locked</Tag>}
                    </Space>
                  }
                >
                  <Space>
                    <Tag>#{s.index}</Tag>
                    {s.user ? (
                      <UserCell user={s.user} />
                    ) : (
                      <Typography.Text type="secondary">empty</Typography.Text>
                    )}
                  </Space>
                </List.Item>
              )}
            />
            <Typography.Title level={5} style={{ marginTop: 20 }}>
              Viewers ({detail.data.viewers.length})
            </Typography.Title>
            <List
              size="small"
              dataSource={detail.data.viewers}
              renderItem={(v) => (
                <List.Item>
                  <UserCell user={v} />
                </List.Item>
              )}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
