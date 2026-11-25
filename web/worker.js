// Runs the linter off the main thread so large files do not freeze the page.
import { lintStream, applyFixes, lintText } from './lib/index.js';

self.onmessage = async (ev) => {
  const { id, file, text, options, wantFix } = ev.data;
  try {
    let result;
    if (file) {
      let seen = 0;
      const total = file.size;
      let last = 0;
      const counted = file.stream().pipeThrough(new TransformStream({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          const now = performance.now();
          if (now - last > 80) { last = now; self.postMessage({ id, progress: total ? seen / total : 0 }); }
          controller.enqueue(chunk);
        },
      }));
      const t0 = performance.now();
      result = await lintStream(counted, { ...options, filename: file.name });
      result.ms = performance.now() - t0;
    } else {
      const t0 = performance.now();
      result = lintText(text, options);
      result.ms = performance.now() - t0;
    }
    let fixed = null;
    if (wantFix) {
      // Fixes need every occurrence, so lint again without the per-rule cap (small inputs only).
      const bytes = file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(text);
      const full = lintText(bytes, { ...options, filename: file ? file.name : options.filename, maxPerRule: 0 });
      const out = applyFixes(bytes, full.diagnostics);
      fixed = { bytes: out.output, applied: out.applied };
    }
    self.postMessage({ id, result, fixed });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
