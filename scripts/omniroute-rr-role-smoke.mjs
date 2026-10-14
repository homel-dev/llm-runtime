const base = 'http://127.0.0.1:20128';
const auth = 'Bearer rr-in-pod-role-proxy-no-credential';
const tool = {
  type: 'function',
  name: 'read',
  description: 'Read a small path',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const requests = [
  {
    label: 'coder /v1/chat/completions',
    path: '/v1/chat/completions',
    body: {
      model: 'coder',
      messages: [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: 'Reply with the word ready.' }],
      stream: true, stream_options: { include_usage: true }, max_tokens: 256,
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }],
      thinking: { type: 'enabled', clear_thinking: false },
    },
  },
  {
    label: 'planner /v1/responses',
    path: '/v1/responses',
    body: {
      model: 'planner',
      input: [
        { role: 'developer', content: 'Answer briefly.' },
        { role: 'user', content: [{ type: 'input_text', text: 'Reply with the word ready.' }] },
      ],
      stream: true, store: false, max_output_tokens: 256,
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'], tools: [tool],
    },
  },
];
for (const { label, path, body } of requests) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth, accept: 'text/event-stream' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    console.error(`${label}: HTTP ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  if (!res.body) { console.error(`${label}: missing SSE body`); process.exitCode = 1; continue; }
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = '', meaningful = false, completed = false, failed = false, events = 0;
  const deadline = Date.now() + 110000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const frame = buffer.slice(0, separator.index).replaceAll('\r', '');
      buffer = buffer.slice(separator.index + separator[0].length);
      const event = /^event:\s*(\S+)/m.exec(frame)?.[1] || '';
      if (event === 'error' || event === 'response.failed') failed = true;
      for (const line of frame.split('\n').filter(x => x.startsWith('data:'))) {
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') { if (path.endsWith('/chat/completions')) completed = true; continue; }
        let decoded;
        try { decoded = JSON.parse(payload); } catch { continue; }
        if (decoded.error || decoded.type === 'error' || decoded.type === 'response.failed') failed = true;
        if (decoded.type === 'response.completed') completed = true;
        if (decoded.choices?.length || decoded.type === 'response.completed' || decoded.type === 'response.output_text.delta' || decoded.type === 'response.output_item.added') meaningful = true;
        events++;
      }
    }
  }
  if (failed || !meaningful || !completed) {
    console.error(`${label}: FAIL streamError=${failed} meaningful=${meaningful} completed=${completed} events=${events}`);
    process.exitCode = 1;
  } else {
    console.log(`${label}: SSE OK events=${events}`);
  }
}
