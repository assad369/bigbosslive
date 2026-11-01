import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { DeleteOutlined, InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { isCancel } from 'axios';
import {
  COSMETIC_TYPES,
  FRAME_FORMATS,
  MAX_COSMETICS_PER_BATCH,
  MAX_GRANT_DAYS,
  MEDIA_TYPES,
  VIP_TIERS,
  type AnimationFormat,
  type CosmeticType,
} from '@bigboss/shared';
import { send } from '../../lib/api';
import {
  acceptAttr,
  checkFile,
  describeAccepted,
  mediaTypeOf,
  uploadAsset,
} from '../../lib/upload';
import { DecorationPreview } from '../../components/DecorationPreview';
import { cosmeticTypeLabel } from '../../lib/decorations';

/** Uploads running at once: enough to saturate a typical uplink without starving the UI. */
const CONCURRENCY = 3;

interface Row {
  id: string;
  file: File;
  name: string;
  format: AnimationFormat;
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  url?: string;
  error?: string;
}

interface Shared {
  type: CosmeticType;
  vipTierRequired: number;
  vipIncluded: boolean;
  priceDiamonds: number;
  durationDays: number;
  active: boolean;
}

const DEFAULTS: Shared = {
  type: 'frame',
  vipTierRequired: 0,
  vipIncluded: false,
  priceDiamonds: 0,
  durationDays: 30,
  active: true,
};

/** "gold_crown-v2.svga" → "Gold crown v2". */
function nameFromFile(file: string): string {
  const base = file
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (base.charAt(0).toUpperCase() + base.slice(1)).slice(0, 40) || 'Untitled';
}

const fitsType = (type: CosmeticType, format: AnimationFormat) =>
  type !== 'frame' || (FRAME_FORMATS as readonly string[]).includes(format);

/**
 * Upload any number of decoration files at once. Each file becomes a row (name from the file
 * name, format from its type); shared settings apply to all. Rows save in batches, and a saved
 * batch leaves the list, so a failure part-way can be retried without duplicates.
 */
export function BulkDecorationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Shared>();
  const type = Form.useWatch('type', form) ?? DEFAULTS.type;
  const tier = Form.useWatch('vipTierRequired', form) ?? 0;
  const included = Form.useWatch('vipIncluded', form) ?? false;
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const started = useRef(new Set<string>());
  const aborts = useRef(new Map<string, AbortController>());

  const patch = (id: string, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  // Feed queued rows to the uploader, CONCURRENCY at a time.
  useEffect(() => {
    let slots = CONCURRENCY - rows.filter((r) => r.status === 'uploading').length;
    for (const row of rows) {
      if (slots <= 0) break;
      if (row.status !== 'queued' || started.current.has(row.id)) continue;
      slots--;
      started.current.add(row.id);
      const ctrl = new AbortController();
      aborts.current.set(row.id, ctrl);
      patch(row.id, { status: 'uploading', progress: 0, error: undefined });
      uploadAsset('cosmetic-asset', row.file, {
        signal: ctrl.signal,
        onProgress: (f) => patch(row.id, { progress: Math.round(f * 100) }),
      })
        .then(({ url }) => patch(row.id, { status: 'done', progress: 100, url }))
        .catch((err: unknown) => {
          if (isCancel(err)) return;
          patch(row.id, {
            status: 'error',
            error: err instanceof Error ? err.message : 'Upload failed',
          });
        })
        .finally(() => {
          aborts.current.delete(row.id);
          started.current.delete(row.id);
        });
    }
  }, [rows]);

  // Stop uploads when the dialog goes away.
  useEffect(() => {
    const live = aborts.current;
    return () => live.forEach((c) => c.abort());
  }, []);

  const reset = () => {
    aborts.current.forEach((c) => c.abort());
    aborts.current.clear();
    started.current.clear();
    setRows([]);
    form.setFieldsValue(DEFAULTS);
  };

  const add = (file: File) => {
    const problem = checkFile('cosmetic-asset', file);
    if (problem) {
      message.error(problem);
      return;
    }
    const mediaType = mediaTypeOf(file)!;
    setRows((rs) => [
      ...rs,
      {
        id: crypto.randomUUID(),
        file,
        name: nameFromFile(file.name),
        format: MEDIA_TYPES[mediaType].format,
        status: 'queued',
        progress: 0,
      },
    ]);
  };

  const remove = (id: string) => {
    aborts.current.get(id)?.abort();
    setRows((rs) => rs.filter((r) => r.id !== id));
  };

  const busy = rows.some((r) => r.status === 'queued' || r.status === 'uploading');
  const failed = rows.filter((r) => r.status === 'error').length;
  const misfits = rows.filter((r) => !fitsType(type, r.format)).length;
  const unnamed = rows.some((r) => !r.name.trim());
  const ready = rows.filter((r) => r.status === 'done');
  const canSave = ready.length > 0 && !busy && !failed && !misfits && !unnamed && !saving;

  const save = async () => {
    const shared = await form.validateFields();
    setSaving(true);
    let saved = 0;
    try {
      for (let i = 0; i < ready.length; i += MAX_COSMETICS_PER_BATCH) {
        const chunk = ready.slice(i, i + MAX_COSMETICS_PER_BATCH);
        await send('post', '/admin/cosmetics/bulk', {
          items: chunk.map((r) => ({
            ...shared,
            vipIncluded: shared.vipTierRequired > 0 && shared.vipIncluded,
            name: r.name.trim(),
            assetUrl: r.url,
            animationFormat: r.format,
            previewUrl: null,
            sortOrder: 0,
          })),
        });
        saved += chunk.length;
        const done = new Set(chunk.map((r) => r.id));
        setRows((rs) => rs.filter((r) => !done.has(r.id)));
      }
      message.success(`Added ${saved} decoration${saved === 1 ? '' : 's'}`);
      await qc.invalidateQueries({ queryKey: ['cosmetics'] });
      reset();
      onClose();
    } catch (err) {
      if (saved) await qc.invalidateQueries({ queryKey: ['cosmetics'] });
      message.error(
        `${saved ? `Saved ${saved}; the rest were not: ` : ''}${(err as Error).message}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (!rows.length) return onClose();
    modal.confirm({
      title: 'Discard this upload?',
      content: 'Files not saved yet will be dropped.',
      okText: 'Discard',
      okButtonProps: { danger: true },
      onOk: () => {
        reset();
        onClose();
      },
    });
  };

  return (
    <Modal
      open={open}
      title="Bulk upload decorations"
      width={920}
      onCancel={close}
      maskClosable={false}
      footer={
        <Space>
          <Typography.Text type="secondary">
            {ready.length} of {rows.length} ready
          </Typography.Text>
          <Button onClick={close}>Cancel</Button>
          <Button type="primary" disabled={!canSave} loading={saving} onClick={save}>
            Save {ready.length || ''} decoration{ready.length === 1 ? '' : 's'}
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" initialValues={DEFAULTS} requiredMark="optional">
        <Space wrap size="middle" align="start">
          <Form.Item name="type" label="Type" rules={[{ required: true }]} style={{ width: 190 }}>
            <Select
              options={COSMETIC_TYPES.map((t) => ({ value: t, label: cosmeticTypeLabel(t) }))}
            />
          </Form.Item>
          <Form.Item name="vipTierRequired" label="VIP tier" style={{ width: 150 }}>
            <Select
              onChange={(t: number) => t === 0 && form.setFieldValue('vipIncluded', false)}
              options={[
                { value: 0, label: 'Anyone' },
                ...VIP_TIERS.map((t) => ({ value: t.tier, label: t.label })),
              ]}
            />
          </Form.Item>
          <Form.Item
            name="vipIncluded"
            label="Included with tier"
            valuePropName="checked"
            tooltip="Holders of the tier (or higher) wear it free. It is not sold."
          >
            <Switch disabled={tier === 0} />
          </Form.Item>
          <Form.Item name="priceDiamonds" label="Price (diamonds)" rules={[{ required: true }]}>
            <InputNumber min={0} disabled={included} style={{ width: 130 }} />
          </Form.Item>
          <Form.Item name="durationDays" label="Days" rules={[{ required: true }]}>
            <InputNumber min={1} max={MAX_GRANT_DAYS} style={{ width: 100 }} />
          </Form.Item>
          <Form.Item name="active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Space>
      </Form>

      <Upload.Dragger
        multiple
        accept={acceptAttr('cosmetic-asset')}
        showUploadList={false}
        beforeUpload={(file) => {
          add(file);
          return Upload.LIST_IGNORE;
        }}
        style={{ marginBottom: 16 }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">Drop files here, or click to choose. Any number of files.</p>
        <p className="ant-upload-hint">{describeAccepted('cosmetic-asset')} each</p>
      </Upload.Dragger>

      {misfits > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${misfits} file${misfits === 1 ? ' is' : 's are'} MP4, which can't be an avatar frame. Remove ${misfits === 1 ? 'it' : 'them'} or change the type.`}
        />
      )}
      {failed > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${failed} upload${failed === 1 ? '' : 's'} failed. Retry or remove ${failed === 1 ? 'it' : 'them'} to save.`}
        />
      )}

      {rows.length > 0 && (
        <Table<Row>
          rowKey="id"
          size="small"
          dataSource={rows}
          pagination={rows.length > 50 ? { pageSize: 50 } : false}
          scroll={{ y: 360 }}
          columns={[
            {
              title: '',
              key: 'preview',
              width: 56,
              render: (_, r) =>
                r.url ? (
                  <DecorationPreview url={r.url} format={r.format} size={40} />
                ) : (
                  <div style={{ width: 40, height: 40 }} />
                ),
            },
            {
              title: 'Name',
              key: 'name',
              render: (_, r) => (
                <Input
                  value={r.name}
                  maxLength={40}
                  status={r.name.trim() ? undefined : 'error'}
                  onChange={(e) => patch(r.id, { name: e.target.value })}
                />
              ),
            },
            {
              title: 'Format',
              key: 'format',
              width: 90,
              render: (_, r) => (
                <Tag color={fitsType(type, r.format) ? undefined : 'red'}>
                  {r.format === 'none' ? 'image' : r.format}
                </Tag>
              ),
            },
            {
              title: 'Upload',
              key: 'status',
              width: 200,
              render: (_, r) =>
                r.status === 'error' ? (
                  <Space size={4}>
                    <Typography.Text
                      type="danger"
                      ellipsis={{ tooltip: r.error }}
                      style={{ maxWidth: 130 }}
                    >
                      {r.error}
                    </Typography.Text>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => patch(r.id, { status: 'queued', progress: 0 })}
                    />
                  </Space>
                ) : r.status === 'queued' ? (
                  <Typography.Text type="secondary">Waiting…</Typography.Text>
                ) : (
                  <Progress
                    percent={r.progress}
                    size="small"
                    status={r.status === 'done' ? 'success' : 'active'}
                  />
                ),
            },
            {
              title: '',
              key: 'remove',
              width: 48,
              render: (_, r) => (
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => remove(r.id)}
                />
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}
