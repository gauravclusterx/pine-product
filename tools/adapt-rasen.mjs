// One-off: adapt the Rasen layer (shared with the Pine AI CRM) to this codebase's credential model.
// Here keys are decrypted by the caller (server/modules/voiceWorkspace.ts) and passed in plain.
import fs from "fs";

const p = "server/voice/rasen/service.ts";
let s = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const a = s.indexOf("// ─── Credential resolution");
const b = s.indexOf("// ─── Key validation / workspace context");
if (a < 0 || b < 0) throw new Error("credential section not found");

const replacement = `// ─── Credential resolution ───────────────────────────────────────────────────

/**
 * Every exported function takes the workspace key as its first argument: either the plaintext
 * key, or an object carrying it as \`apiKey\`. Keys are stored encrypted and decrypted by the
 * caller (modules/voiceWorkspace.ts) — this layer never touches ciphertext or the database.
 */
export function getRasenApiKey(input: any): string {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (input && typeof input === "object" && typeof input.apiKey === "string" && input.apiKey.trim()) return input.apiKey.trim();
  throw new Error("Voice API key not configured");
}

/** True when a usable voice key was supplied. Never throws. */
export function hasRasenApiKey(input: any): boolean {
  try { return !!getRasenApiKey(input); } catch { return false; }
}

`;
s = s.slice(0, a) + replacement + s.slice(b);
s = s.replace('import { decrypt } from "../backend/utils/encrypt.js";\n', "");
s = s.replace(/ \* Polymorphic credential handling[\s\S]*?`getRasenApiKey\(\)` normalises all three to a usable bearer token\.\n \*\n/, "");
if (/decrypt|rasenApiKey\b/.test(s)) throw new Error("credential leftovers: " + (s.match(/.*(decrypt|rasenApiKey\b).*/g) || []).slice(0, 3).join(" | "));
fs.writeFileSync(p, s);
console.log("service.ts adapted");
