import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Card, Table, type TableProps } from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, type Paged } from '../lib/api';

export interface ServerTableProps<T> {
  queryKey: string;
  url: string;
  filters?: Record<string, unknown>;
  columns: TableProps<T>['columns'];
  rowKey: string | ((row: T) => string);
  toolbar?: ReactNode;
  pageSize?: number;
  expandable?: TableProps<T>['expandable'];
  title?: ReactNode;
  footer?: (data: (Paged<T> & Record<string, unknown>) | undefined) => ReactNode;
  /** Called whenever a new page of rows arrives (e.g. to enable "export this page"). */
  onData?: (rows: T[]) => void;
}

/** Server-paginated table: page/pageSize/filters are part of the query key and the request. */
export function ServerTable<T extends object>({
  queryKey,
  url,
  filters = {},
  columns,
  rowKey,
  toolbar,
  pageSize: initialSize = 20,
  expandable,
  title,
  footer,
  onData,
}: ServerTableProps<T>) {
  const filterKey = JSON.stringify(filters);
  // Paging is remembered per filter set, so new filters start back on page 1.
  const [paging, setPaging] = useState({ filterKey, page: 1 });
  const page = paging.filterKey === filterKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ filterKey, page: p });
  const [pageSize, setPageSize] = useState(initialSize);
  const q = useQuery({
    queryKey: [queryKey, url, filters, page, pageSize],
    queryFn: () => get<Paged<T> & Record<string, unknown>>(url, { ...filters, page, pageSize }),
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (q.data) onData?.(q.data.items);
  }, [q.data, onData]);

  return (
    <Card
      variant="borderless"
      title={title}
      extra={toolbar}
      styles={{ body: { padding: 0 } }}
      style={{ boxShadow: '0 1px 2px rgba(43,33,24,0.06), 0 4px 16px rgba(43,33,24,0.04)' }}
    >
      {q.error && (
        <Alert type="error" showIcon message={(q.error as Error).message} style={{ margin: 16 }} />
      )}
      <Table<T>
        rowKey={rowKey as TableProps<T>['rowKey']}
        columns={columns}
        dataSource={q.data?.items ?? []}
        loading={q.isFetching}
        expandable={expandable}
        scroll={{ x: 'max-content' }}
        pagination={{
          current: page,
          pageSize,
          total: q.data?.total ?? 0,
          showSizeChanger: true,
          showTotal: (t) => `${t.toLocaleString()} total`,
          onChange: (p, s) => {
            setPage(s !== pageSize ? 1 : p);
            setPageSize(s);
          },
        }}
        footer={footer ? () => footer(q.data) : undefined}
      />
    </Card>
  );
}
