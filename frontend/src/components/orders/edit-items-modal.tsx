'use client';

import { Modal } from '@/components/ui/modal';
import { OrderItemsEditor } from './order-items-editor';

/**
 * Fulfillment-queue "Edit items" modal — a thin Modal shell around the shared
 * {@link OrderItemsEditor}. All the editing logic lives in the shared editor so
 * the queue and the order-drawer's Items tab can never drift apart again.
 */
export function EditItemsModal({
  orderGid,
  orderName,
  currency = 'Rs',
  prepaid = false,
  onClose,
  onSaved,
}: {
  orderGid: string;
  orderName: string | null;
  currency?: string;
  prepaid?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={`Edit items — ${orderName ?? 'order'}`} size="lg">
      <OrderItemsEditor
        orderGid={orderGid}
        currency={currency}
        prepaid={prepaid}
        onClose={onClose}
        onSaved={onSaved}
      />
    </Modal>
  );
}
