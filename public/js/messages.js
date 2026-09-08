// Rendering chat content into the #messages panel: user/assistant bubbles,
// Markdown, the empty-chat suggestion cards, and (via lineup.js) a soccer
// lineup's draft/finalize card. Self-contained — takes the data it needs as
// function arguments rather than importing app state, so it has no
// dependency on any other module in this app; lineup.js follows the same
// rule (it reports changes back via a callback instead of importing
// state.js), so composing it here doesn't break that property.
import { renderLineupCard } from './lineup.js';

const messagesEl = document.getElementById('messages');
const input = document.getElementById('input');

export function addBubble(role, text) {
  messagesEl.querySelector('#empty-state')?.remove();
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// A user message's `content` is a plain string for text-only messages, or an
// OpenAI/OpenRouter-style array of parts once something is attached:
//   { type: 'text', text }
//   { type: 'image_url', image_url: { url } }
//   { type: 'file', file: { filename, file_data } }               (PDF)
// Word/Excel attachments have no API content type of their own — their
// extracted text is sent as an extra `text` part, tagged with a
// recognizable "[Attached document: name]" header so it round-trips back
// into a labeled chip here instead of reading as part of the user's own
// message.
const DOC_ATTACHMENT_PREFIX = /^\[Attached document: (.+?)\]\n\n/;

export function renderUserContent(bubble, content) {
  bubble.textContent = '';
  if (typeof content === 'string') {
    bubble.textContent = content;
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part.type === 'image_url' && part.image_url?.url) {
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.src = part.image_url.url;
      bubble.appendChild(img);
    } else if (part.type === 'file' && part.file?.filename) {
      bubble.appendChild(makeFileChipEl(part.file.filename, '📄'));
    } else if (part.type === 'text' && part.text) {
      const docMatch = part.text.match(DOC_ATTACHMENT_PREFIX);
      if (docMatch) {
        bubble.appendChild(makeFileChipEl(docMatch[1], '📝'));
        continue;
      }
      const textDiv = document.createElement('div');
      textDiv.className = 'msg-text';
      textDiv.textContent = part.text;
      bubble.appendChild(textDiv);
    }
  }
}

function makeFileChipEl(name, icon) {
  const chip = document.createElement('div');
  chip.className = 'msg-file';
  const iconEl = document.createElement('span');
  iconEl.className = 'file-icon';
  iconEl.textContent = icon;
  const nameEl = document.createElement('span');
  nameEl.textContent = name;
  chip.append(iconEl, nameEl);
  return chip;
}

// Renders the small download link the export_file tool's result produces
// (see chat.js / lib/exportChat.js). Only ever called for the one message
// that actually carries export metadata — never a persistent per-message
// control.
export function renderExportChip(bubble, exportMeta) {
  if (!exportMeta || !/^\/api\/files\/[a-f0-9-]{36}$/.test(exportMeta.url || '')) return;
  const link = document.createElement('a');
  link.className = 'msg-export';
  link.href = exportMeta.url;
  link.download = exportMeta.filename || 'export';
  link.title = `Download ${(exportMeta.format || 'file').toUpperCase()}`;
  link.target = '_blank';
  link.rel = 'noopener';
  const icon = document.createElement('span');
  icon.className = 'export-icon';
  icon.textContent = '⬇️';
  const label = document.createElement('span');
  label.textContent = exportMeta.filename || 'Download';
  link.append(icon, label);
  bubble.appendChild(link);
}

export function renderAssistantText(el, text) {
  if (window.marked && window.DOMPurify) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  } else {
    // Markdown libraries failed to load (CDN blocked, offline, etc.) — fall
    // back to plain text rather than breaking the chat.
    el.textContent = text;
  }
}

// Some reasoning models stream a flat `reasoning` string; others send a
// structured `reasoning_details` array. `reasoning.encrypted` entries are
// opaque provider-signed blobs, not human-readable text, so they're skipped.
export function extractReasoningChunk(delta) {
  if (typeof delta.reasoning === 'string' && delta.reasoning) {
    return delta.reasoning;
  }
  if (Array.isArray(delta.reasoning_details)) {
    let text = '';
    for (const d of delta.reasoning_details) {
      if (d.type === 'reasoning.text' && typeof d.text === 'string') text += d.text;
      else if (d.type === 'reasoning.summary' && typeof d.summary === 'string') text += d.summary;
    }
    return text;
  }
  return '';
}

