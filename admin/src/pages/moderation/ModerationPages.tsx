import { useState } from 'react';
import { Button, Form, Image, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { PkBattle } from '@bigboss/shared';
import { send } from '../../lib/api';
import { ago, dateTime, num } from '../../lib/format';
import { ActionButton, PageHeader, StatusTag, UserCell, type Brief } from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { FormModal } from '../../components/FormModal';
import { useAuth } from '../../auth/useAuth';

// ── Reports ──────────────────────────────────────────────────────────────────────

interface ReportRow {
  _id: string;
  reporter: Brief | null;
  targetUser: Brief | null;
  targetType: string;
  targetId: string;
  reason: string;
  details: string;
  status: string;
  resolution: { by: string; action: string; note: string | null; at: string } | null;
  createdAt: string;
}

export function ReportsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<string | undefined>('open');
  const [targetType, setTargetType] = useState<string | undefined>();
  const [resolving, setResolving] = useState<ReportRow | null>(null);

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="User reports across profiles, rooms, posts and messages"
      />
      <ServerTable<ReportRow>
        queryKey="reports"
        url="/admin/reports"
        filters={{ status, targetType }}
        rowKey="_id"
        toolbar={
          <Space wrap>
            <Select
              allowClear
              placeholder="Status"
              value={status}
              onChange={setStatus}
              style={{ width: 130 }}
              options={['open', 'resolved', 'dismissed'].map((s) => ({ value: s, label: s }))}
            />
            <Select
              allowClear
              placeholder="Target"
              value={targetType}
              onChange={setTargetType}
              style={{ width: 130 }}
              options={['user', 'room', 'post', 'comment', 'message'].map((s) => ({
                value: s,
                label: s,
              }))}
            />
          </Space>
        }
        expandable={{
          expandedRowRender: (r) => (
            <Typography.Paragraph style={{ margin: 0 }}>
              {r.details || <i>No details</i>}
              {r.resolution && (
                <>
                  <br />
                  <b>Resolution:</b> {r.resolution.action} — {r.resolution.note ?? ''} (
                  {dateTime(r.resolution.at)})
                </>
              )}
            </Typography.Paragraph>
          ),
        }}
        columns={[
          { title: 'Reported', dataIndex: 'createdAt', render: ago },
          { title: 'Reporter', key: 'reporter', render: (_, r) => <UserCell user={r.reporter} /> },
          {
            title: 'Target',
            key: 'target',
            render: (_, r) =>
              r.targetUser ? (
                <UserCell user={r.targetUser} />
              ) : (
                <Space>
                  <Tag>{r.targetType}</Tag>
                  <Typography.Text code copyable>
                    {r.targetId}
                  </Typography.Text>
                </Space>
              ),
          },
          {
            title: 'Reason',
            dataIndex: 'reason',
            render: (r: string) => <Tag color="volcano">{r}</Tag>,
          },
          { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
          {
            title: '',
            key: 'a',
            render: (_, r) =>
              r.status === 'open' &&
              can('reports.resolve') && (
                <Button size="small" onClick={() => setResolving(r)}>
                  Resolve
                </Button>
              ),
          },
        ]}
      />
      <FormModal<{ status: string; action: string; note: string }>
        open={Boolean(resolving)}
        title="Resolve report"
        onClose={() => setResolving(null)}
        initialValues={{ status: 'resolved', action: 'warned' }}
        invalidate={[['reports']]}
        submit={(v) => send('post', `/admin/reports/${resolving!._id}/resolve`, v)}
      >
        {() => (
          <>
            <Form.Item name="status" label="Outcome" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'resolved', label: 'Resolved (action taken)' },
                  { value: 'dismissed', label: 'Dismissed (no violation)' },
                ]}
              />
            </Form.Item>
            <Form.Item name="action" label="Action" rules={[{ required: true }]}>
              <Select
                options={[
                  'warned',
                  'content_removed',
                  'user_banned',
                  'room_ended',
                  'no_action',
                ].map((a) => ({ value: a, label: a.replace(/_/g, ' ') }))}
              />
            </Form.Item>
            <Form.Item name="note" label="Internal note">
              <Input.TextArea rows={3} maxLength={500} />
            </Form.Item>
            <Typography.Text type="secondary">
              Ban users or end rooms from their detail pages; this records the decision.
            </Typography.Text>
          </>
        )}
      </FormModal>
    </>
  );
}

// ── Feed moderation ───────────────────────────────────────────────────────────────

interface PostRow {
  _id: string;
  author: Brief | null;
  text: string;
  media: { url: string; type: string }[];
  likeCount: number;
  commentCount: number;
  status: string;
  createdAt: string;
}

