import { useEffect, useState } from 'react';
import { Alert, Input, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { UserCell, type Brief } from './common';

interface Lookup {
  user: Brief | null;
  ownsAgencyId: string | null;
  memberOfAgencyId: string | null;
}

/**
 * Pick a user by the short id people see in the app (a uid also works). Drop it into a
 * `Form.Item` like an `<Input/>`: the field value is what was typed, and a preview of the
 * matching user (with their agency ties) shows underneath so staff confirm before saving.
 */
export function UserPicker({
  value,
  onChange,
  placeholder = 'Short ID, e.g. 200',
  warnIfInAgency = false,
}: {
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  /** Flag users who already own or belong to an agency. */
  warnIfInAgency?: boolean;
}) {
  const [term, setTerm] = useState(value ?? '');
  useEffect(() => {
    const t = setTimeout(() => setTerm((value ?? '').trim()), 350);
    return () => clearTimeout(t);
  }, [value]);

  const q = useQuery({
    queryKey: ['user-lookup', term],
    queryFn: () => get<Lookup>('/admin/users/lookup', { q: term }),
    enabled: term.length > 0,
    retry: false,
    staleTime: 30_000,
  });

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Input
        value={value}
        onChange={(e) => onChange?.(e.target.value.trim())}
        placeholder={placeholder}
        allowClear
      />
      {term && q.isFetching && <Spin size="small" />}
      {term && q.isError && !q.isFetching && (
        <Typography.Text type="danger">No active user with that ID</Typography.Text>
      )}
      {term && q.data?.user && (
        <>
          <UserCell user={q.data.user} />
          {warnIfInAgency && q.data.ownsAgencyId && (
            <Alert type="warning" showIcon message="This user already owns an agency" />
          )}
          {warnIfInAgency && q.data.memberOfAgencyId && (
            <Alert type="warning" showIcon message="This user is a host in an agency" />
          )}
        </>
      )}
    </Space>
  );
}
