import { useEffect, type ReactNode } from 'react';
import { App, Form, Modal, type FormInstance } from 'antd';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Modal + antd Form wired to a mutation. `children` receives the form instance and renders
 * the fields; `initialValues` re-seeds the form every time the modal opens.
 */
export function FormModal<V extends object>({
  open,
  title,
  initialValues,
  onClose,
  submit,
  invalidate = [],
  children,
  width = 560,
  okText = 'Save',
}: {
  open: boolean;
  title: ReactNode;
  initialValues?: Partial<V>;
  onClose: () => void;
  submit: (values: V) => Promise<unknown>;
  invalidate?: QueryKey[];
  children: (form: FormInstance<V>) => ReactNode;
  width?: number;
  okText?: string;
}) {
  const [form] = Form.useForm<V>();
  const { message } = App.useApp();
  const qc = useQueryClient();

  useEffect(() => {
    if (open) {
      form.resetFields();
      if (initialValues)
        form.setFieldsValue(initialValues as Parameters<typeof form.setFieldsValue>[0]);
    }
  }, [open, initialValues, form]);

  const m = useMutation({
    mutationFn: submit,
    onSuccess: async () => {
      message.success('Saved');
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
      onClose();
    },
    onError: (err: Error) => message.error(err.message),
  });

  return (
    <Modal
      open={open}
      title={title}
      width={width}
      onCancel={onClose}
      okText={okText}
      confirmLoading={m.isPending}
      onOk={() => form.validateFields().then((v) => m.mutate(v))}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark="optional" style={{ marginTop: 16 }}>
        {children(form)}
      </Form>
    </Modal>
  );
}
