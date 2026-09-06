// Staging, extracting, and previewing composer attachments (images, PDFs,
// Word/Excel), plus the 📎 attach button's popover menu and paste-to-attach.
//
// See the note in settings.js about the circular import with that module:
// this file needs to know the current model's image capability before
// staging/offering an image, and settings.js needs to clear a staged image
// when the model changes — genuinely mutual, and safe here because neither
// side's top-level code touches the other's exports (only event handlers do).
import { currentModelSupportsImages } from './settings.js';

const input = document.getElementById('input');
const imageInput = document.getElementById('image-input');
const fileInput = document.getElementById('file-input');
const attachmentPreviewsEl = document.getElementById('attachment-previews');
const attachBtn = document.getElementById('attach-btn');
const attachMenu = document.getElementById('attach-menu');
const attachFileItem = document.getElementById('attach-file-item');
const attachImageItem = document.getElementById('attach-image-item');

// Staged attachments not yet sent, in the order they'll appear in the
// outgoing message. Each entry is one of:
//   { id, kind: 'image', name, dataUrl }
//   { id, kind: 'pdf',   name, dataUrl }
//   { id, kind: 'doc',   name, text }        (extracted from .docx/.xlsx/.xls)
let stagedAttachments = [];

export function getStagedAttachments() {
  return stagedAttachments;
}

export function clearStagedAttachments() {
  stagedAttachments = [];
  renderAttachmentPreviews();
}

// The "Upload image" menu item's visibility is computed fresh each time
// the attach menu opens (see openAttachMenu), so this just needs to drop
// any already-staged image the moment the selected model can't take one.
export function handleImageCapabilityChange() {
  if (!currentModelSupportsImages() && stagedAttachments.some((a) => a.kind === 'image')) {
    stagedAttachments = stagedAttachments.filter((a) => a.kind !== 'image');
    renderAttachmentPreviews();
  }
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
    // Mirrors the image menu item's own gating: a model that can't see
    // images shouldn't silently receive one via paste either.
    if (!currentModelSupportsImages()) return;
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
  attachImageItem.hidden = !currentModelSupportsImages();
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
