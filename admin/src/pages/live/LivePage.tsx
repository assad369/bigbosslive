import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Avatar,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  List,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import { DownloadOutlined, EyeOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import type { LiveRoom, LiveSummary } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { ago, dateTime, diamonds, downloadCsv, duration, num } from '../../lib/format';
import {
  ActionButton,
  FilterBar,
  Money,
  PageHeader,
  StatusTag,
  UserCell,
  type Brief,
} from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { useIsMobile } from '../../lib/responsive';
import { useAuth } from '../../auth/useAuth';

type AdminRoom = LiveRoom & {
  endReason: string | null;
  endedBy: string | null;
  giftCount: number;
  durationSec: number;
  /** Null on rooms from before the counter existed. */
  totalJoins: number | null;
  uniqueViewers: number | null;
  chatMessages: number | null;
  reactions: number | null;
};

const END_REASONS: Record<string, string> = {
  host: 'Host ended it',
  admin: 'Ended by staff',
  stale: 'Connection lost',
  webhook: 'Host left',
  banned: 'Host banned',
  moderation: 'Content moderation',
  moderator: 'Ended by a moderator',
  camera_off: 'Camera off too long',
};

const count = (n: number | null | undefined) => (n === null || n === undefined ? '—' : num(n));

/** Start and end of a live, on two lines. */
function Span({ from, to }: { from: string; to: string | null }) {
  return (
    <div style={{ lineHeight: 1.25, whiteSpace: 'nowrap' }}>
      {dateTime(from)}
      <br />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        to {to ? dayjs(to).format(dayjs(to).isSame(from, 'day') ? 'HH:mm' : 'MM-DD HH:mm') : '—'}
      </Typography.Text>
    </div>
  );
}

/**
 * Ended lives, newest first: the platform's streaming history, or one host's (`hostId`).
 * Each row opens the post-live summary.
 */
export function LiveHistoryTable({
  hostId,
  compact,
  toolbar,
  filters,
}: {
  hostId?: string;
  /** Inside a user page: no host column. */
  compact?: boolean;
  toolbar?: ReactNode;
  filters?: Record<string, unknown>;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState<string | null>(null);
  const [rows, setRows] = useState<AdminRoom[]>([]);
  const summary = useQuery({
    queryKey: ['live-summary', open],
    queryFn: () => get<{ summary: LiveSummary }>(`/admin/live/${open}/summary`),
    enabled: Boolean(open),
  });
  const s = summary.data?.summary;

  const exportCsv = () =>
    downloadCsv(
      'live-history.csv',
      rows.map((r) => ({
        room: r.title,
        type: r.type,
        hostShortId: r.host?.shortId ?? '',
        hostName: r.host?.displayName ?? '',
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationMinutes: Math.round(r.durationSec / 60),
        peakViewers: r.peakViewers,
        uniqueViewers: r.uniqueViewers ?? '',
        joins: r.totalJoins ?? '',
        gifts: r.giftCount,
        hostDiamonds: r.giftDiamonds,
        chatMessages: r.chatMessages ?? '',
        reactions: r.reactions ?? '',
        endReason: r.endReason ? (END_REASONS[r.endReason] ?? r.endReason) : '',
      })),
    );

  return (
    <>
      <ServerTable<AdminRoom>
        queryKey="live-history"
        url="/admin/live"
        filters={{ status: 'ended', ...filters, ...(hostId ? { hostId } : {}) }}
        rowKey="id"
        onData={setRows}
        toolbar={
          <FilterBar>
            {toolbar}
            <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!rows.length}>
              Export page
            </Button>
          </FilterBar>
        }
        onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: 'Live',
            key: 'room',
            render: (_, r) => (
              <Space>
                <Avatar shape="square" size={40} src={r.coverUrl ?? undefined} />
                <div style={{ lineHeight: 1.3 }}>
                  <Typography.Text strong>{r.title || 'Untitled live'}</Typography.Text>
                  <br />
                  <Space size={4}>
                    <Tag color={r.type === 'audio' ? 'purple' : 'blue'}>
                      {r.type === 'audio' ? 'Audio' : 'Video'}
                    </Tag>
                    {r.pkBattleId && <Tag color="volcano">PK</Tag>}
                  </Space>
                </div>
              </Space>
            ),
          },
          ...(compact
            ? []
            : [
                {
                  title: 'Host',
                  key: 'host',
                  render: (_: unknown, r: AdminRoom) => <UserCell user={r.host} />,
                },
              ]),
          {
            title: 'When',
            key: 'when',
            render: (_, r) => <Span from={r.startedAt} to={r.endedAt} />,
          },
          { title: 'Duration', key: 'dur', render: (_, r) => duration(r.durationSec) },
          {
            title: 'Viewers',
            key: 'v',
            align: 'right',
            render: (_, r) => (
              <div style={{ lineHeight: 1.25 }}>
                {num(r.peakViewers)} peak
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {count(r.uniqueViewers)} unique · {count(r.totalJoins)} joins
                </Typography.Text>
              </div>
            ),
          },
          {
            title: 'Gifts to host',
            key: 'diamonds',
            align: 'right',
            render: (_, r) => (
              <div style={{ lineHeight: 1.25 }}>
                <Money value={r.giftDiamonds} unit="diamonds" />
                <br />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {num(r.giftCount)} gifts
                </Typography.Text>
              </div>
            ),
          },
          {
            title: 'Chat',
            key: 'chat',
            align: 'right',
            render: (_, r) => count(r.chatMessages),
          },
          {
            title: 'Ended because',
            key: 'reason',
            render: (_, r) =>
              r.endReason ? (
                <Tag color={r.endReason === 'host' ? 'default' : 'orange'}>
                  {END_REASONS[r.endReason] ?? r.endReason}
                </Tag>
              ) : (
                '—'
              ),
          },
        ]}
      />
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        size={mobile ? '100%' : 520}
        title={s?.title || 'Live summary'}
      >
        {summary.isLoading && <Skeleton active />}
        {s && (
          <>
            <Descriptions
              column={1}
              size="small"
              bordered
              layout={mobile ? 'vertical' : 'horizontal'}
            >
              <Descriptions.Item label="Type">
                {s.type === 'audio' ? 'Audio live' : 'Video live'}
              </Descriptions.Item>
              <Descriptions.Item label="Started">{dateTime(s.startedAt)}</Descriptions.Item>
              <Descriptions.Item label="Ended">
                {dateTime(s.endedAt)}
                {s.endReason ? ` · ${END_REASONS[s.endReason] ?? s.endReason}` : ''}
              </Descriptions.Item>
              <Descriptions.Item label="Duration">{duration(s.durationSec)}</Descriptions.Item>
              <Descriptions.Item label="Viewers">
                {num(s.audience.peakViewers)} peak · {count(s.audience.uniqueViewers)} unique ·{' '}
                {count(s.audience.totalJoins)} joins
              </Descriptions.Item>
              <Descriptions.Item label="New followers">
                {num(s.audience.newFollowers)}
              </Descriptions.Item>
              <Descriptions.Item label="Chat / reactions">
                {count(s.engagement.chatMessages)} messages · {count(s.engagement.reactions)}{' '}
                reactions
              </Descriptions.Item>
              <Descriptions.Item label="Gifts to host">
                <Money value={s.gifts.hostDiamonds} unit="diamonds" /> (host got{' '}
                <Money value={s.gifts.hostEarnings} unit="diamonds" />)
              </Descriptions.Item>
              <Descriptions.Item label="All gifts in room">
                <Money value={s.gifts.roomDiamonds} unit="diamonds" /> · {num(s.gifts.giftCount)}{' '}
                gifts from {num(s.gifts.gifters)} people
              </Descriptions.Item>
            </Descriptions>
            {!s.final && (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                Just ended: late gifts may still be counted.
              </Typography.Paragraph>
            )}
            <Typography.Title level={5} style={{ marginTop: 20 }}>
              Top gifters
            </Typography.Title>
            <List
              size="small"
              dataSource={s.gifts.topGifters}
              locale={{ emptyText: 'No gifts' }}
              renderItem={(g) => (
                <List.Item extra={<Money value={g.diamonds} unit="diamonds" />}>
                  <Space>
                    <Tag>#{g.rank}</Tag>
                    <UserCell user={g.user} />
                  </Space>
                </List.Item>
              )}
            />
            <Typography.Title level={5} style={{ marginTop: 20 }}>
              Top gifts
            </Typography.Title>
            <List
              size="small"
              dataSource={s.gifts.topGifts}
              locale={{ emptyText: 'No gifts' }}
              renderItem={(g) => (
                <List.Item extra={<Money value={g.diamonds} unit="diamonds" />}>
                  <Space>
                    <Avatar shape="square" src={g.gift.iconUrl ?? undefined}>
                      🎁
                    </Avatar>
                    {g.gift.name} × {num(g.count)}
                  </Space>
                </List.Item>
              )}
            />
          </>
        )}
      </Drawer>
    </>
  );
}

