import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/useAuth';
import { firebaseConfigured } from '../lib/firebase';
import { Logo } from '../components/Logo';
import { brand } from '../theme';

export function LoginPage() {
  const { signIn, error, status, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const onFinish = async ({ email, password }: { email: string; password: string }) => {
    setBusy(true);
    setFailure(null);
    try {
      await signIn(email, password);
    } catch {
      setFailure('Incorrect email or password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: `radial-gradient(1200px 600px at 10% -10%, ${brand.palette.champagne} 0%, transparent 60%), radial-gradient(900px 500px at 110% 110%, ${brand.palette.champagneDeep} 0%, transparent 55%), ${brand.palette.ivory}`,
      }}
    >
      <Card
        variant="borderless"
        style={{
          width: '100%',
          maxWidth: 420,
          boxShadow: '0 20px 60px rgba(107,72,38,0.15)',
          borderTop: `4px solid ${brand.palette.gold}`,
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Logo size={56} />
          <Typography.Title
            level={2}
            style={{
              fontFamily: brand.typography.display,
              margin: '12px 0 0',
              background: brand.gradients.gold,
              WebkitBackgroundClip: 'text',
              color: 'transparent',
            }}
          >
            BigBoss Live
          </Typography.Title>
          <Typography.Text type="secondary">Administration console</Typography.Text>
        </div>
        {!firebaseConfigured && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="Firebase is not configured"
            description="Set the VITE_FIREBASE_* variables (see .env.example)."
          />
        )}
        {status === 'forbidden' && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            message="This account has no admin role"
            action={
              <Button size="small" onClick={() => void signOut()}>
                Sign out
              </Button>
            }
          />
        )}
        {(failure ?? error) && (
          <Alert type="error" showIcon style={{ marginBottom: 16 }} message={failure ?? error} />
        )}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input
              prefix={<MailOutlined />}
              size="large"
              autoComplete="username"
              placeholder="you@bigbosslive.app"
            />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password
              prefix={<LockOutlined />}
              size="large"
              autoComplete="current-password"
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            block
            size="large"
            loading={busy}
            style={{
              background: brand.gradients.gold,
              border: 0,
              color: brand.palette.ink,
              fontWeight: 600,
            }}
          >
            Sign in
          </Button>
        </Form>
        <Typography.Paragraph
          type="secondary"
          style={{ marginTop: 16, marginBottom: 0, fontSize: 12, textAlign: 'center' }}
        >
          Access is restricted to authorised staff. All actions are audited.
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
