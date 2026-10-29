// Title cleanup for eBay visibility: strip decorative special characters that eBay's
// search dislikes, while KEEPING meaningful ones — hyphens inside specs (2-10g, 5-28g,
// Pop-Up, M-Craft), decimal points (0.06mm, N.G), and slashes in sizes are preserved.
// Only " - " style separators, asterisks, pipes, brackets, emoji etc. are removed.

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
const DECORATIVE = /[*|~^#_=+<>\[\]{}]/g;

export function hasSpecials(s: string): boolean {
  if (!s) return false;
  return (
    EMOJI.test(s) ||
    /[*|~^#_=+<>\[\]{}]/.test(s) ||
    /\s[-–—]+\s/.test(s) || // " - " separators
    /[“”"]/.test(s) ||
    /\s{2,}/.test(s)
  );
}

export function cleanTitle(s: string): string {
  let t = s ?? "";
  t = t.replace(EMOJI, " ");
  t = t.replace(/[“”"]/g, "");        // stray quotes
  t = t.replace(/\s[-–—]+\s/g, " ");  // " - " separators become a space
  t = t.replace(DECORATIVE, " ");     // decorative punctuation
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, "").trim(); // eBay 80-char cap, don't cut mid-word
  return t;
}
