// Single production entrypoint.
// Keep legacy `node server.js` usage on the same production-safe API implementation
// as Render's `npm start`, so the project never has two drifting backend stacks.
import "./server.production.js";
