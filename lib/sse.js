async function pipeUpstreamStream(upstream, res, { onUsage, extraChunk } = {}) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', doneSeen = false;
  const handle = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { doneSeen = true; return; }
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    if (data.error) throw new Error('Provider stream failed');
    if (data.usage) onUsage?.(data.usage);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  try {
    while (!doneSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 256000) throw new Error('Stream event too large');
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) handle(line);
    }
    if (buffer.trim()) handle(buffer);
    if (!doneSeen) throw new Error('Stream interrupted');
    if (extraChunk) res.write(extraChunk);
    res.write('data: [DONE]\n\n');
  } catch {
    if (extraChunk) res.write(extraChunk);
    res.write(`data: ${JSON.stringify({ error: { message: 'The response was interrupted. Completed actions remain saved.' } })}\n\n`);
  } finally {
    await reader.cancel().catch(() => {});
    res.end();
  }
}
module.exports = { pipeUpstreamStream };
