// Minimal, safe Markdown -> HTML renderer (escapes all HTML first).
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<button type="button" class="ts-link" data-ts="$1">$1</button>');
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  let html = '', list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); closeList(); const n = m[1].length; html += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushPara(); closeList(); html += '<hr>'; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushPara(); closeList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      html += '<div class="table-wrap"><table><thead><tr>' + cells(line).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { html += '<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++; }
      i--; html += '</tbody></table></div>'; continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (list !== type) { closeList(); html += `<${type}>`; list = type; }
      html += `<li>${inline(m[1].replace(/^\[( |x)\]\s*/i, (x) => (x.includes('x') || x.includes('X') ? '☑ ' : '☐ ')))}</li>`;
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    closeList(); para.push(line.trim());
  }
  flushPara(); closeList();
  return html;
}
