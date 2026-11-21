import { useState } from 'react';
import { Button, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { CoinBagSummary } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { dateTime, diamonds } from '../../lib/format';
import { FilterBar, PageHeader, StatusTag, UserCell, type Brief } from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { FormModal } from '../../components/FormModal';
import { useAuth } from '../../auth/useAuth';

type AdminCoinBag = CoinBagSummary & {
  fee: number;
  feeRate: number;
  grabbedAmount: number;
  refundedAmount: number;
  refundOrphaned: number;
  closedAt: string | null;
  closeReason: string | null;
  cancelReason: string | null;
};

type Grab = {
  idx: number;
  amount: number;
  uid: string | null;
  user: Brief | null;
  claimedAt: string | null;
  remote: boolean;
  refundedAt: string | null;
};

const CLOSE_REASONS: Record<string, string> = {
  finished: 'All grabbed',
  expired: 'Window ended',
  room_ended: 'Live ended',
  cancelled: 'Cancelled by staff',
};

function GrabsDrawer({ bag, onClose }: { bag: AdminCoinBag | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['coin-bag-grabs', bag?.id],
    queryFn: () => get<{ items: Grab[] }>(`/admin/coin-bags/${bag!.id}/grabs`),
    enabled: Boolean(bag),
  });
  return (
    <Drawer
      open={Boolean(bag)}
      onClose={onClose}
      width={560}
      title={bag ? `Shares of ${diamonds(bag.pool)} 💎` : ''}
    >
      <Table<Grab>
        rowKey="idx"
        size="small"
        loading={q.isLoading}
        dataSource={q.data?.items ?? []}
        pagination={false}
        columns={[
          { title: '#', dataIndex: 'idx', width: 48, render: (i: number) => i + 1 },
          { title: 'Diamonds', dataIndex: 'amount', render: (n: number) => diamonds(n) },
          {
            title: 'Grabbed by',
            key: 'user',
            render: (_, g) =>
              g.uid ? (
                <Space direction="vertical" size={0}>
                  <UserCell user={g.user} fallbackId={g.uid} />
                  {g.remote && <Tag color="purple">remote host</Tag>}
                </Space>
              ) : g.refundedAt ? (
                <Tag>refunded</Tag>
              ) : (
                <Tag color="gold">open</Tag>
              ),
          },
          { title: 'When', key: 'at', render: (_, g) => dateTime(g.claimedAt ?? g.refundedAt) },
        ]}
      />
    </Drawer>
  );
}

/** Every coin bag released in a live: who paid, what was grabbed, what went back. */
export function CoinBagsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<string | undefined>();
  const [uid, setUid] = useState<string | undefined>();
  const [grabsOf, setGrabsOf] = useState<AdminCoinBag | null>(null);
  const [cancelling, setCancelling] = useState<AdminCoinBag | null>(null);
  return (
    <>
      <PageHeader
        title="Coin bags"
        subtitle="Diamonds viewers drop into lives, split at random among those who grab. Switch on and set the rules in Settings → Coin bags."
      />
      <ServerTable<AdminCoinBag>
        queryKey="coin-bags"
        url="/admin/coin-bags"
        filters={{ status, uid }}
        rowKey="id"
        toolbar={
          <FilterBar>
            <Select
              allowClear
              placeholder="Status"
              value={status}
              onChange={setStatus}
              style={{ width: 140 }}
              options={['active', 'finished', 'expired', 'cancelled'].map((s) => ({
                value: s,
                label: s,
              }))}
            />
            <Input.Search
              allowClear
              placeholder="Releaser short ID or uid"
              onSearch={(v) => setUid(v.trim() || undefined)}
              style={{ width: 240 }}
            />
          </FilterBar>
        }
        columns={[
          { title: 'Released', dataIndex: 'createdAt', render: dateTime },
          {
            title: 'Releaser',
            key: 'releaser',
            render: (_, b) => <UserCell user={b.releaser} />,
          },
          {
            title: 'In the live of',
            key: 'host',
            render: (_, b) => <UserCell user={b.host} />,
          },
          {
            title: 'Amount',
            key: 'amount',
            render: (_, b) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{diamonds(b.amount)} 💎</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  fee {diamonds(b.fee)} ({Math.round(b.feeRate * 100)}%)
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: 'Grabbed',
            key: 'grabbed',
            render: (_, b) => (
              <a onClick={() => setGrabsOf(b)}>
                {b.grabbedCount}/{b.shareCount} · {diamonds(b.grabbedAmount)}
              </a>
            ),
          },
          {
            title: 'Refunded',
            key: 'refunded',
            render: (_, b) =>
              b.refundOrphaned ? (
                <Tag color="red">{diamonds(b.refundOrphaned)} unpaid (account gone)</Tag>
              ) : (
                diamonds(b.refundedAmount)
              ),
          },
          {
            title: 'Status',
            key: 'status',
            render: (_, b) => (
              <Space direction="vertical" size={0}>
                <StatusTag status={b.status} />
                {b.closeReason && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {CLOSE_REASONS[b.closeReason] ?? b.closeReason}
                    {b.cancelReason ? `: ${b.cancelReason}` : ''}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: '',
            key: 'a',
            render: (_, b) =>
              b.status === 'active' &&
              can('coinBags.manage') && (
                <Button danger size="small" onClick={() => setCancelling(b)}>
                  Cancel
                </Button>
              ),
          },
        ]}
      />
      <GrabsDrawer bag={grabsOf} onClose={() => setGrabsOf(null)} />
      <FormModal<{ reason: string }>
        open={Boolean(cancelling)}
        title="Cancel this coin bag?"
        okText="Cancel bag and refund"
        onClose={() => setCancelling(null)}
        submit={(v) => send('post', `/admin/coin-bags/${cancelling!.id}/cancel`, v)}
        invalidate={[['coin-bags']]}
      >
        {() => (
          <>
            <Typography.Paragraph type="secondary">
              It closes now. Unclaimed shares go back to the releaser; the platform fee and shares
              already grabbed stay where they are.
            </Typography.Paragraph>
            <Form.Item name="reason" label="Reason" rules={[{ required: true, min: 3, max: 200 }]}>
              <Input.TextArea rows={2} maxLength={200} showCount />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}
