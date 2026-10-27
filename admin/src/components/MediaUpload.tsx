import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { App, Button, Image, Input, Progress, Space, Tooltip, Typography, Upload } from 'antd';
import {
  DeleteOutlined,
  FileOutlined,
  InboxOutlined,
  LinkOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { isCancel } from 'axios';
import type { AdminUploadKind, MediaType } from '@bigboss/shared';
import {
  acceptAttr,
  checkFile,
  describeAccepted,
  isImage,
  mediaTypeOfUrl,
  uploadAsset,
} from '../lib/upload';
import { brand } from '../theme';
import { UploadTracker } from './uploadTracker';

/**
 * Upload-from-device control for a media URL field. Drop it into a `Form.Item` in place of
 * `<Input/>`: it is controlled through `value`/`onChange`, so the form's rules (required,
 * `type: 'url'`) still apply to the URL it produces. A pasted URL still works for assets
 * already on the CDN.
 */
export function MediaUpload({
  value,
  onChange,
  kind,
  onUploaded,
  compact = false,
  disabled = false,
}: {
  value?: string | null;
  onChange?: (url: string | null) => void;
  kind: AdminUploadKind;
  /** Called with the detected type, e.g. to set the matching animation format. */
  onUploaded?: (info: { url: string; type: MediaType }) => void;
  /** Single-line variant for tables. */
  compact?: boolean;
  disabled?: boolean;
}) {
  const { message } = App.useApp();
  const tracker = useContext(UploadTracker);
  const [progress, setProgress] = useState<number | null>(null);
  const [pasting, setPasting] = useState(false);
  const [draft, setDraft] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const start = async (file: File) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const end = tracker?.begin();
    setProgress(0);
    try {
      const res = await uploadAsset(kind, file, {
        signal: ctrl.signal,
        onProgress: (f) => setProgress(Math.round(f * 100)),
      });
      onChange?.(res.url);
      onUploaded?.(res);
      message.success(`${file.name} uploaded`);
    } catch (err) {
      if (!isCancel(err) && !ctrl.signal.aborted) message.error((err as Error).message);
    } finally {
      end?.();
      if (abort.current === ctrl) {
        abort.current = null;
        setProgress(null);
      }
    }
  };

  const beforeUpload = (file: File) => {
    const problem = checkFile(kind, file);
    if (problem) message.error(problem);
    else void start(file);
    // Never let antd upload on its own; `start` handles it.
    return Upload.LIST_IGNORE;
  };

  const picker = (child: ReactNode) => (
    <Upload
      accept={acceptAttr(kind)}
      showUploadList={false}
      beforeUpload={beforeUpload}
      disabled={disabled || progress !== null}
      maxCount={1}
    >
      {child}
    </Upload>
  );

  const uploading = progress !== null && (
    <Space style={{ width: '100%' }}>
      <Progress percent={progress} size="small" style={{ minWidth: 140 }} />
      <Button size="small" onClick={() => abort.current?.abort()}>
        Cancel
      </Button>
    </Space>
  );

  const remove = (
    <Tooltip title="Remove">
      <Button
        size="small"
        icon={<DeleteOutlined />}
        disabled={disabled || progress !== null}
        onClick={() => onChange?.(null)}
        aria-label="Remove file"
      />
    </Tooltip>
  );

  if (compact) {
    return (
      <Space>
        {value && <Preview url={value} size={32} />}
        {uploading ||
          picker(
            <Button size="small" icon={<UploadOutlined />} disabled={disabled}>
              {value ? 'Replace' : 'Upload'}
            </Button>,
          )}
        {value && remove}
      </Space>
    );
  }

  const applyPasted = () => {
    const url = draft.trim();
    if (!url) return;
    try {
      new URL(url);
    } catch {
      message.error('That is not a valid URL');
      return;
    }
    onChange?.(url);
    setDraft('');
    setPasting(false);
  };

  const pasteForm = pasting && (
    <Space.Compact style={{ width: '100%', marginTop: 8 }}>
      <Input
        autoFocus
        placeholder="https://cdn…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={(e) => {
          e.preventDefault();
          applyPasted();
        }}
      />
      <Button type="primary" onClick={applyPasted}>
        Use URL
      </Button>
    </Space.Compact>
  );

  const pasteToggle = (
    <Typography.Link onClick={() => setPasting((p) => !p)} style={{ fontSize: 12 }}>
      <LinkOutlined /> {pasting ? 'Cancel' : 'Paste a URL instead'}
    </Typography.Link>
  );

  if (!value) {
    return (
      <div>
        {uploading || (
          <Upload.Dragger
            accept={acceptAttr(kind)}
            showUploadList={false}
            beforeUpload={beforeUpload}
            disabled={disabled}
            maxCount={1}
            style={{ padding: '4px 0' }}
          >
            <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}>
              <InboxOutlined />
            </p>
            <Typography.Text>Click or drop a file to upload</Typography.Text>
            <br />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {describeAccepted(kind)}
            </Typography.Text>
          </Upload.Dragger>
        )}
        <div style={{ marginTop: 6 }}>{pasteToggle}</div>
        {pasteForm}
      </div>
    );
  }

  return (
    <div
      style={{
        border: `1px solid ${brand.palette.border}`,
        borderRadius: 10,
        padding: 10,
        background: brand.palette.surfaceMuted,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Preview url={value} size={64} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Typography.Link
            href={value}
            target="_blank"
            rel="noreferrer"
            ellipsis
            style={{ display: 'block' }}
          >
            {value.split('/').pop()}
          </Typography.Link>
          <div style={{ marginTop: 6 }}>
            {uploading || (
              <Space>
                {picker(
                  <Button size="small" icon={<UploadOutlined />} disabled={disabled}>
                    Replace
                  </Button>,
                )}
                {remove}
                {pasteToggle}
              </Space>
            )}
          </div>
        </div>
      </div>
      {pasteForm}
    </div>
  );
}

/** Thumbnail for an image, a muted inline player for MP4, a file chip for SVGA/Lottie. */
function Preview({ url, size }: { url: string; size: number }) {
  const type = mediaTypeOfUrl(url);
  const box = {
    width: size,
    height: size,
    borderRadius: 8,
    flex: 'none',
    background: brand.palette.ivory,
    border: `1px solid ${brand.palette.border}`,
  } as const;
  if (isImage(type) || type === null) {
    return (
      <Image
        src={url}
        width={size}
        height={size}
        style={{ ...box, objectFit: 'contain' }}
        fallback="data:image/gif;base64,R0lGODlhAQABAAAAACw="
      />
    );
  }
  if (type === 'video/mp4') {
    return (
      <video src={url} muted loop autoPlay playsInline style={{ ...box, objectFit: 'contain' }} />
    );
  }
  return (
    <div
      style={{ ...box, display: 'grid', placeItems: 'center', color: brand.palette.bronze }}
      title={type === 'application/json' ? 'Lottie animation' : 'SVGA animation'}
    >
      <div style={{ textAlign: 'center', fontSize: size > 40 ? 11 : 9, fontWeight: 700 }}>
        <FileOutlined style={{ fontSize: size > 40 ? 20 : 14 }} />
        {size > 40 && <div>{type === 'application/json' ? 'LOTTIE' : 'SVGA'}</div>}
      </div>
    </div>
  );
}
