import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  Col,
  ColorPicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Pagination,
  Row,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  GiftOutlined,
  PlusOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COSMETIC_TYPES,
  STORE_COSMETIC_TYPES,
  FRAME_FORMATS,
  MAX_GRANT_DAYS,
  MAX_LEVEL,
  MEDIA_TYPES,
  VIP_TIERS,
  buildDefaultLevels,
  vipTierLabel,
  type AdminCosmetic,
  type Cosmetic,
  type CosmeticType,
  type Gift,
} from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { money, num } from '../../lib/format';
import { ActionButton, FilterBar, PageHeader, ToggleSwitch, VipTag } from '../../components/common';
import { AssignDecorationModal } from '../../components/AssignDecorationModal';
import { cosmeticTypeLabel } from '../../lib/decorations';
import { DecorationThumb } from '../../components/CosmeticPicker';
import { FormModal } from '../../components/FormModal';
import { MediaUpload } from '../../components/MediaUpload';
import { ServerTable } from '../../components/ServerTable';
import { UploadTrackerProvider, useUploadTracker } from '../../components/uploadTracker';
import { useIsMobile } from '../../lib/responsive';
import { brand } from '../../theme';
import { BulkDecorationsModal } from './BulkDecorationsModal';

const card = { variant: 'borderless' as const, styles: { body: { padding: 0 } } };
const animationOptions = ['none', 'svga', 'lottie', 'mp4'].map((v) => ({ value: v, label: v }));
const tierOptions = VIP_TIERS.map((t) => ({ value: t.tier, label: `${t.tier} · ${t.label}` }));
const tierRequiredOptions = [{ value: 0, label: 'Anyone' }, ...tierOptions];

// ── Gifts ────────────────────────────────────────────────────────────────────

type GiftForm = Omit<Gift, 'id'>;
type GiftStatus = 'all' | 'active' | 'inactive';

