import { useState } from 'react';
import dayjs from 'dayjs';
import { Alert, Card, Col, DatePicker, Row, Segmented, Space, Table, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  GameMoney,
  GameStatsByGame,
  GameStatsDay,
  GameStatsOverview,
  GameStatsPeriod,
  GameTopPlayer,
} from '@bigboss/shared';
import { get } from '../../lib/api';
import { num, pct, short } from '../../lib/format';
import { useIsMobile } from '../../lib/responsive';
import { StatCard, UserCell } from '../../components/common';
import { brand } from '../../theme';
import { dayStr, GAMES_STATS_KEY, ggrColor } from './gamesApi';

const PERIODS = [
  { label: 'Today', value: 'today' },
  { label: 'Yesterday', value: 'yesterday' },
  { label: '7 days', value: 'last7Days' },
  { label: '30 days', value: 'last30Days' },
  { label: 'Custom', value: 'range' },
] as const;
type PeriodKey = (typeof PERIODS)[number]['value'];

function Diamonds({ value, signed }: { value: number; signed?: boolean }) {
  return (
    <span
      style={{
        color: signed ? ggrColor(value) : undefined,
        fontVariantNumeric: 'tabular-nums',
        fontWeight: signed ? 600 : undefined,
      }}
    >
      {signed && value > 0 ? '+' : ''}
      {num(value)} 💎
    </span>
  );
}

/** The six headline figures of one period. */
function MoneyCards({ m, players }: { m: GameMoney; players?: number }) {
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} md={8}>
        <StatCard
          gold
          title="Platform win / loss (GGR)"
          value={`${m.ggr > 0 ? '+' : ''}${num(m.ggr)}`}
          suffix="💎"
          hint="Turnover − payouts − cashback. Negative: players won."
        />
      </Col>
      <Col xs={12} md={4}>
        <StatCard
          title="Turnover"
          value={num(m.turnover)}
          suffix="💎"
          hint={`${num(m.stakeCount)} stakes`}
        />
      </Col>
      <Col xs={12} md={4}>
        <StatCard
          title="Payouts"
          value={num(m.payouts)}
          suffix="💎"
          hint={`${num(m.winCount)} wins`}
        />
      </Col>
      <Col xs={12} md={4}>
        <StatCard title="RTP" value={pct(m.rtp, 2)} hint={`Cashback ${num(m.cashback)} 💎`} />
      </Col>
      <Col xs={12} md={4}>
        <StatCard
          title="Players"
          value={players === undefined ? '—' : num(players)}
          hint={`Refunds ${short(m.refunds)} · claw-backs ${short(m.reversals)}`}
        />
      </Col>
    </Row>
  );
}

function TopPlayers({ from, to }: { from: string; to: string }) {
  const [side, setSide] = useState<'winners' | 'losers'>('winners');
  const q = useQuery({
    queryKey: [...GAMES_STATS_KEY, 'top', from, to, side],
    queryFn: () =>
      get<{ items: GameTopPlayer[] }>('/admin/games/stats/top-players', { from, to, side }),
  });
  return (
    <Card
      variant="borderless"
      title="Top players"
      extra={
        <Segmented
          size="small"
          value={side}
          onChange={(v) => setSide(v as 'winners' | 'losers')}
          options={[
            { label: 'Biggest winners', value: 'winners' },
            { label: 'Biggest losers', value: 'losers' },
          ]}
        />
      }
      styles={{ body: { padding: 0 } }}
    >
      <Table<GameTopPlayer>
        rowKey="uid"
        size="small"
        loading={q.isFetching}
        dataSource={q.data?.items ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: 'Player',
            render: (_, r) => <UserCell user={r.user} fallbackId={r.uid} />,
          },
          {
            title: 'Player net',
            align: 'right',
            render: (_, r) => <Diamonds value={r.playerNet} signed />,
          },
          { title: 'Turnover', align: 'right', render: (_, r) => num(r.turnover) },
          { title: 'Payouts', align: 'right', render: (_, r) => num(r.payouts) },
        ]}
      />
    </Card>
  );
}

