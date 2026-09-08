function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 100) return false;
  let bytes = 0;
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) return false;
    if (typeof message.content === 'string') { if (message.content.length > 32000) return false; }
    else if (message.role === 'user' && Array.isArray(message.content) && message.content.length <= 8) {
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= 32000) continue;
        if (part?.type === 'image_url' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(part.image_url?.url || '')) continue;
        if (part?.type === 'file' && typeof part.file?.filename === 'string' && part.file.filename.length <= 200 && /^data:application\/pdf;base64,JVBER[A-Za-z0-9+/=]+$/.test(part.file.file_data || '')) continue;
        return false;
      }
    } else return false;
    bytes += Buffer.byteLength(JSON.stringify(message.content));
    if (bytes > 2 * 1024 * 1024) return false;
  }
  return messages.at(-1).role === 'user';
}
function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}
module.exports = { validateMessages, validDate };
