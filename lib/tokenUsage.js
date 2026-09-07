// Accumulates OpenRouter's per-response `usage` totals onto the login
// session, so the profile screen can show "tokens used this session"
// without a database — express-session already persists whatever's set on
// req.session. Called after every OpenRouter response (streaming or not,
// tool-calling or plain) across all three chat flows.
function addUsage(session, usage) {
  if (!session || !usage) return;
  if (!session.tokenUsage) {
    session.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  session.tokenUsage.promptTokens += prompt;
  session.tokenUsage.completionTokens += completion;
  session.tokenUsage.totalTokens += usage.total_tokens || prompt + completion;
}

module.exports = { addUsage };
