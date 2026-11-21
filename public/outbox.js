const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function load() {
  const { messages } = await (await fetch('/api/dev/outbox')).json();
  document.getElementById('list').innerHTML = messages.length ? messages.map((m) => {
    const code = (m.subject || m.text || '').match(/\b\d{6}\b/);
    return `<div class="card stack"><div class="row spread small"><span class="chip">${m.channel === 'email' ? '✉ Email' : '💬 WhatsApp'}</span><span class="muted">${new Date(m.at).toLocaleString()}</span></div>
      <div><b>To:</b> ${esc(m.to)}</div>${m.subject ? `<div><b>${esc(m.subject)}</b></div>` : ''}
      ${code ? `<div class="otp-input" style="font-weight:700">${code[0]}</div>` : ''}
      <details><summary class="small">Message</summary><pre style="white-space:pre-wrap">${esc(m.text)}</pre></details></div>`;
  }).join('') : '<p class="muted">No messages yet.</p>';
}
document.getElementById('refresh').onclick = load;
load(); setInterval(load, 4000);
