// Server-side file generation for the chat assistant's export_file tool
// (see exportChat.js) and the direct POST /api/export endpoint. Every
// format is built with a free, open-source library already vetted for this
// app — docx, exceljs, and pdfkit (base-14 fonts only, no embedding) — no
// paid/licensed SDKs.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

const EXPORT_FORMATS = ['txt', 'csv', 'pdf', 'docx', 'xlsx'];
const TEXT_FORMATS = new Set(['txt', 'pdf', 'docx']);
const TABLE_FORMATS = new Set(['csv', 'xlsx']);

const LIMITS = {
  MAX_CHARS: 500_000,
  MAX_ROWS: 10_000,
  MAX_SHEETS: 10,
  MAX_FILENAME: 80,
};

const CONTENT_TYPES = {
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

class ExportValidationError extends Error {}

function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, LIMITS.MAX_FILENAME);
  return cleaned || 'export';
}

function validateExportInput(input) {
  const { format, filename, title, content, markdown, rows, headers, sheets } = input || {};

  if (!EXPORT_FORMATS.includes(format)) {
    throw new ExportValidationError(`format must be one of: ${EXPORT_FORMATS.join(', ')}`);
  }
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new ExportValidationError('filename is required');
  }
  if (title != null && typeof title !== 'string') throw new ExportValidationError('title must be a string');
  if (content != null && typeof content !== 'string') throw new ExportValidationError('content must be a string');
  if (markdown != null && typeof markdown !== 'string') throw new ExportValidationError('markdown must be a string');

  const textBody = markdown || content || '';
  if (TEXT_FORMATS.has(format) && !textBody) {
    throw new ExportValidationError(`format "${format}" requires content or markdown`);
  }
  if (textBody.length > LIMITS.MAX_CHARS) {
    throw new ExportValidationError(`content/markdown exceeds ${LIMITS.MAX_CHARS} characters`);
  }

  let normalizedSheets = [];
  if (TABLE_FORMATS.has(format)) {
    const hasRows = Array.isArray(rows) && rows.length > 0;
    const hasSheets = Array.isArray(sheets) && sheets.length > 0;
    if (!hasRows && !hasSheets) {
      throw new ExportValidationError(`format "${format}" requires rows or sheets`);
    }
    if (hasSheets && sheets.length > LIMITS.MAX_SHEETS) {
      throw new ExportValidationError(`sheets exceeds the max of ${LIMITS.MAX_SHEETS}`);
    }
    normalizedSheets = hasSheets ? sheets : [{ name: 'Sheet1', rows, headers }];
    for (const sheet of normalizedSheets) {
      const sheetRows = sheet?.rows;
      if (!Array.isArray(sheetRows)) throw new ExportValidationError('each sheet\'s rows must be an array of arrays');
      if (sheetRows.length > LIMITS.MAX_ROWS) {
        throw new ExportValidationError(`rows exceeds the max of ${LIMITS.MAX_ROWS} per sheet`);
      }
    }
  }

  return {
    format,
    filename: sanitizeFilename(filename),
    title: title || '',
    content: content || '',
    markdown: markdown || '',
    rows: Array.isArray(rows) ? rows : [],
    headers: Array.isArray(headers) ? headers : [],
    sheets: normalizedSheets,
  };
}

// --- A deliberately small Markdown subset shared by the pdf/docx renderers:
// headings (#-######), bullet lists (- or *), paragraphs, and **bold** runs.
// Anything else (tables, links, nested lists, etc.) just falls through as a
// plain paragraph rather than failing — "simple renderer... or fall back to
// plain text" per the brief, not a full CommonMark implementation.
function parseInlineRuns(line) {
  const runs = [];
  const boldPattern = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = boldPattern.exec(line))) {
    if (match.index > lastIndex) runs.push({ text: line.slice(lastIndex, match.index), bold: false });
    runs.push({ text: match[1], bold: true });
    lastIndex = boldPattern.lastIndex;
  }
  if (lastIndex < line.length) runs.push({ text: line.slice(lastIndex), bold: false });
  return runs.length ? runs : [{ text: '', bold: false }];
}

function parseSimpleMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue; // blank lines just separate blocks, no empty paragraphs
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, runs: parseInlineRuns(headingMatch[2]) });
      continue;
    }
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      blocks.push({ type: 'bullet', runs: parseInlineRuns(bulletMatch[1]) });
      continue;
    }
    blocks.push({ type: 'paragraph', runs: parseInlineRuns(line) });
  }
  return blocks;
}

