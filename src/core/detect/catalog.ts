/**
 * Which npm packages sit in a category with known alternatives.
 *
 * This is the first of the three tests: "there was a real alternative".
 * A replacement proves it by itself — the displaced package *is* the
 * alternative. A dependency_choice has to be looked up here.
 *
 * Hand-written on purpose. It is honest about what it does and does not cover,
 * costs nothing to run, and does not need a model in the loop. It also does not
 * generalise, and it encodes taste — revisit once there is evidence about which
 * packages actually turn into decisions worth asking about.
 */

export interface Category {
  slug: string;
  label: string;
  members: readonly string[];
}

export const CATEGORIES: readonly Category[] = [
  {
    slug: 'orm',
    label: 'ORM / data mapper',
    members: ['prisma', '@prisma/client', 'typeorm', 'sequelize', '@mikro-orm/core', 'objection', 'drizzle-orm', 'mongoose'],
  },
  {
    slug: 'query-builder',
    label: 'query builder',
    members: ['knex', 'kysely', 'sql-template-strings', 'slonik'],
  },
  {
    slug: 'db-driver',
    label: 'database driver',
    members: ['pg', 'mysql2', 'mysql', 'better-sqlite3', 'sqlite3', 'postgres', '@libsql/client', 'mongodb', 'ioredis', 'redis'],
  },
  {
    slug: 'http-server',
    label: 'HTTP server framework',
    members: ['express', 'fastify', 'hono', 'koa', '@hapi/hapi', 'restify', 'polka', 'h3'],
  },
  {
    slug: 'web-framework',
    label: 'application framework',
    members: ['next', 'remix', '@remix-run/node', 'astro', 'nuxt', '@sveltejs/kit', 'gatsby'],
  },
  {
    slug: 'validation',
    label: 'schema validation',
    members: ['zod', 'yup', 'joi', 'valibot', 'superstruct', 'ajv', 'io-ts', 'arktype', 'class-validator'],
  },
  {
    slug: 'test-runner',
    label: 'test runner',
    members: ['vitest', 'jest', 'mocha', 'ava', 'tap', 'jasmine', 'uvu'],
  },
  {
    slug: 'bundler',
    label: 'bundler / build tool',
    members: ['webpack', 'vite', 'rollup', 'esbuild', 'parcel', 'tsup', 'rspack', 'turbopack'],
  },
  {
    slug: 'ts-runner',
    label: 'TypeScript execution',
    members: ['tsx', 'ts-node', '@swc-node/register', 'esbuild-register', 'babel-node'],
  },
  {
    slug: 'date',
    label: 'date handling',
    members: ['moment', 'dayjs', 'date-fns', 'luxon', '@js-joda/core', 'temporal-polyfill'],
  },
  {
    slug: 'state',
    label: 'client state management',
    members: ['redux', '@reduxjs/toolkit', 'zustand', 'jotai', 'mobx', 'recoil', 'valtio', 'nanostores'],
  },
  {
    slug: 'data-fetching',
    label: 'server state / data fetching',
    members: ['@tanstack/react-query', 'react-query', 'swr', '@apollo/client', 'urql', 'relay-runtime'],
  },
  {
    slug: 'http-client',
    label: 'HTTP client',
    members: ['axios', 'got', 'node-fetch', 'ky', 'undici', 'superagent', 'bent'],
  },
  {
    slug: 'styling',
    label: 'styling approach',
    members: ['tailwindcss', 'styled-components', '@emotion/react', 'sass', '@stitches/react', '@vanilla-extract/css', 'unocss'],
  },
  {
    slug: 'queue',
    label: 'job queue',
    members: ['bullmq', 'bull', 'agenda', 'bee-queue', 'graphile-worker', 'pg-boss', 'kue'],
  },
  {
    slug: 'logger',
    label: 'logging',
    members: ['pino', 'winston', 'bunyan', 'consola', 'loglevel', 'signale', 'debug'],
  },
  {
    slug: 'auth',
    label: 'authentication',
    members: ['passport', 'next-auth', '@auth/core', 'lucia', 'jsonwebtoken', 'jose', '@clerk/nextjs', 'firebase-auth'],
  },
  {
    slug: 'linter',
    label: 'linting',
    members: ['eslint', '@biomejs/biome', 'oxlint', 'xo', 'standard'],
  },
  {
    slug: 'formatter',
    label: 'formatting',
    members: ['prettier', 'dprint'],
  },
  {
    slug: 'migrations',
    label: 'schema migrations',
    members: ['drizzle-kit', 'node-pg-migrate', 'umzug', 'db-migrate', 'flyway'],
  },
  {
    slug: 'id',
    label: 'identifier generation',
    members: ['uuid', 'nanoid', 'cuid', 'cuid2', '@paralleldrive/cuid2', 'ulid', 'shortid'],
  },
  {
    slug: 'env',
    label: 'environment configuration',
    members: ['dotenv', 'dotenv-flow', 'envalid', 'znv', 'convict'],
  },
  {
    slug: 'templating',
    label: 'server templating',
    members: ['ejs', 'handlebars', 'pug', 'nunjucks', 'mustache', 'eta'],
  },
  {
    slug: 'monorepo',
    label: 'monorepo tooling',
    members: ['nx', 'turbo', 'lerna', '@changesets/cli', 'rush'],
  },
  {
    slug: 'router',
    label: 'client routing',
    members: ['react-router-dom', 'react-router', '@tanstack/react-router', 'wouter', '@reach/router', 'vue-router', 'svelte-routing'],
  },
  {
    slug: 'react-transform',
    label: 'React build transform',
    members: ['@vitejs/plugin-react', '@vitejs/plugin-react-swc', '@babel/preset-react', '@swc/plugin-react'],
  },
  {
    slug: 'component-workshop',
    label: 'component workshop',
    members: ['storybook', '@storybook/nextjs', '@storybook/react', 'histoire', 'ladle'],
  },
  {
    slug: 'e2e-testing',
    label: 'end-to-end testing',
    members: ['@playwright/test', 'playwright', 'cypress', 'puppeteer', 'webdriverio', 'selenium-webdriver', 'testcafe'],
  },
  {
    slug: 'dom-testing',
    label: 'component testing',
    members: ['@testing-library/react', '@testing-library/vue', 'enzyme', '@vue/test-utils'],
  },
  {
    slug: 'dom-environment',
    label: 'test DOM environment',
    members: ['jsdom', 'happy-dom', 'linkedom'],
  },
  {
    slug: 'ui-kit',
    label: 'UI component library',
    members: ['@mui/material', 'antd', '@chakra-ui/react', '@mantine/core', '@headlessui/react', 'react-bootstrap', 'primereact'],
  },
  {
    slug: 'baas',
    label: 'backend-as-a-service',
    members: ['@supabase/supabase-js', 'firebase', 'appwrite', 'pocketbase', 'aws-amplify', 'convex'],
  },
  // Kept narrow on purpose. An over-broad category manufactures replacements
  // that never happened: lumping a build integration in with a plugin once
  // produced "@tailwindcss/vite → tailwindcss-animate", which is not a swap.
  {
    slug: 'css-pipeline',
    label: 'CSS pipeline',
    members: ['postcss', 'autoprefixer', 'lightningcss', '@parcel/css'],
  },
  {
    slug: 'tailwind-integration',
    label: 'Tailwind build integration',
    members: ['@tailwindcss/postcss', '@tailwindcss/vite', 'tailwindcss-cli'],
  },
  {
    slug: 'tailwind-animation',
    label: 'Tailwind animation utilities',
    members: ['tailwindcss-animate', 'tw-animate-css'],
  },
];

const BY_PACKAGE = new Map<string, Category>();
for (const category of CATEGORIES) {
  for (const member of category.members) {
    BY_PACKAGE.set(member, category);
  }
}

export function categoryOf(packageName: string): Category | null {
  return BY_PACKAGE.get(packageName) ?? null;
}

/**
 * Packages whose presence is mandated rather than chosen. Asking about these is
 * precisely the failure mode that makes the product look stupid — nobody
 * "decided" on `@types/node`.
 */
const NON_DECISION_EXACT = new Set([
  'tslib',
  'core-js',
  'regenerator-runtime',
  '@babel/runtime',
  'react-dom',
  'react-native',
  'scheduler',
]);

const NON_DECISION_PATTERNS = [/^@types\//];

export function isNonDecision(packageName: string): boolean {
  if (NON_DECISION_EXACT.has(packageName)) return true;
  return NON_DECISION_PATTERNS.some((pattern) => pattern.test(packageName));
}

/** The other members of a package's category — "you chose X over these". */
export function alternativesTo(packageName: string): readonly string[] {
  const category = categoryOf(packageName);
  if (category === null) return [];
  return category.members.filter((member) => member !== packageName);
}
