import { parse } from 'parse5';

// Associate visible text with annotation spans in bounded Poppler output.
export function cardLinksMatch(popplerXml, topics, locale, pageLabel) {
  const document = parse(popplerXml);
  let text = '';
  const hrefs = [];
  const normal = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  function visit(node) {
    if (node.tagName === 'text') {
      const chars = [];
      function collect(child, href) {
        if (child.tagName === 'a') href = child.attrs?.find(a => a.name === 'href')?.value ?? '';
        if (child.nodeName === '#text') for (let i = 0; i < child.value.length; i++) chars.push({ char: child.value[i], href });
        for (const nested of child.childNodes ?? []) collect(nested, href);
      }
      collect(node, '');
      let pendingSpace = false;
      for (const { char, href } of chars) {
        if (/\s/u.test(char)) { pendingSpace = true; continue; }
        if (pendingSpace && text && !text.endsWith(' ')) { text += ' '; hrefs.push(''); }
        pendingSpace = false;
        text += char; hrefs.push(href);
      }
      if (text && !text.endsWith(' ')) { text += ' '; hrefs.push(''); }
      return;
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(document);
  if (!text || !Array.isArray(topics) || !['en', 'de'].includes(locale) || typeof pageLabel !== 'function') return false;
  if (!topics.length) return true;
  const heading = locale === 'de' ? 'Wichtige Beobachtungen' : 'Key observations';
  const footer = locale === 'de' ? 'Lassen Sie uns sprechen' : 'Let’s get in touch';
  const headingAt = text.indexOf(heading);
  const footerAt = text.indexOf(footer, headingAt + heading.length);
  if (headingAt < 0 || footerAt < 0) return false;
  let from = headingAt + heading.length;
  for (let index = 0; index < topics.length; index++) {
    const title = normal(topics[index].title);
    const nextTitle = normal(topics[index + 1]?.title);
    if (!title) return false;
    const start = text.indexOf(title, from);
    const end = nextTitle ? text.indexOf(nextTitle, start + title.length) : footerAt;
    if (start < 0 || end <= start || end > footerAt) return false;
    const example = topics[index].urls?.[0];
    if (example && !example.redacted) {
      let expected, label;
      try { expected = new URL(example.url).href; label = normal(pageLabel(example.url, locale)); } catch { return false; }
      const prefix = locale === 'de' ? 'Beispielseite:' : 'Example page:';
      const prefixAt = text.indexOf(prefix, start);
      if (!label || prefixAt < 0 || prefixAt + prefix.length > end) return false;
      let cursor = prefixAt + prefix.length;
      for (let i = 0; i < label.length; i++) {
        const char = label[i];
        if (/\s/u.test(char)) continue;
        while (cursor < end && /\s/u.test(text[cursor])) cursor++;
        if (cursor >= end || text[cursor] !== char) return false;
        try { if (new URL(hrefs[cursor]).href !== expected) return false; } catch { return false; }
        cursor++;
      }
    }
    from = end;
  }
  return true;
}
