// Entry point: wires up the composer's send/streaming flow and the textarea's
// own behavior, then bootstraps the page. Everything else (thread state,
// settings, sidebar, attachments, message rendering) lives in its own module
// under public/js/ — this file is deliberately the only one that reaches
// into all of them, since it's the one place that actually needs to.
import {
  getActiveThread,
  saveState,
  touchActiveThread,
  makeThreadTitle,
  maybeGenerateTitle,
  initActiveThread,
  getActiveController,
  setActiveController,
} from './state.js';
import { loadModels, loadAgents } from './settings.js';
import { getStagedAttachments, clearStagedAttachments } from './attachments.js';
import { addBubble, renderUserContent, renderAssistantText, extractReasoningChunk, renderExportChip } from './messages.js';
import { renderLineupCard } from './lineup.js';

const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const logoutBtn = document.getElementById('logout-btn');
const usernameBtn = document.getElementById('username-btn');
const modelSelect = document.getElementById('model-select');
const responseLengthSelect = document.getElementById('response-length-select');
const agentSelect = document.getElementById('agent-select');
const attachBtn = document.getElementById('attach-btn');

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

sendBtn.addEventListener('click', (e) => {
  const activeController = getActiveController();
  if (activeController) {
    e.preventDefault();
    activeController.abort();
  }
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (getActiveController()) return;

  const text = input.value.trim();
  const stagedAttachments = getStagedAttachments();
  if (!text && stagedAttachments.length === 0) return;

  const userContent =
    stagedAttachments.length === 0
      ? text
      : [
          { type: 'text', text },
          ...stagedAttachments
            .filter((a) => a.kind === 'image')
            .map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } })),
          ...stagedAttachments
            .filter((a) => a.kind === 'pdf')
            .map((a) => ({ type: 'file', file: { filename: a.name, file_data: a.dataUrl } })),
          ...stagedAttachments
            .filter((a) => a.kind === 'doc')
            .map((a) => ({ type: 'text', text: `[Attached document: ${a.name}]\n\n${a.text}` })),
        ];

  const activeThread = getActiveThread();

  const userBubble = addBubble('user', '');
  renderUserContent(userBubble, userContent);
  activeThread.messages.push({ role: 'user', content: userContent });
  if (!activeThread.title) {
    activeThread.title = makeThreadTitle(text) || 'Attachment';
  }
  touchActiveThread();
  input.value = '';
  input.style.height = 'auto';
  clearStagedAttachments();

  const controller = new AbortController();
  setActiveController(controller);
  sendBtn.textContent = 'Stop';
  sendBtn.classList.add('stop');
  input.disabled = true;
  attachBtn.disabled = true;
  const bubble = addBubble('pending', 'Thinking...');
  let assistantText = '';
  let reasoningText = '';
  let structured = false;
  let finishReason = '';
  let exportMeta = null;
  let lineupMeta = null;

  function ensureAssistantStructure() {
    if (structured) return;
    structured = true;
    bubble.classList.remove('pending');
    bubble.classList.add('assistant');
    bubble.innerHTML =
      '<details class="thinking" hidden><summary>Thinking</summary><div class="thinking-body"></div></details><div class="answer"></div><div class="truncated-note" hidden>Response was cut off at the token limit.</div>';
  }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: activeThread.messages,
        model: modelSelect.value,
        responseLength: responseLengthSelect.value,
        agent: agentSelect.value,
      }),
      signal: controller.signal,
    });

    if (res.status === 401) {
      window.location.href = '/';
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      bubble.remove();
      addBubble('error', data.error || 'Something went wrong.');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamError = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }

        if (json.error) {
          streamError = json.error.message || 'OpenRouter request failed';
          continue;
        }

        const delta = json.choices?.[0]?.delta || {};
        if (json.choices?.[0]?.finish_reason) {
          finishReason = json.choices[0].finish_reason;
        }
        if (delta.export) {
          exportMeta = delta.export;
        }
        if (delta.lineup) {
          lineupMeta = delta.lineup;
        }

        const reasoningChunk = extractReasoningChunk(delta);
        if (reasoningChunk) {
          ensureAssistantStructure();
          reasoningText += reasoningChunk;
          const thinkingEl = bubble.querySelector('.thinking');
          thinkingEl.hidden = false;
          thinkingEl.open = true;
          renderAssistantText(bubble.querySelector('.thinking-body'), reasoningText);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        if (delta.content) {
          ensureAssistantStructure();
          if (!assistantText) {
            const thinkingEl = bubble.querySelector('.thinking');
            if (thinkingEl) thinkingEl.open = false; // collapse once the real answer starts
          }
          assistantText += delta.content;
          renderAssistantText(bubble.querySelector('.answer'), assistantText);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      }
    }

    if (streamError && !assistantText) {
      bubble.remove();
      addBubble('error', streamError);
    } else {
      if (finishReason === 'length') {
        const note = bubble.querySelector('.truncated-note');
        if (note) note.hidden = false;
      }
      if (exportMeta) {
        ensureAssistantStructure();
        renderExportChip(bubble, exportMeta);
      }
      const newMessage = {
        role: 'assistant',
        content: assistantText,
        ...(exportMeta ? { export: exportMeta } : {}),
        ...(lineupMeta ? { lineup: lineupMeta } : {}),
      };
      activeThread.messages.push(newMessage);
      if (lineupMeta) {
        ensureAssistantStructure();
        renderLineupCard(bubble, lineupMeta, {
          onUpdate: (newMeta) => {
            newMessage.lineup = newMeta;
            saveState();
          },
        });
      }
      touchActiveThread();
      maybeGenerateTitle(activeThread, text, assistantText, agentSelect.value);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      if (assistantText) {
        bubble.classList.remove('pending');
        bubble.classList.add('assistant');
        const newMessage = {
          role: 'assistant',
          content: assistantText,
          ...(exportMeta ? { export: exportMeta } : {}),
          ...(lineupMeta ? { lineup: lineupMeta } : {}),
        };
        activeThread.messages.push(newMessage);
        if (lineupMeta) {
          renderLineupCard(bubble, lineupMeta, {
            onUpdate: (newMeta) => {
              newMessage.lineup = newMeta;
              saveState();
            },
          });
        }
        touchActiveThread();
        maybeGenerateTitle(activeThread, text, assistantText, agentSelect.value);
      } else {
        bubble.remove();
      }
    } else {
      bubble.remove();
      addBubble('error', 'Could not reach the server.');
    }
  } finally {
    setActiveController(null);
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('stop');
    input.disabled = false;
    attachBtn.disabled = false;
    input.focus();
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});

usernameBtn.addEventListener('click', () => {
  window.location.href = '/profile';
});

async function loadUsername() {
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (data.ok) usernameBtn.textContent = data.username;
  } catch {
    // username just won't show — clicking still navigates to /profile
  }
}

(async () => {
  await Promise.all([loadModels(), loadAgents(), loadUsername()]);
  initActiveThread();
})();