const GIFT_CATEGORIES = ['popular', 'luxury', 'exclusive', 'event'];
const GIFT_PAGE_SIZE = 50;
const GIFT_MOBILE_PAGE_SIZE = 20;
const giftCategoryOptions = GIFT_CATEGORIES.map((c) => ({ value: c, label: c }));
const giftStatusOptions: { value: GiftStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

/** "VVIP+" for a gift that needs a tier, null when anyone can send it. */
function giftTierLabel(tier: number): string | null {
  if (!tier) return null;
  return `${vipTierLabel(tier) ?? `Tier ${tier}`}+`;
}

export function GiftsPage() {
  const mobile = useIsMobile();
  const [editing, setEditing] = useState<Gift | 'new' | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | undefined>();
  const [status, setStatus] = useState<GiftStatus>('all');
  const q = useQuery({
    queryKey: ['gifts'],
    queryFn: () => get<{ items: Gift[] }>('/admin/gifts'),
  });
  const inv = [['gifts']];
  const all = useMemo(() => q.data?.items ?? [], [q.data]);

  // Categories outside the usual set (older data) still show up in the filter.
  const categoryOptions = useMemo(() => {
    const extra = [...new Set(all.map((g) => g.category))].filter(
      (c) => !GIFT_CATEGORIES.includes(c),
    );
    return [...giftCategoryOptions, ...extra.map((c) => ({ value: c, label: c }))];
  }, [all]);

  const gifts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter(
      (g) =>
        (!needle || g.name.toLowerCase().includes(needle)) &&
        (!category || g.category === category) &&
        (status === 'all' || g.active === (status === 'active')),
    );
  }, [all, search, category, status]);

  // Paging is remembered per filter set, so new filters start back on page 1.
  const filterKey = JSON.stringify([search, category, status]);
  const [paging, setPaging] = useState({ filterKey, page: 1 });
  const page = paging.filterKey === filterKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ filterKey, page: p });

  const filters = (
    <FilterBar>
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="Search gifts"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: 200 }}
      />
      <Select
        allowClear
        placeholder="All categories"
        value={category}
        onChange={setCategory}
        options={categoryOptions}
        style={{ width: 160 }}
      />
      <Segmented<GiftStatus> value={status} onChange={setStatus} options={giftStatusOptions} />
    </FilterBar>
  );

  const count = (
    <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
      {gifts.length === all.length
        ? `${num(all.length)} gifts`
        : `${num(gifts.length)} of ${num(all.length)} gifts`}
    </Typography.Text>
  );

  return (
    <>
      <PageHeader
        title="Gifts"
        subtitle="Gifts are deactivated, never deleted — history references them"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            block={mobile}
            onClick={() => setEditing('new')}
          >
            New gift
          </Button>
        }
      />
      <Card
        {...card}
        title={count}
        // A card header is one line: on a phone the filters get their own row.
        extra={mobile ? undefined : filters}
      >
        {mobile && <div className="bb-table-toolbar">{filters}</div>}
        {q.error && (
          <Alert
            type="error"
            showIcon
            message={(q.error as Error).message}
            style={{ margin: 16 }}
          />
        )}
        {mobile ? (
          <GiftMobileList
            gifts={gifts}
            loading={q.isLoading}
            page={page}
            onPage={setPage}
            onEdit={setEditing}
            invalidate={inv}
          />
        ) : (
          <Table<Gift>
            rowKey="id"
            loading={q.isLoading}
            dataSource={gifts}
            pagination={{
              current: page,
              pageSize: GIFT_PAGE_SIZE,
              showSizeChanger: false,
              showTotal: (t) => `${t.toLocaleString()} total`,
              onChange: setPage,
            }}
            scroll={{ x: 'max-content' }}
            columns={[
              {
                title: 'Gift',
                key: 'g',
                fixed: 'left',
                render: (_, g) => (
                  <Space>
                    <Avatar
                      shape="square"
                      src={g.iconUrl}
                      size={40}
                      style={{ background: brand.palette.champagne, flexShrink: 0 }}
                    />
                    <Typography.Text
                      strong
                      ellipsis={{ tooltip: g.name }}
                      style={{ maxWidth: 200 }}
                    >
                      {g.name}
                    </Typography.Text>
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
                render: (v: number) => giftTierLabel(v) ?? '—',
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
                fixed: 'right',
                render: (_, g) => (
                  <Button size="small" onClick={() => setEditing(g)}>
                    Edit
                  </Button>
                ),
              },
            ]}
          />
        )}
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
            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item name="price" label="Price (diamonds)" rules={[{ required: true }]}>
                  <InputNumber min={1} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="category" label="Category" rules={[{ required: true }]}>
                  <Select options={giftCategoryOptions} />
                </Form.Item>
              </Col>
            </Row>
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
            <Row gutter={12}>
              <Col xs={24} sm={10}>
                <Form.Item
                  name="animationFormat"
                  label="Animation format"
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
              </Col>
            </Row>
            <Row gutter={12}>
              <Col xs={24} sm={10}>
                <Form.Item name="vipTierRequired" label="VIP tier required">
                  <Select options={tierRequiredOptions} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} sm={8}>
                <Form.Item name="sortOrder" label="Sort order">
                  <InputNumber style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col xs={12} sm={6}>
                <Form.Item name="active" label="Active" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
            </Row>
          </>
        )}
      </FormModal>
    </>
  );
}

