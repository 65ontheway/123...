## Project Structure
- Keep HTML files as pure markup. All styles belong in `css/` and all behavior in `js/` modules — never inline `<style>` or `<script>` blocks in HTML.
- When a file exceeds ~500 lines, propose a split before adding new features to it.

## Feature Conventions
- Chat features (image upload, attachments, streaming) must handle: file size limits, MIME type validation, and a graceful error message in the UI. Wire new UI controls into the app's existing module structure (each `public/js/*.js` module owns the DOM elements and listeners for its own concern) rather than adding new global listeners.

## Testing
- After any multi-file refactor or feature change, run the regression test suite and confirm the app loads in a browser before declaring done. Report which tests were run.
