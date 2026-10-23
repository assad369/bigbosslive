import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADMIN_ROLES } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { ago, dateTime } from '../../lib/format';
import { ActionButton, PageHeader } from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { FormModal } from '../../components/FormModal';

// ── Settings ───────────────────────────────────────────────────────────────────

type Config = Record<string, Record<string, unknown>>;

const LABELS: Record<string, string> = {
  platformFeeRate: 'Platform fee on gifts (0–0.9)',
  maxAgencyRate: 'Max agency commission (0–0.5)',
  receivedLevelWeight: 'Level points per diamond received',
  beansPerUsd: 'Beans per 1 USD (withdrawals)',
  minWithdrawBeans: 'Minimum withdrawal (beans)',
  maxGiftQuantity: 'Max gift quantity per send',
  staleAfterSec: 'Close lives with no heartbeat after (s)',
  audioSeatCount: 'Audio room seats',
  seatRequestTtlSec: 'Seat request expiry (s)',
  followerPushOnGoLive: 'Push followers when a host goes live',
  inviteTtlSec: 'PK invitation expiry (s)',
  durationsSec: 'PK durations (seconds)',
  blockContactInfo: 'Block phone numbers / links in user text',
  blockedWords: 'Extra blocked words',
  maintenanceMessage: 'Maintenance message',
};

const SECTIONS: { key: string; title: string; help: string }[] = [
  { key: 'features', title: 'Features', help: 'Kill switches. Changes apply within ~30 seconds.' },
  {
    key: 'economy',
    title: 'Economy',
    help: 'Commission, level weighting and withdrawal rules. Changing level weight → re-level users from the Levels page.',
  },
  { key: 'live', title: 'Live', help: 'Room behaviour.' },
  { key: 'pk', title: 'PK', help: 'PK battle options.' },
  {
    key: 'moderation',
    title: 'Moderation',
    help: 'Applied to chat, comments, posts, room titles and profiles.',
  },
  {
    key: 'app',
    title: 'App',
    help: 'Version gates, maintenance mode and links read by the mobile app before sign-in.',
  },
];

function Field({ name, value }: { name: string; value: unknown }) {
  const label =
    LABELS[name] ?? name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  if (typeof value === 'boolean') {
    return (
      <Form.Item name={name} label={label} valuePropName="checked">
        <Switch />
      </Form.Item>
    );
  }
  if (typeof value === 'number') {
    return (
      <Form.Item name={name} label={label} rules={[{ required: true }]}>
        <InputNumber style={{ width: '100%' }} step={value < 1 ? 0.01 : 1} />
      </Form.Item>
    );
  }
  if (Array.isArray(value)) {
    return (
      <Form.Item
        name={name}
        label={label}
        getValueProps={(v: unknown[]) => ({ value: (v ?? []).map(String) })}
        normalize={(v: string[]) =>
          typeof value[0] === 'number' || name === 'durationsSec'
            ? v.map(Number).filter((n) => !Number.isNaN(n))
            : v
        }
      >
        <Select mode="tags" tokenSeparators={[',']} />
      </Form.Item>
    );
  }
  if (value && typeof value === 'object') {
    return (
      <Form.Item label={label}>
        <Space>
          {Object.entries(value as Record<string, unknown>).map(([k]) => (
            <Form.Item key={k} name={[name, k]} noStyle>
              <InputNumber addonBefore={k} min={0} />
            </Form.Item>
          ))}
        </Space>
      </Form.Item>
    );
  }
  return (
    <Form.Item name={name} label={label}>
      {name.toLowerCase().includes('message') ? <Input.TextArea rows={2} /> : <Input />}
    </Form.Item>
  );
}

function Section({ k, value }: { k: string; value: Record<string, unknown> }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const qc = useQueryClient();
  useEffect(() => form.setFieldsValue(value), [value, form]);
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      send('put', `/admin/config/${k}`, { ...value, ...v }),
    onSuccess: () => {
      message.success('Settings saved');
      void qc.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  return (
    <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} initialValues={value}>
      <Row gutter={24}>
        {Object.entries(value).map(([name, v]) => (
          <Col key={name} xs={24} md={typeof v === 'boolean' ? 8 : 12}>
            <Field name={name} value={v} />
          </Col>
        ))}
      </Row>
      <Button type="primary" htmlType="submit" loading={save.isPending}>
        Save {k}
      </Button>
    </Form>
  );
}

export function SettingsPage() {
  const q = useQuery({ queryKey: ['config'], queryFn: () => get<Config>('/admin/config') });
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Runtime configuration — validated by the server, cached for 30 seconds"
      />
      {q.error && <Alert type="error" message={(q.error as Error).message} />}
      {q.data && (
        <Card variant="borderless">
          <Tabs
            tabPlacement="top"
            items={SECTIONS.filter((s) => q.data[s.key]).map((s) => ({
              key: s.key,
              label: s.title,
              children: (
                <>
                  <Typography.Paragraph type="secondary">{s.help}</Typography.Paragraph>
                  <Section k={s.key} value={q.data[s.key]!} />
                </>
              ),
            }))}
          />
        </Card>
      )}
    </>
  );
}

