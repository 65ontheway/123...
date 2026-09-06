// The composer's four dropdowns/config sources: which model, which agent,
// how long a reply should be, and (derived from the model catalog) which
// models can see images.
//
// Note: this module and attachments.js import from each other —
// settings.js needs to clear a staged image the moment the selected model
// stops supporting them, and attachments.js needs to know the current
// model's capability before staging one. That's a real, mutual dependency
// between "what can the current model do" and "what's staged for it", not
// an accident of file layout. It's safe under ES modules because both
// sides only touch the other's exports inside event handlers / async
// functions, never at the top level while the modules are still loading.
import { handleImageCapabilityChange } from './attachments.js';
import { getActiveThread, saveState } from './state.js';

const modelSelect = document.getElementById('model-select');
const agentSelect = document.getElementById('agent-select');
const responseLengthSelect = document.getElementById('response-length-select');

// Which models can accept images, keyed by model id — filled in from
// /api/models (which derives it from OpenRouter's live catalog). The
// "Upload image" menu item in attachments.js is shown/hidden based on this
// rather than a hardcoded list.
//
// The "Upload file" option isn't gated the same way: PDFs go through
// OpenRouter's own universal PDF parser (works with any model), and
// Word/Excel files are converted to plain text in the browser before
// sending — so neither depends on the selected model's declared modalities.
let modelCapabilities = new Map();

export function currentModelSupportsImages() {
  return modelCapabilities.get(modelSelect.value) === true;
}

modelSelect.addEventListener('change', () => {
  const thread = getActiveThread();
  if (thread) {
    thread.model = modelSelect.value;
    saveState();
  }
  handleImageCapabilityChange();
});

export async function loadModels() {
  try {
    const res = await fetch('/api/models');
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) return;
    modelSelect.innerHTML = '';
    modelCapabilities = new Map();
    for (const m of data.models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
      modelCapabilities.set(m.id, m.supportsImages === true);
    }
    modelSelect.value = data.default;
    handleImageCapabilityChange();
  } catch (err) {
    // dropdown just stays empty; chat still works with the server's default model
  }
}

export async function loadAgents() {
  try {
    const res = await fetch('/api/agents');
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) return;
    agentSelect.innerHTML = '';
    for (const a of data.agents) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.label;
      agentSelect.appendChild(opt);
    }
    const saved = localStorage.getItem('raygpt.agent');
    agentSelect.value = saved && [...agentSelect.options].some((o) => o.value === saved) ? saved : data.default;
  } catch (err) {
    // dropdown just stays empty; chat still works without an agent selected
  }
}

// Response length and agent are global settings (not tied to any one
// chat), unlike the model picker which is remembered per-thread.
const savedResponseLength = localStorage.getItem('raygpt.responseLength');
responseLengthSelect.value = ['short', 'medium', 'long'].includes(savedResponseLength)
  ? savedResponseLength
  : 'medium';
responseLengthSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('raygpt.responseLength', responseLengthSelect.value);
  } catch {
    // localStorage unavailable — setting just won't persist across reloads
  }
});
agentSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('raygpt.agent', agentSelect.value);
  } catch {
    // localStorage unavailable — setting just won't persist across reloads
  }
});
