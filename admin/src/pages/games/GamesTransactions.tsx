import { useState } from 'react';
import dayjs from 'dayjs';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  Select,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  GAME_TX_KINDS,
  GAME_TX_STATUSES,
  type GameTransaction,
  type GameTxKind,
  type GameTxStatus,
} from '@bigboss/shared';
import { get } from '../../lib/api';
import { dateTime, downloadCsv, num } from '../../lib/format';
import { useIsMobile } from '../../lib/responsive';
import { FilterBar, UserCell } from '../../components/common';
import {
  GAMES_KEY,
  GAMES_TX_KEY,
  KIND_LABELS,
  STATUS_COLORS,
  type GamesCatalogResponse,
} from './gamesApi';

interface Filters {
  user?: string;
  gameId?: string;
  kind?: GameTxKind;
  status?: GameTxStatus;
  roundId?: string;
  from?: string;
  to?: string;
}

function Amount({ t }: { t: GameTransaction }) {
  const sign = t.type === 'debit' ? '−' : '+';
  const muted = t.applied === 0;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', opacity: muted ? 0.5 : 1 }}>
      {sign}
      {num(t.applied)} 💎
      {t.applied !== t.requested && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {' '}
          of {num(t.requested)}
        </Typography.Text>
      )}
    </span>
  );
}

/** Every AsadSoft wallet call, newest first, with the full record in a drawer. */
export function GamesTransactions({ initialUser }: { initialUser?: string }) {
  const mobile = useIsMobile();
  const [filters, setFilters] = useState<Filters>(initialUser ? { user: initialUser } : {});
  const [userInput, setUserInput] = useState(initialUser ?? '');
  const [roundInput, setRoundInput] = useState('');
  const [open, setOpen] = useState<GameTransaction | null>(null);
  const catalog = useQuery({
    queryKey: GAMES_KEY,
    queryFn: () => get<GamesCatalogResponse>('/admin/games'),
  });

  const q = useInfiniteQuery({
    queryKey: [...GAMES_TX_KEY, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      get<{ items: GameTransaction[]; nextCursor: string | null }>('/admin/games/transactions', {
        ...filters,
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <>
      <Card
        variant="borderless"
        styles={{ body: { padding: 0 } }}
        title={
          <FilterBar>
            <Input.Search
              placeholder="User short ID or uid"
              allowClear
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              onSearch={(v) => set({ user: v.trim() || undefined })}
              style={{ width: 200 }}
            />
            <Select
              allowClear
              placeholder="Game"
              value={filters.gameId}
              onChange={(gameId) => set({ gameId })}
              options={(catalog.data?.items ?? []).map((g) => ({ value: g.gameId, label: g.name }))}
              style={{ width: 170 }}
            />
            <Select
              allowClear
              placeholder="Kind"
              value={filters.kind}
              onChange={(kind) => set({ kind })}
              options={GAME_TX_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
              style={{ width: 150 }}
            />
            <Select
              allowClear
              placeholder="Status"
              value={filters.status}
              onChange={(status) => set({ status })}
              options={GAME_TX_STATUSES.map((s) => ({ value: s, label: s }))}
              style={{ width: 120 }}
            />
            <Input.Search
              placeholder="Round id"
              allowClear
              value={roundInput}
              onChange={(e) => setRoundInput(e.target.value)}
              onSearch={(v) => set({ roundId: v.trim() || undefined })}
              style={{ width: 180 }}
            />
            <DatePicker.RangePicker
              showTime
              onChange={(v) =>
                set({
                  from: v?.[0]?.toISOString(),
                  to: v?.[1]?.toISOString(),
                })
              }
            />
            <Button
              disabled={rows.length === 0}
              onClick={() =>
                downloadCsv(
                  `game-transactions-${dayjs().format('YYYYMMDD-HHmm')}.csv`,
                  rows.map((t) => ({
                    time: t.createdAt,
                    txId: t.txId,
                    type: t.type,
                    kind: t.kind,
                    status: t.status,
                    uid: t.uid,
                    shortId: t.user?.shortId ?? '',
                    gameId: t.gameId,
                    roundId: t.roundId,
                    refTxId: t.refTxId,
                    requested: t.requested,
                    applied: t.applied,
                    shortfall: t.shortfall,
                    balanceAfter: t.balanceAfter,
                    code: t.code,
                  })),
                )
              }
            >
              Export loaded rows
            </Button>
          </FilterBar>
        }
      >
        {q.error && (
          <Alert
            type="error"
            showIcon
            message={(q.error as Error).message}
            style={{ margin: 16 }}
          />
        )}
        <Table<GameTransaction>
          rowKey="txId"
          size={mobile ? 'small' : 'middle'}
          loading={q.isFetching && !q.isFetchingNextPage}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 'max-content' }}
          onRow={(t) => ({ onClick: () => setOpen(t), style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Time', render: (_, t) => dateTime(t.createdAt) },
            { title: 'Player', render: (_, t) => <UserCell user={t.user} fallbackId={t.uid} /> },
            { title: 'Game', render: (_, t) => t.gameId ?? '—' },
            { title: 'Kind', render: (_, t) => KIND_LABELS[t.kind] },
            { title: 'Amount', align: 'right', render: (_, t) => <Amount t={t} /> },
            {
              title: 'Balance after',
              align: 'right',
              render: (_, t) => (t.balanceAfter === null ? '—' : num(t.balanceAfter)),
            },
            {
              title: 'Status',
              render: (_, t) => (
                <>
                  <Tag color={STATUS_COLORS[t.status]}>{t.status}</Tag>
                  {t.code && <Typography.Text type="secondary">{t.code}</Typography.Text>}
                </>
              ),
            },
          ]}
        />
        <div style={{ padding: 16, textAlign: 'center' }}>
          {q.hasNextPage ? (
            <Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              Load more
            </Button>
          ) : (
            <Typography.Text type="secondary">
              {rows.length ? `${rows.length} transactions` : 'No transactions'}
            </Typography.Text>
          )}
        </div>
      </Card>

      <Drawer
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        width={mobile ? '100%' : 560}
        title="Wallet call"
      >
        {open && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="txId">
              <Typography.Text copyable code>
                {open.txId}
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Player">
              <UserCell user={open.user} fallbackId={open.uid} />
            </Descriptions.Item>
            <Descriptions.Item label="Call">
              {open.type} · {KIND_LABELS[open.kind]}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color={STATUS_COLORS[open.status]}>{open.status}</Tag> HTTP {open.httpStatus}
              {open.code ? ` · ${open.code}` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="Requested">{num(open.requested)} 💎</Descriptions.Item>
            <Descriptions.Item label="Applied">{num(open.applied)} 💎</Descriptions.Item>
            {open.shortfall > 0 && (
              <Descriptions.Item label="Shortfall">
                {num(open.shortfall)} 💎 (no longer held when clawed back)
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Balance after">
              {open.balanceAfter === null ? '—' : `${num(open.balanceAfter)} 💎`}
            </Descriptions.Item>
            <Descriptions.Item label="Game">{open.gameId ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Round">
              {open.roundId ? (
                <Typography.Link
                  onClick={() => {
                    setRoundInput(open.roundId!);
                    set({ roundId: open.roundId! });
                    setOpen(null);
                  }}
                >
                  {open.roundId}
                </Typography.Link>
              ) : (
                '—'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Provider round">{open.gameRoundId ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Session">{open.sessionId ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Reverses">{open.refTxId ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Reversed by">{open.reversedBy ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Description">{open.description ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Currency">{open.currency ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Time">{dateTime(open.createdAt)}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </>
  );
}
