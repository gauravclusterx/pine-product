// After `vite build`: the web app's page becomes dist/app.html and the landing site is copied into
// dist/, so any static host (Vercel) serves the landing at / and the app at /login, /app, /admin.
import fs from "fs";
import path from "path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const dist = path.join(root, "dist");
const landing = path.join(root, "landing");
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("run vite build first");
fs.renameSync(path.join(dist, "index.html"), path.join(dist, "app.html"));
fs.cpSync(landing, dist, { recursive: true });
console.log("landing merged: dist/index.html = landing, dist/app.html = web app");
