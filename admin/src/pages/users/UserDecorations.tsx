import { useState } from 'react';
import { Alert, Button, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { AdminUserCosmetic, AnimationFormat } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { ActionButton } from '../../components/common';
import { AssignDecorationModal } from '../../components/AssignDecorationModal';
import { cosmeticTypeLabel } from '../../lib/decorations';
import { DecorationThumb } from '../../components/CosmeticPicker';
import { DecorationPreview } from '../../components/DecorationPreview';
import { useAuth } from '../../auth/useAuth';
import { brand } from '../../theme';

interface Wardrobe {
  items: AdminUserCosmetic[];
  frame: { frameUrl: string | null; frameFormat: AnimationFormat };
}

const sourceTag = (r: AdminUserCosmetic) => {
  if (r.source === 'vip') return <Tag color="gold">Tier perk</Tag>;
  if (r.grantSource === 'admin') return <Tag color="purple">Granted</Tag>;
  if (r.grantSource === 'purchase') return <Tag color="blue">Purchased</Tag>;
  return <Tag>Owned</Tag>;
};

/** A user's frames, entrance effects and other decorations, with grant and revoke. */
export function UserDecorations({ uid }: { uid: string }) {
  const { can } = useAuth();
  const [assigning, setAssigning] = useState(false);
  const key = ['user-cosmetics', uid];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<Wardrobe>(`/admin/users/${encodeURIComponent(uid)}/cosmetics`),
  });
  const frame = q.data?.frame;

  return (
    <>
      <Space
        align="center"
        wrap
        size="large"
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}
      >
        <Space size="large" wrap>
          <Space>
            {frame?.frameUrl ? (
              <DecorationPreview url={frame.frameUrl} format={frame.frameFormat} size={64} />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 8,
                  border: `1px dashed ${brand.palette.border}`,
                }}
              />
            )}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Shown frame
              </Typography.Text>
              <br />
              <Typography.Text strong>{frame?.frameUrl ? 'Showing' : 'None'}</Typography.Text>
            </div>
          </Space>
        </Space>
        {can('users.edit') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAssigning(true)}>
            Assign decoration
          </Button>
        )}
      </Space>

      {q.error && <Alert type="error" showIcon message={(q.error as Error).message} />}
      <Table<AdminUserCosmetic>
        rowKey={(r) => `${r.source}:${r.item.id}`}
        size="small"
        loading={q.isLoading}
        dataSource={q.data?.items ?? []}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: 'No decorations yet' }}
        columns={[
          {
            title: 'Decoration',
            key: 'item',
            render: (_, r) => (
              <Space>
                <DecorationThumb item={r.item} size={40} />
                <div>
                  <Typography.Text strong>{r.item.name}</Typography.Text>
                  <br />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {cosmeticTypeLabel(r.item.type)}
                  </Typography.Text>
                </div>
              </Space>
            ),
          },
          { title: 'Source', key: 'source', render: (_, r) => sourceTag(r) },
          {
            title: 'Worn',
            dataIndex: 'equipped',
            render: (e: boolean) => (e ? <Tag color="green">Equipped</Tag> : '—'),
          },
          {
            title: 'Expires',
            dataIndex: 'expiresAt',
            render: (e: string | null, r) =>
              e ? dateTime(e) : r.source === 'vip' ? 'With tier' : '—',
          },
          {
            title: 'Acquired',
            dataIndex: 'acquiredAt',
            render: (a: string | null) => (a ? dateTime(a) : '—'),
          },
          ...(can('users.edit')
            ? [
                {
                  title: '',
                  key: 'revoke',
                  render: (_: unknown, r: AdminUserCosmetic) =>
                    r.source === 'owned' && (
                      <ActionButton
                        danger
                        label="Revoke"
                        confirm={`Take “${r.item.name}” away from this user?`}
                        run={() =>
                          send(
                            'delete',
                            `/admin/users/${encodeURIComponent(uid)}/cosmetics/${r.item.id}`,
                          )
                        }
                        invalidate={[key, ['cosmetics']]}
                        success="Revoked"
                      />
                    ),
                },
              ]
            : []),
        ]}
      />
      <AssignDecorationModal open={assigning} onClose={() => setAssigning(false)} uid={uid} />
    </>
  );
}
