import { useEffect, useState } from 'react';
import { Select, Space, Tag, Typography } from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AdminCosmetic, Cosmetic, CosmeticType } from '@bigboss/shared';
import { get, type Paged } from '../lib/api';
import { cosmeticTypeLabel } from '../lib/decorations';
import { DecorationPreview } from './DecorationPreview';
import { VipTag } from './common';

/** A decoration's still preview if it has one, else the asset itself. */
export function DecorationThumb({
  item,
  size,
}: {
  item: Pick<Cosmetic, 'previewUrl' | 'assetUrl' | 'animationFormat'>;
  size: number;
}) {
  return item.previewUrl ? (
    <DecorationPreview url={item.previewUrl} format="none" size={size} />
  ) : (
    <DecorationPreview url={item.assetUrl} format={item.animationFormat} size={size} />
  );
}

/**
 * Pick a decoration by name from the whole catalog (inactive ones included, for event-only
 * grants). Drop it into a `Form.Item`: the value is the decoration id. `onPick` gets the full
 * item, e.g. to default a duration from it.
 */
export function CosmeticPicker({
  value,
  onChange,
  onPick,
  type,
}: {
  value?: string;
  onChange?: (id: string) => void;
  onPick?: (item: AdminCosmetic | null) => void;
  type?: CosmeticType;
}) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  // Remember the picked item so it stays labelled when a new search no longer lists it.
  const [picked, setPicked] = useState<AdminCosmetic | null>(null);

  const q = useQuery({
    queryKey: ['cosmetic-picker', term, type],
    queryFn: () => get<Paged<AdminCosmetic>>('/admin/cosmetics', { q: term, type, pageSize: 30 }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const items = q.data?.items ?? [];
  const shown =
    picked && picked.id === value && !items.some((i) => i.id === value)
      ? [picked, ...items]
      : items;

  return (
    <Select<string>
      value={value}
      placeholder="Search decorations by name"
      showSearch={{ filterOption: false, onSearch: setSearch }}
      loading={q.isFetching}
      notFoundContent={q.isFetching ? 'Searching…' : 'No decorations match'}
      onChange={(id) => {
        const item = shown.find((i) => i.id === id) ?? null;
        setPicked(item);
        onChange?.(id);
        onPick?.(item);
      }}
      optionLabelProp="title"
      options={shown.map((item) => ({
        value: item.id,
        title: item.name,
        label: (
          <Space>
            <DecorationThumb item={item} size={28} />
            <Typography.Text strong>{item.name}</Typography.Text>
            <Tag>{cosmeticTypeLabel(item.type)}</Tag>
            {item.vipTierRequired > 0 && <VipTag tier={item.vipTierRequired} />}
            {!item.active && <Tag>inactive</Tag>}
          </Space>
        ),
      }))}
    />
  );
}
