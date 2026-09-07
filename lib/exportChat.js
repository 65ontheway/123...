// Lets the General Assistant flow generate a real downloadable file when a
// message explicitly asks for one ("export this as Word", "give me a
// PDF"), via the export_file tool. The model only decides *what* to put in
// the file — lib/export.js does the actual generation, and the file is
// served back through a short-lived link (lib/exportStore.js) rather than
// ever being inlined into a chat message.
//
// Sending `tools`/`tool_choice` on every single message would add a whole
// extra non-streaming round trip before the normal reply could even start
// streaming — a real latency cost paid by every message just to catch the
// rare export request. Instead, a cheap keyword check gates the two-call
// tool flow: only a message that plausibly asks for a file pays that cost;
// everything else keeps the existing single streaming call unchanged. The
// model itself is still the real gatekeeper for whether to *call* the tool
// (a passing mention of "PDF" won't produce a file) — this is only a filter
// on whether to offer it the option.
const { EXPORT_FILE_TOOL, generateExport, ExportValidationError } = require('./export');
const { storeExport, checkExportRateLimit } = require('./exportStore');

const EXPORT_INTENT_REGEX =
  /\b(export|download|pdf|docx?|word\s*doc(ument)?s?|csv|excel|xlsx|spreadsheets?|text\s*files?|txt\s*files?)\b/i;

function extractPlainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

function looksLikeExportRequest(content) {
  return EXPORT_INTENT_REGEX.test(extractPlainText(content));
}

const EXPORT_SYSTEM_MESSAGE = {
  role: 'system',
  content:
    'You can call the export_file tool to generate a downloadable file (txt, csv, pdf, docx, or xlsx), ' +
    'but ONLY when the user explicitly asks for a file, a download, or an export in their latest message. ' +
    'For a normal question or request, just answer directly in plain text and do not call this tool. ' +
    "When exporting, fill in the file's content/rows yourself from the conversation so far — pick a short, " +
    'descriptive filename (no extension) and the format the user asked for (default to pdf if unclear).',
};

// Forwards an upstream SSE stream unchanged, except: if `exportMeta` is
// given, one extra chunk carrying `delta.export = {...}` is written right
// before the terminal `data: [DONE]` line (or appended at the end, if the
// upstream never sends one) — the frontend already parses `delta.content`
// out of these chunks the same way, so `delta.export` rides along for free
// with no change to the wire format.
async function pipeExplainStream(upstream, res, exportMeta) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneSeen = false;
  const metadataChunk = exportMeta
    ? `data: ${JSON.stringify({ choices: [{ delta: { export: exportMeta } }] })}\n\n`
    : '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (metadataChunk && line.trim() === 'data: [DONE]') {
        doneSeen = true;
        res.write(metadataChunk);
      }
      res.write(line + '\n');
    }
  }
  if (buffer.trim()) res.write(buffer);
  if (metadataChunk && !doneSeen) {
    res.write(metadataChunk);
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

async function handleExportAwareChat(res, { upstreamMessages, selectedModel, maxTokens, apiKey, username, appUrl }) {
  if (!checkExportRateLimit(username)) {
    return res.status(429).json({ ok: false, error: 'Too many export requests — try again in a minute.' });
  }

  const baseHeaders = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': appUrl,
    'X-Title': 'Simple LLM Chat',
  };

  const toolCallRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      model: selectedModel,
      messages: [EXPORT_SYSTEM_MESSAGE, ...upstreamMessages],
      tools: [EXPORT_FILE_TOOL],
      tool_choice: 'auto',
      stream: false,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!toolCallRes.ok) {
    const data = await toolCallRes.json().catch(() => ({}));
    return res
      .status(toolCallRes.status)
      .json({ ok: false, error: data?.error?.message || 'OpenRouter request failed' });
  }
  const toolCallData = await toolCallRes.json();
  const assistantMessage = toolCallData?.choices?.[0]?.message;
  const toolCall = assistantMessage?.tool_calls?.[0];

  if (!toolCall) {
    // The keyword filter is deliberately loose (see the note above) — most
    // matches won't actually be an export ask, and the model correctly
    // answers in plain text instead. That reply is already fully generated
    // (this call wasn't streamed), so it's sent back as a single chunk
    // rather than live-streamed — the same trade-off already made for the
    // Soccer Lineup agent's non-tool-call case.
    const plainReply = assistantMessage?.content;
    if (!plainReply) {
      return res.status(502).json({ ok: false, error: 'Model did not return a response — try rephrasing.' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: plainReply } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return res.status(502).json({ ok: false, error: 'Model returned an invalid export request.' });
  }

  let toolResultContent;
  let exportMeta = null;
  try {
    const generated = await generateExport(args);
    const { id, expiresAt } = storeExport(generated);
    const filename = `${generated.filename}.${generated.extension}`;
    exportMeta = { url: `/api/files/${id}`, filename, format: generated.extension, expiresAt };
    toolResultContent = JSON.stringify({ url: exportMeta.url, filename, format: exportMeta.format, expiresAt });
  } catch (err) {
    const message = err instanceof ExportValidationError ? err.message : 'Failed to generate the file.';
    toolResultContent = `Could not generate the file: ${message}`;
  }

  const explainRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        EXPORT_SYSTEM_MESSAGE,
        ...upstreamMessages,
        assistantMessage,
        { role: 'tool', tool_call_id: toolCall.id, content: toolResultContent },
      ],
      stream: true,
      include_reasoning: true,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!explainRes.ok) {
    const data = await explainRes.json().catch(() => ({}));
    return res
      .status(explainRes.status)
      .json({ ok: false, error: data?.error?.message || 'OpenRouter request failed' });
  }
  return pipeExplainStream(explainRes, res, exportMeta);
}

module.exports = { looksLikeExportRequest, handleExportAwareChat };
