/**
 * The cost check against a fixture list of cost sentences with expected
 * verdicts.
 *
 * SYNTHETIC FOR NOW. 0002 says to start from the builder's own answers once
 * there are some; there are none yet. These are the spec's examples plus
 * deliberately awkward cases. Replace them with real answers, hand-labelled,
 * after the first two weeks of use — and where the rules disagree with the
 * builder more than one time in four, that is the case for an LLM check.
 */
import { describe, expect, test } from 'vitest';

import { checkCost, COST_CHECK_VERSION, type CostContext } from './cost-check.js';

const ctx: CostContext = {
  choice: 'react-router-dom',
  alternative: '@tanstack/react-router',
  packageNames: ['react', 'react-router-dom', 'zod', '@tanstack/react-query', 'vitest'],
  paths: ['src/routes/booking.tsx', 'src/lib/api.ts', 'package.json'],
};

interface Case {
  cost: string;
  namesLoss: boolean;
  systemSpecific: boolean;
  why: string;
}

const CASES: Case[] = [
  // From the spec.
  { cost: "it's slower", namesLoss: false, systemSpecific: false, why: 'comparative only' },
  {
    cost: 'I lost type-safe route params, so src/routes/booking.tsx parses ids by hand',
    namesLoss: true,
    systemSpecific: true,
    why: 'names the loss and the file it lands in',
  },
  {
    cost: 'Postgres needs a server',
    namesLoss: false,
    systemSpecific: false,
    why: 'generic property of the technology',
  },

  // Loss constructions.
  {
    cost: 'we gave up loader-level data fetching, so every page wires @tanstack/react-query itself',
    namesLoss: true,
    systemSpecific: true,
    why: 'another dependency named',
  },
  {
    cost: "can't validate search params at the route anymore",
    namesLoss: true,
    systemSpecific: false,
    why: 'a real loss, but true of any project',
  },
  {
    cost: 'at the cost of being slower',
    namesLoss: false,
    systemSpecific: false,
    why: 'loss construction pointing only at a comparative',
  },
  {
    cost: 'no longer get typed links, which broke 3 routes during the swap',
    namesLoss: true,
    systemSpecific: true,
    why: 'a number makes it about this system',
  },
  {
    cost: 'it is a bit more complex',
    namesLoss: false,
    systemSpecific: false,
    why: 'comparative with filler',
  },

  // The tightening: naming the choice or its alternative is not specific.
  {
    cost: 'means we lose what @tanstack/react-router gave us for free',
    namesLoss: true,
    systemSpecific: false,
    why: 'only the alternative itself is named',
  },

  // Known false negative, kept on purpose so a fix shows up as a diff:
  // a real, specific loss in words the rules do not know.
  {
    cost: 'zod schemas now run twice per navigation in api.ts',
    namesLoss: false,
    systemSpecific: true,
    why: 'KNOWN MISS: a real cost, phrased without a loss construction',
  },
];

describe(`cost check v${COST_CHECK_VERSION} against the fixture list`, () => {
  test.each(CASES)('$why — "$cost"', ({ cost, namesLoss, systemSpecific }) => {
    const verdict = checkCost(cost, ctx);
    expect({ namesLoss: verdict.namesLoss, systemSpecific: verdict.systemSpecific }).toEqual({
      namesLoss,
      systemSpecific,
    });
    // One sentence of feedback per failing part, none when both pass.
    expect(verdict.feedback).toHaveLength(Number(!namesLoss) + Number(!systemSpecific));
  });
});

describe('feedback', () => {
  test('a comparative is called out by name, with the question that fixes it', () => {
    const [first] = checkCost("it's slower", ctx).feedback;
    expect(first).toBe(
      '“slower” says what got worse, not what you gave up. What did react-router-dom stop you doing that @tanstack/react-router let you do?',
    );
  });

  test('an empty cost is asked for, not judged', () => {
    const verdict = checkCost('   ', ctx);
    expect(verdict.feedback).toEqual(['No cost named yet. What did choosing react-router-dom give up?']);
  });

  test('every verdict carries the version that made it', () => {
    expect(checkCost('x', ctx).version).toBe(COST_CHECK_VERSION);
  });
});
