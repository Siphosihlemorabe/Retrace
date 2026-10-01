/**
 * Docker, broken into outcomes. Hand-written (0007). Dockerfiles, compose files
 * and .dockerignore are structured enough that line rules are reliable; the two
 * outcomes about the shape of a whole Dockerfile (multi-stage, layer order)
 * read the file as a whole.
 */
import { matchingLines, toHits } from '../text.js';
import type { FileAtCommit, Hit, OutcomeDef, SkillDef } from '../types.js';

const isDockerfile = (p: string) => /(^|\/)(Dockerfile|Containerfile)([.\-][\w.-]+)?$|\.dockerfile$/i.test(p);
const isCompose = (p: string) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(p);
const isDockerignore = (p: string) => /(^|\/)\.dockerignore$/.test(p);

/** Dockerfile instructions, ignoring comments. */
const instruction = (line: string) => line.replace(/^\s*#.*$/, '');

function lineRule(def: {
  slug: string;
  name: string;
  description: string;
  dockerfile?: RegExp;
  compose?: RegExp;
}): OutcomeDef {
  return {
    slug: def.slug,
    name: def.name,
    description: def.description,
    detect(file: FileAtCommit): Hit[] {
      if (def.dockerfile !== undefined && isDockerfile(file.path)) {
        return toHits(matchingLines(file, def.dockerfile, undefined, instruction), 'config');
      }
      if (def.compose !== undefined && isCompose(file.path)) {
        return toHits(matchingLines(file, def.compose, undefined, instruction), 'config');
      }
      return [];
    },
  };
}

const FROM = /^\s*FROM\s+\S+/i;

export const DOCKER: SkillDef = {
  slug: 'docker',
  name: 'Docker',
  kind: 'technology',
  aliases: ['containers', 'docker compose', 'dockerfile'],
  outcomes: [
    lineRule({
      slug: 'docker.dockerfile',
      name: 'A working Dockerfile',
      description: 'FROM, COPY, RUN, CMD: building an image',
      dockerfile: /^\s*(FROM|CMD|ENTRYPOINT)\b/i,
    }),
    lineRule({
      slug: 'docker.pinned_base_image',
      name: 'Pinned base image',
      description: 'A specific tag or digest, not :latest',
      // A tag that is not "latest", or a digest.
      dockerfile: /^\s*FROM\s+(--platform=\S+\s+)?[\w./-]+(:(?!latest\b)[\w.-]+|@sha256:[a-f0-9]{8,})/i,
    }),
    {
      slug: 'docker.multi_stage',
      name: 'Multi-stage build',
      description: 'Build in one stage, ship a smaller one',
      detect(file) {
        if (!isDockerfile(file.path)) return [];
        const froms = matchingLines(file, FROM, undefined, instruction);
        const named = matchingLines(file, /^\s*FROM\s+\S+\s+AS\s+\w+/i, undefined, instruction);
        return froms.length >= 2 && named.length >= 1 ? toHits(froms, 'config') : [];
      },
    },
    {
      slug: 'docker.layer_caching',
      name: 'Layer caching order',
      description: 'Copy the lockfile and install before copying the source',
      detect(file) {
        if (!isDockerfile(file.path)) return [];
        const lines = file.lines.map(instruction);
        const lock = lines.findIndex((l) =>
          /^\s*COPY\s+.*\b(package(-lock)?\.json|package\*\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|poetry\.lock|go\.(mod|sum))\b/i.test(l),
        );
        if (lock < 0) return [];
        const all = lines.findIndex((l, i) => i > lock && /^\s*COPY\s+\.\s+\S+/i.test(l));
        const install = lines.findIndex(
          (l, i) => i > lock && (all < 0 || i < all) && /^\s*RUN\s+.*\b(npm (ci|install)|yarn|pnpm (i|install)|pip install|go mod download)\b/i.test(l),
        );
        return all > 0 && install > 0 ? [{ start: lock + 1, end: all + 1, via: 'config' }] : [];
      },
    },
    lineRule({
      slug: 'docker.non_root_user',
      name: 'Non-root user',
      description: 'USER, so the app does not run as root',
      dockerfile: /^\s*USER\s+(?!(root|0)(\s|:|$))\S+/i,
      compose: /^\s*user:\s*(?!["']?(root|0)["']?\s*$)\S+/i,
    }),
    {
      slug: 'docker.dockerignore',
      name: '.dockerignore',
      description: 'Keeping secrets and node_modules out of the build context',
      detect(file) {
        if (!isDockerignore(file.path)) return [];
        return toHits(matchingLines(file, /^\s*[^#\s]/), 'config');
      },
    },
    lineRule({
      slug: 'docker.healthcheck',
      name: 'Healthcheck',
      description: 'HEALTHCHECK: letting Docker know the app is alive',
      dockerfile: /^\s*HEALTHCHECK\b/i,
      compose: /^\s*healthcheck:/i,
    }),
    lineRule({
      slug: 'docker.compose_services',
      name: 'Compose services',
      description: 'Running several containers together',
      compose: /^\s*services:\s*$/i,
    }),
    lineRule({
      slug: 'docker.volumes',
      name: 'Volumes',
      description: 'Data that outlives the container',
      dockerfile: /^\s*VOLUME\b/i,
      compose: /^\s*volumes:/i,
    }),
    lineRule({
      slug: 'docker.env_and_secrets',
      name: 'Env and secrets',
      description: 'ENV, ARG, env_file, secrets: configuration without baking it in',
      dockerfile: /^\s*(ENV|ARG)\b/i,
      compose: /^\s*(environment|env_file|secrets):/i,
    }),
    lineRule({
      slug: 'docker.ports_networking',
      name: 'Ports and networking',
      description: 'EXPOSE, ports, networks',
      dockerfile: /^\s*EXPOSE\b/i,
      compose: /^\s*(ports|networks|expose):/i,
    }),
  ],
};
