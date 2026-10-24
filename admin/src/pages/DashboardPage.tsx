import { Card, Col, Row, Segmented, Skeleton } from 'antd';
import {
  AlertOutlined,
  BankOutlined,
  GiftOutlined,
  TeamOutlined,
  UserAddOutlined,
  VideoCameraOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { get } from '../lib/api';
import { num, short } from '../lib/format';
import { PageHeader, StatCard } from '../components/common';
import { brand } from '../theme';

interface Overview {
  users: { total: number; newToday: number; activeDay: number };
  live: { rooms: number; viewers: number };
  economy: { rechargedToday: number; giftsToday: number };
  queues: { pendingWithdrawals: number; openReports: number };
  network: { agents: number; agencies: number };
}

interface Point {
  date: string;
  signups: number;
  recharged: number;
  gifts: number;
  lives: number;
}

const axis = { fontSize: 12, fill: brand.palette.inkMuted };

export function DashboardPage() {
  const [days, setDays] = useState(30);
  const overview = useQuery({
    queryKey: ['stats', 'overview'],
    queryFn: () => get<Overview>('/admin/stats/overview'),
    refetchInterval: 30_000,
  });
  const series = useQuery({
    queryKey: ['stats', 'series', days],
    queryFn: () => get<{ items: Point[] }>('/admin/stats/series', { days }),
  });
  const o = overview.data;
  const data = (series.data?.items ?? []).map((p) => ({ ...p, label: p.date.slice(5) }));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Live pulse of the platform — refreshes every 30 seconds"
      />
      {!o ? (
        <Skeleton active />
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={12} xl={6}>
            <StatCard
              gold
              title="Live right now"
              value={o.live.rooms}
              icon={<VideoCameraOutlined />}
              hint={`${num(o.live.viewers)} viewers watching`}
            />
          </Col>
          <Col xs={12} xl={6}>
            <StatCard
              title="Users"
              value={short(o.users.total)}
              icon={<TeamOutlined />}
              hint={`${num(o.users.activeDay)} active in 24h`}
            />
          </Col>
          <Col xs={12} xl={6}>
            <StatCard
              title="New today"
              value={o.users.newToday}
              icon={<UserAddOutlined />}
              hint={`${num(o.network.agents)} agents · ${num(o.network.agencies)} agencies`}
            />
          </Col>
          <Col xs={12} xl={6}>
            <StatCard
              title="Recharged today"
              value={short(o.economy.rechargedToday)}
              suffix="💎"
              icon={<WalletOutlined />}
              hint="UTC day"
            />
          </Col>
          <Col xs={12} xl={6}>
            <StatCard
              title="Gifted today"
              value={short(o.economy.giftsToday)}
              suffix="💎"
              icon={<GiftOutlined />}
            />
          </Col>
          <Col xs={12} xl={6}>
            <StatCard
              title="Pending withdrawals"
              value={o.queues.pendingWithdrawals}
              icon={<BankOutlined />}
            />
          </Col>
          <Col xs={12} xl={6}>
            <StatCard title="Open reports" value={o.queues.openReports} icon={<AlertOutlined />} />
          </Col>
        </Row>
      )}

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={14}>
          <Card
            variant="borderless"
            title="Diamond flow"
            extra={
              <Segmented
                size="small"
                value={days}
                onChange={(v) => setDays(v as number)}
                options={[
                  { label: '7d', value: 7 },
                  { label: '30d', value: 30 },
                  { label: '90d', value: 90 },
                ]}
              />
            }
          >
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="gRecharge" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={brand.palette.gold} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={brand.palette.gold} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gGifts" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={brand.palette.bronze} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={brand.palette.bronze} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={brand.palette.border} vertical={false} />
                <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
                <YAxis
                  tick={axis}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={short}
                  width={48}
                />
                <Tooltip formatter={(v) => num(Number(v))} />
                <Area
                  type="monotone"
                  dataKey="recharged"
                  name="Recharged"
                  stroke={brand.palette.goldDeep}
                  fill="url(#gRecharge)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="gifts"
                  name="Gifted"
                  stroke={brand.palette.bronze}
                  fill="url(#gGifts)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card variant="borderless" title="Signups & live sessions">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid stroke={brand.palette.border} vertical={false} />
                <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
                <YAxis tick={axis} tickLine={false} axisLine={false} width={36} />
                <Tooltip />
                <Bar
                  dataKey="signups"
                  name="Signups"
                  fill={brand.palette.goldDeep}
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="lives"
                  name="Live sessions"
                  fill={brand.palette.champagneDeep}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>
    </>
  );
}
