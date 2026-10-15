import React from 'react';
import { safeHref } from '@/lib/apiClient';

/**
 * Just enough Markdown for the changelog: **bold**, `code`, [links](https://…)
 * and nested "- " bullets. Built as React elements (never raw HTML).
 */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${i++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{inline(m[1], key)}</strong>);
    else if (m[2] !== undefined) out.push(<code key={key} className="px-1 rounded bg-stone-100 text-[0.95em]">{m[2]}</code>);
    else {
      const href = safeHref(m[4]);
      out.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="underline">{m[3]}</a> : m[3]);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MiniMarkdown({ lines }: { lines: string[] }) {
  return (
    <ul className="space-y-1 list-disc pl-4">
      {lines.map((line, i) => {
        const indent = line.match(/^\s*/)![0].length;
        const text = line.trim().replace(/^[-*]\s+/, '');
        return (
          <li key={i} className={indent >= 2 ? 'ml-4 list-[circle]' : ''}>
            {inline(text, String(i))}
          </li>
        );
      })}
    </ul>
  );
}
