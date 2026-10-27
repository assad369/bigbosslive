import { useState } from 'react';
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  ColorPicker,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MEDIA_TYPES, type Cosmetic, type Gift } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { money, num } from '../../lib/format';
import { PageHeader, ToggleSwitch } from '../../components/common';
import { FormModal } from '../../components/FormModal';
import { MediaUpload } from '../../components/MediaUpload';
import { UploadTrackerProvider, useUploadTracker } from '../../components/uploadTracker';
import { brand } from '../../theme';

const card = { variant: 'borderless' as const, styles: { body: { padding: 0 } } };
const animationOptions = ['none', 'svga', 'lottie', 'mp4'].map((v) => ({ value: v, label: v }));

// ── Gifts ────────────────────────────────────────────────────────────────────

type GiftForm = Omit<Gift, 'id'>;

export function GiftsPage() {
  const [editing, setEditing] = useState<Gift | 'new' | null>(null);
  const q = useQuery({
    queryKey: ['gifts'],
    queryFn: () => get<{ items: Gift[] }>('/admin/gifts'),
  });
  const inv = [['gifts']];
  return (
    <>
      <PageHeader
        title="Gifts"
        subtitle="Gifts are deactivated, never deleted — history references them"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            New gift
          </Button>
        }
      />
      <Card {...card}>
        <Table<Gift>
          rowKey="id"
          loading={q.isLoading}
          dataSource={q.data?.items ?? []}
          pagination={{ pageSize: 50 }}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: 'Gift',
              key: 'g',
              render: (_, g) => (
                <Space>
                  <Avatar
                    shape="square"
                    src={g.iconUrl}
                    size={40}
                    style={{ background: brand.palette.champagne }}
                  />
                  <Typography.Text strong>{g.name}</Typography.Text>
                </Space>
              ),
            },
            {
              title: 'Price',
              dataIndex: 'price',
              align: 'right',
              render: (p: number) => `${num(p)} 💎`,
            },
            { title: 'Category', dataIndex: 'category', render: (c: string) => <Tag>{c}</Tag> },
            { title: 'Animation', dataIndex: 'animationFormat' },
            {
              title: 'VIP',
              dataIndex: 'vipTierRequired',
              render: (v: number) => (v ? `VIP ${v}+` : '—'),
            },
            { title: 'Order', dataIndex: 'sortOrder' },
            {
              title: 'Active',
              dataIndex: 'active',
              render: (a: boolean, g) => (
                <ToggleSwitch
                  checked={a}
                  onToggle={(active) => send('patch', `/admin/gifts/${g.id}`, { active })}
                  invalidate={inv}
                />
              ),
            },
            {
              title: '',
              key: 'e',
              render: (_, g) => (
                <Button size="small" onClick={() => setEditing(g)}>
                  Edit
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <FormModal<GiftForm>
        open={editing !== null}
        title={editing === 'new' ? 'New gift' : 'Edit gift'}
        onClose={() => setEditing(null)}
        initialValues={
          editing && editing !== 'new'
            ? editing
            : {
                category: 'popular',
                animationFormat: 'none',
                active: true,
                sortOrder: 0,
                vipTierRequired: 0,
                animationUrl: null,
              }
        }
        invalidate={inv}
        submit={(v) =>
          editing === 'new'
            ? send('post', '/admin/gifts', v)
            : send('patch', `/admin/gifts/${(editing as Gift).id}`, v)
        }
      >
        {(form) => (
          <>
            <Form.Item name="name" label="Name" rules={[{ required: true, max: 40 }]}>
              <Input />
            </Form.Item>
            <Space.Compact block>
              <Form.Item
                name="price"
                label="Price (diamonds)"
                rules={[{ required: true }]}
                style={{ flex: 1 }}
              >
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="category"
                label="Category"
                rules={[{ required: true }]}
                style={{ flex: 1, marginLeft: 12 }}
              >
                <Select
                  options={['popular', 'luxury', 'exclusive', 'event'].map((c) => ({
                    value: c,
                    label: c,
                  }))}
                />
              </Form.Item>
            </Space.Compact>
            <Form.Item
              name="iconUrl"
              label="Icon"
              rules={[{ required: true, message: 'Upload an icon' }, { type: 'url' }]}
            >
              <MediaUpload kind="gift-icon" />
            </Form.Item>
            <Form.Item
              name="animationUrl"
              label="Animation"
              rules={[{ type: 'url' }]}
              extra="SVGA, Lottie (.json) or MP4. The format is set from the file."
            >
              <MediaUpload
                kind="gift-animation"
                onUploaded={({ type }) =>
                  form.setFieldValue('animationFormat', MEDIA_TYPES[type].format)
                }
              />
            </Form.Item>
            <Form.Item
              name="animationFormat"
              label="Animation format"
              style={{ width: 180 }}
              dependencies={['animationUrl']}
              rules={[
                ({ getFieldValue }) => ({
                  validator: (_, f: string) =>
                    !getFieldValue('animationUrl') || f !== 'none'
                      ? Promise.resolve()
                      : Promise.reject(new Error('Pick the animation format')),
                }),
              ]}
            >
              <Select options={animationOptions} />
            </Form.Item>
            <Space size="large">
              <Form.Item name="vipTierRequired" label="VIP tier required">
                <InputNumber min={0} max={10} />
              </Form.Item>
              <Form.Item name="sortOrder" label="Sort order">
                <InputNumber />
              </Form.Item>
              <Form.Item name="active" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Space>
          </>
        )}
      </FormModal>
    </>
  );
}

