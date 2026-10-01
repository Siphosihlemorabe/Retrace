/**
 * The cost-quality check (0002 §4). Rule-based on purpose, and crude on purpose.
 *
 * Two questions, from CLAUDE.md: does the sentence name something *lost*, and
 * is that loss specific to *this* system rather than a generic property of the
 * technology? Each "no" gets one sentence of feedback naming what is missing —
 * that feedback loop is the learning half of the product.
 *
 * Keyword rules are trivially gamed and will misjudge good answers in
 * unexpected words. Acceptable for one builder who is not gaming it; never
 * acceptable as evidence. COST_CHECK_VERSION is stored with every verdict so
 * v1 judgements can be recomputed or discounted when something better exists.
 *
 * Pure: everything it needs to know about the repo is passed in.
 */

/** Bump whenever a rule change could change a verdict. */
export const COST_CHECK_VERSION = 1;

export interface CostContext {
  /** What was chosen, as the user would say it: "react-router-dom". */
  choice: string;
  /** What it was chosen over, if known: "@tanstack/react-router". */
  alternative: string | null;
  /** Every dependency in the manifest at HEAD. */
  packageNames: readonly string[];
  /** Tracked file paths at HEAD. */
  paths: readonly string[];
  /** Identifiers from the anchor diff, when available. */
  identifiers?: readonly string[];
}

export interface CostVerdict {
  namesLoss: boolean;
  systemSpecific: boolean;
  /** One sentence per missing part. Empty when both pass. */
  feedback: string[];
  version: number;
}

/**
 * Constructions that say something was given up. From 0002's list, plus the
 * obvious inflections of each.
 */
const LOSS = new RegExp(
  [
    String.raw`\bg(?:a|i)ve up\b`,
    String.raw`\bgiving up\b`,
    String.raw`\blos(?:e|t|ing)\b`,
    String.raw`\bcan(?:'|’)?t\b`,
    String.raw`\bcannot\b`,
    String.raw`\bcouldn(?:'|’)?t\b`,
    String.raw`\bno longer\b`,
    String.raw`\binstead of\b`,
    String.raw`\bat the (?:cost|expense) of\b`,
    String.raw`\b(?:means|meant) (?:we|i|you)\b`,
    String.raw`\bsacrific(?:e|ed|ing)\b`,
    String.raw`\btrad(?:e|ed|ing) away\b`,
  ].join('|'),
  'i',
);

/** "Worse" words. On their own they say what got worse, not what was lost. */
const COMPARATIVE = new Set([
  'slower', 'faster', 'heavier', 'lighter', 'bigger', 'larger', 'smaller',
  'harder', 'easier', 'simpler', 'complex', 'complicated', 'verbose',
  'worse', 'better', 'messier', 'bloated', 'clunkier', 'riskier',
]);
const FILLER = new Set([
  'it', 'its', "it's", 'it’s', 'is', 'was', 'be', 'being', 'a', 'an', 'the',
  'bit', 'little', 'lot', 'much', 'more', 'less', 'slightly', 'somewhat',
  'way', 'kind', 'of', 'we', 'are', 'were', 'got', 'gets', 'and', 'so', 'that',
  'too', 'very', 'really', 'just', 'now', 'things', 'thing', 'everything',
]);

const words = (text: string) =>
  text.toLowerCase().match(/[a-z’']+/g)?.map((w) => w.replace(/^'+|'+$/g, '')) ?? [];

/** True when the words carry nothing but a comparative and filler. */
function onlyComparative(text: string): boolean {
  const meaningful = words(text).filter((w) => !FILLER.has(w));
  return meaningful.length > 0 && meaningful.every((w) => COMPARATIVE.has(w));
}

function namesLoss(text: string): { pass: boolean; comparativeOnly: string | null } {
  if (onlyComparative(text)) {
    const word = words(text).find((w) => COMPARATIVE.has(w)) ?? null;
    return { pass: false, comparativeOnly: word };
  }
  const match = LOSS.exec(text);
  if (match === null) return { pass: false, comparativeOnly: null };

  // "at the cost of being slower": a loss construction pointing at nothing
  // but a comparative still has not said what was lost.
  const after = text.slice(match.index + match[0].length);
  if (onlyComparative(after)) {
    return { pass: false, comparativeOnly: words(after).find((w) => COMPARATIVE.has(w)) ?? null };
  }
  return { pass: true, comparativeOnly: null };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, term: string) =>
  term.length >= 2 && new RegExp(`(^|[^\\w@/.-])${escape(term)}($|[^\\w-])`, 'i').test(text);

function systemSpecific(text: string, ctx: CostContext): boolean {
  if (/\d/.test(text)) return true;

  // The choice and its alternative do not count: "react-router-dom has no
  // typed params" is true of every project that uses it. Naming the *rest* of
  // the system is what makes a cost specific to it.
  const own = new Set([ctx.choice, ctx.alternative].filter((v): v is string => v !== null).map((v) => v.toLowerCase()));
  if (ctx.packageNames.some((p) => !own.has(p.toLowerCase()) && mentions(text, p))) return true;

  for (const path of ctx.paths) {
    const base = path.split('/').pop() ?? path;
    if (mentions(text, path) || (base.includes('.') && mentions(text, base))) return true;
  }
  return (ctx.identifiers ?? []).some((id) => id.length >= 3 && mentions(text, id));
}

export function checkCost(text: string | null, ctx: CostContext): CostVerdict {
  const cost = (text ?? '').trim();
  if (cost === '') {
    return {
      namesLoss: false,
      systemSpecific: false,
      feedback: [`No cost named yet. What did choosing ${ctx.choice} give up?`],
      version: COST_CHECK_VERSION,
    };
  }

  const loss = namesLoss(cost);
  const specific = systemSpecific(cost, ctx);
  const feedback: string[] = [];

  if (!loss.pass) {
    const what = ctx.alternative === null
      ? `What can you no longer do because of ${ctx.choice}?`
      : `What did ${ctx.choice} stop you doing that ${ctx.alternative} let you do?`;
    feedback.push(
      loss.comparativeOnly !== null
        ? `“${loss.comparativeOnly}” says what got worse, not what you gave up. ${what}`
        : `This says what ${ctx.choice} is like, not what it cost. ${what}`,
    );
  }
  if (!specific) {
    feedback.push(
      `This could be said of any project using ${ctx.choice}. Name the part of this codebase it affects — a file, another dependency, or a number.`,
    );
  }

  return { namesLoss: loss.pass, systemSpecific: specific, feedback, version: COST_CHECK_VERSION };
}