export function GamesOverview() {
  const mobile = useIsMobile();
  const [period, setPeriod] = useState<PeriodKey>('today');
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(13, 'day'),
    dayjs(),
  ]);
  const custom = period === 'range';
  const rangeParams = { from: dayStr(range[0]), to: dayStr(range[1]) };

  const overview = useQuery({
    queryKey: [...GAMES_STATS_KEY, 'overview', custom ? rangeParams : null],
    queryFn: () =>
      get<GameStatsOverview>('/admin/games/stats/overview', custom ? rangeParams : undefined),
    refetchInterval: 60_000,
  });
  const o = overview.data;
  const current: GameStatsPeriod | null = o ? (custom ? o.range : o[period]) : null;
  const span = current ? { from: current.from, to: current.to } : rangeParams;

  const daily = useQuery({
    queryKey: [...GAMES_STATS_KEY, 'daily', rangeParams],
    queryFn: () => get<{ items: GameStatsDay[] }>('/admin/games/stats/daily', rangeParams),
  });
  const byGame = useQuery({
    queryKey: [...GAMES_STATS_KEY, 'by-game', span],
    queryFn: () =>
      get<{ items: (GameStatsByGame & { players: number })[] }>('/admin/games/stats/by-game', span),
    enabled: Boolean(current),
  });
  const axis = { fontSize: 12, fill: brand.palette.inkMuted };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {overview.error && (
        <Alert type="error" showIcon message={(overview.error as Error).message} />
      )}
      <Space wrap>
        <Segmented
          value={period}
          onChange={(v) => setPeriod(v as PeriodKey)}
          options={PERIODS.map((p) => ({ label: p.label, value: p.value }))}
        />
        <DatePicker.RangePicker
          allowClear={false}
          value={range}
          disabledDate={(d) => d.isAfter(dayjs(), 'day')}
          onChange={(v) => {
            if (v?.[0] && v[1]) setRange([v[0], v[1]]);
          }}
        />
        {o && (
          <Typography.Text type="secondary">
            {current ? `${current.from} → ${current.to}` : ''} · days in {o.timezone}
          </Typography.Text>
        )}
      </Space>

      {current && <MoneyCards m={current} players={current.players} />}

      {o && (
        <Row gutter={[16, 16]}>
          {(
            [
              ['Today', o.today],
              ['Yesterday', o.yesterday],
              ['Last 7 days', o.last7Days],
              ['Last 30 days', o.last30Days],
              ['All time', o.allTime],
            ] as const
          ).map(([label, m]) => (
            <Col key={label} xs={12} md={8} lg={4} flex={mobile ? undefined : 1}>
              <Card variant="borderless" size="small">
                <Typography.Text type="secondary">{label}</Typography.Text>
                <div style={{ fontSize: 18 }}>
                  <Diamonds value={m.ggr} signed />
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {short(m.turnover)} turnover · RTP {pct(m.rtp, 1)}
                </Typography.Text>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Card variant="borderless" title={`Daily · ${rangeParams.from} → ${rangeParams.to}`}>
        <ResponsiveContainer width="100%" height={mobile ? 220 : 300}>
          <ComposedChart data={daily.data?.items ?? []}>
            <CartesianGrid stroke={brand.palette.border} vertical={false} />
            <XAxis dataKey="day" tick={axis} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={axis} tickFormatter={short} />
            <Tooltip formatter={(v) => num(Number(v))} />
            <Bar
              dataKey="turnover"
              name="Turnover"
              fill={brand.palette.champagneDeep}
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="payouts"
              name="Payouts"
              fill={brand.palette.bronze}
              radius={[4, 4, 0, 0]}
            />
            <Line
              dataKey="ggr"
              name="GGR"
              stroke={brand.palette.goldDeep}
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card variant="borderless" title="By game" styles={{ body: { padding: 0 } }}>
            <Table
              rowKey="gameId"
              size="small"
              loading={byGame.isFetching}
              dataSource={byGame.data?.items ?? []}
              pagination={false}
              scroll={{ x: 'max-content' }}
              columns={[
                { title: 'Game', dataIndex: 'name' },
                { title: 'Players', align: 'right', render: (_, r) => num(r.players) },
                { title: 'Turnover', align: 'right', render: (_, r) => num(r.turnover) },
                { title: 'Payouts', align: 'right', render: (_, r) => num(r.payouts) },
                { title: 'Cashback', align: 'right', render: (_, r) => num(r.cashback) },
                { title: 'RTP', align: 'right', render: (_, r) => pct(r.rtp, 2) },
                {
                  title: 'GGR',
                  align: 'right',
                  render: (_, r) => <Diamonds value={r.ggr} signed />,
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <TopPlayers from={span.from} to={span.to} />
        </Col>
      </Row>
      {current && (current.transfersIn > 0 || current.transfersOut > 0) && (
        <Alert
          type="info"
          showIcon
          message={`Game wallet transfers: ${num(current.transfersIn)} 💎 in, ${num(current.transfersOut)} 💎 out. Diamonds held in game wallets are custody, not revenue.`}
        />
      )}
    </Space>
  );
}