export function FeedModerationPage() {
  const [status, setStatus] = useState<string | undefined>('active');
  const setPost = (id: string, s: string) =>
    send('post', `/admin/feed/${id}/status`, { status: s });
  return (
    <>
      <PageHeader title="Feed moderation" subtitle="Review, hide or remove posts" />
      <ServerTable<PostRow>
        queryKey="feed"
        url="/admin/feed"
        filters={{ status }}
        rowKey="_id"
        toolbar={
          <Select
            allowClear
            placeholder="Status"
            value={status}
            onChange={setStatus}
            style={{ width: 130 }}
            options={['active', 'hidden', 'removed'].map((s) => ({ value: s, label: s }))}
          />
        }
        columns={[
          { title: 'Author', key: 'author', render: (_, p) => <UserCell user={p.author} /> },
          {
            title: 'Post',
            key: 'post',
            render: (_, p) => (
              <Space orientation="vertical" size={4} style={{ maxWidth: 420 }}>
                <Typography.Paragraph
                  ellipsis={{ rows: 3, expandable: true }}
                  style={{ margin: 0 }}
                >
                  {p.text}
                </Typography.Paragraph>
                {p.media.length > 0 && (
                  <Image.PreviewGroup>
                    <Space size={4}>
                      {p.media
                        .filter((m) => m.type === 'image')
                        .slice(0, 4)
                        .map((m) => (
                          <Image
                            key={m.url}
                            src={m.url}
                            width={56}
                            height={56}
                            style={{ objectFit: 'cover', borderRadius: 6 }}
                          />
                        ))}
                    </Space>
                  </Image.PreviewGroup>
                )}
              </Space>
            ),
          },
          {
            title: 'Engagement',
            key: 'eng',
            render: (_, p) => `❤ ${num(p.likeCount)} · 💬 ${num(p.commentCount)}`,
          },
          { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
          { title: 'Posted', dataIndex: 'createdAt', render: ago },
          {
            title: '',
            key: 'a',
            render: (_, p) => (
              <Space>
                {p.status !== 'active' && (
                  <ActionButton
                    label="Restore"
                    run={() => setPost(p._id, 'active')}
                    invalidate={[['feed']]}
                  />
                )}
                {p.status === 'active' && (
                  <ActionButton
                    label="Hide"
                    run={() => setPost(p._id, 'hidden')}
                    invalidate={[['feed']]}
                  />
                )}
                {p.status !== 'removed' && (
                  <ActionButton
                    danger
                    label="Remove"
                    confirm="Remove this post?"
                    run={() => setPost(p._id, 'removed')}
                    invalidate={[['feed']]}
                  />
                )}
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}

// ── Device bans ─────────────────────────────────────────────────────────────────

export function DeviceBansPage() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Device bans"
        subtitle="Banned devices cannot use the app on any account"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            Ban device
          </Button>
        }
      />
      <ServerTable<{ _id: string; reason: string; by: string; createdAt: string }>
        queryKey="device-bans"
        url="/admin/devices/bans"
        rowKey="_id"
        columns={[
          {
            title: 'Device',
            dataIndex: '_id',
            render: (d: string) => (
              <Typography.Text code copyable>
                {d}
              </Typography.Text>
            ),
          },
          { title: 'Reason', dataIndex: 'reason' },
          { title: 'By', dataIndex: 'by' },
          { title: 'When', dataIndex: 'createdAt', render: dateTime },
          {
            title: '',
            key: 'a',
            render: (_, d) => (
              <ActionButton
                label="Unban"
                confirm="Lift this device ban?"
                run={() => send('delete', `/admin/devices/bans/${encodeURIComponent(d._id)}`)}
                invalidate={[['device-bans']]}
              />
            ),
          },
        ]}
      />
      <FormModal<{ deviceId: string; reason: string; cascade: boolean }>
        open={open}
        title="Ban device"
        onClose={() => setOpen(false)}
        initialValues={{ cascade: true }}
        invalidate={[['device-bans']]}
        submit={(v) => send('post', '/admin/devices/bans', v)}
      >
        {() => (
          <>
            <Form.Item name="deviceId" label="Device ID" rules={[{ required: true, min: 6 }]}>
              <Input />
            </Form.Item>
            <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 3 }]}>
              <Input maxLength={300} />
            </Form.Item>
            <Form.Item
              name="cascade"
              label="Also ban every account seen on this device"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}

// ── PK battles ──────────────────────────────────────────────────────────────────

export function PkBattlesPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<string | undefined>();
  return (
    <>
      <PageHeader title="PK battles" subtitle="Host-vs-host gift battles" />
      <ServerTable<PkBattle>
        queryKey="pk"
        url="/admin/pk"
        filters={{ status }}
        rowKey="id"
        toolbar={
          <Select
            allowClear
            placeholder="Status"
            value={status}
            onChange={setStatus}
            style={{ width: 140 }}
            options={['pending', 'active', 'ended', 'rejected', 'cancelled', 'expired'].map(
              (s) => ({ value: s, label: s }),
            )}
          />
        }
        columns={[
          {
            title: 'Battle',
            key: 'hosts',
            render: (_, b) => (
              <Space>
                {b.hosts.map((h, i) => (
                  <Space key={h.uid}>
                    {i === 1 && <Typography.Text type="secondary">vs</Typography.Text>}
                    <Typography.Text
                      strong
                      style={{ color: b.winnerUid === h.uid ? '#B8860B' : undefined }}
                    >
                      {b.winnerUid === h.uid ? '👑 ' : ''}
                      {h.displayName}
                    </Typography.Text>
                    <Tag>{num(h.score)}</Tag>
                  </Space>
                ))}
              </Space>
            ),
          },
          { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
          {
            title: 'Duration',
            dataIndex: 'durationSec',
            render: (s: number) => `${Math.round(s / 60)} min`,
          },
          {
            title: 'Result',
            key: 'res',
            render: (_, b) => (b.status === 'ended' ? (b.isDraw ? 'Draw' : 'Decided') : '—'),
          },
          { title: 'Started', dataIndex: 'startedAt', render: dateTime },
          {
            title: '',
            key: 'a',
            render: (_, b) =>
              b.status === 'active' &&
              can('live.moderate') && (
                <ActionButton
                  danger
                  label="End"
                  confirm="End this PK now?"
                  run={() => send('post', `/admin/pk/${b.id}/end`)}
                  invalidate={[['pk']]}
                />
              ),
          },
        ]}
      />
    </>
  );
}
