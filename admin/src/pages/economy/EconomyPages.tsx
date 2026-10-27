import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import { get, send } from '../../lib/api';
import { ago, dateTime, downloadCsv, duration, money, num, pct } from '../../lib/format';
import {
  ActionButton,
  Money,
  PageHeader,
  StatCard,
  StatusTag,
  UserCell,
  type Brief,
} from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { FormModal } from '../../components/FormModal';
import { MediaUpload } from '../../components/MediaUpload';
import { useAuth } from '../../auth/useAuth';

const rangeParams = (r: [Dayjs | null, Dayjs | null] | null) => ({
  from: r?.[0]?.startOf('day').toISOString(),
  to: r?.[1]?.endOf('day').toISOString(),
});

// ── Recharges ─────────────────────────────────────────────────────────────────

interface RechargeRow {
  _id: string;
  userId: string;
  diamonds: number;
  source: string;
  agentId: string | null;
  adminId: string | null;
  note: string | null;
  createdAt: string;
}

export function RechargesPage() {
  const [source, setSource] = useState<string | undefined>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [uid, setUid] = useState('');
  return (
    <>
      <PageHeader
        title="Recharges"
        subtitle="Every diamond credit from agents, admins and store purchases"
      />
      <ServerTable<RechargeRow>
        queryKey="recharges"
        url="/admin/recharges"
        filters={{ source, uid: uid || undefined, ...rangeParams(range) }}
        rowKey="_id"
        toolbar={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="User uid"
              onSearch={setUid}
              style={{ width: 200 }}
            />
            <Select
              allowClear
              placeholder="Source"
              value={source}
              onChange={setSource}
              style={{ width: 120 }}
              options={['agent', 'admin', 'iap'].map((s) => ({ value: s, label: s }))}
            />
            <DatePicker.RangePicker
              onChange={(r) => setRange(r as [Dayjs | null, Dayjs | null] | null)}
            />
          </Space>
        }
        footer={(d) => (
          <Typography.Text strong>
            Total in filter: <Money value={(d?.totalDiamonds as number) ?? 0} unit="diamonds" />
          </Typography.Text>
        )}
        columns={[
          { title: 'When', dataIndex: 'createdAt', render: dateTime },
          {
            title: 'User',
            dataIndex: 'userId',
            render: (u: string) => <Link to={`/users/${u}`}>{u}</Link>,
          },
          {
            title: 'Diamonds',
            dataIndex: 'diamonds',
            align: 'right',
            render: (d: number) => <Money value={d} unit="diamonds" />,
          },
          {
            title: 'Source',
            dataIndex: 'source',
            render: (s: string) => (
              <Tag color={s === 'iap' ? 'green' : s === 'agent' ? 'purple' : 'gold'}>{s}</Tag>
            ),
          },
          {
            title: 'By',
            key: 'by',
            render: (_, r) =>
              r.agentId ? (
                <Link to={`/users/${r.agentId}`}>agent {r.agentId}</Link>
              ) : r.adminId ? (
                `admin ${r.adminId}`
              ) : (
                'store'
              ),
          },
          { title: 'Note', dataIndex: 'note', render: (n: string | null) => n ?? '—' },
        ]}
      />
    </>
  );
}

// ── Gift transactions ─────────────────────────────────────────────────────────────

interface GiftTxRow {
  _id: string;
  senderId: string;
  giftName: string;
  quantity: number;
  totalCost: number;
  receivers: {
    userId: string;
    cost: number;
    beans: number;
    platformFee: number;
    agencyFee: number;
  }[];
  roomId: string | null;
  createdAt: string;
}

