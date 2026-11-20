/** Phone numbers are stored and compared in E.164 only. */

/**
 * Normalise what a person or a lead form typed into E.164, or "" when it cannot be a phone
 * number. A national number gets the org's default country code.
 */
export function toE164(raw: unknown, defaultCountryCode = "1"): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  // An extension is not diallable: drop it.
  s = s.replace(/(?:ext\.?|x)\s*\d+\s*$/i, "");
  const plus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return "";
  if (!plus && digits.startsWith("00")) return valid("+" + digits.slice(2));
  if (plus) return valid("+" + digits);
  const cc = String(defaultCountryCode).replace(/\D/g, "") || "1";
  // National trunk prefix.
  if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  const nationalLength = cc === "1" || cc === "91" ? 10 : null;
  if (nationalLength && digits.length === nationalLength) return valid("+" + cc + digits);
  if (digits.startsWith(cc) && (!nationalLength || digits.length === cc.length + nationalLength)) return valid("+" + digits);
  if (!nationalLength) return valid("+" + cc + digits);
  return "";
}

function valid(e164: string): string {
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return "";
  // North American numbers: area code and exchange cannot start with 0 or 1.
  if (e164.startsWith("+1") && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) return "";
  return e164;
}

export function isE164(s: unknown): boolean {
  return typeof s === "string" && valid(s) === s;
}

/** For logs and lists: keep the last four digits. */
export function maskPhone(e164: string): string {
  const s = String(e164 || "");
  return s.length <= 4 ? s : "•".repeat(Math.max(0, s.length - 4)) + s.slice(-4);
}