// ── Admin team ─────────────────────────────────────────────────────────────────

interface AdminRow {
  _id: string;
  displayName: string;
  shortId: string;
  email: string | null;
  adminRole: string;
  avatarUrl: string | null;
  lastSeenAt: string;
}

const ROLE_HELP: Record<string, string> = {
  support: 'Read-only users, live rooms and reports',
  moderator: 'Bans, reports, feed, live moderation, device bans',
  finance: 'Recharges, adjustments, withdrawals, agents, agencies',
  admin: 'Everything except managing admins',
  superadmin: 'Everything, including admin roles',
};

export function AdminsPage() {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['admins'],
    queryFn: () => get<{ items: AdminRow[] }>('/admin/admins'),
  });
  const setRole = (uid: string, role: string | null) =>
    send('post', '/admin/admins', { uid, role });
  return (
    <>
      <PageHeader
        title="Admin team"
        subtitle="Roles are Firebase custom claims; changing a role signs the person out everywhere"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            Grant access
          </Button>
        }
      />
      <Card variant="borderless" styles={{ body: { padding: 0 } }}>
        <Table<AdminRow>
          rowKey="_id"
          loading={q.isLoading}
          dataSource={q.data?.items ?? []}
          pagination={false}
          columns={[
            {
              title: 'Admin',
              key: 'a',
              render: (_, a) => (
                <Space>
                  <Avatar src={a.avatarUrl ?? undefined}>{a.displayName[0]}</Avatar>
                  <div>
                    <Typography.Text strong>{a.displayName}</Typography.Text>
                    <br />
                    <Typography.Text type="secondary">{a.email ?? a._id}</Typography.Text>
                  </div>
                </Space>
              ),
            },
            {
              title: 'Role',
              dataIndex: 'adminRole',
              render: (r: string) => <Tag color="gold">{r}</Tag>,
            },
            { title: 'Last seen', dataIndex: 'lastSeenAt', render: ago },
            {
              title: '',
              key: 'x',
              render: (_, a) => (
                <Space>
                  <Select
                    size="small"
                    value={a.adminRole}
                    style={{ width: 130 }}
                    options={ADMIN_ROLES.map((r) => ({ value: r, label: r }))}
                    onChange={(r) => void setRole(a._id, r).then(() => q.refetch())}
                  />
                  <ActionButton
                    danger
                    label="Revoke"
                    confirm="Remove all admin access?"
                    run={() => setRole(a._id, null)}
                    invalidate={[['admins']]}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Card variant="borderless" title="Role permissions" style={{ marginTop: 16 }}>
        {ADMIN_ROLES.map((r) => (
          <div key={r} style={{ marginBottom: 6 }}>
            <Tag color="gold">{r}</Tag> {ROLE_HELP[r]}
          </div>
        ))}
      </Card>
      <FormModal<{ uid: string; role: string }>
        open={open}
        title="Grant admin access"
        onClose={() => setOpen(false)}
        initialValues={{ role: 'support' }}
        invalidate={[['admins']]}
        submit={(v) => setRole(v.uid, v.role)}
      >
        {() => (
          <>
            <Form.Item
              name="uid"
              label="User uid"
              rules={[{ required: true }]}
              extra="The person must have signed in to the app (or dashboard) once."
            >
              <Input />
            </Form.Item>
            <Form.Item name="role" label="Role">
              <Select
                options={ADMIN_ROLES.map((r) => ({ value: r, label: `${r} — ${ROLE_HELP[r]}` }))}
              />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}

// ── Audit log ──────────────────────────────────────────────────────────────────

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
}

export function AuditPage() {
  const [action, setAction] = useState('');
  const [adminId, setAdminId] = useState('');
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of every admin write" />
      <ServerTable<AuditRow>
        queryKey="audit"
        url="/admin/audit"
        filters={{ action: action || undefined, adminId: adminId || undefined }}
        rowKey="_id"
        toolbar={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="Action (e.g. wallet.adjust)"
              onSearch={setAction}
              style={{ width: 220 }}
            />
            <Input.Search
              allowClear
              placeholder="Admin uid"
              onSearch={setAdminId}
              style={{ width: 200 }}
            />
          </Space>
        }
        expandable={{
          expandedRowRender: (r) => (
            <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(r.payload, null, 2)}
            </pre>
          ),
        }}
        columns={[
          { title: 'When', dataIndex: 'createdAt', render: dateTime },
          {
            title: 'Admin',
            key: 'a',
            render: (_, r) => (
              <Space>
                <Typography.Text code>{r.adminId}</Typography.Text>
                <Tag color="gold">{r.adminRole}</Tag>
              </Space>
            ),
          },
          { title: 'Action', dataIndex: 'action', render: (a: string) => <Tag>{a}</Tag> },
          {
            title: 'Target',
            key: 't',
            render: (_, r) => `${r.targetType}${r.targetId ? ` · ${r.targetId}` : ''}`,
          },
          { title: 'IP', dataIndex: 'ip' },
        ]}
      />
    </>
  );
}
