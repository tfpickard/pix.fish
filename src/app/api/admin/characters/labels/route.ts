import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { deleteLabel, listLabelsForSubject, upsertLabel } from '@/lib/db/queries/character-labels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Eval ground-truth labels. An admin marks each appearance correct/wrong under a
// stable subjectLabel; scripts/eval-characters.ts scores a census against these.
// GET ?subject=<label> returns that subject's labels (to prefill the UI).

export async function GET(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const subject = new URL(req.url).searchParams.get('subject');
  if (!subject) return NextResponse.json({ labels: [] });
  const labels = await listLabelsForSubject(subject);
  return NextResponse.json({ labels });
}

const putSchema = z.object({
  subjectLabel: z.string().min(1).max(120),
  imageId: z.number().int().positive(),
  // null clears the label; true/false sets the verdict.
  verdict: z.boolean().nullable()
});

export async function PUT(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = putSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const { subjectLabel, imageId, verdict } = parsed.data;
  if (verdict === null) await deleteLabel(subjectLabel, imageId);
  else await upsertLabel(subjectLabel, imageId, verdict);
  return NextResponse.json({ ok: true });
}
