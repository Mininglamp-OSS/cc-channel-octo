/**
 * Phase 2: cross-session RECALL. Point a fresh query() at a pre-populated
 * memoryDir (written by phase 1) and ask the question cold — no history, no
 * resume. If it answers "teal", auto-memory recall works end to end.
 *
 * Usage: node scripts/memory-recall.mjs <memoryDir>
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const memDir = process.argv[2];
if (!memDir) { console.error('usage: node scripts/memory-recall.mjs <memoryDir>'); process.exit(1); }
const cwd = mkdtempSync(join(tmpdir(), 'mem-recall-cwd-'));
console.log('[recall] memoryDir =', memDir);

let sawRecall = false, answer = '';
const q = query({
  prompt: 'What is my favorite color? Answer in one word.',
  options: {
    cwd,
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'bypassPermissions',
    settingSources: [],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are a helpful assistant in a chat gateway.' },
    settings: { autoMemoryEnabled: true, autoMemoryDirectory: memDir },
  },
});
for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'memory_recall') {
    sawRecall = true;
    console.log('[recall] *** memory_recall *** items=', (msg.memories ?? []).length, JSON.stringify(msg.memories ?? []).slice(0, 300));
  }
  if (msg.type === 'assistant') {
    const text = (msg.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) answer += text;
  }
}
console.log('[recall] answer:', answer.slice(0, 200).replace(/\n/g, ' '));
console.log(`[recall] === memory_recall_seen=${sawRecall}, mentions teal/青=${/teal|青/i.test(answer)} ===`);
