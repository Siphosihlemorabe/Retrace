/** Who wrote some code, in the product's words (G4: framed, never accusatory). */
export const WHO: Record<string, string> = {
  builder: 'you',
  builder_with_agent: 'you, with an agent',
  agent: 'your agent',
  template: 'template',
  automation: 'automated',
  other_human: 'someone else',
  unknown: 'author not confirmed',
};

/** The same, for the narrow column beside each line of code. */
export const SHORT: Record<string, string> = {
  builder: 'you',
  builder_with_agent: 'you+AI',
  agent: 'agent',
  template: 'tmpl',
  automation: 'bot',
  other_human: 'other',
  unknown: '?',
};

/** The connected model, as the builder would name it. */
export const PROVIDER: Record<string, string> = {
  'claude-cli': 'your Claude Code',
  'anthropic-api': 'the Anthropic API',
  ollama: 'Ollama on this computer',
  off: 'no model',
};
