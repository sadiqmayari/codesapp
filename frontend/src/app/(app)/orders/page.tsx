import { redirect } from 'next/navigation';

// Orders landing → Shopify Orders (the fulfilment view) is the default tab.
// Abandoned checkouts moved to /orders/abandoned.
export default function OrdersIndex() {
  redirect('/orders/fulfillment');
}
