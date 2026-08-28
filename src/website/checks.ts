export interface CheckFinding {
  category: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  file?: string;
}

export interface CheckSummary {
  findings: CheckFinding[];
  filesChecked: number;
}

const PLACEHOLDER_PATTERNS: Array<[RegExp, string]> = [
  [/lorem ipsum/i, 'lorem ipsum placeholder text'],
  [/\bTODO\b/, 'TODO marker'],
  [/\bFIXME\b/, 'FIXME marker'],
  [/PLACEHOLDER/i, 'placeholder marker'],
  [/YOUR[_ ]?(TEXT|NAME|COMPANY|BUSINESS|EMAIL|PHONE|LOGO)/i, 'template variable'],
  [/\bexample\.com\b/, 'example.com reference'],
  [/INSERT .* HERE/i, 'insert-here marker'],
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[a-zA-Z0-9]{16,}/, 'API key pattern (sk-...)'],
  [/api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i, 'hardcoded API key'],
  [/password\s*[:=]\s*['"][^'"]{4,}['"]/i, 'hardcoded password'],
  [/Bearer\s+[a-zA-Z0-9._-]{16,}/, 'bearer token'],
  [/BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY/, 'private key block'],
];

function extractHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1]!);
  return out;
}

/**
 * Deterministic QA checks over generated static site files. Runs on every
 * build; the Reviewer (LLM) sees these findings plus its own judgement.
 */
export function runBuildChecks(files: Map<string, string>, opts: { allowExternalResources?: boolean } = {}): CheckSummary {
  const findings: CheckFinding[] = [];
  const htmlFiles = [...files.entries()].filter(([p]) => p.endsWith('.html'));
  const lowerNames = new Set([...files.keys()].map((p) => p.toLowerCase()));

  if (![...lowerNames].includes('index.html')) {
    findings.push({ category: 'build', severity: 'high', description: 'index.html is missing at the site root' });
  }
  if (htmlFiles.length === 0) {
    findings.push({ category: 'build', severity: 'high', description: 'no HTML pages found in generated files' });
    return { findings, filesChecked: files.size };
  }

  for (const [file, content] of htmlFiles) {
    // Runtime-error-ish basics
    if (!/<\/html>/i.test(content)) {
      findings.push({ category: 'build', severity: 'high', description: 'HTML document not closed', file });
    }
    // Responsive behaviour
    if (!/<meta[^>]+name=["']viewport["']/i.test(content)) {
      findings.push({ category: 'responsive', severity: 'high', description: 'viewport meta tag missing', file });
    }
    // SEO basics
    if (!/<title>[^<]{3,}<\/title>/i.test(content)) {
      findings.push({ category: 'seo', severity: 'medium', description: 'missing or empty <title>', file });
    }
    if (!/<meta[^>]+name=["']description["']/i.test(content)) {
      findings.push({ category: 'seo', severity: 'low', description: 'meta description missing', file });
    }
    // Accessibility basics
    for (const img of content.matchAll(/<img\b[^>]*>/gi)) {
      if (!/\balt\s*=\s*["'][^"']*["']/i.test(img[0])) {
        findings.push({ category: 'accessibility', severity: 'medium', description: 'image without alt attribute', file });
      }
    }
    for (const label of content.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
      const tag = label[0];
      if (/\btype\s*=\s*["'](hidden|submit|button|reset)["']/i.test(tag)) continue;
      if (/\bid\s*=\s*["']([^"']+)["']/i.test(tag)) {
        const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)![1]!;
        if (!new RegExp(`<label[^>]+for\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(content)) {
          findings.push({ category: 'forms', severity: 'medium', description: `form control #${id} has no associated label`, file });
        }
      } else {
        findings.push({ category: 'forms', severity: 'medium', description: 'form control without id/label', file });
      }
    }
    // Navigation / links
    for (const href of extractHrefs(content)) {
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
      if (/^https?:\/\//i.test(href)) {
        if (!opts.allowExternalResources) {
          findings.push({ category: 'security', severity: 'medium', description: `external resource reference: ${href.slice(0, 80)}`, file });
        }
        continue;
      }
      const clean = href.split('#')[0]!.split('?')[0]!;
      if (clean === '') continue;
      const candidates = [clean, clean.replace(/^\.\//, ''), clean.replace(/^\//, '')];
      if (!candidates.some((c) => lowerNames.has(c.toLowerCase()))) {
        findings.push({ category: 'links', severity: 'high', description: `internal link target missing: ${clean}`, file });
      }
    }
    // Placeholder content
    for (const [re, label] of PLACEHOLDER_PATTERNS) {
      if (re.test(content)) {
        findings.push({ category: 'placeholder_content', severity: 'high', description: `placeholder content detected: ${label}`, file });
      }
    }
    // Secrets exposed client-side
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(content)) {
        findings.push({ category: 'exposed_secrets', severity: 'high', description: `possible secret in client-side file: ${label}`, file });
      }
    }
    // Broken UI / inline styles sanity: unclosed critical tags
    const opens = (content.match(/<div\b/gi) ?? []).length;
    const closes = (content.match(/<\/div>/gi) ?? []).length;
    if (Math.abs(opens - closes) > 2) {
      findings.push({ category: 'broken_ui', severity: 'low', description: 'unbalanced <div> tags', file });
    }
  }

  // Non-HTML files: secrets scan too (JS config etc.)
  for (const [file, content] of files) {
    if (file.endsWith('.html')) continue;
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(content)) {
        findings.push({ category: 'exposed_secrets', severity: 'high', description: `possible secret: ${label}`, file });
      }
    }
  }

  return { findings, filesChecked: files.size };
}