export function GiftTransactionsPage() {
  const [senderId, setSender] = useState('');
  const [receiverId, setReceiver] = useState('');
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  return (
    <>
      <PageHeader
        title="Gift history"
        subtitle="Every gift sent, with the commission split per receiver"
      />
      <ServerTable<GiftTxRow>
        queryKey="gift-tx"
        url="/admin/gift-transactions"
        filters={{
          senderId: senderId || undefined,
          receiverId: receiverId || undefined,
          ...rangeParams(range),
        }}
        rowKey="_id"
        toolbar={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="Sender uid"
              onSearch={setSender}
              style={{ width: 180 }}
            />
            <Input.Search
              allowClear
              placeholder="Receiver uid"
              onSearch={setReceiver}
              style={{ width: 180 }}
            />
            <DatePicker.RangePicker
              onChange={(r) => setRange(r as [Dayjs | null, Dayjs | null] | null)}
            />
          </Space>
        }
        expandable={{
          expandedRowRender: (t) => (
            <Table
              size="small"
              rowKey="userId"
              pagination={false}
              dataSource={t.receivers}
              columns={[
                {
                  title: 'Receiver',
                  dataIndex: 'userId',
                  render: (u: string) => <Link to={`/users/${u}`}>{u}</Link>,
                },
                { title: 'Value', dataIndex: 'cost', render: num },
                { title: 'Beans to host', dataIndex: 'beans', render: num },
                { title: 'Platform fee', dataIndex: 'platformFee', render: num },
                { title: 'Agency fee', dataIndex: 'agencyFee', render: num },
              ]}
            />
          ),
        }}
        columns={[
          { title: 'When', dataIndex: 'createdAt', render: dateTime },
          {
            title: 'Sender',
            dataIndex: 'senderId',
            render: (u: string) => <Link to={`/users/${u}`}>{u}</Link>,
          },
          { title: 'Gift', key: 'g', render: (_, t) => `${t.giftName} × ${t.quantity}` },
          { title: 'Receivers', key: 'r', render: (_, t) => t.receivers.length },
          {
            title: 'Total',
            dataIndex: 'totalCost',
            align: 'right',
            render: (d: number) => <Money value={d} unit="diamonds" />,
          },
          {
            title: 'Room',
            dataIndex: 'roomId',
            render: (r: string | null) =>
              r ? <Typography.Text code>{r.slice(-6)}</Typography.Text> : '—',
          },
        ]}
      />
    </>
  );
}

// ── Withdrawals ───────────────────────────────────────────────────────────────────

interface WithdrawalRow {
  _id: string;
  user: Brief | null;
  userId: string;
  beans: number;
  amountUsd: number;
  method: string;
  account: Record<string, string>;
  status: string;
  note: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export function WithdrawalsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<string | undefined>('pending');
  const [rows, setRows] = useState<WithdrawalRow[]>([]);
  const [rejecting, setRejecting] = useState<WithdrawalRow | null>(null);
  const review = (id: string, action: string, note: string | null = null) =>
    send('post', `/admin/withdrawals/${id}/review`, { action, note });
  const inv = [['withdrawals']];