/** Phones: one compact row per gift instead of the wide table. */
function GiftMobileList({
  gifts,
  loading,
  page,
  onPage,
  onEdit,
  invalidate,
}: {
  gifts: Gift[];
  loading: boolean;
  page: number;
  onPage: (page: number) => void;
  onEdit: (gift: Gift) => void;
  invalidate: string[][];
}) {
  if (loading) {
    return (
      <div style={{ padding: 12 }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} avatar={{ shape: 'square', size: 48 }} active paragraph={{ rows: 1 }} />
        ))}
      </div>
    );
  }
  if (gifts.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 24 }} />;
  }
  const rows = gifts.slice((page - 1) * GIFT_MOBILE_PAGE_SIZE, page * GIFT_MOBILE_PAGE_SIZE);
  return (
    <>
      {rows.map((g) => {
        const tier = giftTierLabel(g.vipTierRequired);
        return (
          <div
            key={g.id}
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
              padding: 12,
              borderBottom: '1px solid rgba(43, 33, 24, 0.06)',
            }}
          >
            <Avatar
              shape="square"
              src={g.iconUrl}
              size={48}
              style={{
                background: brand.palette.champagne,
                flexShrink: 0,
                opacity: g.active ? 1 : 0.5,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Typography.Text
                strong
                ellipsis
                type={g.active ? undefined : 'secondary'}
                style={{ display: 'block' }}
              >
                {g.name}
              </Typography.Text>
              <Typography.Text style={{ display: 'block' }}>{num(g.price)} 💎</Typography.Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                <Tag style={{ marginInlineEnd: 0 }}>{g.category}</Tag>
                {g.animationFormat !== 'none' && (
                  <Tag style={{ marginInlineEnd: 0 }}>{g.animationFormat}</Tag>
                )}
                {tier && (
                  <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                    {tier}
                  </Tag>
                )}
                <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                  #{g.sortOrder}
                </Tag>
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 10,
                flexShrink: 0,
              }}
            >
              <ToggleSwitch
                checked={g.active}
                onToggle={(active) => send('patch', `/admin/gifts/${g.id}`, { active })}
                invalidate={invalidate}
              />
              <Button size="small" onClick={() => onEdit(g)}>
                Edit
              </Button>
            </div>
          </div>
        );
      })}
      {gifts.length > GIFT_MOBILE_PAGE_SIZE && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
          <Pagination
            simple
            current={page}
            pageSize={GIFT_MOBILE_PAGE_SIZE}
            total={gifts.length}
            onChange={onPage}
          />
        </div>
      )}
    </>
  );
}

// ── Decorations ──────────────────────────────────────────────────────────────────

type DecorationForm = Omit<Cosmetic, 'id'>;
const NEW_DECORATION: Partial<DecorationForm> = {
  type: 'frame',
  animationFormat: 'svga',
  durationDays: 30,
  vipTierRequired: 0,
  vipIncluded: false,
  priceDiamonds: 0,
  active: true,
  sortOrder: 0,
  previewUrl: null,
};

const typeOptions = COSMETIC_TYPES.map((t) => ({ value: t, label: cosmeticTypeLabel(t) }));
/** New items: only types the app can show (chat bubbles have no design yet). */
const newTypeOptions = STORE_COSMETIC_TYPES.map((t) => ({
  value: t,
  label: cosmeticTypeLabel(t),
}));
const frameFormatOptions = animationOptions.filter((o) =>
  (FRAME_FORMATS as readonly string[]).includes(o.value),
);

export function StorePage() {
  return (
    <>
      <PageHeader
        title="Decorations store"
        subtitle="An unlimited library of frames, entrance effects and other decorations. Tier badges live under Tier Packages."
      />
      <DecorationsTab />
    </>
  );
}

interface DecorationFilters {
  type?: CosmeticType;
  vipTier?: number;
  access?: 'store' | 'included';
  status?: 'active' | 'inactive';
  q?: string;
}

