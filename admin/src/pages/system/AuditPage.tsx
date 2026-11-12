import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import {
  Avatar,
  Button,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  BankOutlined,
  CloudServerOutlined,
  CrownOutlined,
  FileTextOutlined,
  FlagOutlined,
  GiftOutlined,
  MobileOutlined,
  NotificationOutlined,
  PictureOutlined,
  RiseOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShoppingOutlined,
  SkinOutlined,
  StopOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  TrophyOutlined,
  UserOutlined,
  VideoCameraOutlined,
  WalletOutlined,
  YoutubeOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { FilterBar, PageHeader, UserCell, type Brief } from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import {
  AUDIT_DOMAINS,
  ROLE_META,
  TONE_COLORS,
  actionOptions,
  describeAction,
  domainOf,
  formatScalar,
  humanizeKey,
  isScalar,
  roleLabel,
  targetLabel,
  type AuditTone,
} from '../../lib/audit';
import { ago } from '../../lib/format';
import { useIsMobile } from '../../lib/responsive';
import { brand } from '../../theme';

interface AuditRow {
  _id: string;
  adminId: string;
  adminRole: string;
  action: string;
  targetType: string;
  targetId: string | null;
  payload: unknown;
  ip: string;
  createdAt: string;
  /** The actor's profile; null for automated entries or a deleted account. */
  actor: Brief | null;
  /** The user the entry is about (its target, or the user its payload names). */
  subject: Brief | null;
}

const DOMAIN_ICONS: Record<string, ComponentType> = {
  user: UserOutlined,
  admin: SafetyCertificateOutlined,
  wallet: WalletOutlined,
  withdrawal: BankOutlined,
  moderator: StopOutlined,
  device: MobileOutlined,
  report: FlagOutlined,
  feed: FileTextOutlined,
  live: VideoCameraOutlined,
  youtube: YoutubeOutlined,
  pk: ThunderboltOutlined,
  gift: GiftOutlined,
  recharge_package: ShoppingOutlined,
  tier_package: CrownOutlined,
  cosmetic: SkinOutlined,
  levels: RiseOutlined,
  agency: TeamOutlined,
  game: TrophyOutlined,
  banner: PictureOutlined,
  announcement: NotificationOutlined,
  config: SettingOutlined,
  maintenance: ToolOutlined,
  storage: CloudServerOutlined,
  sightguard: RobotOutlined,
};

const FULL_TIME = 'ddd, D MMM YYYY · HH:mm:ss';
const tint = (hex: string, alpha = 0.12) =>
  `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
/** Long ids keep their ends: `6745f0…9a3c`. */
const shortenId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

// ── Cells ──────────────────────────────────────────────────────────────────────

function ActivityIcon({
  domain,
  tone,
  size = 36,
}: {
  domain: string;
  tone: AuditTone;
  size?: number;
}) {
  const Icon = DOMAIN_ICONS[domain] ?? AppstoreOutlined;
  const color = TONE_COLORS[tone];
  return (
    <span
      className="bb-audit-chip"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        color,
        background: tint(color),
        boxShadow: `inset 0 0 0 1px ${tint(color, 0.2)}`,
      }}
    >
      <Icon />
    </span>
  );
}

function RolePill({ role }: { role: string }) {
  const color = ROLE_META[role]?.color ?? brand.palette.inkMuted;
  return (
    <span className="bb-audit-pill" style={{ color, background: tint(color, 0.1) }}>
      {roleLabel(role)}
    </span>
  );
}

function WhenCell({ at }: { at: string }) {
  const d = dayjs(at);
  return (
    <Tooltip title={`${d.format(FULL_TIME)} (UTC${d.format('Z')})`}>
      <div style={{ lineHeight: 1.3, whiteSpace: 'nowrap' }}>
        <Typography.Text strong style={{ color: brand.palette.ink }}>
          {ago(at)}
        </Typography.Text>
        <br />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {d.format('D MMM YYYY, HH:mm')}
        </Typography.Text>
      </div>
    </Tooltip>
  );
}

function ActorCell({ row, showRole = true }: { row: AuditRow; showRole?: boolean }) {
  if (row.adminId === 'system')
    return (
      <Space size={10}>
        <Avatar
          size={32}
          icon={<RobotOutlined />}
          style={{ background: brand.palette.surfaceMuted, color: brand.palette.inkMuted }}
        />
        <div style={{ lineHeight: 1.25 }}>
          <Typography.Text strong style={{ color: brand.palette.ink }}>
            SightGuard
          </Typography.Text>
          <br />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Automated moderation
          </Typography.Text>
        </div>
      </Space>
    );
  return (
    <Space size={10} align="center">
      <UserCell user={row.actor} fallbackId={row.adminId} />
      {showRole && <RolePill role={row.adminRole} />}
    </Space>
  );
}

function TargetCell({ row }: { row: AuditRow }) {
  const isUser = row.targetType === 'user';
  const typed =
    !isUser && (row.targetId || !row.subject) ? (
      <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        {targetLabel(row.targetType)}
        {row.targetId && (
          <>
            {' · '}
            <span onClick={(e) => e.stopPropagation()}>
              <Typography.Text
                type="secondary"
                className="bb-mono"
                style={{ fontSize: 12 }}
                copyable={{ text: row.targetId, tooltips: ['Copy id', 'Copied'] }}
              >
                {shortenId(row.targetId)}
              </Typography.Text>
            </span>
          </>
        )}
      </Typography.Text>
    ) : null;
  if (row.subject)
    return (
      <div>
        <UserCell user={row.subject} />
        {typed && <div style={{ marginTop: 4 }}>{typed}</div>}
      </div>
    );
  if (isUser && row.targetId) return <UserCell user={null} fallbackId={row.targetId} />;
  return typed ?? <Typography.Text type="secondary">—</Typography.Text>;
}

function ActivityCell({ row, compact }: { row: AuditRow; compact?: boolean }) {
  const d = describeAction(row.action, row.payload);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minWidth: 0 }}>
      <ActivityIcon domain={d.domain} tone={d.tone} />
      <div style={{ minWidth: 0, lineHeight: 1.35 }}>
        <Typography.Text strong style={{ color: brand.palette.ink }}>
          {d.label}
        </Typography.Text>
        <div style={{ fontSize: 12, color: brand.palette.inkMuted }}>
          {d.summary ?? d.domainLabel}
        </div>
        {compact && (
          <div style={{ fontSize: 12, color: brand.palette.inkSubtle, marginTop: 2 }}>
            {row.adminId === 'system'
              ? 'SightGuard'
              : (row.actor?.displayName ?? shortenId(row.adminId))}
            {' · '}
            {roleLabel(row.adminRole)} · {ago(row.createdAt)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detail drawer ──────────────────────────────────────────────────────────────

function PayloadValue({ value }: { value: unknown }) {
  if (isScalar(value)) return <>{formatScalar(value)}</>;
  if (Array.isArray(value) && value.every(isScalar)) {
    if (!value.length) return <>—</>;
    return (
      <Space size={[4, 4]} wrap>
        {value.slice(0, 12).map((v, i) => (
          <Tag key={i} style={{ marginInlineEnd: 0 }}>
            {formatScalar(v)}
          </Tag>
        ))}
        {value.length > 12 && <Tag>+{value.length - 12} more</Tag>}
      </Space>
    );
  }
  return (
    <pre className="bb-audit-json" style={{ maxHeight: 180 }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function AuditDetail({ row, onClose }: { row: AuditRow | null; onClose: () => void }) {
  const mobile = useIsMobile();
  const d = row ? describeAction(row.action, row.payload) : null;
  const payload =
    row?.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? Object.entries(row.payload as Record<string, unknown>)
      : null;
  const json = row ? JSON.stringify(row.payload, null, 2) : '';
  const section = (title: string, body: ReactNode) => (
    <section style={{ marginTop: 24 }}>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.6, textTransform: 'uppercase' }}
      >
        {title}
      </Typography.Text>
      <div style={{ marginTop: 8 }}>{body}</div>
    </section>
  );

  return (
    <Drawer
      open={!!row}
      onClose={onClose}
      size={mobile ? '100%' : 560}
      title="Audit entry"
      destroyOnHidden
    >
      {row && d && (
        <>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <ActivityIcon domain={d.domain} tone={d.tone} size={48} />
            <div style={{ minWidth: 0 }}>
              <Typography.Title
                level={4}
                style={{ margin: 0, fontFamily: brand.typography.display }}
              >
                {d.label}
              </Typography.Title>
              <Typography.Text type="secondary">
                {d.domainLabel} · {ago(row.createdAt)}
              </Typography.Text>
            </div>
          </div>
          {d.summary && (
            <div
              style={{
                marginTop: 16,
                padding: '10px 14px',
                borderRadius: 10,
                background: brand.palette.surfaceMuted,
                color: brand.palette.ink,
              }}
            >
              {d.summary}
            </div>
          )}

          {section(
            'Overview',
            <Descriptions
              bordered
              size="small"
              column={1}
              styles={{ label: { width: 130, color: brand.palette.inkMuted } }}
              items={[
                {
                  key: 'by',
                  label: 'Performed by',
                  children: <ActorCell row={row} showRole={false} />,
                },
                { key: 'role', label: 'Role', children: <RolePill role={row.adminRole} /> },
                { key: 'target', label: 'Target', children: <TargetCell row={row} /> },
                {
                  key: 'when',
                  label: 'Time',
                  children: `${dayjs(row.createdAt).format(FULL_TIME)} (UTC${dayjs(row.createdAt).format('Z')})`,
                },
                {
                  key: 'action',
                  label: 'Action key',
                  children: (
                    <Typography.Text code copyable>
                      {row.action}
                    </Typography.Text>
                  ),
                },
                {
                  key: 'ip',
                  label: 'IP address',
                  children: row.ip ? (
                    <Typography.Text copyable className="bb-mono">
                      {row.ip}
                    </Typography.Text>
                  ) : (
                    '—'
                  ),
                },
                {
                  key: 'id',
                  label: 'Entry id',
                  children: (
                    <Typography.Text
                      type="secondary"
                      copyable
                      className="bb-mono"
                      style={{ fontSize: 12 }}
                    >
                      {row._id}
                    </Typography.Text>
                  ),
                },
              ]}
            />,
          )}

          {section(
            'Details',
            payload && payload.length ? (
              <Descriptions
                bordered
                size="small"
                column={1}
                styles={{ label: { width: 130, color: brand.palette.inkMuted } }}
                items={payload.map(([k, v]) => ({
                  key: k,
                  label: humanizeKey(k),
                  children: <PayloadValue value={v} />,
                }))}
              />
            ) : row.payload !== null && row.payload !== undefined ? (
              <PayloadValue value={row.payload} />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No additional details recorded"
              />
            ),
          )}

          {row.payload !== null && row.payload !== undefined && (
            <Collapse
              ghost
              style={{ marginTop: 16 }}
              items={[
                {
                  key: 'raw',
                  label: <Typography.Text type="secondary">Raw JSON</Typography.Text>,
                  extra: (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Typography.Text
                        copyable={{ text: json, tooltips: ['Copy JSON', 'Copied'] }}
                      />
                    </span>
                  ),
                  children: <pre className="bb-audit-json">{json}</pre>,
                },
              ]}
            />
          )}
        </>
      )}
    </Drawer>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

const DOMAIN_OPTIONS = Object.entries(AUDIT_DOMAINS).map(([value, label]) => {
  const Icon = DOMAIN_ICONS[value] ?? AppstoreOutlined;
  return {
    value,
    label: (
      <Space size={8}>
        <span style={{ color: brand.palette.bronze }}>
          <Icon />
        </span>
        {label}
      </Space>
    ),
    search: label.toLowerCase(),
  };
});

export function AuditPage() {
  const mobile = useIsMobile();
  const [domain, setDomain] = useState<string | undefined>();
  const [action, setAction] = useState<string | undefined>();
  const [actor, setActor] = useState('');
  const [actorDraft, setActorDraft] = useState('');
  const [actorKind, setActorKind] = useState<string | undefined>();
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [open, setOpen] = useState<AuditRow | null>(null);

  const actions = useMemo(() => {
    const groups = actionOptions();
    return domain ? groups.filter((g) => g.title === domain) : groups;
  }, [domain]);
  const filtered = !!(domain || action || actor || actorKind || range);
  const clear = () => {
    setDomain(undefined);
    setAction(undefined);
    setActor('');
    setActorDraft('');
    setActorKind(undefined);
    setRange(null);
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every change made by staff, platform moderators and automated moderation"
      />
      <ServerTable<AuditRow>
        queryKey="audit"
        url="/admin/audit"
        filters={{
          domain: action ? undefined : domain,
          action,
          adminId: actor || undefined,
          actorKind,
          from: range?.[0].startOf('day').toISOString(),
          to: range?.[1].endOf('day').toISOString(),
        }}
        rowKey="_id"
        rowClassName={() => 'bb-audit-row'}
        onRow={(r) => ({ onClick: () => setOpen(r) })}
        toolbar={
          <FilterBar>
            <Select
              allowClear
              showSearch={{
                filterOption: (input, o) => !!o?.search.includes(input.toLowerCase()),
              }}
              placeholder="All areas"
              style={{ width: 200 }}
              value={domain}
              options={DOMAIN_OPTIONS}
              onChange={(v?: string) => {
                setDomain(v);
                if (v && action && domainOf(action) !== v) setAction(undefined);
              }}
            />
            <Select
              allowClear
              showSearch={{ optionFilterProp: 'label' }}
              placeholder="Any action"
              style={{ width: 230 }}
              value={action}
              options={actions}
              onChange={setAction}
              popupMatchSelectWidth={280}
            />
            <Select
              allowClear
              placeholder="Anyone"
              style={{ width: 180 }}
              value={actorKind}
              onChange={setActorKind}
              options={[
                { value: 'staff', label: 'Staff' },
                { value: 'platform_moderator', label: 'Platform moderators' },
                { value: 'system', label: 'Automated' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder="Performed by (ID or uid)"
              style={{ width: 220 }}
              value={actorDraft}
              onChange={(e) => {
                setActorDraft(e.target.value);
                if (!e.target.value) setActor('');
              }}
              onSearch={(v) => setActor(v.trim())}
            />
            <DatePicker.RangePicker
              value={range}
              onChange={(v) => setRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
              allowEmpty={[false, false]}
              disabledDate={(d) => d.isAfter(dayjs(), 'day')}
              presets={[
                { label: 'Today', value: [dayjs(), dayjs()] },
                { label: 'Last 7 days', value: [dayjs().subtract(6, 'day'), dayjs()] },
                { label: 'Last 30 days', value: [dayjs().subtract(29, 'day'), dayjs()] },
                { label: 'This month', value: [dayjs().startOf('month'), dayjs()] },
              ]}
              style={{ width: 250 }}
            />
            {filtered && (
              <Button type="link" onClick={clear} style={{ paddingInline: 4 }}>
                Clear filters
              </Button>
            )}
          </FilterBar>
        }
        columns={
          mobile
            ? [
                {
                  title: 'Activity',
                  key: 'activity',
                  render: (_, r) => <ActivityCell row={r} compact />,
                },
              ]
            : [
                {
                  title: 'When',
                  dataIndex: 'createdAt',
                  width: 150,
                  render: (at: string) => <WhenCell at={at} />,
                },
                {
                  title: 'Activity',
                  key: 'activity',
                  render: (_, r) => <ActivityCell row={r} />,
                },
                {
                  title: 'Performed by',
                  key: 'actor',
                  render: (_, r) => <ActorCell row={r} />,
                },
                {
                  title: 'Target',
                  key: 'target',
                  render: (_, r) => <TargetCell row={r} />,
                },
              ]
        }
      />
      <AuditDetail row={open} onClose={() => setOpen(null)} />
    </>
  );
}
