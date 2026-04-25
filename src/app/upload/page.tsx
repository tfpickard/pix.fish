import { redirect } from 'next/navigation';

export const dynamic = 'force-static';

// Convenience alias for visitors typing /upload directly. Auth gating happens
// at /admin/upload (redirects to sign-in via the admin layout).
export default function UploadAlias() {
  redirect('/admin/upload');
}
