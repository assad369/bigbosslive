import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  InputNumber,
  Row,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CrownOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  MAX_GRANT_DAYS,
  VIP_TIERS,
  type AdminTierPackage,
  type OwnedTierPackage,
} from '@bigboss/shared';
import { get, send, useIntentKey } from '../lib/api';
import { dateTime, num } from '../lib/format';
import { useAuth } from '../auth/useAuth';
import { brand } from '../theme';
import { ActionButton, VipTag } from './common';
import { FormModal } from './FormModal';
import { TierBadgePreview } from './TierBadgePreview';

const tierFilterOptions = [
  { value: 0, label: 'All' },
  ...[...VIP_TIERS].reverse().map((t) => ({ value: t.tier, label: t.label })),
];

/**
 * Give a user a tier package for free. It replaces what they wear now and is worn at once.
 * Inactive packages are listed too: that is how event-only badges reach users.
 */
export function AssignTierPackageModal({
  uid,
  open,
  onClose,
}: {
  uid: string;
  open: boolean;
  onClose: () => void;
}) {
  const intentKey = useIntentKey(open);
  const [tier, setTier] = useState(0);
  const [picked, setPicked] = useState<AdminTierPackage | null>(null);
  const initialValues = useMemo(() => ({}), []);
  const list = useQuery({
    queryKey: ['tier-package-picker', tier],
    queryFn: () =>
      get<{ items: AdminTierPackage[] }>('/admin/tier-packages', {
        tier: tier || undefined,
        page: 1,
        pageSize: 100,
      }),
    enabled: open,
  });

  return (
    <FormModal<{ days?: number }>
      open={open}
      title="Assign Tier Package"
      okText="Assign"
      width={640}
      onClose={() => {
        setPicked(null);
        onClose();
      }}
      initialValues={initialValues}
      invalidate={[['user', uid], ['user-tier-packages', uid], ['users'], ['tier-packages']]}
      submit={(v) => {
        if (!picked) return Promise.reject(new Error('Pick a package'));
        return send(
          'post',
          `/admin/users/${encodeURIComponent(uid)}/tier-packages`,
          { packageId: picked.id, days: v.days ?? undefined },
          { 'Idempotency-Key': intentKey },
        );
      }}
    >
      {() => (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="No diamonds are charged. It replaces the user's current tier package and is worn at once."
          />
          <Segmented
            value={tier}
            onChange={(v) => setTier(Number(v))}
            options={tierFilterOptions}
            style={{ marginBottom: 12 }}
          />
          <div style={{ maxHeight: 340, overflowY: 'auto', marginBottom: 16 }}>
            {list.isLoading ? (
              <Spin />
            ) : !list.data?.items.length ? (
              <Empty description="No packages for this tier" />
            ) : (
              <Row gutter={[10, 10]}>
                {list.data.items.map((p) => {
                  const selected = picked?.id === p.id;
                  return (
                    <Col span={12} key={p.id}>
                      <Card
                        size="small"
                        hoverable
                        onClick={() => setPicked(p)}
                        style={{
                          borderColor: selected ? brand.palette.gold : undefined,
                          background: selected ? brand.palette.champagneTint : undefined,
                          borderWidth: selected ? 2 : 1,
                        }}
                      >
                        <Space>
                          <TierBadgePreview badge={p.badge} size={48} />
                          <div style={{ lineHeight: 1.3 }}>
                            <Typography.Text strong>{p.name}</Typography.Text>
                            {!p.active && (
                              <Tag style={{ marginLeft: 6 }} color="default">
                                inactive
                              </Tag>
                            )}
                            <div>
                              <VipTag tier={p.tier} />
                            </div>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              💎 {num(p.priceDiamonds)} · {p.durationDays} days
                            </Typography.Text>
                          </div>
                        </Space>
                      </Card>
                    </Col>
                  );
                })}
              </Row>
            )}
          </div>
          <Form.Item
            name="days"
            label="Validity override (days)"
            extra={
              picked
                ? `Leave empty to use the package's ${picked.durationDays} days. Adds to time left if they already hold it.`
                : 'Leave empty to use the package duration.'
            }
          >
            <InputNumber min={1} max={MAX_GRANT_DAYS} style={{ width: 200 }} />
          </Form.Item>
        </>
      )}
    </FormModal>
  );
}