// Example prompts shown on an empty chat instead of a plain placeholder
// line. Clicking one fills the composer (rather than sending immediately)
// so the user can tweak it first — several are intentionally incomplete
// sentences meant to be finished.
const EMPTY_STATE_SUGGESTIONS = [
  { icon: '💡', label: 'Explain something', detail: 'Explain … like I\'m new to it', prompt: 'Explain ' },
  { icon: '✍️', label: 'Help me write', detail: 'Draft an email, message, or doc', prompt: 'Help me write ' },
  { icon: '💻', label: 'Debug some code', detail: 'Paste an error and get a fix', prompt: 'Here\'s an error I\'m seeing — help me fix it:\n\n' },
  { icon: '📎', label: 'Summarize a file', detail: 'Attach a PDF, Word, or Excel file', prompt: 'Please summarize the attached document.' },
];

function renderEmptyState() {
  const soccer = document.getElementById('agent-select')?.value === 'soccer-lineup';
  const wrap = document.createElement('div');
  wrap.id = 'empty-state';

  const headline = document.createElement('p');
  headline.className = 'empty-state-headline';
  headline.textContent = 'What are we working on?';
  wrap.appendChild(headline);

  const subhead = document.createElement('p');
  subhead.className = 'empty-state-subhead';
  subhead.textContent = soccer ? 'Start with a command, using names from your roster.' : 'Ask anything, or start from one of these.';
  wrap.appendChild(subhead);

  const grid = document.createElement('div');
  grid.className = 'suggestion-grid';
  const suggestions = soccer ? [
    { icon: '⚽', label: 'Create a lineup', detail: 'Uses your saved roster and preferences', prompt: 'Create a lineup' },
    { icon: '⏸', label: 'Rest a player', detail: 'Replace the name with a current roster name', prompt: 'Rest [player name] in Q1' },
    { icon: '📍', label: 'Choose a position', detail: 'Specify the player, position and quarter', prompt: 'Put [player name] at left back in Q2' },
    { icon: '⚙️', label: 'Set a preference', detail: 'Review before saving a new default', prompt: 'Make weaker defenders on the left my default' },
  ] : EMPTY_STATE_SUGGESTIONS;
  for (const s of suggestions) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'suggestion-card';

    const icon = document.createElement('span');
    icon.className = 'suggestion-icon';
    icon.textContent = s.icon;
    card.appendChild(icon);

    const textWrap = document.createElement('span');
    textWrap.className = 'suggestion-text';
    const label = document.createElement('span');
    label.className = 'suggestion-label';
    label.textContent = s.label;
    const detail = document.createElement('span');
    detail.className = 'suggestion-detail';
    detail.textContent = s.detail;
    textWrap.append(label, detail);
    card.appendChild(textWrap);

    card.addEventListener('click', () => {
      input.value = s.prompt;
      input.dispatchEvent(new Event('input')); // trigger auto-grow
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });

    grid.appendChild(card);
  }
  wrap.appendChild(grid);
  messagesEl.appendChild(wrap);
}

// Renders a thread's full message list into #messages, or the empty-state
// suggestions if it has none yet. `messages` is a thread's own messages
// array (not read from shared state — see state.js). `onLineupUpdate`, if
// given, is called as `onLineupUpdate(message, newLineupMeta)` whenever a
// lineup card's own action (generate another option / finalize / undo)
// changes that message's lineup metadata — the caller (state.js) decides
// how to persist it; omitting the callback still renders the card, it just
// won't survive a reload.
export function renderHistory(messages, { onLineupUpdate } = {}) {
  messagesEl.innerHTML = '';
  if (messages.length === 0) {
    renderEmptyState();
    return;
  }
  for (const m of messages) {
    const bubble = addBubble(m.role === 'user' ? 'user' : 'assistant', '');
    if (m.role === 'assistant') {
      renderAssistantText(bubble, m.content);
      renderExportChip(bubble, m.export);
      if (m.lineup) {
        renderLineupCard(bubble, m.lineup, {
          onUpdate: (newMeta) => onLineupUpdate && onLineupUpdate(m, newMeta),
        });
      }
    } else {
      renderUserContent(bubble, m.content);
    }
  }
}

document.getElementById('agent-select')?.addEventListener('change', () => {
  const empty = messagesEl.querySelector('#empty-state');
  if (empty) { empty.remove(); renderEmptyState(); }
});
