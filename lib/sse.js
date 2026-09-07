// Streams an upstream OpenRouter response body through to the client,
// reconstructed line-by-line rather than as raw bytes so callers can
// observe/augment individual SSE events without changing what the client
// receives:
//   - onUsage(usage) — called whenever a chunk carries a top-level `usage`
//     field (OpenRouter always includes one in the final chunk of a
//     streaming response). Used to accumulate session token totals.
//   - extraChunk — a fully-formed `data: {...}\n\n` string written right
//     before the terminal `data: [DONE]` line (or appended at the very end,
//     if the upstream never sends one). Used by the export_file tool to
//     attach download metadata to the reply without changing the wire
//     format the frontend already parses.
// Shared by the plain chat flow and every agent's explanatory
// (post-tool-call) streamed reply.
async function pipeUpstreamStream(upstream, res, { onUsage, extraChunk } = {}) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneSeen = false;

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (trimmed === 'data: [DONE]') {
      doneSeen = true;
      if (extraChunk) res.write(extraChunk);
      res.write(line + '\n');
      return;
    }
    if (onUsage && trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const json = JSON.parse(payload);
          if (json.usage) onUsage(json.usage);
        } catch {
          // not JSON (keep-alive comment, partial line, etc.) — ignore
        }
      }
    }
    res.write(line + '\n');
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim()) res.write(buffer);
  if (extraChunk && !doneSeen) {
    res.write(extraChunk);
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

module.exports = { pipeUpstreamStream };
