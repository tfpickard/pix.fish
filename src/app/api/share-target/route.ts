import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { POST as uploadPost } from '@/app/api/images/route';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// PWA share-target receiver. The manifest sends `image` for the file field;
// the upload API expects `file`. We rename and forward to the upload POST
// handler so enrichment + webhooks + slug generation all happen in one place.
export async function POST(req: Request) {
  const session = await auth();
  if (!isOwner(session)) {
    // Bounce to login so a signed-out share intent doesn't silently drop.
    return NextResponse.redirect(new URL('/api/auth/signin?callbackUrl=/admin/upload', req.url), 303);
  }

  let incoming: FormData;
  try {
    incoming = await req.formData();
  } catch {
    return NextResponse.redirect(new URL('/admin/upload?error=invalid-share', req.url), 303);
  }

  const image = incoming.get('image') ?? incoming.get('file');
  if (!(image instanceof File)) {
    return NextResponse.redirect(new URL('/admin/upload?error=no-image', req.url), 303);
  }

  const title = typeof incoming.get('title') === 'string' ? (incoming.get('title') as string) : '';
  const text = typeof incoming.get('text') === 'string' ? (incoming.get('text') as string) : '';
  const manualCaption = (title || text).trim().slice(0, 200);

  const forwardForm = new FormData();
  forwardForm.set('file', image, image.name);
  if (manualCaption) forwardForm.set('manual_caption', manualCaption);

  // Synthesize a Request against /api/images so the upload handler's
  // formData() parse and auth() lookup see real values. Preserve the cookie
  // header so the handler's isOwner() check still passes.
  const forwardedUrl = new URL('/api/images', req.url);
  const headers = new Headers();
  const cookie = req.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const forwarded = new Request(forwardedUrl, {
    method: 'POST',
    body: forwardForm,
    headers
  });
  const uploadRes = await uploadPost(forwarded);
  if (!uploadRes.ok) {
    return NextResponse.redirect(new URL('/admin/upload?error=share-upload-failed', req.url), 303);
  }
  const data = (await uploadRes.json().catch(() => ({}))) as { image?: { slug?: string } };
  const slug = data.image?.slug ?? '';
  const dest = new URL(`/admin/upload?shared=${encodeURIComponent(slug)}`, req.url);
  return NextResponse.redirect(dest, 303);
}
