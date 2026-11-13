import { useState } from 'react';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { EditOutlined, SyncOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { AdminGame } from '@bigboss/shared';
import { get, send } from '../../lib/api';
import { ago } from '../../lib/format';
import { ActionButton, ToggleSwitch } from '../../components/common';
import { FormModal } from '../../components/FormModal';
import { MediaUpload } from '../../components/MediaUpload';
import { useAuth } from '../../auth/useAuth';
import { brand } from '../../theme';
import { GAMES_KEY, type GamesCatalogResponse } from './gamesApi';

interface EditValues {
  displayName: string | null;
  iconUrl: string | null;
  minLevel: number | null;
  sortOrder: number;
}

export function GamesCatalog() {
  const { can } = useAuth();
  const canEdit = can('games.manage');
  const [editing, setEditing] = useState<AdminGame | null>(null);
  const q = useQuery({
    queryKey: GAMES_KEY,
    queryFn: () => get<GamesCatalogResponse>('/admin/games'),
  });
  const patch = (gameId: string, body: Partial<AdminGame>) =>
    send('patch', `/admin/games/${gameId}`, body);
  const globalMin = q.data?.settings.minLevel ?? 0;

  return (
    <>
      {q.data && !q.data.integration.configured && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="AsadSoft is not configured on the server (ASADSOFT_* env). Games can't launch."
        />
      )}
      <Card
        variant="borderless"
        styles={{ body: { padding: 0 } }}
        title={
          <Space direction="vertical" size={0}>
            <span>AsadSoft catalogue</span>
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              New games arrive switched off. Synced {ago(q.data?.integration.lastSyncAt)}.
            </Typography.Text>
          </Space>
        }
        extra={
          canEdit && (
            <ActionButton
              label="Sync from AsadSoft"
              icon={<SyncOutlined />}
              type="primary"
              size="middle"
              run={() => send('post', '/admin/games/sync')}
              invalidate={[GAMES_KEY]}
              success="Catalogue synced"
            />
          )
        }
      >
        <Table<AdminGame>
          rowKey="gameId"
          loading={q.isFetching}
          dataSource={q.data?.items ?? []}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: 'Game',
              render: (_, g) => (
                <Space>
                  <Avatar
                    shape="square"
                    size={40}
                    src={g.iconUrl ?? undefined}
                    style={{ background: brand.palette.champagne, color: brand.palette.bronzeDeep }}
                  >
                    {g.name[0]}
                  </Avatar>
                  <div style={{ lineHeight: 1.3 }}>
                    <Typography.Text strong>{g.name}</Typography.Text>
                    <br />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {g.gameId} · {g.provider.category}
                    </Typography.Text>
                  </div>
                </Space>
              ),
            },
            {
              title: 'Provider',
              render: (_, g) =>
                g.provider.available ? (
                  <Tag color="green">listed</Tag>
                ) : (
                  <Tag color="red">withdrawn</Tag>
                ),
            },
            {
              title: 'Enabled',
              render: (_, g) => (
                <ToggleSwitch
                  checked={g.enabled}
                  disabled={!canEdit || !g.provider.available}
                  onToggle={(enabled) => patch(g.gameId, { enabled })}
                  invalidate={[GAMES_KEY]}
                />
              ),
            },
            {
              title: 'In live rooms',
              render: (_, g) => (
                <ToggleSwitch
                  checked={g.liveRoom}
                  disabled={!canEdit}
                  onToggle={(liveRoom) => patch(g.gameId, { liveRoom })}
                  invalidate={[GAMES_KEY]}
                />
              ),
            },
            {
              title: 'Min level',
              render: (_, g) =>
                g.minLevel === null ? (
                  <Typography.Text type="secondary">{globalMin} (global)</Typography.Text>
                ) : (
                  <Tag color="gold">Lv {g.minLevel}</Tag>
                ),
            },
            { title: 'Order', dataIndex: 'sortOrder' },
            {
              title: '',
              render: (_, g) =>
                canEdit && (
                  <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(g)}>
                    Edit
                  </Button>
                ),
            },
          ]}
        />
      </Card>

      <FormModal<EditValues>
        open={Boolean(editing)}
        title={`Edit ${editing?.provider.name ?? ''}`}
        initialValues={
          editing
            ? {
                displayName: editing.displayName,
                iconUrl: editing.iconUrl,
                minLevel: editing.minLevel,
                sortOrder: editing.sortOrder,
              }
            : undefined
        }
        onClose={() => setEditing(null)}
        invalidate={[GAMES_KEY]}
        submit={(v) =>
          patch(editing!.gameId, {
            displayName: v.displayName?.trim() || null,
            iconUrl: v.iconUrl || null,
            minLevel: v.minLevel ?? null,
            sortOrder: v.sortOrder ?? 0,
          })
        }
      >
        {() => (
          <>
            <Form.Item
              name="displayName"
              label="Name in the app"
              extra={`Blank: the provider's name (${editing?.provider.name ?? ''})`}
            >
              <Input maxLength={60} allowClear />
            </Form.Item>
            <Form.Item
              name="iconUrl"
              label="Icon"
              extra="Square image. AsadSoft sends no artwork, so the app shows a plain tile without one."
            >
              <MediaUpload kind="game-icon" />
            </Form.Item>
            <Form.Item
              name="minLevel"
              label="Minimum level"
              extra={`Blank: the global minimum (level ${globalMin})`}
            >
              <InputNumber min={0} max={999} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="sortOrder" label="Display order" extra="Lower comes first">
              <InputNumber min={-10000} max={10000} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}