  return (
    <>
      <PageHeader
        title="Withdrawals"
        subtitle="Beans are held when a request is made and returned if it is rejected"
        extra={
          <Button
            icon={<DownloadOutlined />}
            disabled={!rows.length}
            onClick={() =>
              downloadCsv(
                'withdrawals.csv',
                rows.map((r) => ({
                  id: r._id,
                  user: r.user?.shortId ?? r.userId,
                  beans: r.beans,
                  usd: r.amountUsd,
                  method: r.method,
                  ...r.account,
                  status: r.status,
                  requested: r.createdAt,
                })),
              )
            }
          >
            Export page
          </Button>
        }
      />
      <ServerTable<WithdrawalRow>
        queryKey="withdrawals"
        url="/admin/withdrawals"
        filters={{ status }}
        rowKey="_id"
        toolbar={
          <Select
            allowClear
            placeholder="Status"
            value={status}
            onChange={setStatus}
            style={{ width: 140 }}
            options={['pending', 'approved', 'paid', 'rejected'].map((s) => ({
              value: s,
              label: s,
            }))}
          />
        }
        onData={setRows}
        footer={(d) => {
          const pending = d?.pending as { beans: number; usd: number } | undefined;
          return pending ? (
            <Typography.Text>
              Pending queue: <b>{num(pending.beans)}</b> beans · <b>{money(pending.usd)}</b>
            </Typography.Text>
          ) : null;
        }}
        columns={[
          { title: 'Requested', dataIndex: 'createdAt', render: ago },
          {
            title: 'User',
            key: 'u',
            render: (_, w) => <UserCell user={w.user} fallbackId={w.userId} />,
          },
          {
            title: 'Beans',
            dataIndex: 'beans',
            align: 'right',
            render: (b: number) => <Money value={b} unit="beans" />,
          },
          {
            title: 'Payout',
            dataIndex: 'amountUsd',
            align: 'right',
            render: (u: number) => <Money value={u} unit="usd" />,
          },
          {
            title: 'Method',
            key: 'm',
            render: (_, w) => (
              <div>
                <Tag>{w.method.replace('_', ' ')}</Tag>
                <div style={{ fontSize: 12 }}>
                  {Object.entries(w.account).map(([k, v]) => (
                    <div key={k}>
                      <Typography.Text type="secondary">{k}:</Typography.Text>{' '}
                      <Typography.Text copyable>{v}</Typography.Text>
                    </div>
                  ))}
                </div>
              </div>
            ),
          },
          { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
          {
            title: '',
            key: 'a',
            render: (_, w) =>
              can('withdrawals.review') && (
                <Space>
                  {w.status === 'pending' && (
                    <ActionButton
                      type="primary"
                      label="Approve"
                      run={() => review(w._id, 'approve')}
                      invalidate={inv}
                      confirm="Approve this payout?"
                    />
                  )}
                  {w.status === 'approved' && (
                    <ActionButton
                      type="primary"
                      label="Mark paid"
                      run={() => review(w._id, 'mark_paid')}
                      invalidate={inv}
                      confirm="Confirm the money was sent?"
                    />
                  )}
                  {(w.status === 'pending' || w.status === 'approved') && (
                    <Button size="small" danger onClick={() => setRejecting(w)}>
                      Reject
                    </Button>
                  )}
                </Space>
              ),
          },
        ]}
      />
      <FormModal<{ note: string }>
        open={Boolean(rejecting)}
        title="Reject withdrawal"
        okText="Reject & refund"
        onClose={() => setRejecting(null)}
        invalidate={inv}
        submit={(v) => review(rejecting!._id, 'reject', v.note)}
      >
        {() => (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`${num(rejecting?.beans)} beans will be returned to the user.`}
            />
            <Form.Item name="note" label="Reason (sent to the user)" rules={[{ required: true }]}>
              <Input.TextArea rows={3} maxLength={300} />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}

// ── Host agencies ──────────────────────────────────────────────────────────────────

interface AgencyRow {
  _id: string;
  name: string;
  ownerId: string;
  owner: Brief | null;
  logoUrl: string | null;
  commissionRate: number;
  status: string;
  memberCount: number;
  createdAt: string;
}

export function AgenciesPage() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Host agencies"
        subtitle="Agencies earn a commission on gifts their hosts receive"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            New agency
          </Button>
        }
      />
      <ServerTable<AgencyRow>
        queryKey="agencies"
        url="/admin/agencies"
        filters={{ q: q || undefined }}
        rowKey="_id"
        toolbar={
          <Input.Search
            allowClear
            placeholder="Search agencies"
            onSearch={setQ}
            style={{ width: 240 }}
          />
        }
        columns={[
          {
            title: 'Agency',
            key: 'n',
            render: (_, a) => (
              <Link to={`/agencies/${a._id}`}>
                <Typography.Text strong>{a.name}</Typography.Text>
              </Link>
            ),
          },
          {
            title: 'Owner',
            key: 'o',
            render: (_, a) => <UserCell user={a.owner} fallbackId={a.ownerId} />,
          },
          { title: 'Commission', dataIndex: 'commissionRate', render: (r: number) => pct(r) },
          { title: 'Hosts', dataIndex: 'memberCount', align: 'right' },
          { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
          { title: 'Created', dataIndex: 'createdAt', render: dateTime },
        ]}
      />
      <FormModal<{ name: string; ownerId: string; commissionRate: number; logoUrl: string | null }>
        open={open}
        title="Create agency"
        onClose={() => setOpen(false)}
        initialValues={{ commissionRate: 0.05, logoUrl: null }}
        invalidate={[['agencies']]}
        submit={(v) => send('post', '/admin/agencies', { ...v, logoUrl: v.logoUrl ?? null })}
      >
        {() => (
          <>
            <Form.Item name="name" label="Name" rules={[{ required: true, min: 2, max: 40 }]}>
              <Input />
            </Form.Item>
            <Form.Item name="logoUrl" label="Logo (optional)" rules={[{ type: 'url' }]}>
              <MediaUpload kind="agency-logo" />
            </Form.Item>
            <Form.Item name="ownerId" label="Owner uid" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item
              name="commissionRate"
              label="Commission rate (0–0.5, capped by economy settings)"
              rules={[{ required: true }]}
            >
              <InputNumber min={0} max={0.5} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}

interface AgencyDetail {
  agency: AgencyRow;
  owner: Brief | null;
  currentPeriod: string;
  members: {
    user: Brief | null;
    joinedAt: string;
    periodBeans: number;
    periodLiveSeconds: number;
  }[];
  history: { userId: string; periodKey: string; beans: number; liveSeconds: number }[];
}

export function AgencyDetailPage() {
  const { id = '' } = useParams();
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const key = ['agency', id];
  const q = useQuery({ queryKey: key, queryFn: () => get<AgencyDetail>(`/admin/agencies/${id}`) });
  if (!q.data)
    return q.error ? (
      <Alert type="error" message={(q.error as Error).message} />
    ) : (
      <Skeleton active />
    );
  const { agency, owner, members, history, currentPeriod } = q.data;
  const totalBeans = members.reduce((s, m) => s + m.periodBeans, 0);
  const totalSeconds = members.reduce((s, m) => s + m.periodLiveSeconds, 0);
  const inv = [key, ['agencies']];

  return (
    <>
      <PageHeader
        title={agency.name}
        subtitle={
          <>
            Owner: {owner?.displayName ?? agency.ownerId} · commission {pct(agency.commissionRate)}{' '}
            · period {currentPeriod}
          </>
        }
        extra={
          <>
            <Button onClick={() => setEditOpen(true)}>Edit</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
              Add host
            </Button>
            <ActionButton
              size="middle"
              danger={agency.status === 'active'}
              label={agency.status === 'active' ? 'Suspend' : 'Reactivate'}
              confirm="Change agency status?"
              run={() =>
                send('patch', `/admin/agencies/${id}`, {
                  status: agency.status === 'active' ? 'suspended' : 'active',
                })
              }
              invalidate={inv}
            />
          </>
        }
      />
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={8}>
          <StatCard gold title="Hosts" value={members.length} />
        </Col>
        <Col xs={24} md={8}>
          <StatCard title="Beans this month" value={num(totalBeans)} />
        </Col>
        <Col xs={24} md={8}>
          <StatCard title="Live time this month" value={duration(totalSeconds)} />
        </Col>
      </Row>
      <Card variant="borderless" title="Hosts (current period)">
        <Table
          rowKey={(m) => m.user?.id ?? m.joinedAt}
          dataSource={members}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: 'Host', key: 'u', render: (_, m) => <UserCell user={m.user} /> },
            {
              title: 'Beans',
              dataIndex: 'periodBeans',
              align: 'right',
              render: (b: number) => <Money value={b} unit="beans" />,
            },
            { title: 'Live time', dataIndex: 'periodLiveSeconds', render: duration },
            { title: 'Joined', dataIndex: 'joinedAt', render: dateTime },
            {
              title: '',
              key: 'a',
              render: (_, m) =>
                m.user && (
                  <ActionButton
                    danger
                    label="Remove"
                    confirm="Remove this host from the agency?"
                    run={() => send('delete', `/admin/agencies/${id}/members/${m.user!.id}`)}
                    invalidate={inv}
                  />
                ),
            },
          ]}
        />
      </Card>
      <Card variant="borderless" title="Closed periods" style={{ marginTop: 16 }}>
        <Table
          size="small"
          rowKey={(h) => `${h.periodKey}-${h.userId}`}
          dataSource={history}
          pagination={{ pageSize: 20 }}
          columns={[
            { title: 'Period', dataIndex: 'periodKey' },
            {
              title: 'Host',
              dataIndex: 'userId',
              render: (u: string) => <Link to={`/users/${u}`}>{u}</Link>,
            },
            { title: 'Beans', dataIndex: 'beans', render: num },
            { title: 'Live time', dataIndex: 'liveSeconds', render: duration },
          ]}
        />
      </Card>
      <FormModal<{ userId: string }>
        open={addOpen}
        title="Add host"
        onClose={() => setAddOpen(false)}
        invalidate={inv}
        submit={(v) => send('post', `/admin/agencies/${id}/members`, v)}
      >
        {() => (
          <Form.Item name="userId" label="Host uid" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        )}
      </FormModal>
      <FormModal<{ name: string; commissionRate: number; logoUrl: string | null }>
        open={editOpen}
        title="Edit agency"
        onClose={() => setEditOpen(false)}
        initialValues={{
          name: agency.name,
          commissionRate: agency.commissionRate,
          logoUrl: agency.logoUrl,
        }}
        invalidate={inv}
        submit={(v) => send('patch', `/admin/agencies/${id}`, { ...v, logoUrl: v.logoUrl ?? null })}
      >
        {() => (
          <>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="logoUrl" label="Logo" rules={[{ type: 'url' }]}>
              <MediaUpload kind="agency-logo" />
            </Form.Item>
            <Form.Item name="commissionRate" label="Commission rate" rules={[{ required: true }]}>
              <InputNumber min={0} max={0.5} step={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}
      </FormModal>
      <Descriptions
        style={{ marginTop: 16 }}
        size="small"
        items={[
          {
            key: 'id',
            label: 'Agency id',
            children: (
              <Typography.Text code copyable>
                {agency._id}
              </Typography.Text>
            ),
          },
        ]}
      />
    </>
  );
}
