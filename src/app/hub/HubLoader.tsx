'use client';

import dynamic from 'next/dynamic';

// Rendered in the browser only: it reads the device's view choice and the reset link's fragment.
const AdminApp = dynamic(() => import('@/components/admin/AdminApp').then((m) => m.AdminApp), { ssr: false });

export function HubLoader() {
  return <AdminApp />;
}