interface RoomDetail {
  room: LiveRoom & {
    livekitRoom: string;
    seats: {
      index: number;
      user: Brief | null;
      muted: boolean;
      videoMuted: boolean;
      locked: boolean;
    }[];
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
  const mobile = useIsMobile();
  // `?view=history&host=<uid>` (linked from gift history) opens one host's history.
  const [params] = useSearchParams();
  const [status, setStatus] = useState<'live' | 'ended'>(
    params.get('view') === 'history' ? 'ended' : 'live',
  );
  const [type, setType] = useState<string | undefined>();
  const [host, setHost] = useState(params.get('host') ?? '');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['live-room', open],
    queryFn: () => get<RoomDetail>(`/admin/live/${open}`),
    enabled: Boolean(open),
    refetchInterval: 10_000,
  });

  const filterBar = (
    <>
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
    </>
  );

  if (status === 'ended')
    return (
      <>
        <PageHeader
          title="Live rooms"
          subtitle="Streaming history: every ended live, newest first. Click a row for its summary."
        />
        <LiveHistoryTable
          filters={{
            type,
            hostId: host || undefined,
            from: range?.[0]?.startOf('day').toISOString(),
            to: range?.[1]?.endOf('day').toISOString(),
          }}
          toolbar={
            <>
              {filterBar}
              <Input.Search
                allowClear
                defaultValue={host}
                placeholder="Host short ID or uid"
                onSearch={(v) => setHost(v.trim())}
                style={{ width: 200 }}
              />
              <DatePicker.RangePicker
                onChange={(r) => setRange(r as [Dayjs | null, Dayjs | null] | null)}
              />
            </>
          }
        />
      </>
    );

  return (
    <>
      <PageHeader title="Live rooms" subtitle="Rooms broadcasting right now, most-watched first" />
      <ServerTable<AdminRoom>
        queryKey="live"
        url="/admin/live"
        filters={{ status, type }}
        rowKey="id"
        toolbar={<FilterBar>{filterBar}</FilterBar>}
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
                    {r.locked && <Tag>{r.hasPassword ? 'locked · password' : 'locked'}</Tag>}
                  </Space>
                </div>
              </Space>
            ),
          },
          { title: 'Host', key: 'host', render: (_, r) => <UserCell user={r.host} /> },
          {
            title: 'Viewers',
            key: 'v',
            align: 'right',
            render: (_, r) => num(r.viewerCount),
          },
          {
            title: 'Earned',
            key: 'diamonds',
            align: 'right',
            render: (_, r) => <Money value={r.giftDiamonds} unit="diamonds" />,
          },
          { title: 'Duration', key: 'dur', render: (_, r) => duration(r.durationSec) },
          { title: 'Started', key: 't', render: (_, r) => ago(r.startedAt) },
          {
            title: '',
            key: 'actions',
            render: (_, r) => (
              <Space>
                <a onClick={() => setOpen(r.id)}>
                  <EyeOutlined /> Inspect
                </a>
                {can('live.moderate') && (
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
        size={mobile ? '100%' : 520}
        title={detail.data?.room.title ?? 'Room'}
      >
        {detail.data && (
          <>
            <Descriptions
              column={1}
              size="small"
              bordered
              layout={mobile ? 'vertical' : 'horizontal'}
            >
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
                    .map((h) => `${h.displayName}: ${diamonds(h.score)}`)
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
                      {s.videoMuted && <Tag>camera off</Tag>}
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
