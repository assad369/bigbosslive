/**
 * Text moderation for user-generated content (Google Play / App Store UGC policies).
 *
 * Masks profanity with asterisks, and optionally rejects contact info (phone numbers, URLs,
 * messenger handles) that is used to move users off-platform. Matching is normalised against
 * common obfuscations: leetspeak, repeated letters, and separators between letters.
 */

const BASE_BLOCKLIST = [
  'fuck', 'motherfuck', 'shit', 'bitch', 'bastard', 'asshole', 'dick', 'pussy', 'cunt', 'whore', 'slut',
  'nigger', 'nigga', 'faggot', 'retard', 'rape', 'porn', 'nude', 'nudes', 'xxx', 'sex',
  'chod', 'choda', 'magi', 'khanki', 'bal', 'madarchod', 'behenchod', 'randi', 'harami',
];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

function normaliseWord(word: string): string {
  return word
    .toLowerCase()
    .split('')
    .map((c) => LEET[c] ?? c)
    .join('')
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1{2,}/g, '$1$1');
}

const PHONE = /(?:\+?\d[\s\-.()]*){8,}/;
const URL = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|me|app|xyz|link|ly|gg)\b/i;
const HANDLE = /\b(?:whats\s*app|wh?ats?app|telegram|t\.me|imo|viber|wechat)\b/i;

export interface FilterResult {
  text: string;
  masked: boolean;
  contactInfo: boolean;
}

export function filterText(input: string, extraWords: readonly string[] = []): FilterResult {
  const blocked = new Set([...BASE_BLOCKLIST, ...extraWords.map(normaliseWord)].filter((w) => w.length >= 2));
  let masked = false;
  // Split on whitespace but keep it, so the original spacing survives.
  const text = input
    .split(/(\s+)/)
    .map((token) => {
      if (/^\s+$/.test(token)) return token;
      const norm = normaliseWord(token);
      // Short words must match exactly ("bal" ≠ "ball"); longer ones also match as a prefix
      // ("fucking"), never as an infix, which would mask innocent words ("grape").
      const hit = norm.length > 0 && [...blocked].some((w) => norm === w || (w.length >= 4 && norm.startsWith(w)));
      if (!hit) return token;
      masked = true;
      return '*'.repeat(token.length);
    })
    .join('');
  const contactInfo = PHONE.test(input) || URL.test(input) || HANDLE.test(input);
  return { text, masked, contactInfo };
}
