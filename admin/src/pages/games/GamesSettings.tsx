import { useEffect } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  InputNumber,
  Row,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, send } from '../../lib/api';
import { ago } from '../../lib/format';
import { useAuth } from '../../auth/useAuth';
import { GAMES_KEY, type GamesCatalogResponse, type GamesSettings as Settings } from './gamesApi';

export function GamesSettings() {
  const { can } = useAuth();
  const canEdit = can('games.manage');
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Settings>();
  const q = useQuery({
    queryKey: GAMES_KEY,
    queryFn: () => get<GamesCatalogResponse>('/admin/games'),
  });
  useEffect(() => {
    if (q.data) form.setFieldsValue(q.data.settings);
  }, [q.data, form]);

  const save = useMutation({
    mutationFn: (v: Settings) => send('put', '/admin/games/settings', v),
    onSuccess: () => {
      message.success('Saved. Other servers pick it up within 30 seconds.');
      void qc.invalidateQueries({ queryKey: GAMES_KEY });
    },
    onError: (e: Error) => message.error(e.message),
  });
  const i = q.data?.integration;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card variant="borderless" title="Rules" loading={q.isLoading}>
          <Form<Settings>
            form={form}
            layout="vertical"
            disabled={!canEdit}
            onFinish={(v) => save.mutate(v)}
          >
            <Form.Item
              name="enabled"
              label="Games"
              valuePropName="checked"
              extra="Off: games disappear from the app, open games are closed and new stakes are refused. Wins and refunds still pay."
            >
              <Switch checkedChildren="On" unCheckedChildren="Off" />
            </Form.Item>
            <Form.Item
              name="minLevel"
              label="Minimum level to play"
              extra="A game's own minimum level overrides this."
              rules={[{ required: true }]}
            >
              <InputNumber min={0} max={999} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name="liveRoomEnabled"
              label="Games in live rooms"
              valuePropName="checked"
              extra="Shows the Games button in live rooms. Each game also has its own live-room switch."
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="showLocked"
              label="Show games the player's level hasn't reached"
              valuePropName="checked"
              extra="On: shown with a lock and the level needed. Off: hidden."
            >
              <Switch />
            </Form.Item>
            {canEdit && (
              <Button type="primary" htmlType="submit" loading={save.isPending}>
                Save
              </Button>
            )}
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card variant="borderless" title="AsadSoft integration" loading={q.isLoading}>
          {i && !i.configured && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="Not configured"
              description="Set ASADSOFT_API_URL, ASADSOFT_API_KEY, ASADSOFT_API_SECRET and ASADSOFT_WALLET_TOKEN on the API server. See docs/GAMES.md."
            />
          )}
          {i && (
            <Descriptions column={1} size="small">
              <Descriptions.Item label="Status">
                {i.configured ? <Tag color="green">configured</Tag> : <Tag color="red">off</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="AsadSoft API">{i.apiUrl ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Wallet callback URL">
                <Typography.Text copyable code>
                  {i.walletCallbackUrl}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="Games">
                {i.enabledCount} on, of {i.catalogSize} in the catalogue
              </Descriptions.Item>
              <Descriptions.Item label="Last sync">{ago(i.lastSyncAt)}</Descriptions.Item>
              <Descriptions.Item label="Last wallet call">
                {ago(i.lastCallbackAt)}
              </Descriptions.Item>
            </Descriptions>
          )}
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            In the AsadSoft dashboard (Operators → this operator) set the wallet callback URL above,
            auth type <b>bearer</b> with the same token as ASADSOFT_WALLET_TOKEN, and currency{' '}
            <b>DIAMOND</b>.
          </Typography.Paragraph>
        </Card>
      </Col>
    </Row>
  );
}
