// Streams an upstream OpenRouter response body straight through to the
// client unchanged. Shared by the plain chat flow and every agent's
// explanatory (post-tool-call) streamed reply.
async function pipeUpstreamStream(upstream, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(decoder.decode(value, { stream: true }));
  }
  res.end();
}

module.exports = { pipeUpstreamStream };