// ── VIP & cosmetics ──────────────────────────────────────────────────────────────

interface VipPackage {
  _id: string;
  tier: number;
  name: string;
  priceDiamonds: number;
  durationDays: number;
  perks: string[];
  badgeUrl: string | null;
  frameUrl: string | null;
  active: boolean;
  sortOrder: number;
}

export function StorePage() {
  const [vip, setVip] = useState<VipPackage | 'new' | null>(null);
  const [item, setItem] = useState<Cosmetic | 'new' | null>(null);
  const vipQ = useQuery({
    queryKey: ['vip-packages'],
    queryFn: () => get<{ items: VipPackage[] }>('/admin/vip-packages'),
  });
  const itemsQ = useQuery({
    queryKey: ['cosmetics'],
    queryFn: () => get<{ items: Cosmetic[] }>('/admin/cosmetics'),
  });

  return (
    <>
      <PageHeader title="VIP & store" subtitle="Memberships and cosmetics bought with diamonds" />
      <Tabs
        items={[
          {
            key: 'vip',
            label: 'VIP tiers',
            children: (
              <Card
                {...card}
                title=" "
                extra={
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setVip('new')}>
                    New tier
                  </Button>
                }
              >
                <Table<VipPackage>
                  rowKey="_id"
                  loading={vipQ.isLoading}
                  dataSource={vipQ.data?.items ?? []}
                  pagination={false}
                  columns={[
                    {
                      title: 'Tier',
                      dataIndex: 'tier',
                      render: (t: number) => <Tag color="gold">VIP {t}</Tag>,
                    },
                    { title: 'Name', dataIndex: 'name' },
                    {
                      title: 'Price',
                      dataIndex: 'priceDiamonds',
                      render: (p: number) => `${num(p)} 💎`,
                    },
                    { title: 'Days', dataIndex: 'durationDays' },
                    {
                      title: 'Perks',
                      dataIndex: 'perks',
                      render: (p: string[]) => p.map((x) => <Tag key={x}>{x}</Tag>),
                    },
                    {
                      title: 'Active',
                      dataIndex: 'active',
                      render: (a: boolean) => (a ? <Tag color="green">yes</Tag> : <Tag>no</Tag>),
                    },
                    {
                      title: '',
                      key: 'e',
                      render: (_, v) => (
                        <Button size="small" onClick={() => setVip(v)}>
                          Edit
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'items',
            label: 'Cosmetics',
            children: (
              <Card
                {...card}
                title=" "
                extra={
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setItem('new')}>
                    New item
                  </Button>
                }
              >
                <Table<Cosmetic>
                  rowKey="id"
                  loading={itemsQ.isLoading}
                  dataSource={itemsQ.data?.items ?? []}
                  pagination={{ pageSize: 50 }}
                  scroll={{ x: 'max-content' }}
                  columns={[
                    {
                      title: 'Item',
                      key: 'i',
                      render: (_, c) => (
                        <Space>
                          <Avatar shape="square" src={c.previewUrl ?? undefined} />
                          <Typography.Text strong>{c.name}</Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: 'Type',
                      dataIndex: 'type',
                      render: (t: string) => <Tag>{t.replace('_', ' ')}</Tag>,
                    },
                    {
                      title: 'Price',
                      dataIndex: 'priceDiamonds',
                      render: (p: number) => (p ? `${num(p)} 💎` : 'Free'),
                    },
                    { title: 'Days', dataIndex: 'durationDays' },
                    {
                      title: 'VIP',
                      dataIndex: 'vipTierRequired',
                      render: (v: number) => (v ? `VIP ${v}+` : '—'),
                    },
                    {
                      title: 'Active',
                      dataIndex: 'active',
                      render: (a: boolean) => (a ? <Tag color="green">yes</Tag> : <Tag>no</Tag>),
                    },
                    {
                      title: '',
                      key: 'e',
                      render: (_, c) => (
                        <Button size="small" onClick={() => setItem(c)}>
                          Edit
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
        ]}
      />
      <FormModal<Omit<VipPackage, '_id'>>
        open={vip !== null}
        title={vip === 'new' ? 'New VIP tier' : 'Edit VIP tier'}
        onClose={() => setVip(null)}
        initialValues={
          vip && vip !== 'new'
            ? vip
            : {
                durationDays: 30,
                perks: [],
                active: true,
                sortOrder: 0,
                badgeUrl: null,
                frameUrl: null,
              }
        }
        invalidate={[['vip-packages']]}
        submit={(v) =>
          vip === 'new'
            ? send('post', '/admin/vip-packages', v)
            : send('put', `/admin/vip-packages/${(vip as VipPackage)._id}`, v)
        }
      >
        {() => (
          <>
            <Space size="large">
              <Form.Item name="tier" label="Tier" rules={[{ required: true }]}>
                <InputNumber min={1} max={10} />
              </Form.Item>
              <Form.Item name="priceDiamonds" label="Price (diamonds)" rules={[{ required: true }]}>
                <InputNumber min={1} />
              </Form.Item>
              <Form.Item name="durationDays" label="Days" rules={[{ required: true }]}>
                <InputNumber min={1} max={366} />
              </Form.Item>
            </Space>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="perks" label="Perks">
              <Select mode="tags" tokenSeparators={[',']} />
            </Form.Item>
            <Form.Item name="badgeUrl" label="Badge" rules={[{ type: 'url' }]}>
              <MediaUpload kind="vip-badge" />
            </Form.Item>
            <Form.Item
              name="frameUrl"
              label="Avatar frame"
              rules={[{ type: 'url' }]}
              extra="Static image or SVGA."
            >
              <MediaUpload kind="vip-frame" />
            </Form.Item>
            <Space size="large">
              <Form.Item name="sortOrder" label="Sort">
                <InputNumber />
              </Form.Item>
              <Form.Item name="active" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Space>
          </>
        )}
      </FormModal>
      <FormModal<Omit<Cosmetic, 'id'> & { sortOrder: number }>
        open={item !== null}
        title={item === 'new' ? 'New store item' : 'Edit store item'}
        onClose={() => setItem(null)}
        initialValues={
          item && item !== 'new'
            ? { ...item, sortOrder: 0 }
            : {
                type: 'frame',
                animationFormat: 'svga',
                durationDays: 30,
                vipTierRequired: 0,
                priceDiamonds: 0,
                active: true,
                sortOrder: 0,
                previewUrl: null,
              }
        }
        invalidate={[['cosmetics']]}
        submit={(v) =>
          item === 'new'
            ? send('post', '/admin/cosmetics', v)
            : send('put', `/admin/cosmetics/${(item as Cosmetic).id}`, v)
        }
      >
        {(form) => (
          <>
            <Space size="large">
              <Form.Item
                name="type"
                label="Type"
                rules={[{ required: true }]}
                style={{ width: 180 }}
              >
                <Select
                  options={['frame', 'entry_animation', 'room_background', 'chat_bubble'].map(
                    (t) => ({ value: t, label: t.replace('_', ' ') }),
                  )}
                />
              </Form.Item>
              <Form.Item name="animationFormat" label="Format" style={{ width: 120 }}>
                <Select options={animationOptions} />
              </Form.Item>
            </Space>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item
              name="assetUrl"
              label="Asset"
              rules={[{ required: true, message: 'Upload the asset' }, { type: 'url' }]}
              extra="Image, SVGA, Lottie (.json) or MP4. The format is set from the file."
            >
              <MediaUpload
                kind="cosmetic-asset"
                onUploaded={({ type }) =>
                  form.setFieldValue('animationFormat', MEDIA_TYPES[type].format)
                }
              />
            </Form.Item>
            <Form.Item name="previewUrl" label="Preview image" rules={[{ type: 'url' }]}>
              <MediaUpload kind="cosmetic-preview" />
            </Form.Item>
            <Space size="large">
              <Form.Item name="priceDiamonds" label="Price" rules={[{ required: true }]}>
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item name="durationDays" label="Days" rules={[{ required: true }]}>
                <InputNumber min={1} />
              </Form.Item>
              <Form.Item name="vipTierRequired" label="VIP">
                <InputNumber min={0} max={10} />
              </Form.Item>
              <Form.Item name="active" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Space>
          </>
        )}
      </FormModal>
    </>
  );
}

// ── Levels ────────────────────────────────────────────────────────────────────

interface LevelRow {
  level: number;
  pointsRequired: number;
  name: string;
  color: string;
  iconUrl: string | null;
}

export function LevelsPage() {
  const q = useQuery({
    queryKey: ['levels'],
    queryFn: () => get<{ items: (Omit<LevelRow, 'level'> & { _id: number })[] }>('/admin/levels'),
  });
  // Remount the editor whenever fresh data arrives so its local draft starts from the server.
  return (
    <LevelsEditor
      key={q.dataUpdatedAt}
      loading={q.isLoading}
      initial={(q.data?.items ?? []).map(({ _id, ...r }) => ({ level: _id, ...r }))}
    />
  );
}

function LevelsEditor({ initial, loading }: { initial: LevelRow[]; loading: boolean }) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [rows, setRows] = useState<LevelRow[]>(initial);
  const [uploads, tracker] = useUploadTracker();

  const save = useMutation({
    mutationFn: () =>
      send<{ relevelRecommended: boolean }>('put', '/admin/levels', { items: rows }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['levels'] });
      modal.confirm({
        title: 'Ladder saved',
        content: 'Re-level every user now so stored levels match the new thresholds?',
        okText: 'Re-level users',
        onOk: async () => {
          const r = await send<{ scanned: number; updated: number }>(
            'post',
            '/admin/levels/relevel',
          );
          message.success(`Re-levelled ${num(r.updated)} of ${num(r.scanned)} users`);
        },
      });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const update = (i: number, patch: Partial<LevelRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const invalid = rows.some((r, i) => i > 0 && r.pointsRequired <= rows[i - 1]!.pointsRequired);

  return (
    <>
      <PageHeader
        title="Levels"
        subtitle="Level points = diamonds recharged + gifts received × weight (see Settings → Economy)"
        extra={
          <>
            <Button
              icon={<PlusOutlined />}
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  {
                    level: (rs.at(-1)?.level ?? 0) + 1,
                    pointsRequired: (rs.at(-1)?.pointsRequired ?? 0) + 1000,
                    name: `Level ${(rs.at(-1)?.level ?? 0) + 1}`,
                    color: brand.palette.gold,
                    iconUrl: null,
                  },
                ])
              }
            >
              Add level
            </Button>
            <Button
              type="primary"
              disabled={invalid || !rows.length || uploads > 0}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save ladder
            </Button>
          </>
        }
      />
      {invalid && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="Each level must require more points than the one before it."
        />
      )}
      <UploadTrackerProvider value={tracker}>
        <Card {...card}>
          <Table<LevelRow>
            rowKey="level"
            loading={loading}
            dataSource={rows}
            pagination={{ pageSize: 25 }}
            columns={[
              {
                title: 'Level',
                dataIndex: 'level',
                width: 80,
                render: (l: number, r) => (
                  <Tag color={r.color} style={{ color: '#fff' }}>
                    Lv {l}
                  </Tag>
                ),
              },
              {
                title: 'Points required',
                key: 'p',
                render: (_, r, i) => (
                  <InputNumber
                    min={0}
                    value={r.pointsRequired}
                    onChange={(v) => update(i, { pointsRequired: v ?? 0 })}
                    style={{ width: 180 }}
                    formatter={(v) => num(Number(v))}
                  />
                ),
              },
              {
                title: 'Name',
                key: 'n',
                render: (_, r, i) => (
                  <Input
                    value={r.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    style={{ width: 180 }}
                  />
                ),
              },
              {
                title: 'Icon',
                key: 'i',
                render: (_, r, i) => (
                  <MediaUpload
                    compact
                    kind="level-icon"
                    value={r.iconUrl}
                    onChange={(iconUrl) => update(i, { iconUrl })}
                  />
                ),
              },
              {
                title: 'Colour',
                key: 'c',
                render: (_, r, i) => (
                  <ColorPicker
                    value={r.color}
                    onChangeComplete={(c) => update(i, { color: c.toHexString().toUpperCase() })}
                  />
                ),
              },
              {
                title: '',
                key: 'd',
                render: (_, _r, i) =>
                  i === rows.length - 1 && (
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => setRows((rs) => rs.slice(0, -1))}
                    />
                  ),
              },
            ]}
          />
        </Card>
      </UploadTrackerProvider>
    </>
  );
}

// ── Recharge packages ─────────────────────────────────────────────────────────────

interface PackageRow {
  _id: string;
  sku: string;
  diamonds: number;
  bonusDiamonds: number;
  priceUsd: number;
  active: boolean;
  sortOrder: number;
}

export function PackagesPage() {
  const [editing, setEditing] = useState<PackageRow | 'new' | null>(null);
  const q = useQuery({
    queryKey: ['packages'],
    queryFn: () => get<{ items: PackageRow[] }>('/admin/recharge-packages'),
  });
  return (
    <>
      <PageHeader
        title="Recharge packages"
        subtitle="SKUs must match the product ids in Google Play Console and App Store Connect"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            New package
          </Button>
        }
      />
      <Card {...card}>
        <Table<PackageRow>
          rowKey="_id"
          loading={q.isLoading}
          dataSource={q.data?.items ?? []}
          pagination={false}
          columns={[
            {
              title: 'SKU',
              dataIndex: 'sku',
              render: (s: string) => <Typography.Text code>{s}</Typography.Text>,
            },
            { title: 'Diamonds', dataIndex: 'diamonds', render: num },
            {
              title: 'Bonus',
              dataIndex: 'bonusDiamonds',
              render: (b: number) => (b ? `+${num(b)}` : '—'),
            },
            { title: 'Price', dataIndex: 'priceUsd', render: money },
            {
              title: 'Active',
              dataIndex: 'active',
              render: (a: boolean) => (a ? <Tag color="green">yes</Tag> : <Tag>no</Tag>),
            },
            {
              title: '',
              key: 'e',
              render: (_, p) => (
                <Button size="small" onClick={() => setEditing(p)}>
                  Edit
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <FormModal<Omit<PackageRow, '_id'>>
        open={editing !== null}
        title={editing === 'new' ? 'New package' : 'Edit package'}
        onClose={() => setEditing(null)}
        initialValues={
          editing && editing !== 'new' ? editing : { bonusDiamonds: 0, active: true, sortOrder: 0 }
        }
        invalidate={[['packages']]}
        submit={(v) =>
          editing === 'new'
            ? send('post', '/admin/recharge-packages', v)
            : send('put', `/admin/recharge-packages/${(editing as PackageRow)._id}`, v)
        }
      >
        {() => (
          <>
            <Form.Item name="sku" label="Store product id (SKU)" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Space size="large">
              <Form.Item name="diamonds" label="Diamonds" rules={[{ required: true }]}>
                <InputNumber min={1} />
              </Form.Item>
              <Form.Item name="bonusDiamonds" label="Bonus">
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item name="priceUsd" label="Price (USD)" rules={[{ required: true }]}>
                <InputNumber min={0.01} step={0.01} />
              </Form.Item>
            </Space>
            <Space size="large">
              <Form.Item name="sortOrder" label="Sort">
                <InputNumber />
              </Form.Item>
              <Form.Item name="active" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Space>
          </>
        )}
      </FormModal>
    </>
  );
}