/** The decoration library: paged on the server, so it scales to any number of items. */
function DecorationsTab() {
  const [filters, setFilters] = useState<DecorationFilters>({});
  const [editing, setEditing] = useState<AdminCosmetic | 'new' | null>(null);
  const [assigning, setAssigning] = useState<AdminCosmetic | null>(null);
  const [bulk, setBulk] = useState(false);
  const set = (p: Partial<DecorationFilters>) => setFilters((f) => ({ ...f, ...p }));
  const inv = [['cosmetics'], ['cosmetic-picker']];

  return (
    <>
      <ServerTable<AdminCosmetic>
        queryKey="cosmetics"
        url="/admin/cosmetics"
        filters={filters as Record<string, unknown>}
        rowKey="id"
        pageSize={25}
        title={
          <Space wrap className="bb-filter-bar" style={{ padding: '12px 0' }}>
            <Segmented
              value={filters.type ?? 'all'}
              onChange={(v) => set({ type: v === 'all' ? undefined : (v as CosmeticType) })}
              options={[{ value: 'all', label: 'All' }, ...typeOptions]}
            />
            <Select
              allowClear
              placeholder="Any tier"
              style={{ width: 130 }}
              value={filters.vipTier}
              onChange={(v?: number) => set({ vipTier: v })}
              options={tierRequiredOptions}
            />
            <Select
              allowClear
              placeholder="Any access"
              style={{ width: 170 }}
              value={filters.access}
              onChange={(v?: DecorationFilters['access']) => set({ access: v })}
              options={[
                { value: 'store', label: 'Sold in store' },
                { value: 'included', label: 'Included with a tier' },
              ]}
            />
            <Select
              allowClear
              placeholder="Any status"
              style={{ width: 130 }}
              value={filters.status}
              onChange={(v?: DecorationFilters['status']) => set({ status: v })}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder="Search by name"
              style={{ width: 200 }}
              onSearch={(q) => set({ q: q.trim() || undefined })}
            />
          </Space>
        }
        toolbar={
          <Space wrap>
            <Button icon={<CloudUploadOutlined />} onClick={() => setBulk(true)}>
              Bulk upload
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
              New decoration
            </Button>
          </Space>
        }
        columns={[
          {
            title: 'Decoration',
            key: 'i',
            render: (_, c) => (
              <Space>
                <DecorationThumb item={c} size={44} />
                <div>
                  <Typography.Text strong>{c.name}</Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {c.animationFormat === 'none' ? 'image' : c.animationFormat}
                  </Typography.Text>
                </div>
              </Space>
            ),
          },
          {
            title: 'Type',
            dataIndex: 'type',
            render: (t: CosmeticType) => <Tag>{cosmeticTypeLabel(t)}</Tag>,
          },
          {
            title: 'Access',
            key: 'access',
            render: (_, c) =>
              c.vipIncluded ? (
                <Space size={4}>
                  <Tag color="gold">Included</Tag>
                  <VipTag tier={c.vipTierRequired} />
                </Space>
              ) : (
                <Space size={4}>
                  {c.priceDiamonds ? `${num(c.priceDiamonds)} 💎` : 'Free'}
                  {c.vipTierRequired > 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      · {vipTierLabel(c.vipTierRequired)}+
                    </Typography.Text>
                  )}
                </Space>
              ),
          },
          { title: 'Days', dataIndex: 'durationDays' },
          { title: 'Holders', dataIndex: 'ownerCount', render: num },
          { title: 'Order', dataIndex: 'sortOrder' },
          {
            title: 'Active',
            dataIndex: 'active',
            render: (a: boolean, c) => (
              <ToggleSwitch
                checked={a}
                onToggle={(active) => send('patch', `/admin/cosmetics/${c.id}`, { active })}
                invalidate={inv}
              />
            ),
          },
          {
            title: '',
            key: 'actions',
            render: (_, c) => (
              <Space size={4}>
                <Button size="small" onClick={() => setEditing(c)}>
                  Edit
                </Button>
                <Button size="small" icon={<GiftOutlined />} onClick={() => setAssigning(c)}>
                  Assign
                </Button>
                <Tooltip
                  title={
                    c.ownerCount
                      ? 'Users hold this decoration. Deactivate it instead.'
                      : 'Delete permanently'
                  }
                >
                  <span>
                    <ActionButton
                      danger
                      type="text"
                      icon={<DeleteOutlined />}
                      label=""
                      disabled={c.ownerCount > 0}
                      confirm={`Delete “${c.name}” permanently?`}
                      run={() => send('delete', `/admin/cosmetics/${c.id}`)}
                      invalidate={inv}
                      success="Deleted"
                    />
                  </span>
                </Tooltip>
              </Space>
            ),
          },
        ]}
      />
      <FormModal<DecorationForm>
        open={editing !== null}
        title={editing === 'new' ? 'New decoration' : 'Edit decoration'}
        onClose={() => setEditing(null)}
        initialValues={editing && editing !== 'new' ? editing : NEW_DECORATION}
        invalidate={inv}
        submit={(v) =>
          editing === 'new'
            ? send('post', '/admin/cosmetics', v)
            : send('patch', `/admin/cosmetics/${(editing as AdminCosmetic).id}`, v)
        }
      >
        {(form) => (
          <>
            <Space size="large" align="start">
              <Form.Item
                name="type"
                label="Type"
                rules={[{ required: true }]}
                style={{ width: 190 }}
                extra={editing !== 'new' ? "Type can't change once created." : undefined}
              >
                <Select
                  options={editing === 'new' ? newTypeOptions : typeOptions}
                  disabled={editing !== 'new'}
                />
              </Form.Item>
              <Form.Item noStyle dependencies={['type']}>
                {({ getFieldValue }) => (
                  <Form.Item
                    name="animationFormat"
                    label="Format"
                    style={{ width: 130 }}
                    rules={[{ required: true }]}
                  >
                    <Select
                      options={
                        getFieldValue('type') === 'frame' ? frameFormatOptions : animationOptions
                      }
                    />
                  </Form.Item>
                )}
              </Form.Item>
            </Space>
            <Form.Item name="name" label="Name" rules={[{ required: true, max: 40 }]}>
              <Input />
            </Form.Item>
            <Form.Item
              name="assetUrl"
              label="Asset"
              rules={[{ required: true, message: 'Upload the asset' }, { type: 'url' }]}
              extra="Image, SVGA, Lottie (.json) or MP4 (not for frames). The format is set from the file."
            >
              <MediaUpload
                kind="cosmetic-asset"
                onUploaded={({ type }) =>
                  form.setFieldValue('animationFormat', MEDIA_TYPES[type].format)
                }
              />
            </Form.Item>
            <Form.Item
              name="previewUrl"
              label="Preview image"
              rules={[{ type: 'url' }]}
              extra="Optional still image for the store grid."
            >
              <MediaUpload kind="cosmetic-preview" />
            </Form.Item>
            <Space size="large" align="start" wrap>
              <Form.Item name="vipTierRequired" label="Tier">
                <Select
                  options={tierRequiredOptions}
                  style={{ width: 140 }}
                  onChange={(t: number) => t === 0 && form.setFieldValue('vipIncluded', false)}
                />
              </Form.Item>
              <Form.Item noStyle dependencies={['vipTierRequired']}>
                {({ getFieldValue }) => (
                  <Form.Item
                    name="vipIncluded"
                    label="Included with tier"
                    valuePropName="checked"
                    tooltip="Holders of this tier or higher wear it free; it is not sold in the store."
                  >
                    <Switch disabled={!getFieldValue('vipTierRequired')} />
                  </Form.Item>
                )}
              </Form.Item>
              <Form.Item noStyle dependencies={['vipIncluded']}>
                {({ getFieldValue }) => (
                  <Form.Item name="priceDiamonds" label="Price" rules={[{ required: true }]}>
                    <InputNumber min={0} disabled={!!getFieldValue('vipIncluded')} />
                  </Form.Item>
                )}
              </Form.Item>
              <Form.Item name="durationDays" label="Days" rules={[{ required: true }]}>
                <InputNumber min={1} max={MAX_GRANT_DAYS} />
              </Form.Item>
            </Space>
            <Space size="large">
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
      <AssignDecorationModal
        open={assigning !== null}
        item={assigning}
        onClose={() => setAssigning(null)}
      />
      <BulkDecorationsModal open={bulk} onClose={() => setBulk(false)} />
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

/** Consecutive levels sharing a name and colour, shown as the ladder's tier bands. */
function levelBands(rows: LevelRow[]) {
  const bands: { name: string; color: string; from: number; to: number }[] = [];
  for (const r of rows) {
    const last = bands.at(-1);
    if (last && last.name === r.name && last.color === r.color) last.to = r.level;
    else bands.push({ name: r.name, color: r.color, from: r.level, to: r.level });
  }
  return bands;
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const bands = useMemo(() => levelBands(rows), [rows]);

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

  // Keyed by level, not the render index: antd restarts that index on every table page.
  const update = (level: number, patch: Partial<LevelRow>) =>
    setRows((rs) => rs.map((r) => (r.level === level ? { ...r, ...patch } : r)));
  const loadDefaults = () =>
    modal.confirm({
      title: `Load the default ${MAX_LEVEL} levels?`,
      content:
        'This replaces the table below with the default ladder (Bronze to Supreme). Nothing changes until you press Save ladder.',
      okText: 'Load defaults',
      onOk: () => {
        setRows(buildDefaultLevels());
        setPage(1);
      },
    });
  const invalid = rows.some((r, i) => i > 0 && r.pointsRequired <= rows[i - 1]!.pointsRequired);

  return (
    <>
      <PageHeader
        title="Levels"
        subtitle="Level points = diamonds recharged + gifts received × weight (see Settings → Economy)"
        extra={
          <>
            <Button icon={<UndoOutlined />} onClick={loadDefaults}>
              Load default {MAX_LEVEL} levels
            </Button>
            <Button
              icon={<PlusOutlined />}
              disabled={rows.length >= MAX_LEVEL}
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
      {bands.length > 0 && (
        <Card variant="borderless" size="small" style={{ marginBottom: 16 }} title="Tier bands">
          <Space wrap>
            {bands.map((b) => (
              <Tag key={b.from} color={b.color} style={{ color: '#fff' }}>
                {b.name} · Lv {b.from === b.to ? b.from : `${b.from}–${b.to}`}
              </Tag>
            ))}
          </Space>
        </Card>
      )}
      <UploadTrackerProvider value={tracker}>
        <Card
          {...card}
          title={`Levels (${num(rows.length)})`}
          extra={
            <InputNumber
              min={1}
              max={Math.max(1, rows.length)}
              precision={0}
              placeholder="Go to level"
              style={{ width: 130 }}
              onPressEnter={(e) => {
                const v = Number((e.target as HTMLInputElement).value);
                const i = rows.findIndex((r) => r.level >= v);
                if (v >= 1 && rows.length) {
                  setPage(Math.floor((i < 0 ? rows.length - 1 : i) / pageSize) + 1);
                }
              }}
            />
          }
        >
          <Table<LevelRow>
            rowKey="level"
            scroll={{ x: 'max-content' }}
            loading={loading}
            dataSource={rows}
            pagination={{
              current: page,
              pageSize,
              showSizeChanger: true,
              pageSizeOptions: [25, 50, 100],
              onChange: (p, size) => {
                setPage(size === pageSize ? p : 1);
                setPageSize(size);
              },
            }}
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
                render: (_, r) => (
                  <InputNumber
                    min={0}
                    value={r.pointsRequired}
                    onChange={(v) => update(r.level, { pointsRequired: v ?? 0 })}
                    style={{ width: 180 }}
                    formatter={(v) => num(Number(v))}
                  />
                ),
              },
              {
                title: 'Name',
                key: 'n',
                render: (_, r) => (
                  <Input
                    value={r.name}
                    onChange={(e) => update(r.level, { name: e.target.value })}
                    style={{ width: 180 }}
                  />
                ),
              },
              {
                title: 'Icon',
                key: 'i',
                render: (_, r) => (
                  <MediaUpload
                    compact
                    kind="level-icon"
                    value={r.iconUrl}
                    onChange={(iconUrl) => update(r.level, { iconUrl })}
                  />
                ),
              },
              {
                title: 'Colour',
                key: 'c',
                render: (_, r) => (
                  <ColorPicker
                    value={r.color}
                    onChangeComplete={(c) =>
                      update(r.level, { color: c.toHexString().toUpperCase() })
                    }
                  />
                ),
              },
              {
                title: '',
                key: 'd',
                render: (_, r) =>
                  r.level === rows.at(-1)?.level && (
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
          scroll={{ x: 'max-content' }}
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
