import type { FormRule } from 'antd';
import { ADMIN_PASSWORD_MAX_LENGTH, ADMIN_PASSWORD_MIN_LENGTH } from '@bigboss/shared';

/** Same limits the API enforces on `POST /admin/admins/:uid/password`. */
export const newPasswordRules: FormRule[] = [
  { required: true, message: 'Enter a new password' },
  {
    min: ADMIN_PASSWORD_MIN_LENGTH,
    message: `Use at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`,
  },
  {
    max: ADMIN_PASSWORD_MAX_LENGTH,
    message: `Use at most ${ADMIN_PASSWORD_MAX_LENGTH} characters`,
  },
  {
    validator: (_, value?: string) =>
      value && value.trim() !== value
        ? Promise.reject(new Error('No spaces at the start or end'))
        : Promise.resolve(),
  },
];

/** Must equal the field named `other`. */
export const confirmPasswordRules = (other: string): FormRule[] => [
  { required: true, message: 'Type the new password again' },
  ({ getFieldValue }) => ({
    validator: (_, value?: string) =>
      !value || value === getFieldValue(other)
        ? Promise.resolve()
        : Promise.reject(new Error('The passwords do not match')),
  }),
];
