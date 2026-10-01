/**
 * `npm run detect <path>` — print candidate decisions found in a local clone.
 *
 * Writes nothing, anywhere. The whole point of this entry point is a fast loop
 * for tuning the detector; a bad detector version should leave no residue.
 */
import { parseArgs } from 'node:util';

import { detectDependencyDecisions } from '../core/detect/dependency.js';
import { rank, type RankedCandidate, type RankResult } from '../core/detect/rank.js';
import { GitError, openRepo } from '../core/git/index.js';

const USAGE = `
Usage: npm run detect <path-to-repo> [options]

  --all              include suppressed candidates, with the reason
  --json             machine-readable output, for diffing runs
  --limit <n>        cap surfaced candidates (default 20)
  --manifest <path>  manifest to walk (default package.json)
`.trim();

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      limit: { type: 'string', default: '20' },
      manifest: { type: 'string', default: 'package.json' },
      help: { type: 'boolean', default: false },
    },
  });

  const target = positionals[0];
  if (values.help === true || target === undefined) {
    console.log(USAGE);
    return target === undefined ? 1 : 0;
  }

  const limit = Number.parseInt(values.limit ?? '20', 10);
  if (Number.isNaN(limit) || limit < 1) {
    console.error(`--limit must be a positive integer, got ${String(values.limit)}`);
    return 1;
  }

  const repo = await openRepo(target);
  const result = await detectDependencyDecisions(repo, {
    manifestPath: values.manifest ?? 'package.json',
  });
  const ranked = rank(result.candidates);

  if (values.json === true) {
    console.log(JSON.stringify({ ...ranked, meta: result }, null, 2));
    return 0;
  }

  printReport(ranked, {
    showAll: values.all === true,
    limit,
    commitsWalked: result.commitsWalked,
    manifestPath: result.manifestPath,
  });
  return 0;
}

interface ReportOptions {
  showAll: boolean;
  limit: number;
  commitsWalked: number;
  manifestPath: string;
}

function printReport(result: RankResult, options: ReportOptions): void {
  const { ranked, summary } = result;

  if (summary.total === 0) {
    console.log(
      `No dependency changes found in ${options.manifestPath} across ${options.commitsWalked} commits.`,
    );
    return;
  }

  const visible = options.showAll
    ? ranked
    : ranked.filter((c) => c.suppressed === null).slice(0, options.limit);

  console.log('');
  for (const [index, candidate] of visible.entries()) {
    printCandidate(candidate, index + 1);
  }

  if (visible.length === 0) {
    console.log('  Nothing cleared the threshold. Re-run with --all to see why.\n');
  }

  printSummary(summary, options);
}

function printCandidate(candidate: RankedCandidate, position: number): void {
  const verb =
    candidate.kind === 'replacement'
      ? 'replaced'
      : candidate.kind === 'removal'
        ? 'removed '
        : 'chose   ';

  const subject =
    candidate.kind === 'replacement' && candidate.displaced !== null
      ? `npm:${candidate.displaced} → ${candidate.subjectKey}`
      : candidate.subjectKey;

  const mark = candidate.suppressed === null ? ' ' : '·';
  console.log(
    `${mark} ${String(position).padStart(2)}. [${candidate.score.toFixed(2)}] ${verb} ${subject}`,
  );
  console.log(
    `        ${candidate.shortSha}  ${candidate.date.toISOString().slice(0, 10)}  ${JSON.stringify(candidate.subject)} · ${candidate.filesInCommit} files · ${candidate.projectAgeDays}d in`,
  );

  if (candidate.suppressed !== null) {
    console.log(
      `        suppressed: ${candidate.suppressed} — ${candidate.suppressedDetail ?? ''}`,
    );
  } else {
    console.log(`        alternative:  ${candidate.tests.alternative.why}`);
    console.log(`        load-bearing: ${candidate.tests.loadBearing.why}`);
    console.log(`        deliberate:   ${candidate.tests.deliberate.why}`);
  }
  console.log('');
}

/**
 * Per-run calibration. If most candidates die on one heuristic, that is a
 * finding about the heuristic rather than about the repo.
 */
function printSummary(
  summary: RankResult['summary'],
  options: ReportOptions,
): void {
  const dropped = Object.entries(summary.suppressed).filter(([, n]) => n > 0);

  console.log(
    `${summary.total} candidate${summary.total === 1 ? '' : 's'} · ${summary.surfaced} above threshold · ${options.commitsWalked} commits walked`,
  );

  if (dropped.length > 0) {
    const detail = dropped.map(([reason, n]) => `${n} ${reason}`).join(', ');
    console.log(`suppressed: ${detail}${options.showAll ? '' : '  (--all to see them)'}`);
  }
  console.log('');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof GitError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.stack : String(error));
  }
  process.exitCode = 1;
}