/** The user detail's "Tier package" tab: what they wear, what they hold, grant and remove. */
export function UserTierPackages({ uid }: { uid: string }) {
  const { can } = useAuth();
  const [assigning, setAssigning] = useState(false);
  const key = ['user-tier-packages', uid];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      get<{ items: OwnedTierPackage[] }>(`/admin/users/${encodeURIComponent(uid)}/tier-packages`),
  });
  const worn = q.data?.items.find((o) => o.worn) ?? null;
  const invalidate = [key, ['user', uid], ['users'], ['tier-packages']];
  const revoke = (o: OwnedTierPackage) =>
    send('delete', `/admin/users/${encodeURIComponent(uid)}/tier-packages/${o.package.id}`);

  return (
    <>
      <Space
        align="start"
        wrap
        size="large"
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}
      >
        <Space align="start" size="large">
          <TierBadgePreview badge={worn?.package.badge ?? null} size={64} />
          <Descriptions column={1} size="small">
            <Descriptions.Item label="Tier">
              {worn ? <VipTag tier={worn.package.tier} /> : 'None'}
            </Descriptions.Item>
            <Descriptions.Item label="Package">{worn?.package.name ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Expires at">
              {worn ? dateTime(worn.expiresAt) : '—'}
            </Descriptions.Item>
          </Descriptions>
        </Space>
        {can('users.edit') && (
          <Space wrap>
            <Button type="primary" icon={<CrownOutlined />} onClick={() => setAssigning(true)}>
              Assign Tier Package
            </Button>
            {worn && (
              <ActionButton
                danger
                size="middle"
                label="Remove Tier Package"
                confirm={`Take “${worn.package.name}” away from this user? It comes off at once.`}
                run={() => revoke(worn)}
                invalidate={invalidate}
                success="Removed"
              />
            )}
          </Space>
        )}
      </Space>

      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      <Table<OwnedTierPackage>
        rowKey={(o) => o.package.id}
        size="small"
        loading={q.isLoading}
        dataSource={q.data?.items ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: 'No tier packages yet' }}
        columns={[
          {
            title: 'Package',
            key: 'p',
            render: (_, o) => (
              <Space>
                <TierBadgePreview badge={o.package.badge} size={36} />
                <Typography.Text strong>{o.package.name}</Typography.Text>
              </Space>
            ),
          },
          { title: 'Tier', key: 't', render: (_, o) => <VipTag tier={o.package.tier} /> },
          {
            title: 'Source',
            dataIndex: 'source',
            render: (s: OwnedTierPackage['source']) =>
              s === 'admin' ? <Tag color="purple">Granted</Tag> : <Tag color="blue">Purchased</Tag>,
          },
          {
            title: 'Status',
            key: 's',
            render: (_, o) =>
              o.worn ? (
                <Tag color="green">Wearing</Tag>
              ) : o.expired ? (
                <Tag color="red">Expired</Tag>
              ) : (
                <Tag>Owned</Tag>
              ),
          },
          { title: 'Expires', dataIndex: 'expiresAt', render: dateTime },
          { title: 'Acquired', dataIndex: 'acquiredAt', render: dateTime },
          ...(can('users.edit')
            ? [
                {
                  title: '',
                  key: 'revoke',
                  render: (_: unknown, o: OwnedTierPackage) => (
                    <ActionButton
                      danger
                      label="Revoke"
                      confirm={`Take “${o.package.name}” away from this user?`}
                      run={() => revoke(o)}
                      invalidate={invalidate}
                      success="Revoked"
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
      <AssignTierPackageModal uid={uid} open={assigning} onClose={() => setAssigning(false)} />
    </>
  );
}
