import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Row,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bar,
  CartesianGrid,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { GameKey } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { dateTime, num, pct, short } from '../../lib/format';
import {
  ActionButton,
  PageHeader,
  StatCard,
  StatusTag,
  ToggleSwitch,
} from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { MediaUpload } from '../../components/MediaUpload';
import { useAuth } from '../../auth/useAuth';
import { brand } from '../../theme';

interface GameConfig {
  bettingSeconds: number;
  revealSeconds: number;
  minBet: number;
  maxBet: number;
  maxRoundStake: number;
  chips: number[];
  payouts: Record<string, number>;
  weights: Record<string, number>;
}

interface GameRow {
  _id: GameKey;
  name: string;
  enabled: boolean;
  url: string;
  iconUrl: string | null;
  sortOrder: number;
  config: GameConfig;
}

interface Analytics {
  daily: {
    date: string;
    staked: number;
    paid: number;
    bets: number;
    players: number;
    rtp: number;
    houseProfit: number;
  }[];
  totals: { staked: number; paid: number; houseProfit: number; rtp: number };
  theoreticalRtp: Record<string, number>;
}

function ConfigEditor({ game, canEdit }: { game: GameRow; canEdit: boolean }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [cfg, setCfg] = useState<GameConfig>(game.config);
  const options = Object.keys(cfg.payouts);
  const totalWeight = Object.values(cfg.weights).reduce((s, w) => s + w, 0);
  const rtp = (o: string) =>
    totalWeight ? ((cfg.weights[o] ?? 0) / totalWeight) * (cfg.payouts[o] ?? 0) : 0;
  const weighted = game._id !== 'teen_patti';

  const save = useMutation({
    mutationFn: () => send('put', `/admin/games/${game._id}/config`, cfg),
    onSuccess: () => {
      message.success('Config saved — applies from the next round');
      void qc.invalidateQueries({ queryKey: ['games'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const set = (patch: Partial<GameConfig>) => setCfg((c) => ({ ...c, ...patch }));

  return (
    <>
      <Row gutter={16}>
        {(['bettingSeconds', 'revealSeconds', 'minBet', 'maxBet', 'maxRoundStake'] as const).map(
          (k) => (
            <Col key={k} xs={12} md={8} style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {k.replace(/([A-Z])/g, ' $1').toLowerCase()}
              </Typography.Text>
              <InputNumber
                disabled={!canEdit}
                min={1}
                value={cfg[k]}
                onChange={(v) => set({ [k]: v ?? 1 })}
                style={{ width: '100%' }}
              />
            </Col>
          ),
        )}
        <Col xs={24} md={16} style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            chips
          </Typography.Text>
          <Select
            disabled={!canEdit}
            mode="tags"
            value={cfg.chips.map(String)}
            onChange={(v: string[]) =>
              set({
                chips: v
                  .map(Number)
                  .filter((n) => n > 0)
                  .sort((a, b) => a - b),
              })
            }
            style={{ width: '100%' }}
          />
        </Col>
      </Row>
      <Table
        size="small"
        rowKey="o"
        pagination={false}
        dataSource={options.map((o) => ({ o }))}
        columns={[
          { title: 'Option', dataIndex: 'o', render: (o: string) => <Tag color="gold">{o}</Tag> },
          {
            title: 'Payout ×',
            key: 'p',
            render: (_, { o }) => (
              <InputNumber
                disabled={!canEdit}
                min={1}
                step={0.1}
                value={cfg.payouts[o]}
                onChange={(v) => set({ payouts: { ...cfg.payouts, [o]: v ?? 1 } })}
              />
            ),
          },
          ...(weighted
            ? [
                {
                  title: 'Weight',
                  key: 'w',
                  render: (_: unknown, { o }: { o: string }) => (
                    <InputNumber
                      disabled={!canEdit}
                      min={0}
                      value={cfg.weights[o]}
                      onChange={(v) => set({ weights: { ...cfg.weights, [o]: v ?? 0 } })}
                    />
                  ),
                },
                {
                  title: 'Win chance',
                  key: 'c',
                  render: (_: unknown, { o }: { o: string }) =>
                    pct(totalWeight ? (cfg.weights[o] ?? 0) / totalWeight : 0, 2),
                },
                {
                  title: 'RTP',
                  key: 'r',
                  render: (_: unknown, { o }: { o: string }) => (
                    <span
                      style={{
                        color:
                          rtp(o) > 1
                            ? brand.palette.danger
                            : rtp(o) > 0.98
                              ? brand.palette.warning
                              : brand.palette.success,
                      }}
                    >
                      {pct(rtp(o), 2)}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {weighted && options.some((o) => rtp(o) > 1) && (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          message="An option pays out more than 100% — the server will refuse this config."
        />
      )}
      {canEdit && (
        <Space style={{ marginTop: 16 }}>
          <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save config
          </Button>
          <Button onClick={() => setCfg(game.config)}>Reset</Button>
        </Space>
      )}
    </>
  );
}

function AnalyticsPanel({ game }: { game: GameKey }) {
  const [days, setDays] = useState(14);
  const q = useQuery({
    queryKey: ['game-analytics', game, days],
    queryFn: () => get<Analytics>(`/admin/games/${game}/analytics`, { days }),
  });
  const t = q.data?.totals;
  const axis = { fontSize: 12, fill: brand.palette.inkMuted };
  return (
    <>
      <Segmented
        value={days}
        onChange={(v) => setDays(v as number)}
        options={[
          { label: '7d', value: 7 },
          { label: '14d', value: 14 },
          { label: '30d', value: 30 },
          { label: '90d', value: 90 },
        ]}
        style={{ marginBottom: 16 }}
      />
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <StatCard title="Staked" value={short(t?.staked ?? 0)} suffix="💎" />
        </Col>
        <Col xs={12} md={6}>
          <StatCard title="Paid out" value={short(t?.paid ?? 0)} suffix="💎" />
        </Col>
        <Col xs={12} md={6}>
          <StatCard gold title="House profit" value={short(t?.houseProfit ?? 0)} suffix="💎" />
        </Col>
        <Col xs={12} md={6}>
          <StatCard title="Actual RTP" value={pct(t?.rtp ?? 0, 2)} />
        </Col>
      </Row>
      <Card variant="borderless" style={{ marginTop: 16 }}>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={q.data?.daily ?? []}>
            <CartesianGrid stroke={brand.palette.border} vertical={false} />
            <XAxis dataKey="date" tick={axis} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis yAxisId="l" tick={axis} tickFormatter={short} />
            <YAxis
              yAxisId="r"
              orientation="right"
              tick={axis}
              tickFormatter={(v) => pct(Number(v), 0)}
              domain={[0, 1.2]}
            />
            <Tooltip formatter={(v, n) => (n === 'RTP' ? pct(Number(v), 2) : num(Number(v)))} />
            <Bar
              yAxisId="l"
              dataKey="staked"
              name="Staked"
              fill={brand.palette.champagneDeep}
              radius={[4, 4, 0, 0]}
            />
            <Bar
              yAxisId="l"
              dataKey="paid"
              name="Paid"
              fill={brand.palette.bronze}
              radius={[4, 4, 0, 0]}
            />
            <Line
              yAxisId="r"
              dataKey="rtp"
              name="RTP"
              stroke={brand.palette.goldDeep}
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>
    </>
  );
}

export function GamesPage() {
  const { can } = useAuth();
  const [openKey, setOpenKey] = useState<GameKey | null>(null);
  const q = useQuery({
    queryKey: ['games'],
    queryFn: () => get<{ items: GameRow[] }>('/admin/games'),
  });
  const open = q.data?.items.find((g) => g._id === openKey) ?? null;

  return (
    <>
      <PageHeader
        title="Games"
        subtitle="Server-authoritative, provably-fair mini-games (commit–reveal seeds)"
      />
      <Row gutter={[16, 16]}>
        {(q.data?.items ?? []).map((g) => (
          <Col key={g._id} xs={24} md={8}>
            <Card
              variant="borderless"
              hoverable
              onClick={() => setOpenKey(g._id)}
              style={{
                borderTop: `3px solid ${g.enabled ? brand.palette.gold : brand.palette.border}`,
              }}
            >
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Typography.Title
                    level={4}
                    style={{ margin: 0, fontFamily: brand.typography.display }}
                  >
                    {g.name}
                  </Typography.Title>
                  {g.enabled ? <Tag color="green">enabled</Tag> : <Tag>disabled</Tag>}
                </Space>
                <Typography.Text type="secondary">
                  {Object.keys(g.config.payouts).length} options · {g.config.bettingSeconds}s
                  betting · bets {num(g.config.minBet)}–{short(g.config.maxBet)}
                </Typography.Text>
                <Typography.Text code ellipsis style={{ maxWidth: '100%' }}>
                  {g.url}
                </Typography.Text>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
      <Drawer
        open={Boolean(open)}
        onClose={() => setOpenKey(null)}
        size={Math.min(900, window.innerWidth)}
        title={open?.name}
      >
        {open && (
          <Tabs
            items={[
              {
                key: 'settings',
                label: 'Settings',
                children: (
                  <>
                    <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
                      <Descriptions.Item label="Enabled">
                        <ToggleSwitch
                          disabled={!can('games.manage')}
                          checked={open.enabled}
                          onToggle={(enabled) =>
                            send('patch', `/admin/games/${open._id}`, { enabled })
                          }
                          invalidate={[['games']]}
                        />
                      </Descriptions.Item>
                      <Descriptions.Item label="Icon">
                        <GameIconEditor
                          game={open}
                          disabled={!can('games.manage')}
                          onSaved={() => void q.refetch()}
                        />
                      </Descriptions.Item>
                      <Descriptions.Item label="Hosted URL">
                        <Form
                          layout="inline"
                          initialValues={{ url: open.url }}
                          onFinish={(v: { url: string }) =>
                            send('patch', `/admin/games/${open._id}`, v).then(() => q.refetch())
                          }
                        >
                          <Form.Item
                            name="url"
                            rules={[{ type: 'url', required: true }]}
                            style={{ flex: 1, minWidth: 260 }}
                          >
                            <Input disabled={!can('games.manage')} />
                          </Form.Item>
                          {can('games.manage') && <Button htmlType="submit">Save</Button>}
                        </Form>
                      </Descriptions.Item>
                    </Descriptions>
                    <ConfigEditor
                      key={JSON.stringify(open.config)}
                      game={open}
                      canEdit={can('games.manage')}
                    />
                  </>
                ),
              },
              {
                key: 'analytics',
                label: 'Analytics',
                children: <AnalyticsPanel game={open._id} />,
              },
              {
                key: 'rounds',
                label: 'Rounds',
                children: (
                  <ServerTable<{
                    id: string;
                    roundNo: number;
                    status: string;
                    outcome: string | null;
                    staked: number;
                    payoutTotal: number;
                    betCount: number;
                    settlesAt: string;
                    serverSeedHash: string;
                  }>
                    queryKey="game-rounds"
                    url={`/admin/games/${open._id}/rounds`}
                    rowKey="id"
                    columns={[
                      { title: '#', dataIndex: 'roundNo' },
                      {
                        title: 'Status',
                        dataIndex: 'status',
                        render: (s: string) => <StatusTag status={s} />,
                      },
                      {
                        title: 'Outcome',
                        dataIndex: 'outcome',
                        render: (o: string | null) => (o ? <Tag color="gold">{o}</Tag> : '—'),
                      },
                      { title: 'Bets', dataIndex: 'betCount' },
                      { title: 'Staked', dataIndex: 'staked', render: num },
                      { title: 'Paid', dataIndex: 'payoutTotal', render: num },
                      { title: 'Settles', dataIndex: 'settlesAt', render: dateTime },
                      {
                        title: '',
                        key: 'v',
                        render: (_, r) =>
                          r.status !== 'settled' &&
                          can('games.manage') && (
                            <ActionButton
                              danger
                              label="Void & refund"
                              confirm="Refund every bet in this round?"
                              run={() => send('post', `/admin/games/rounds/${r.id}/void`)}
                              invalidate={[['game-rounds']]}
                            />
                          ),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        )}
      </Drawer>
      {!q.isLoading && !q.data?.items.length && (
        <Alert
          type="info"
          showIcon
          message="No games registered yet. They are created automatically when the API starts."
        />
      )}
    </>
  );
}

/** Game tile icon; saves as soon as a file is uploaded or removed. */
function GameIconEditor({
  game,
  disabled,
  onSaved,
}: {
  game: GameRow;
  disabled: boolean;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const save = useMutation({
    mutationFn: (iconUrl: string | null) => send('patch', `/admin/games/${game._id}`, { iconUrl }),
    onSuccess: () => {
      message.success('Icon saved');
      onSaved();
    },
    onError: (e: Error) => message.error(e.message),
  });
  return (
    <MediaUpload
      compact
      kind="game-icon"
      value={save.isPending ? save.variables : game.iconUrl}
      onChange={(url) => save.mutate(url)}
      disabled={disabled || save.isPending}
    />
  );
}
