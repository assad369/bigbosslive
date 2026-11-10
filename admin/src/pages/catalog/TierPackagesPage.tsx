import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  MAX_GRANT_DAYS,
  VIP_TIERS,
  type AdminTierPackage,
  type BadgeBlendMode,
} from '@bigboss/shared';
import { send } from '../../lib/api';
import { num } from '../../lib/format';
import { ActionButton, PageHeader, ToggleSwitch, VipTag } from '../../components/common';
import { FormModal } from '../../components/FormModal';
import { MediaUpload } from '../../components/MediaUpload';
import { ServerTable } from '../../components/ServerTable';
import { TierBadgePreview } from '../../components/TierBadgePreview';

interface TierPackageForm {
  tier: number;
  name: string;
  priceDiamonds: number;
  durationDays: number;
  sortOrder: number;
  badgeUrl: string | null;
  badgeSvgaUrl: string | null;
  badgeMp4Url: string | null;
  badgeBlendMode: BadgeBlendMode;
  active: boolean;
}

const NEW_PACKAGE: Partial<TierPackageForm> = {
  durationDays: 30,
  sortOrder: 0,
  badgeUrl: null,
  badgeSvgaUrl: null,
  badgeMp4Url: null,
  badgeBlendMode: 'normal',
  active: true,
};

const TIER_HINTS: Record<number, string> = {
  1: 'Entry tier. Ranks below VVIP.',
  2: 'Ranks above VIP in viewer lists and on the Popular tab.',
  3: 'Ranks above VVIP. Rose pill and chat tint.',
  4: 'The top tier: first in viewer lists and on the Popular tab.',
};

const tierOptions = [...VIP_TIERS].reverse().map((t) => ({ value: t.tier, label: t.label }));

const IMAGE_TYPES = ['image/png', 'image/webp', 'image/jpeg', 'image/gif'] as const;

function toForm(p: AdminTierPackage): TierPackageForm {
  return {
    tier: p.tier,
    name: p.name,
    priceDiamonds: p.priceDiamonds,
    durationDays: p.durationDays,
    sortOrder: p.sortOrder,
    badgeUrl: p.badge.imageUrl,
    badgeSvgaUrl: p.badge.svgaUrl,
    badgeMp4Url: p.badge.mp4Url,
    badgeBlendMode: p.badge.blendMode,
    active: p.active,
  };
}

