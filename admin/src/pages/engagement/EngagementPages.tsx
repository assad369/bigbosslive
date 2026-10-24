import { useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
  Form,
  Image,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, SendOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { get, send } from '../../lib/api';
import { dateTime, num } from '../../lib/format';
import { ActionButton, PageHeader, StatusTag } from '../../components/common';
import { ServerTable } from '../../components/ServerTable';
import { FormModal } from '../../components/FormModal';

// ── Announcements ──────────────────────────────────────────────────────────────────

interface AnnouncementRow {
  _id: string;
  title: string;
  body: string;
  audience: string;
  status: string;
  stats: { recipients: number; pushed: number; failed: number };
  createdAt: string;
  completedAt: string | null;
}

export function AnnouncementsPage() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Announcements"
        subtitle="Broadcast to the in-app inbox and push notifications"
        extra={
          <Button type="primary" icon={<SendOutlined />} onClick={() => setOpen(true)}>
            New announcement
          </Button>
        }
      />
      <ServerTable<AnnouncementRow>
        queryKey="announcements"
        url="/admin/announcements"
        rowKey="_id"
        columns={[
          { title: 'Sent', dataIndex: 'createdAt', render: dateTime },
          {
            title: 'Message',
            key: 'm',
            render: (_, a) => (
              <div style={{ maxWidth: 420 }}>
                <Typography.Text strong>{a.title}</Typography.Text>
                <br />
                <Typography.Text type="secondary">{a.body}</Typography.Text>
              </div>
            ),
          },
          { title: 'Audience', dataIndex: 'audience', render: (a: string) => <Tag>{a}</Tag> },
          { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusTag status={s} /> },
          {
            title: 'Recipients',
            key: 'r',
            align: 'right',
            render: (_, a) => num(a.stats.recipients),
          },
          {
            title: 'Pushed',
            key: 'p',
            align: 'right',
            render: (_, a) => `${num(a.stats.pushed)} ✓ · ${num(a.stats.failed)} ✗`,
          },
        ]}
      />
      <FormModal<{ title: string; body: string; imageUrl?: string; audience: string }>
        open={open}
        title="New announcement"
        okText="Send"
        onClose={() => setOpen(false)}
        initialValues={{ audience: 'all' }}
        invalidate={[['announcements']]}
        submit={(v) => send('post', '/admin/announcements', { ...v, imageUrl: v.imageUrl || null })}
      >
        {() => (
          <>
            <Form.Item name="title" label="Title" rules={[{ required: true, max: 80 }]}>
              <Input showCount maxLength={80} />
            </Form.Item>
            <Form.Item name="body" label="Message" rules={[{ required: true, max: 500 }]}>
              <Input.TextArea rows={4} showCount maxLength={500} />
            </Form.Item>
            <Form.Item name="imageUrl" label="Image URL (optional)" rules={[{ type: 'url' }]}>
              <Input />
            </Form.Item>
            <Form.Item name="audience" label="Audience">
              <Select
                options={[
                  { value: 'all', label: 'Everyone' },
                  { value: 'hosts', label: 'Hosts (have gone live)' },
                  { value: 'agents', label: 'Agents' },
                  { value: 'vip', label: 'Active VIPs' },
                ]}
              />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}

// ── Banners ────────────────────────────────────────────────────────────────────

interface BannerRow {
  _id: string;
  title: string;
  imageUrl: string;
  linkUrl: string | null;
  placement: string;
  sortOrder: number;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

type BannerForm = Omit<BannerRow, '_id' | 'startsAt' | 'endsAt'> & {
  window?: [Dayjs | null, Dayjs | null] | null;
};

export function BannersPage() {
  const [editing, setEditing] = useState<BannerRow | 'new' | null>(null);
  const q = useQuery({
    queryKey: ['banners'],
    queryFn: () => get<{ items: BannerRow[] }>('/admin/banners'),
  });
  const inv = [['banners']];
  const toBody = (v: BannerForm) => {
    const { window, ...rest } = v;
    return {
      ...rest,
      linkUrl: rest.linkUrl || null,
      startsAt: window?.[0]?.toISOString() ?? null,
      endsAt: window?.[1]?.toISOString() ?? null,
    };
  };

  return (
    <>
      <PageHeader
        title="Banners"
        subtitle="Promotional carousels in the app"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            New banner
          </Button>
        }
      />
      <Card variant="borderless" styles={{ body: { padding: 0 } }}>
        <Table<BannerRow>
          rowKey="_id"
          loading={q.isLoading}
          dataSource={q.data?.items ?? []}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: 'Banner',
              key: 'b',
              render: (_, b) => (
                <Space>
                  <Image
                    src={b.imageUrl}
                    width={120}
                    height={48}
                    style={{ objectFit: 'cover', borderRadius: 8 }}
                  />
                  <Typography.Text strong>{b.title}</Typography.Text>
                </Space>
              ),
            },
            { title: 'Placement', dataIndex: 'placement', render: (p: string) => <Tag>{p}</Tag> },
            {
              title: 'Window',
              key: 'w',
              render: (_, b) =>
                `${b.startsAt ? dateTime(b.startsAt) : 'now'} → ${b.endsAt ? dateTime(b.endsAt) : '∞'}`,
            },
            { title: 'Order', dataIndex: 'sortOrder' },
            {
              title: 'Active',
              dataIndex: 'active',
              render: (a: boolean) => (a ? <Tag color="green">yes</Tag> : <Tag>no</Tag>),
            },
            {
              title: '',
              key: 'a',
              render: (_, b) => (
                <Space>
                  <Button size="small" onClick={() => setEditing(b)}>
                    Edit
                  </Button>
                  <ActionButton
                    danger
                    label="Delete"
                    confirm="Delete this banner?"
                    run={() => send('delete', `/admin/banners/${b._id}`)}
                    invalidate={inv}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <FormModal<BannerForm>
        open={editing !== null}
        title={editing === 'new' ? 'New banner' : 'Edit banner'}
        onClose={() => setEditing(null)}
        initialValues={
          editing && editing !== 'new'
            ? {
                ...editing,
                window: [
                  editing.startsAt ? dayjs(editing.startsAt) : null,
                  editing.endsAt ? dayjs(editing.endsAt) : null,
                ],
              }
            : { placement: 'home', sortOrder: 0, active: true }
        }
        invalidate={inv}
        submit={(v) =>
          editing === 'new'
            ? send('post', '/admin/banners', toBody(v))
            : send('put', `/admin/banners/${(editing as BannerRow)._id}`, toBody(v))
        }
      >
        {() => (
          <>
            <Form.Item name="title" label="Title" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="imageUrl" label="Image URL" rules={[{ required: true, type: 'url' }]}>
              <Input />
            </Form.Item>
            <Form.Item name="linkUrl" label="Link (deep link or URL)">
              <Input placeholder="bigboss://live/… or https://…" />
            </Form.Item>
            <Space size="large">
              <Form.Item name="placement" label="Placement">
                <Select
                  style={{ width: 140 }}
                  options={['home', 'live', 'wallet', 'games'].map((p) => ({ value: p, label: p }))}
                />
              </Form.Item>
              <Form.Item name="sortOrder" label="Order">
                <InputNumber />
              </Form.Item>
              <Form.Item name="active" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Space>
            <Form.Item name="window" label="Schedule (optional)">
              <DatePicker.RangePicker
                showTime
                allowEmpty={[true, true]}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </>
        )}
      </FormModal>
    </>
  );
}
