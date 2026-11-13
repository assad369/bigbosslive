import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  Row,
  Space,
  Table,
  Typography,
} from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { GamePlayerSummary, GamesBlock, UserBrief } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { dateTime, num, pct } from '../../lib/format';
import { ActionButton, UserCell } from '../../components/common';
import { FormModal } from '../../components/FormModal';
import { useAuth } from '../../auth/useAuth';
import { GAMES_BLOCKED_KEY, GAMES_PLAYER_KEY, ggrColor } from './gamesApi';

const signed = (n: number) => (
  <span style={{ color: ggrColor(-n), fontWeight: 600 }}>
    {n > 0 ? '+' : ''}
    {num(n)} 💎
  </span>
);

/**
 * One player's games figures, with Block / Unblock. Used on the Players tab and on the user
 * page. `uid` may also be a short id.
 */
export function GamesPlayerCard({ uid, compact }: { uid: string; compact?: boolean }) {
  const { can } = useAuth();
  const [blocking, setBlocking] = useState(false);
  const q = useQuery({
    queryKey: [...GAMES_PLAYER_KEY, uid],
    queryFn: () => get<GamePlayerSummary>(`/admin/games/players/${encodeURIComponent(uid)}`),
    retry: false,
  });
  const p = q.data;
  const invalidate = [GAMES_PLAYER_KEY, GAMES_BLOCKED_KEY];

  return (
    <Card
      variant="borderless"
      title={compact ? 'Games' : p ? <UserCell user={p.user} fallbackId={p.uid} /> : 'Player'}
      loading={q.isLoading}
      extra={
        p &&
        can('games.block') &&
        (p.block ? (
          <ActionButton
            label="Unblock games"
            confirm="Let this player play games again?"
            run={() => send('delete', `/admin/users/${p.uid}/games-block`)}
            invalidate={invalidate}
            success="Unblocked"
          />
        ) : (
          <Button size="small" danger icon={<StopOutlined />} onClick={() => setBlocking(true)}>
            Block from games
          </Button>
        ))
      }
    >
      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      {p && (
        <>
          {p.block && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={`Blocked from games ${dateTime(p.block.at)}`}
              description={`${p.block.reason} (by ${p.block.by})`}
            />
          )}
          <Descriptions column={compact ? 1 : 2} size="small">
            <Descriptions.Item label="Player net, lifetime">
              {signed(p.lifetime.playerNet)}
            </Descriptions.Item>
            <Descriptions.Item label="Player net, today">
              {signed(p.today.playerNet)}
            </Descriptions.Item>
            <Descriptions.Item label="Turnover">{num(p.lifetime.turnover)} 💎</Descriptions.Item>
            <Descriptions.Item label="Payouts">{num(p.lifetime.payouts)} 💎</Descriptions.Item>
            <Descriptions.Item label="Cashback">{num(p.lifetime.cashback)} 💎</Descriptions.Item>
            <Descriptions.Item label="RTP">{pct(p.lifetime.rtp, 2)}</Descriptions.Item>
            <Descriptions.Item label="Stakes / wins">
              {num(p.lifetime.stakeCount)} / {num(p.lifetime.winCount)}
            </Descriptions.Item>
            <Descriptions.Item label="Last played">
              {dateTime(p.lifetime.lastPlayedAt)}
              {p.lifetime.lastGameId ? ` · ${p.lifetime.lastGameId}` : ''}
            </Descriptions.Item>
          </Descriptions>
        </>
      )}
      <FormModal<{ reason: string }>
        open={blocking}
        title="Block from games"
        onClose={() => setBlocking(false)}
        invalidate={invalidate}
        okText="Block"
        submit={(v) => send('post', `/admin/users/${p!.uid}/games-block`, v)}
      >
        {() => (
          <>
            <Typography.Paragraph type="secondary">
              Launching is refused and every new stake is refused at once; open games are closed.
              Wins and refunds already owed still pay.
            </Typography.Paragraph>
            <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 3, max: 200 }]}>
              <Input.TextArea rows={3} maxLength={200} showCount />
            </Form.Item>
          </>
        )}
      </FormModal>
    </Card>
  );
}

interface BlockedRow {
  uid: string;
  user: UserBrief | null;
  block: GamesBlock;
}

export function GamesPlayers() {
  const { can } = useAuth();
  const [lookup, setLookup] = useState<string | null>(null);
  const blocked = useInfiniteQuery({
    queryKey: GAMES_BLOCKED_KEY,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      get<{ items: BlockedRow[]; nextCursor: string | null }>('/admin/games/blocked', {
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = blocked.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={12}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Input.Search
            placeholder="Look up a player: short ID or uid"
            enterButton="Look up"
            allowClear
            onSearch={(v) => setLookup(v.trim() || null)}
          />
          {lookup ? (
            <GamesPlayerCard key={lookup} uid={lookup} />
          ) : (
            <Card variant="borderless">
              <Empty description="Look up a player to see their games P&L and block them" />
            </Card>
          )}
        </Space>
      </Col>
      <Col xs={24} xl={12}>
        <Card variant="borderless" title="Blocked from games" styles={{ body: { padding: 0 } }}>
          <Table<BlockedRow>
            rowKey="uid"
            size="small"
            loading={blocked.isFetching}
            dataSource={rows}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: 'Player', render: (_, r) => <UserCell user={r.user} fallbackId={r.uid} /> },
              { title: 'Reason', render: (_, r) => r.block.reason },
              { title: 'Since', render: (_, r) => dateTime(r.block.at) },
              {
                title: '',
                render: (_, r) =>
                  can('games.block') && (
                    <ActionButton
                      label="Unblock"
                      confirm="Let this player play games again?"
                      run={() => send('delete', `/admin/users/${r.uid}/games-block`)}
                      invalidate={[GAMES_BLOCKED_KEY, GAMES_PLAYER_KEY]}
                      success="Unblocked"
                    />
                  ),
              },
            ]}
          />
          {blocked.hasNextPage && (
            <div style={{ padding: 12, textAlign: 'center' }}>
              <Button
                loading={blocked.isFetchingNextPage}
                onClick={() => void blocked.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );
}