/** Tier packages (VIP < VVIP < Crown < King): badge artwork users buy and wear on the avatar. */
export function TierPackagesPage() {
  const [params, setParams] = useSearchParams();
  const tier = Number(params.get('tier')) || undefined;
  const [status, setStatus] = useState<'active' | 'inactive' | undefined>();
  const [q, setQ] = useState<string | undefined>();
  const [editing, setEditing] = useState<AdminTierPackage | 'new' | null>(null);
  const inv = [['tier-packages'], ['tier-package-picker']];
  const setTier = (t: number | undefined) =>
    setParams((p) => {
      if (t) p.set('tier', String(t));
      else p.delete('tier');
      return p;
    });

  return (
    <>
      <PageHeader
        title="Tier Packages"
        subtitle="VIP < VVIP < Crown < King. Each package is a badge drawn at the bottom-right of the avatar. Users buy several, keep them in an inventory and wear one at a time; the worn package sets their tier."
      />
      <ServerTable<AdminTierPackage>
        queryKey="tier-packages"
        url="/admin/tier-packages"
        filters={{ tier, status, q }}
        rowKey="id"
        pageSize={25}
        title={
          <Space wrap className="bb-filter-bar" style={{ padding: '12px 0' }}>
            <Segmented
              value={tier ?? 0}
              onChange={(v) => setTier(Number(v) || undefined)}
              options={[
                { value: 0, label: 'All' },
                ...[...VIP_TIERS].map((t) => ({ value: t.tier, label: t.label })),
              ]}
            />
            <Select
              allowClear
              placeholder="Any status"
              style={{ width: 130 }}
              value={status}
              onChange={setStatus}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
              ]}
            />
            <Input.Search
              allowClear
              placeholder="Search by name"
              style={{ width: 200 }}
              onSearch={(v) => setQ(v.trim() || undefined)}
            />
          </Space>
        }
        toolbar={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            Add Package
          </Button>
        }
        columns={[
          {
            title: 'Package',
            key: 'p',
            render: (_, p) => (
              <Space>
                <TierBadgePreview badge={p.badge} size={44} />
                <div>
                  <Typography.Text strong>{p.name}</Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    ID: {p.id}
                  </Typography.Text>
                </div>
              </Space>
            ),
          },
          {
            title: 'Format',
            key: 'f',
            render: (_, p) => (
              <Space size={2} wrap>
                {p.badge.mp4Url && <Tag color="geekblue">MP4</Tag>}
                {p.badge.svgaUrl && <Tag color="purple">SVGA</Tag>}
                {p.badge.imageUrl && <Tag>image</Tag>}
                {p.badge.mp4Url && p.badge.blendMode === 'additive' && (
                  <Tag color="cyan">additive</Tag>
                )}
              </Space>
            ),
          },
          {
            title: 'Price',
            dataIndex: 'priceDiamonds',
            render: (v: number) => <Tag color="gold">💎 {num(v)}</Tag>,
          },
          { title: 'Validity', dataIndex: 'durationDays', render: (d: number) => `${d} days` },
          { title: 'Holders', dataIndex: 'ownerCount', render: num },
          { title: 'Order', dataIndex: 'sortOrder' },
          {
            title: 'Active',
            dataIndex: 'active',
            render: (a: boolean, p) => (
              <ToggleSwitch
                checked={a}
                onToggle={(active) => send('patch', `/admin/tier-packages/${p.id}`, { active })}
                invalidate={inv}
              />
            ),
          },
          { title: 'Tier', dataIndex: 'tier', render: (t: number) => <VipTag tier={t} /> },
          {
            title: '',
            key: 'actions',
            render: (_, p) => (
              <Space size={4}>
                <Button size="small" onClick={() => setEditing(p)}>
                  Edit
                </Button>
                <Tooltip
                  title={
                    p.ownerCount
                      ? 'Users hold this package. Deactivate it instead; holders keep wearing it until it expires.'
                      : 'Delete permanently'
                  }
                >
                  <span>
                    <ActionButton
                      danger
                      type="text"
                      icon={<DeleteOutlined />}
                      label=""
                      disabled={p.ownerCount > 0}
                      confirm={`Delete “${p.name}” permanently?`}
                      run={() => send('delete', `/admin/tier-packages/${p.id}`)}
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
      <FormModal<TierPackageForm>
        open={editing !== null}
        title={editing === 'new' ? 'Add tier package' : 'Edit tier package'}
        onClose={() => setEditing(null)}
        initialValues={
          editing && editing !== 'new' ? toForm(editing) : { ...NEW_PACKAGE, tier: tier ?? 1 }
        }
        invalidate={inv}
        submit={(v) =>
          editing === 'new'
            ? send('post', '/admin/tier-packages', v)
            : send('patch', `/admin/tier-packages/${(editing as AdminTierPackage).id}`, {
                ...v,
                tier: undefined,
              })
        }
      >
        {() => (
          <>
            <Form.Item noStyle dependencies={['tier']}>
              {({ getFieldValue }) => (
                <Form.Item
                  name="tier"
                  label="Tier"
                  rules={[{ required: true }]}
                  extra={
                    editing !== 'new'
                      ? "A package's tier can't change once created."
                      : TIER_HINTS[getFieldValue('tier') as number]
                  }
                >
                  <Segmented options={tierOptions} disabled={editing !== 'new'} />
                </Form.Item>
              )}
            </Form.Item>
            <Form.Item name="name" label="Name" rules={[{ required: true, max: 40 }]}>
              <Input />
            </Form.Item>
            <Space size="large" wrap>
              <Form.Item name="priceDiamonds" label="Price (diamonds)" rules={[{ required: true }]}>
                <InputNumber min={0} />
              </Form.Item>
              <Form.Item name="durationDays" label="Validity (days)" rules={[{ required: true }]}>
                <InputNumber min={1} max={MAX_GRANT_DAYS} />
              </Form.Item>
              <Form.Item name="sortOrder" label="Sort">
                <InputNumber />
              </Form.Item>
            </Space>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="Playback: MP4 → SVGA → image"
              description="The app plays the best rendition it can and falls back to the next one. Add a static image so every surface has something to show."
            />
            <Form.Item
              noStyle
              dependencies={['badgeUrl', 'badgeSvgaUrl', 'badgeMp4Url', 'badgeBlendMode']}
            >
              {({ getFieldValue }) => (
                <Form.Item label="Preview">
                  <TierBadgePreview
                    size={120}
                    badge={{
                      imageUrl: getFieldValue('badgeUrl') ?? null,
                      svgaUrl: getFieldValue('badgeSvgaUrl') ?? null,
                      mp4Url: getFieldValue('badgeMp4Url') ?? null,
                      blendMode: getFieldValue('badgeBlendMode') ?? 'normal',
                    }}
                  />
                </Form.Item>
              )}
            </Form.Item>
            <Form.Item
              name="badgeUrl"
              label="Image (PNG/GIF/WEBP)"
              dependencies={['badgeSvgaUrl', 'badgeMp4Url']}
              rules={[
                { type: 'url' },
                ({ getFieldValue }) => ({
                  validator: (_, v) =>
                    v || getFieldValue('badgeSvgaUrl') || getFieldValue('badgeMp4Url')
                      ? Promise.resolve()
                      : Promise.reject(new Error('Add at least one rendition of the badge')),
                }),
              ]}
              extra="The static fallback, and the only rendition on tiny avatars."
            >
              <MediaUpload kind="tier-badge" only={IMAGE_TYPES} />
            </Form.Item>
            <Form.Item name="badgeSvgaUrl" label="SVGA" rules={[{ type: 'url' }]}>
              <MediaUpload kind="tier-badge" only={['application/octet-stream']} />
            </Form.Item>
            <Form.Item
              name="badgeMp4Url"
              label="MP4"
              rules={[{ type: 'url' }]}
              extra="Muted and looping. Keep it short (H.264) so phones can decode it."
            >
              <MediaUpload kind="tier-badge" only={['video/mp4']} />
            </Form.Item>
            <Form.Item noStyle dependencies={['badgeMp4Url', 'badgeUrl', 'badgeSvgaUrl']}>
              {({ getFieldValue }) => {
                const mp4 = getFieldValue('badgeMp4Url');
                return (
                  <>
                    {mp4 && (
                      <Form.Item name="badgeBlendMode" label="MP4 blend mode">
                        <Select
                          options={[
                            { value: 'normal', label: 'Normal (opaque)' },
                            { value: 'additive', label: 'Additive — black becomes transparent' },
                          ]}
                        />
                      </Form.Item>
                    )}
                    {mp4 && !getFieldValue('badgeUrl') && (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginBottom: 16 }}
                        message="No static image"
                        description="Where the MP4 can't play (busy decoders, small avatars), nothing but the SVGA will show. Add a PNG too."
                      />
                    )}
                  </>
                );
              }}
            </Form.Item>
            <Form.Item name="active" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}
