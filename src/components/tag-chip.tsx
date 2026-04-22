import Link from 'next/link';
import { cn } from '@/lib/utils';

type Props = {
  tag: string;
  active?: boolean;
  href?: string;
  className?: string;
};

export function TagChip({ tag, active, href, className }: Props) {
  const body = <span className={cn('chip', active && 'chip-active', className)}>{tag}</span>;
  if (href) return <Link href={href}>{body}</Link>;
  return body;
}
