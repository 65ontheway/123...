    const messagesEl = document.getElementById('messages');
    const composer = document.getElementById('composer');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const modelSelect = document.getElementById('model-select');
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebarResizer = document.getElementById('sidebar-resizer');
    const sidebarBackdrop = document.getElementById('sidebar-backdrop');
    const newChatBtn = document.getElementById('new-chat-btn');
    const threadListEl = document.getElementById('thread-list');
    const responseLengthSelect = document.getElementById('response-length-select');
    const agentSelect = document.getElementById('agent-select');
    const imageInput = document.getElementById('image-input');
    const fileInput = document.getElementById('file-input');
    const attachmentPreviewsEl = document.getElementById('attachment-previews');
    const attachBtn = document.getElementById('attach-btn');
    const attachMenu = document.getElementById('attach-menu');
    const attachFileItem = document.getElementById('attach-file-item');
    const attachImageItem = document.getElementById('attach-image-item');

    let history = [];
    let activeController = null;

    // Which models can accept images, keyed by model id — filled in from
    // /api/models (which derives it from OpenRouter's live catalog). The
    // "Upload image" menu item is shown/hidden based on this rather than a
    // hardcoded list.
    //
    // The "Upload file" option isn't gated the same way: PDFs go through
    // OpenRouter's own universal PDF parser (works with any model), and
    // Word/Excel files are converted to plain text in the browser before
    // sending — so neither depends on the selected model's declared modalities.
    let modelCapabilities = new Map();

    // Staged attachments not yet sent, in the order they'll appear in the
    // outgoing message. Each entry is one of:
    //   { id, kind: 'image', name, dataUrl }
    //   { id, kind: 'pdf',   name, dataUrl }
    //   { id, kind: 'doc',   name, text }        (extracted from .docx/.xlsx/.xls)
    let stagedAttachments = [];

    // The "Upload image" menu item's visibility is computed fresh each time
    // the attach menu opens (see openAttachMenu), so this just needs to drop
    // any already-staged image the moment the selected model can't take one.
    function handleImageCapabilityChange() {
      const supportsImages = modelCapabilities.get(modelSelect.value) === true;
      if (!supportsImages && stagedAttachments.some((a) => a.kind === 'image')) {
        stagedAttachments = stagedAttachments.filter((a) => a.kind !== 'image');
        renderAttachmentPreviews();
      }
    }

    // Conversation threads persist in this browser via localStorage (no
    // server-side storage). Each thread keeps its own messages and the model
    // last used with it; `history` always points at the active thread's
    // messages array, so pushing to it updates the thread in place.
    const STORAGE_KEY = 'raygpt.threads.v1';

    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { threads: [], activeId: null };
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.threads) ? parsed : { threads: [], activeId: null };
      } catch {
        return { threads: [], activeId: null };
      }
    }

    let state = loadState();

    function saveState() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        // localStorage unavailable (private browsing, quota, etc.) — chat
        // still works this session, it just won't persist across reloads.
      }
    }

    function getActiveThread() {
      return state.threads.find((t) => t.id === state.activeId) || null;
    }

    function makeThreadTitle(text) {
      const trimmed = text.trim().replace(/\s+/g, ' ');
      // Cap well past anything the sidebar could ever visually fit (even at
      // its max drag width), so the CSS ellipsis on .thread-item-title does
      // the real, width-aware truncation — this cap only exists to avoid
      // storing an entire pasted essay as a "title".
      return trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
    }

    // After a chat's very first exchange completes, ask the server for a
    // short, real title instead of leaving the truncated first message in
    // the sidebar forever. Only ever attempted once per chat — the flag
    // flips regardless of success so a failure doesn't retry on every message.
    async function maybeGenerateTitle(thread, userText, assistantText) {
      if (!thread || thread.titleGenerated || thread.messages.length !== 2) return;
      thread.titleGenerated = true;
      try {
        const res = await fetch('/api/generate-title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userMessage: userText, assistantMessage: assistantText }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok && data.title) {
          thread.title = data.title;
          saveState();
          renderThreadList();
        }
        // On failure, the truncated fallback title set at send time is left as-is.
      } catch {
        // Network error — same fallback-stays-in-place behavior as above.
      }
    }

    function touchActiveThread() {
      const thread = getActiveThread();
      if (!thread) return;
      thread.updatedAt = Date.now();
      saveState();
      renderThreadList();
    }

    function closeSidebarOnMobile() {
      sidebar.classList.remove('open');
      sidebarBackdrop.classList.remove('open');
    }

    function renderThreadList() {
      threadListEl.innerHTML = '';
      const sorted = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const t of sorted) {
        const item = document.createElement('div');
        item.className = 'thread-item' + (t.id === state.activeId ? ' active' : '');
        item.tabIndex = 0;
        item.setAttribute('role', 'button');

        const title = document.createElement('span');
        title.className = 'thread-item-title';
        title.textContent = t.title || 'New chat';
        title.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          startRenaming(item, title, t);
        });
        item.appendChild(title);

        const rename = document.createElement('button');
        rename.className = 'thread-item-rename';
        rename.textContent = '✎';
        rename.setAttribute('aria-label', 'Rename chat');
        rename.addEventListener('click', (e) => {
          e.stopPropagation();
          startRenaming(item, title, t);
        });
        item.appendChild(rename);

        const del = document.createElement('button');
        del.className = 'thread-item-delete';
        del.textContent = '✕';
        del.setAttribute('aria-label', 'Delete chat');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteThread(t.id);
        });
        item.appendChild(del);

        item.addEventListener('click', () => switchToThread(t.id));
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            switchToThread(t.id);
          }
        });

        threadListEl.appendChild(item);
      }
    }

    function startRenaming(item, titleEl, thread) {
      let cancelled = false;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'thread-item-title-input';
      input.value = thread.title || '';
      input.maxLength = 100;

      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelled = true;
          renderThreadList();
        }
      });
      input.addEventListener('blur', () => {
        if (cancelled) return;
        const value = input.value.trim();
        thread.title = value || 'New chat';
        saveState();
        renderThreadList();
      });

      item.replaceChild(input, titleEl);
      input.focus();
      input.select();
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
      const wrap = document.createElement('div');
      wrap.id = 'empty-state';

      const headline = document.createElement('p');
      headline.className = 'empty-state-headline';
      headline.textContent = 'What are we working on?';
      wrap.appendChild(headline);

      const subhead = document.createElement('p');
      subhead.className = 'empty-state-subhead';
      subhead.textContent = 'Ask anything, or start from one of these.';
      wrap.appendChild(subhead);

      const grid = document.createElement('div');
      grid.className = 'suggestion-grid';
      for (const s of EMPTY_STATE_SUGGESTIONS) {
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

    function renderHistory() {
      messagesEl.innerHTML = '';
      if (history.length === 0) {
        renderEmptyState();
        return;
      }
      for (const m of history) {
        const bubble = addBubble(m.role === 'user' ? 'user' : 'assistant', '');
        if (m.role === 'assistant') {
          renderAssistantText(bubble, m.content);
        } else {
          renderUserContent(bubble, m.content);
        }
      }
    }

    function applyThreadModel(thread) {
      if (thread.model && [...modelSelect.options].some((o) => o.value === thread.model)) {
        modelSelect.value = thread.model;
      }
      handleImageCapabilityChange();
    }

    function switchToThread(id) {
      if (id === state.activeId) return closeSidebarOnMobile();
      if (activeController) activeController.abort();
      const thread = state.threads.find((t) => t.id === id);
      if (!thread) return;
      state.activeId = id;
      history = thread.messages;
      renderHistory();
      applyThreadModel(thread);
      renderThreadList();
      saveState();
      closeSidebarOnMobile();
    }

    function createThread() {
      if (activeController) activeController.abort();
      const thread = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        title: '',
        model: modelSelect.value || '',
        messages: [],
        updatedAt: Date.now(),
        titleGenerated: false, // flips true after the one-shot title generation call, success or fail
      };
      state.threads.push(thread);
      state.activeId = thread.id;
      history = thread.messages;
      renderHistory();
      renderThreadList();
      saveState();
      closeSidebarOnMobile();
      input.focus();
    }

    function deleteThread(id) {
      state.threads = state.threads.filter((t) => t.id !== id);
      if (state.activeId !== id) {
        renderThreadList();
        saveState();
        return;
      }
      state.activeId = null;
      const next = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (next) {
        switchToThread(next.id);
      } else {
        createThread();
      }
    }

    newChatBtn.addEventListener('click', createThread);
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      sidebarBackdrop.classList.toggle('open');
    });
    sidebarBackdrop.addEventListener('click', closeSidebarOnMobile);

    // Drag-to-resize the sidebar. Width is remembered in localStorage so it
    // stays put across reloads, same as the thread state.
    const SIDEBAR_WIDTH_KEY = 'raygpt.sidebarWidth';
    const MIN_SIDEBAR_WIDTH = 160;
    const MAX_SIDEBAR_WIDTH = 480;

    function applySidebarWidth(px) {
      const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, px));
      sidebar.style.width = clamped + 'px';
    }

    try {
      const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (savedWidth) applySidebarWidth(parseInt(savedWidth, 10));
    } catch {
      // localStorage unavailable — sidebar just uses the default width
    }

    let resizing = false;

    function startResize() {
      resizing = true;
      sidebarResizer.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    }

    function doResize(clientX) {
      if (!resizing) return;
      const rect = sidebar.getBoundingClientRect();
      applySidebarWidth(clientX - rect.left);
    }

    function endResize() {
      if (!resizing) return;
      resizing = false;
      sidebarResizer.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebar.getBoundingClientRect().width)));
      } catch {
        // localStorage unavailable — width just won't persist across reloads
      }
    }

    sidebarResizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startResize();
    });
    window.addEventListener('mousemove', (e) => doResize(e.clientX));
    window.addEventListener('mouseup', endResize);

    sidebarResizer.addEventListener('touchstart', startResize, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!resizing) return;
      doResize(e.touches[0].clientX);
    });
    window.addEventListener('touchend', endResize);

    modelSelect.addEventListener('change', () => {
      const thread = getActiveThread();
      if (thread) {
        thread.model = modelSelect.value;
        saveState();
      }
      handleImageCapabilityChange();
    });

    async function loadModels() {
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

    async function loadAgents() {
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

    (async () => {
      await Promise.all([loadModels(), loadAgents()]);
      if (state.threads.length === 0) {
        createThread();
        return;
      }
      if (!getActiveThread()) {
        state.activeId = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
      }
      const thread = getActiveThread();
      history = thread.messages;
      renderHistory();
      applyThreadModel(thread);
      renderThreadList();
    })();

    function addBubble(role, text) {
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

    function renderUserContent(bubble, content) {
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

    // Images are downscaled and re-encoded client-side before being sent, so a
    // photo straight off a phone camera doesn't balloon the request (and the
    // stored thread history, which resends every past attachment on every turn).
    const MAX_IMAGE_DIMENSION = 1280;
    const IMAGE_JPEG_QUALITY = 0.82;

    function downscaleImage(file) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          let { width, height } = img;
          if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
            const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY));
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Could not load image'));
        };
        img.src = objectUrl;
      });
    }

    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    }

    function fileToArrayBuffer(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });
    }

    // .docx -> plain text via mammoth (self-hosted browser bundle, no server round-trip).
    async function extractDocxText(file) {
      const arrayBuffer = await fileToArrayBuffer(file);
      const result = await window.mammoth.extractRawText({ arrayBuffer });
      return result.value.trim();
    }

    // .xlsx/.xls -> plain text via exceljs: each sheet rendered as a simple
    // comma-separated grid under a heading with its sheet name.
    async function extractSpreadsheetText(file) {
      const arrayBuffer = await fileToArrayBuffer(file);
      const workbook = new window.ExcelJS.Workbook();
      await workbook.xlsx.load(arrayBuffer);
      const sheets = [];
      workbook.eachSheet((worksheet) => {
        const rows = [];
        worksheet.eachRow((row) => {
          const cells = row.values.slice(1).map((v) => (v == null ? '' : String(v)));
          rows.push(cells.join(','));
        });
        sheets.push(`--- ${worksheet.name} ---\n${rows.join('\n')}`);
      });
      return sheets.join('\n\n').trim();
    }

    function renderAttachmentPreviews() {
      attachmentPreviewsEl.innerHTML = '';
      attachmentPreviewsEl.hidden = stagedAttachments.length === 0;
      for (const staged of stagedAttachments) {
        const chip = document.createElement('div');
        chip.className =
          'attachment-chip ' + (staged.kind === 'image' ? 'image-attachment' : 'file-attachment');

        if (staged.kind === 'image') {
          const thumb = document.createElement('img');
          thumb.src = staged.dataUrl;
          chip.appendChild(thumb);
        } else {
          const icon = document.createElement('span');
          icon.className = 'file-icon';
          icon.textContent = staged.kind === 'pdf' ? '📄' : '📝';
          chip.appendChild(icon);
          const name = document.createElement('span');
          name.className = 'file-name';
          name.textContent = staged.name;
          chip.appendChild(name);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'attachment-chip-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove attachment');
        remove.addEventListener('click', () => {
          stagedAttachments = stagedAttachments.filter((a) => a.id !== staged.id);
          renderAttachmentPreviews();
        });
        chip.appendChild(remove);

        attachmentPreviewsEl.appendChild(chip);
      }
    }

    function newAttachmentId() {
      return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
    }

    // Shared by the two file pickers and by paste-to-attach: figures out what
    // kind of attachment a File is (by MIME type first, falling back to its
    // extension, since a pasted screenshot has a type but often no real name)
    // and stages it the same way regardless of how it arrived.
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const XLSX_MIMES = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];

    async function ingestFile(file) {
      const ext = (file.name || '').toLowerCase().split('.').pop();

      if (file.type.startsWith('image/')) {
        // Mirrors the image button's own gating: a model that can't see
        // images shouldn't silently receive one via paste either.
        if (modelCapabilities.get(modelSelect.value) !== true) return;
        const dataUrl = await downscaleImage(file);
        stagedAttachments.push({
          id: newAttachmentId(),
          kind: 'image',
          name: file.name || 'pasted-image.png',
          dataUrl,
        });
        return;
      }

      if (file.type === 'application/pdf' || ext === 'pdf') {
        const dataUrl = await fileToDataUrl(file);
        stagedAttachments.push({
          id: newAttachmentId(),
          kind: 'pdf',
          name: file.name || 'document.pdf',
          dataUrl,
        });
      } else if (file.type === DOCX_MIME || ext === 'docx') {
        const text = await extractDocxText(file);
        stagedAttachments.push({
          id: newAttachmentId(),
          kind: 'doc',
          name: file.name || 'document.docx',
          text,
        });
      } else if (XLSX_MIMES.includes(file.type) || ext === 'xlsx' || ext === 'xls') {
        const text = await extractSpreadsheetText(file);
        stagedAttachments.push({
          id: newAttachmentId(),
          kind: 'doc',
          name: file.name || 'spreadsheet.xlsx',
          text,
        });
      }
      // Anything else (e.g. legacy .doc) is silently skipped rather than
      // blocking the rest of a multi-file paste/selection.
    }

    async function ingestFiles(files) {
      for (const file of files) {
        try {
          await ingestFile(file);
        } catch {
          // skip files that fail to decode/parse rather than blocking the rest
        }
      }
      renderAttachmentPreviews();
    }

    imageInput.addEventListener('change', () => {
      const files = [...imageInput.files];
      imageInput.value = ''; // allow re-selecting the same file later
      ingestFiles(files);
    });

    fileInput.addEventListener('change', () => {
      const files = [...fileInput.files];
      fileInput.value = ''; // allow re-selecting the same file later
      ingestFiles(files);
    });

    // The single 📎 attach button opens a small menu ("Upload file" /
    // "Upload image / take photo") instead of showing two separate buttons.
    function openAttachMenu() {
      attachImageItem.hidden = modelCapabilities.get(modelSelect.value) !== true;
      attachMenu.hidden = false;
      attachBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', onAttachMenuOutsideClick, true);
      document.addEventListener('keydown', onAttachMenuKeydown, true);
      attachFileItem.focus(); // always visible, unlike the image item
    }

    function closeAttachMenu() {
      attachMenu.hidden = true;
      attachBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onAttachMenuOutsideClick, true);
      document.removeEventListener('keydown', onAttachMenuKeydown, true);
    }

    function onAttachMenuOutsideClick(e) {
      if (!attachMenu.contains(e.target) && e.target !== attachBtn) closeAttachMenu();
    }

    function onAttachMenuKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAttachMenu();
        attachBtn.focus();
      }
    }

    attachBtn.addEventListener('click', () => {
      if (attachMenu.hidden) openAttachMenu();
      else closeAttachMenu();
    });

    attachFileItem.addEventListener('click', () => {
      closeAttachMenu();
      fileInput.click();
    });

    attachImageItem.addEventListener('click', () => {
      closeAttachMenu();
      imageInput.click();
    });

    // Paste a screenshot (or a file copied from Finder/Explorer) straight
    // into the message box instead of saving it and using the attach menu.
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length === 0) return; // nothing pasted but text — let it through normally
      e.preventDefault();
      ingestFiles(files);
    });

    function renderAssistantText(el, text) {
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
    function extractReasoningChunk(delta) {
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
      if (activeController) {
        e.preventDefault();
        activeController.abort();
      }
    });

    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (activeController) return;

      const text = input.value.trim();
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

      const userBubble = addBubble('user', '');
      renderUserContent(userBubble, userContent);
      history.push({ role: 'user', content: userContent });
      const activeThread = getActiveThread();
      if (activeThread && !activeThread.title) {
        activeThread.title = makeThreadTitle(text) || 'Attachment';
      }
      touchActiveThread();
      input.value = '';
      input.style.height = 'auto';
      stagedAttachments = [];
      renderAttachmentPreviews();

      const controller = new AbortController();
      activeController = controller;
      sendBtn.textContent = 'Stop';
      sendBtn.classList.add('stop');
      input.disabled = true;
      attachBtn.disabled = true;
      const bubble = addBubble('pending', 'Thinking...');
      let assistantText = '';
      let reasoningText = '';
      let structured = false;
      let finishReason = '';

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
            messages: history,
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
          history.push({ role: 'assistant', content: assistantText });
          touchActiveThread();
          maybeGenerateTitle(activeThread, text, assistantText);
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          if (assistantText) {
            bubble.classList.remove('pending');
            bubble.classList.add('assistant');
            history.push({ role: 'assistant', content: assistantText });
            touchActiveThread();
            maybeGenerateTitle(activeThread, text, assistantText);
          } else {
            bubble.remove();
          }
        } else {
          bubble.remove();
          addBubble('error', 'Could not reach the server.');
        }
      } finally {
        activeController = null;
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