function generateTxtBuffer({ content, markdown, title }) {
  const body = markdown || content || '';
  const text = title ? `${title}\n\n${body}` : body;
  return Buffer.from(text, 'utf8');
}

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function generateCsvBuffer({ rows, headers }) {
  const lines = [];
  if (headers.length) lines.push(headers.map(csvEscape).join(','));
  for (const row of rows) {
    lines.push((Array.isArray(row) ? row : []).map(csvEscape).join(','));
  }
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

const PDF_HEADING_SIZES = { 1: 22, 2: 18, 3: 15, 4: 13, 5: 12, 6: 11 };

function writePdfRuns(doc, runs, { size, forceBold }) {
  doc.fontSize(size);
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    doc.font(forceBold || run.bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(run.text, { continued: i < runs.length - 1 });
  }
}

function generatePdfBuffer({ title, content, markdown }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (title) {
      writePdfRuns(doc, [{ text: title, bold: true }], { size: 20, forceBold: true });
      doc.moveDown();
    }

    if (markdown) {
      for (const block of parseSimpleMarkdown(markdown)) {
        if (block.type === 'heading') {
          doc.moveDown(0.4);
          writePdfRuns(doc, block.runs, { size: PDF_HEADING_SIZES[block.level] || 12, forceBold: true });
          doc.moveDown(0.2);
        } else if (block.type === 'bullet') {
          doc.text('•  ', { continued: true, indent: 10 });
          writePdfRuns(doc, block.runs, { size: 11 });
        } else {
          writePdfRuns(doc, block.runs, { size: 11 });
          doc.moveDown(0.3);
        }
      }
    } else {
      doc.font('Helvetica').fontSize(11).text(content || '');
    }

    doc.end();
  });
}

const DOCX_HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

function runsToTextRuns(runs) {
  return runs.map((r) => new TextRun({ text: r.text, bold: r.bold }));
}

async function generateDocxBuffer({ title, content, markdown }) {
  const paragraphs = [];
  if (title) {
    paragraphs.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title, bold: true })] }));
  }

  if (markdown) {
    for (const block of parseSimpleMarkdown(markdown)) {
      if (block.type === 'heading') {
        paragraphs.push(new Paragraph({ heading: DOCX_HEADING_LEVELS[block.level] || HeadingLevel.HEADING_6, children: runsToTextRuns(block.runs) }));
      } else if (block.type === 'bullet') {
        paragraphs.push(new Paragraph({ bullet: { level: 0 }, children: runsToTextRuns(block.runs) }));
      } else {
        paragraphs.push(new Paragraph({ children: runsToTextRuns(block.runs) }));
      }
    }
  } else {
    const lines = (content || '').split(/\n+/).filter((l) => l.trim());
    for (const line of lines) {
      paragraphs.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }

  if (paragraphs.length === 0) paragraphs.push(new Paragraph({ children: [new TextRun('')] }));

  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}

// Excel sheet names: max 31 chars, and : \ / ? * [ ] are all invalid.
function sanitizeSheetName(name) {
  return String(name || 'Sheet1').replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet1';
}

async function generateXlsxBuffer({ sheets }) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sanitizeSheetName(sheet.name));
    if (Array.isArray(sheet.headers) && sheet.headers.length) {
      worksheet.addRow(sheet.headers);
      worksheet.getRow(1).font = { bold: true };
    }
    for (const row of sheet.rows) worksheet.addRow(Array.isArray(row) ? row : []);
  }
  return workbook.xlsx.writeBuffer();
}

async function generateExport(rawInput) {
  const input = validateExportInput(rawInput);
  let buffer;
  switch (input.format) {
    case 'txt':
      buffer = generateTxtBuffer(input);
      break;
    case 'csv':
      buffer = generateCsvBuffer(input);
      break;
    case 'pdf':
      buffer = await generatePdfBuffer(input);
      break;
    case 'docx':
      buffer = await generateDocxBuffer(input);
      break;
    case 'xlsx':
      buffer = await generateXlsxBuffer(input);
      break;
  }
  return { buffer, contentType: CONTENT_TYPES[input.format], extension: input.format, filename: input.filename };
}

const EXPORT_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'export_file',
    description:
      'Export content as a downloadable file. Call this ONLY when the user explicitly asks for a file/download/export. Choose the format they request; if unclear, choose pdf or txt.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: EXPORT_FORMATS, description: 'The file format to generate.' },
        filename: { type: 'string', description: 'Base file name, without an extension.' },
        title: { type: 'string', description: 'Optional document/sheet title.' },
        content: { type: 'string', description: 'Plain text body, used for txt/pdf/docx if markdown is not given.' },
        markdown: {
          type: 'string',
          description: 'Markdown body (headings, **bold**, - bullets) — preferred over content for pdf/docx if present.',
        },
        rows: {
          type: 'array',
          items: { type: 'array' },
          description: 'Tabular rows (array of arrays), for csv/xlsx.',
        },
        headers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Column headers, for csv/xlsx.',
        },
        sheets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              rows: { type: 'array', items: { type: 'array' } },
              headers: { type: 'array', items: { type: 'string' } },
            },
            required: ['rows'],
          },
          description: 'Multiple named sheets of tabular data, for xlsx (overrides rows/headers if present).',
        },
      },
      required: ['format', 'filename'],
    },
  },
};

module.exports = {
  EXPORT_FORMATS,
  LIMITS,
  EXPORT_FILE_TOOL,
  ExportValidationError,
  sanitizeFilename,
  validateExportInput,
  generateExport,
  parseSimpleMarkdown,
};
