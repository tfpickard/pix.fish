import { redirect } from 'next/navigation';

export const dynamic = 'force-static';

// /admin lands on the per-user upload page. The admin layout already
// gates non-authenticated visitors with a redirect to sign-in, so this
// page just resolves the bare /admin path.
export default function AdminIndex() {
  redirect('/admin/upload');
}
