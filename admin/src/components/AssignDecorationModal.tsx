import { useMemo, useState } from 'react';
import { Alert, Form, InputNumber, Space, Typography } from 'antd';
import {
  EQUIPPABLE_COSMETIC_TYPES,
  MAX_GRANT_DAYS,
  type AdminCosmetic,
  type Cosmetic,
} from '@bigboss/shared';
import { get, send, useIntentKey } from '../lib/api';
import { FormModal } from './FormModal';
import { cosmeticTypeLabel } from '../lib/decorations';
import { CosmeticPicker, DecorationThumb } from './CosmeticPicker';
import { UserPicker } from './UserPicker';
import type { Brief } from './common';

interface Values {
  cosmeticId?: string;
  user?: string;
  days: number;
}

const isWearable = (item: Pick<Cosmetic, 'type'>) =>
  (EQUIPPABLE_COSMETIC_TYPES as readonly string[]).includes(item.type);

/**
 * Give a user a decoration. Opened from a user (`uid`: pick the decoration) or from a
 * decoration (`item`: pick the user). Frames and entrance effects are worn at once.
 */
export function AssignDecorationModal({
  open,
  onClose,
  uid,
  item,
}: {
  open: boolean;
  onClose: () => void;
  uid?: string;
  item?: AdminCosmetic | null;
}) {
  const intentKey = useIntentKey(open);
  const [picked, setPicked] = useState<AdminCosmetic | null>(null);
  const chosen = item ?? picked;
  // Stable while open: FormModal re-seeds the form whenever this changes.
  const initialValues = useMemo<Partial<Values>>(
    () => (item ? { days: item.durationDays } : {}),
    [item],
  );

  const submit = async (v: Values) => {
    let target = uid;
    if (!target) {
      const found = await get<{ user: Brief | null }>('/admin/users/lookup', { q: v.user });
      if (!found.user) throw new Error('No active user with that ID');
      target = found.user.id;
    }
    return send(
      'post',
      `/admin/users/${encodeURIComponent(target)}/cosmetics`,
      { cosmeticId: item?.id ?? v.cosmeticId, days: v.days },
      { 'Idempotency-Key': intentKey },
    );
  };

  return (
    <FormModal<Values>
      open={open}
      title={item ? `Assign “${item.name}”` : 'Assign decoration'}
      okText="Assign"
      onClose={() => {
        setPicked(null);
        onClose();
      }}
      initialValues={initialValues}
      invalidate={[['user-cosmetics'], ['cosmetics']]}
      submit={submit}
    >
      {(form) => (
        <>
          {item ? (
            <Space style={{ marginBottom: 16 }}>
              <DecorationThumb item={item} size={48} />
              <div>
                <Typography.Text strong>{item.name}</Typography.Text>
                <br />
                <Typography.Text type="secondary">{cosmeticTypeLabel(item.type)}</Typography.Text>
              </div>
            </Space>
          ) : (
            <Form.Item
              name="cosmeticId"
              label="Decoration"
              rules={[{ required: true, message: 'Pick a decoration' }]}
            >
              <CosmeticPicker
                onPick={(it) => {
                  setPicked(it);
                  if (it) form.setFieldValue('days', it.durationDays);
                }}
              />
            </Form.Item>
          )}
          {!uid && (
            <Form.Item
              name="user"
              label="User"
              rules={[{ required: true, message: 'Enter a user ID' }]}
            >
              <UserPicker />
            </Form.Item>
          )}
          <Form.Item
            name="days"
            label="Days"
            rules={[{ required: true, message: 'How many days?' }]}
            extra="Added to any time they still hold on it."
          >
            <InputNumber min={1} max={MAX_GRANT_DAYS} style={{ width: '100%' }} />
          </Form.Item>
          {chosen &&
            (isWearable(chosen) ? (
              <Alert
                type="info"
                showIcon
                message={`Equipped right away, replacing the user's current ${
                  chosen.type === 'frame' ? 'avatar frame' : 'entrance effect'
                }.`}
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                message={`${cosmeticTypeLabel(chosen.type)}s can't be worn yet. The user will own it.`}
              />
            ))}
          {chosen && !chosen.active && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 8 }}
              message="This decoration is inactive, so it isn't sold in the store. Granting it still works."
            />
          )}
        </>
      )}
    </FormModal>
  );
}
