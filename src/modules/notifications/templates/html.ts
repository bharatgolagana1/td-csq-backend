/** Tiny helpers shared by the e-mail templates. */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function paragraphs(lines: string[]): string {
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n');
}

export function link(href: string, label: string): string {
  return `<p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`;
}

/** Minimal, client-safe wrapper: no external assets, inline styles only. */
export function layout(title: string, bodyHtml: string, brandName: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; line-height: 1.5; max-width: 600px; margin: 0 auto; padding: 24px;">
<h2 style="font-weight: 600;">${escapeHtml(title)}</h2>
${bodyHtml}
<hr style="border: 0; border-top: 1px solid #ddd; margin: 24px 0;">
<p style="color: #666; font-size: 12px;">${escapeHtml(brandName)} · Cargo Service Quality</p>
</body></html>`;
}
