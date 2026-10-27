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
import { LockOutlined, PlusOutlined, UnlockOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADMIN_ROLES, type StorageSettingsInput, type StorageSettingsView } from '@bigboss/shared';
import { ApiError, get, send } from '../../lib/api';
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
  videoSeatCount: 'People on a video stage, host included (2–13)',
  seatRequestTtlSec: 'Seat request expiry (s)',
  followerPushOnGoLive: 'Push followers when a host goes live',
  inviteTtlSec: 'PK invitation expiry (s)',
  durationsSec: 'PK round lengths (seconds)',
  maxRounds: 'PK rounds (best of N)',
  leadInSec: 'PK countdown before each round (s)',
  pauseTimeoutSec: 'PK ends if no next round within (s)',
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

// ── Storage (R2) ───────────────────────────────────────────────────────────────

const SOURCE_TAG: Record<StorageSettingsView['source'], { color: string; label: string }> = {
  database: { color: 'green', label: 'Saved from dashboard' },
  env: { color: 'blue', label: 'From server env (S3_*)' },
  none: { color: 'red', label: 'Not configured — uploads disabled' },
};

const passcodeError = (e: Error) =>
  e instanceof ApiError && e.status === 429
    ? 'Too many wrong passcodes — try again in 15 minutes'
    : e.message;

/**
 * Credentials sit behind a second passcode, checked by the server on every call. The code is
 * kept in component state only, so leaving the page or pressing Lock forgets it.
 */
function StorageSettings() {
  const [form] = Form.useForm<StorageSettingsInput>();
  const { message } = App.useApp();
  const [entry, setEntry] = useState('');
  const [unlocked, setUnlocked] = useState<{ code: string; view: StorageSettingsView } | null>(
    null,
  );
  const headers = unlocked ? { 'X-Admin-Passcode': unlocked.code } : undefined;
  const lock = () => {
    setUnlocked(null);
    setEntry('');
    form.resetFields();
  };
  const show = (code: string, view: StorageSettingsView) => {
    setUnlocked({ code, view });
    form.setFieldsValue({ ...view, secretAccessKey: undefined });
  };
  const onError = (e: Error) => {
    message.error(passcodeError(e));
    if (e instanceof ApiError && (e.status === 403 || e.status === 429)) lock();
  };

  const unlock = useMutation({
    mutationFn: (code: string) =>
      get<StorageSettingsView>('/admin/storage', undefined, { 'X-Admin-Passcode': code }),
    onSuccess: (view, code) => show(code, view),
    onError: (e: Error) => message.error(passcodeError(e)),
  });
  const save = useMutation({
    mutationFn: (v: StorageSettingsInput) =>
      send<StorageSettingsView>(
        'put',
        '/admin/storage',
        { ...v, secretAccessKey: v.secretAccessKey || undefined },
        headers,
      ),
    onSuccess: (view) => {
      message.success('Storage settings saved — live within ~30 seconds');
      show(unlocked!.code, view);
    },
    onError,
  });
  const test = useMutation({
    mutationFn: () => send('post', '/admin/storage/test', undefined, headers),
    onSuccess: () => message.success('Connected — the bucket is reachable'),
    onError,
  });
  const revert = () =>
    send<StorageSettingsView>('delete', '/admin/storage', undefined, headers).then((view) =>
      show(unlocked!.code, view),
    );

  if (!unlocked) {
    return (
      <Space.Compact style={{ maxWidth: 360 }}>
        <Input.Password
          placeholder="Passcode"
          inputMode="numeric"
          maxLength={32}
          autoComplete="off"
          prefix={<LockOutlined />}
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          onPressEnter={() => entry && unlock.mutate(entry)}
        />
        <Button
          type="primary"
          icon={<UnlockOutlined />}
          loading={unlock.isPending}
          disabled={!entry}
          onClick={() => unlock.mutate(entry)}
        >
          Unlock
        </Button>
      </Space.Compact>
    );
  }

  const { view } = unlocked;
  const source = SOURCE_TAG[view.source];
  return (
    <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
      <Space style={{ marginBottom: 16 }}>
        <Tag color={source.color}>{source.label}</Tag>
        {view.updatedAt && (
          <Typography.Text type="secondary">Updated {ago(view.updatedAt)}</Typography.Text>
        )}
      </Space>
      <Row gutter={24}>
        <Col xs={24} md={12}>
          <Form.Item
            name="accountId"
            label="Cloudflare account ID"
            extra="Endpoint: https://<account id>.r2.cloudflarestorage.com"
            rules={[{ required: true }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="bucket" label="Bucket" rules={[{ required: true }]}>
            <Input autoComplete="off" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item name="accessKeyId" label="Access key ID" rules={[{ required: true }]}>
            <Input autoComplete="off" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            name="secretAccessKey"
            label="Secret access key"
            // Only a secret saved from the dashboard can be kept; env values are never copied.
            extra={
              view.source === 'database' ? 'Leave blank to keep the current secret' : undefined
            }
            rules={[{ required: view.source !== 'database' }]}
          >
            <Input.Password
              autoComplete="new-password"
              placeholder={view.secretHint ?? 'Paste the R2 API token secret'}
            />
          </Form.Item>
        </Col>
        <Col xs={24}>
          <Form.Item
            name="publicBaseUrl"
            label="Public base URL"
            extra="Custom domain or r2.dev URL that serves the bucket, e.g. https://media.example.com"
            rules={[{ required: true, type: 'url' }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
        </Col>
      </Row>
      <Space wrap>
        <Button type="primary" htmlType="submit" loading={save.isPending}>
          Save storage
        </Button>
        <Button
          loading={test.isPending}
          disabled={view.source === 'none'}
          onClick={() => test.mutate()}
        >
          Test saved connection
        </Button>
        {view.source === 'database' && (
          <ActionButton
            label="Revert to env"
            size="middle"
            danger
            confirm="Remove the dashboard settings and use the server's S3_* env variables?"
            run={revert}
            success="Reverted to server env"
          />
        )}
        <Button icon={<LockOutlined />} onClick={lock}>
          Lock
        </Button>
      </Space>
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
            items={[
              ...SECTIONS.filter((s) => q.data[s.key]).map((s) => ({
                key: s.key,
                label: s.title,
                children: (
                  <>
                    <Typography.Paragraph type="secondary">{s.help}</Typography.Paragraph>
                    <Section k={s.key} value={q.data[s.key]!} />
                  </>
                ),
              })),
              {
                key: 'storage',
                label: 'Storage (R2)',
                children: (
                  <>
                    <Typography.Paragraph type="secondary">
                      Cloudflare R2 bucket used for every upload. Protected by a passcode; the
                      secret is never shown again after saving.
                    </Typography.Paragraph>
                    <StorageSettings />
                  </>
                ),
              },
            ]}
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
