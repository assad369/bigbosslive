import { useState } from 'react';
import { Alert, App, Form, Input, Modal, Typography } from 'antd';
import { ADMIN_PASSWORD_MAX_LENGTH, ADMIN_PASSWORD_MIN_LENGTH } from '@bigboss/shared';
import { PasswordChangeError, useAuth } from '../auth/useAuth';
import { newPasswordRules, confirmPasswordRules } from './passwordRules';

interface Values {
  current: string;
  next: string;
  confirm: string;
}

/** The signed-in admin changes their own password (current password required). */
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { changePassword, user } = useAuth();
  const { message } = App.useApp();
  const [form] = Form.useForm<Values>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const close = () => {
    if (busy) return;
    form.resetFields();
    setFailure(null);
    onClose();
  };

  const submit = async () => {
    const v = await form.validateFields();
    setBusy(true);
    setFailure(null);
    try {
      await changePassword(v.current, v.next);
      message.success('Password changed. Your other sessions were signed out');
      form.resetFields();
      onClose();
    } catch (err) {
      if (err instanceof PasswordChangeError && err.field === 'current') {
        form.setFields([{ name: 'current', errors: [err.message] }]);
      } else if (err instanceof PasswordChangeError && err.field === 'next') {
        form.setFields([{ name: 'next', errors: [err.message] }]);
      } else {
        setFailure(err instanceof Error ? err.message : 'Could not change the password');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Change password"
      okText="Change password"
      onOk={() => void submit().catch(() => undefined)}
      onCancel={close}
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
      maskClosable={!busy}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        Signed in as {user?.email}. Your other dashboard sessions are signed out; this one stays
        signed in.
      </Typography.Paragraph>
      {failure && <Alert type="error" showIcon message={failure} style={{ marginBottom: 16 }} />}
      <Form form={form} layout="vertical" requiredMark={false} onFinish={() => void submit()}>
        {/* Lets password managers pair the new password with the account. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={user?.email ?? ''}
          readOnly
          hidden
        />
        <Form.Item
          name="current"
          label="Current password"
          rules={[{ required: true, message: 'Enter your current password' }]}
        >
          <Input.Password autoComplete="current-password" maxLength={ADMIN_PASSWORD_MAX_LENGTH} />
        </Form.Item>
        <Form.Item
          name="next"
          label="New password"
          dependencies={['current']}
          extra={`At least ${ADMIN_PASSWORD_MIN_LENGTH} characters`}
          rules={[
            ...newPasswordRules,
            ({ getFieldValue }) => ({
              validator: (_, value?: string) =>
                value && value === getFieldValue('current')
                  ? Promise.reject(new Error('Use a different password from your current one'))
                  : Promise.resolve(),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" maxLength={ADMIN_PASSWORD_MAX_LENGTH} />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="Confirm new password"
          dependencies={['next']}
          rules={confirmPasswordRules('next')}
        >
          <Input.Password autoComplete="new-password" maxLength={ADMIN_PASSWORD_MAX_LENGTH} />
        </Form.Item>
        {/* Enter submits. */}
        <button type="submit" hidden />
      </Form>
    </Modal>
  );
}
