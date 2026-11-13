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
  Tooltip,
  Typography,
} from 'antd';
import { KeyOutlined, LockOutlined, PlusOutlined, UnlockOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_ROLES,
  type StorageSettingsInput,
  type StorageSettingsView,
} from '@bigboss/shared';
import { ApiError, get, send } from '../../lib/api';
import { ago } from '../../lib/format';
import { ActionButton, PageHeader, UserCell, type Brief } from '../../components/common';
import { FormModal } from '../../components/FormModal';
import { confirmPasswordRules, newPasswordRules } from '../../components/passwordRules';
import { useAuth } from '../../auth/useAuth';

// ── Settings ───────────────────────────────────────────────────────────────────

type Config = Record<string, Record<string, unknown>>;

const LABELS: Record<string, string> = {
  platformFeeRate: 'Platform fee on gifts (0–0.9)',
  maxAgencyRate: 'Max agency commission (0–0.5)',
  receivedLevelWeight: 'Level points per diamond received',
  diamondsPerUsd: 'Diamonds per 1 USD (withdrawals)',
  minWithdrawDiamonds: 'Minimum withdrawal (diamonds)',
  maxGiftQuantity: 'Max gift quantity per send',
  diamondsPerStar: 'Diamonds per star shown next to wallet balances',
  staleAfterSec: 'Close lives with no heartbeat after (s)',
  audioSeatCount: 'Audio room seats',
  videoSeatCount: 'People on a video stage, host included (2–13)',
  seatRequestTtlSec: 'Seat request expiry (s)',
  followerPushOnGoLive: 'Push followers when a host goes live',
  giftBannerMinDiamonds: 'Announce gifts worth at least (diamonds) in every live; 0 = all',
  inviteTtlSec: 'PK invitation expiry (s)',
  durationsSec: 'PK round lengths (seconds)',
  maxRounds: 'PK rounds (best of N)',
  leadInSec: 'PK countdown before each round (s)',
  pauseTimeoutSec: 'PK ends if no next round within (s)',
  blockContactInfo: 'Block phone numbers / links in user text',
  blockedWords: 'Extra blocked words',
  maintenanceMessage: 'Maintenance message',
  youtubeEnabled: 'YouTube music in lives (needs YOUTUBE_API_KEY)',
  gamesEnabled: 'AsadSoft games (levels and per-game switches: Games → Settings)',
  safeSearch: 'Safe search (none, moderate or strict)',
  regionCode: 'Country videos must play in (e.g. BD; empty = any)',
  maxDurationSec: 'Longest song (s)',
  searchCacheSec: 'Reuse a search for (s); each search spends quota',
  blockedVideoIds: 'Blocked video ids',
  blockedChannelIds: 'Blocked channel ids (UC…)',
  stealthEnabled: 'Platform moderators join lives hidden',
  selfStageEnabled: 'Platform moderators take a seat without approval',
  banRateLimitPerHour: 'Bans one platform moderator may issue per hour',
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
    key: 'youtube',
    title: 'YouTube music',
    help: 'Rules for songs hosts play in a live. Turn it on with Features → YouTube music.',
  },
  {
    key: 'moderation',
    title: 'Moderation',
    help: 'Applied to chat, comments, posts, room titles and profiles.',
  },
  {
    key: 'platformModerators',
    title: 'Platform moderators',
    help: 'App users granted the platform moderator role (Community → Platform moderators). Hidden moderators add nothing to the viewer count and get no join line or entrance. Turning stealth off does not reveal a moderator already in a room; they show on their next join.',
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
  const cors = useMutation({
    mutationFn: () =>
      send<{ origins: string[] }>('post', '/admin/storage/cors', undefined, headers),
    onSuccess: ({ origins }) => message.success(`CORS rule applied for ${origins.join(', ')}`),
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
        <Button
          loading={cors.isPending}
          disabled={view.source === 'none'}
          onClick={() => cors.mutate()}
        >
          Apply CORS rule
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

// ── Maintenance access ─────────────────────────────────────────────────────────

/** Users who keep using the app while maintenance mode is on. Everyone else is turned away. */
function MaintenanceAccess() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [ids, setIds] = useState<string[]>([]);
  const list = useQuery({
    queryKey: ['maintenance-access'],
    queryFn: () => get<{ items: Brief[] }>('/admin/maintenance/access'),
  });
  const add = useMutation({
    mutationFn: (users: string[]) =>
      send<{ added: Brief[]; notFound: string[] }>('post', '/admin/maintenance/access', {
        users,
      }),
    onSuccess: ({ added, notFound }) => {
      if (added.length) message.success(`Added ${added.length} user(s)`);
      else if (!notFound.length) message.info('Already on the list');
      if (notFound.length) message.warning(`No active user for: ${notFound.join(', ')}`);
      setIds(notFound);
      void qc.invalidateQueries({ queryKey: ['maintenance-access'] });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const submit = () => {
    const users = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
    if (users.length) add.mutate(users);
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space.Compact style={{ width: '100%', maxWidth: 640 }}>
        <Select
          mode="tags"
          style={{ width: '100%' }}
          placeholder="Short IDs or uids, e.g. 200, 345"
          tokenSeparators={[',', ' ', '\n']}
          value={ids}
          onChange={setIds}
          open={false}
          maxCount={100}
        />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          loading={add.isPending}
          disabled={!ids.length}
          onClick={submit}
        >
          Add
        </Button>
      </Space.Compact>
      {list.error && <Alert type="error" message={(list.error as Error).message} />}
      <Table<Brief>
        rowKey="id"
        scroll={{ x: 'max-content' }}
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        locale={{
          emptyText: 'Nobody yet: during maintenance every user sees the maintenance screen',
        }}
        columns={[
          { title: 'User', render: (_, u) => <UserCell user={u} /> },
          { title: 'Short ID', dataIndex: 'shortId', width: 140 },
          {
            title: '',
            width: 110,
            render: (_, u) => (
              <ActionButton
                label="Remove"
                danger
                confirm={`Remove ${u.displayName ?? u.id} from maintenance access?`}
                run={() => send('delete', `/admin/maintenance/access/${encodeURIComponent(u.id)}`)}
                invalidate={[['maintenance-access']]}
                success="Removed"
              />
            ),
          },
        ]}
      />
    </Space>
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
              {
                key: 'maintenance-access',
                label: 'Maintenance access',
                children: (
                  <>
                    <Typography.Paragraph type="secondary">
                      While Maintenance is on (App tab), only these users can sign in and use the
                      app. Everyone else sees the maintenance screen and the server turns their
                      requests away. Staff are not let through automatically: add your own short ID
                      to test. The dashboard always works.
                    </Typography.Paragraph>
                    <MaintenanceAccess />
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
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [passwordFor, setPasswordFor] = useState<AdminRow | null>(null);
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
          scroll={{ x: 'max-content' }}
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
                  <Tooltip
                    title={
                      a._id === me?.uid
                        ? 'Use Change password in your profile menu'
                        : !a.email
                          ? 'This admin has no email sign-in'
                          : undefined
                    }
                  >
                    <Button
                      size="small"
                      icon={<KeyOutlined />}
                      disabled={a._id === me?.uid || !a.email}
                      onClick={() => setPasswordFor(a)}
                    >
                      Set password
                    </Button>
                  </Tooltip>
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
      <FormModal<{ password: string; confirm: string }>
        open={Boolean(passwordFor)}
        title={`Set password for ${passwordFor?.displayName ?? ''}`}
        okText="Set password"
        onClose={() => setPasswordFor(null)}
        submit={(v) =>
          send('post', `/admin/admins/${encodeURIComponent(passwordFor!._id)}/password`, {
            password: v.password,
          })
        }
      >
        {() => (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={`${passwordFor?.email ?? 'This admin'} is signed out everywhere and must sign in with the new password. Share it with them privately.`}
            />
            <Form.Item
              name="password"
              label="New password"
              extra={`At least ${ADMIN_PASSWORD_MIN_LENGTH} characters`}
              rules={newPasswordRules}
            >
              <Input.Password autoComplete="new-password" maxLength={ADMIN_PASSWORD_MAX_LENGTH} />
            </Form.Item>
            <Form.Item
              name="confirm"
              label="Confirm new password"
              dependencies={['password']}
              rules={confirmPasswordRules('password')}
            >
              <Input.Password autoComplete="new-password" maxLength={ADMIN_PASSWORD_MAX_LENGTH} />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}
