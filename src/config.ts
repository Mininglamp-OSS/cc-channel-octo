/**
 * Configuration loading.
 * Three-level priority: env > config.json > defaults.
 *
 * Will be implemented in T4.
 */

export interface Config {
  botToken: string;
  apiUrl: string;
  cwd: string;
  dataDir: string;
  sdk: {
    model?: string;
    allowedTools: string[];
    permissionMode: string;
    maxTurns?: number;
    systemPrompt?: string;
    settingSources: string[];
  };
  rateLimit: {
    maxPerMinute: number;
  };
  context: {
    maxContextChars: number;
    historyLimit: number;
  };
  botBlocklist?: string[];
}
