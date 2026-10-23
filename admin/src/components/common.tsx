import type { ReactNode } from 'react';
import {
  App,
  Avatar,
  Button,
  Card,
  Popconfirm,
  Space,
  Statistic,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { CrownFilled } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { brand } from '../theme';

export function PageHeader({
  title,
  subtitle,
  extra,
}: {
  title: string;
  subtitle?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        marginBottom: 20,
      }}
    >
      <div>
        <Typography.Title level={3} style={{ margin: 0, fontFamily: brand.typography.display }}>
          {title}
        </Typography.Title>
        {subtitle && <Typography.Text type="secondary">{subtitle}</Typography.Text>}
      </div>
      {extra && <Space wrap>{extra}</Space>}
    </div>
  );
}

export function StatCard({
  title,
  value,
  icon,
  hint,
  suffix,
  gold,
}: {
  title: string;
  value: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  suffix?: ReactNode;
  gold?: boolean;
}) {
  return (
    <Card
      variant="borderless"
      style={{
        height: '100%',
        boxShadow: '0 1px 2px rgba(43,33,24,0.06), 0 4px 16px rgba(43,33,24,0.04)',
        ...(gold ? { background: brand.gradients.gold, color: brand.palette.ink } : {}),
      }}
    >
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
        <Statistic
          title={
            <span style={gold ? { color: brand.palette.bronzeDeep } : undefined}>{title}</span>
          }
          value={value as number}
          suffix={suffix}
          styles={{ content: { fontWeight: 600, ...(gold ? { color: brand.palette.ink } : {}) } }}
        />
        {icon && (
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              display: 'grid',
              placeItems: 'center',
              fontSize: 18,
              background: gold ? 'rgba(255,255,255,0.35)' : brand.palette.champagne,
              color: brand.palette.bronzeDeep,
            }}
          >
            {icon}
          </div>
        )}
      </Space>
      {hint && (
        <div
          style={{
            marginTop: 6,
            fontSize: 12,
            color: gold ? brand.palette.bronzeDeep : brand.palette.inkMuted,
          }}
        >
          {hint}
        </div>
      )}
    </Card>
  );
}

export interface Brief {
  id: string;
  shortId?: string;
  displayName?: string;
  avatarUrl?: string | null;
  level?: number;
  vipTier?: number;
}

export function UserCell({
  user,
  fallbackId,
}: {
  user: Brief | null | undefined;
  fallbackId?: string;
}) {
  if (!user) return <Typography.Text type="secondary">{fallbackId ?? '—'}</Typography.Text>;
  return (
    <Link to={`/users/${user.id}`}>
      <Space size={10}>
        <Avatar
          src={user.avatarUrl ?? undefined}
          size={32}
          style={{ background: brand.palette.champagneDeep, color: brand.palette.bronzeDeep }}
        >
          {user.displayName?.[0]?.toUpperCase()}
        </Avatar>
        <div style={{ lineHeight: 1.25 }}>
          <Typography.Text strong style={{ color: brand.palette.ink }}>
            {user.displayName}
          </Typography.Text>
          <br />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            ID {user.shortId}
            {user.level ? ` · Lv ${user.level}` : ''}
          </Typography.Text>
          {user.vipTier ? (
            <Tooltip title={`VIP ${user.vipTier}`}>
              <CrownFilled style={{ color: brand.palette.gold, marginLeft: 6 }} />
            </Tooltip>
          ) : null}
        </div>
      </Space>
    </Link>
  );
}

const STATUS_COLORS: Record<string, string> = {
  active: 'green',
  live: 'gold',
  pending: 'orange',
  approved: 'blue',
  paid: 'green',
  rejected: 'red',
  banned: 'red',
  deleted: 'default',
  ended: 'default',
  open: 'orange',
  resolved: 'green',
  dismissed: 'default',
  hidden: 'orange',
  removed: 'red',
  suspended: 'red',
  betting: 'gold',
  locked: 'blue',
  settled: 'green',
  queued: 'default',
  sending: 'blue',
  sent: 'green',
  failed: 'red',
  cancelled: 'default',
  expired: 'default',
};

export function StatusTag({ status }: { status: string }) {
  return <Tag color={STATUS_COLORS[status] ?? 'default'}>{status.replace(/_/g, ' ')}</Tag>;
}

/**
 * A button that runs a mutation (optionally behind a confirm), shows the outcome, and
 * invalidates the given queries.
 */
export function ActionButton({
  label,
  run,
  invalidate = [],
  confirm,
  danger,
  type = 'default',
  size = 'small',
  icon,
  disabled,
  success = 'Done',
}: {
  label: ReactNode;
  run: () => Promise<unknown>;
  invalidate?: QueryKey[];
  confirm?: string;
  danger?: boolean;
  type?: 'default' | 'primary' | 'link' | 'text';
  size?: 'small' | 'middle';
  icon?: ReactNode;
  disabled?: boolean;
  success?: string;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: run,
    onSuccess: async () => {
      message.success(success);
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    },
    onError: (err: Error) => message.error(err.message),
  });
  const button = (
    <Button
      size={size}
      type={type}
      danger={danger}
      icon={icon}
      loading={m.isPending}
      disabled={disabled}
      onClick={confirm ? undefined : () => m.mutate()}
    >
      {label}
    </Button>
  );
  if (!confirm) return button;
  return (
    <Popconfirm
      title={confirm}
      okText="Confirm"
      okButtonProps={{ danger }}
      onConfirm={() => m.mutateAsync().catch(() => undefined)}
    >
      {button}
    </Popconfirm>
  );
}

/** A switch that persists its new value through a mutation and refreshes the given queries. */
export function ToggleSwitch({
  checked,
  onToggle,
  invalidate = [],
  disabled,
}: {
  checked: boolean;
  onToggle: (next: boolean) => Promise<unknown>;
  invalidate?: QueryKey[];
  disabled?: boolean;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: onToggle,
    onSuccess: async (_d, next) => {
      message.success(next ? 'Enabled' : 'Disabled');
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    },
    onError: (err: Error) => message.error(err.message),
  });
  return (
    <Switch
      size="small"
      checked={checked}
      loading={m.isPending}
      disabled={disabled}
      onChange={(next) => m.mutate(next)}
    />
  );
}

export function Money({ value, unit }: { value: number; unit: 'diamonds' | 'beans' | 'usd' }) {
  const color =
    unit === 'diamonds'
      ? brand.palette.info
      : unit === 'beans'
        ? brand.palette.bronze
        : brand.palette.success;
  const text =
    unit === 'usd'
      ? `$${value.toFixed(2)}`
      : `${new Intl.NumberFormat('en-US').format(value)} ${unit === 'diamonds' ? '💎' : '🫘'}`;
  return <span style={{ color, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{text}</span>;
}
