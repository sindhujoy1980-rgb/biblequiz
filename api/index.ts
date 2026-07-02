// ============================================================
// api/index.ts — Vercel Serverless Entry Point
// Vercel imports this file and calls it as a serverless function
// ============================================================
import app from '../src/app';

// For local dev: also start an HTTP server
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 CyFam Backend running at http://localhost:${PORT}`);
  });
}

// Vercel needs a default export of the Express app
export default app;
