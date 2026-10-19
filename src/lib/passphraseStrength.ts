/**
 * A rough strength hint for a backup password the owner types (Settings → System & backups). Only a
 * hint: the server checks the rules (at least 12 characters, enough different characters).
 */

export type Strength = { level: 'too-short' | 'weak' | 'fair' | 'strong'; text: string };

const COMMON = /(password|passwort|qwerty|azerty|123456|abcdef|letmein|welcome|admin|backup|beautiful|uae|dubai|iloveyou)/i;

/** Estimated bits: the length times the size of the alphabet used, less for repeats and well-known words. */
export function estimateBits(p: string): number {
  if (!p) return 0;
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 20;
  const unique = new Set(p.toLowerCase()).size;
  // Repeats and runs count for little: use the number of different characters as a ceiling.
  const effective = Math.min(p.length, unique * 2);
  let bits = effective * Math.log2(Math.max(pool, 2));
  if (COMMON.test(p)) bits -= 20;
  // Words joined with dashes or spaces: about 11 bits a word for ordinary words, whatever the letters.
  const words = p.split(/[\s\-_.]+/).filter((w) => w.length >= 3);
  if (words.length >= 3) bits = Math.min(bits, words.length * 11 + (/\d/.test(p) ? 3 : 0));
  return Math.max(0, Math.round(bits));
}

export function passphraseStrength(p: string, minLength = 12): Strength {
  if ([...p].length < minLength) return { level: 'too-short', text: `At least ${minLength} characters (${[...p].length} so far).` };
  const bits = estimateBits(p);
  if (bits < 45) return { level: 'weak', text: 'Weak: easy to guess. Add more words, or press Make one for me.' };
  if (bits < 65) return { level: 'fair', text: 'Fair. A few more words would make it strong.' };
  return { level: 'strong', text: 'Strong.' };
}
