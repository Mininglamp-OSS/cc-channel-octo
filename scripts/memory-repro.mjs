/**
 * Isolated repro: does the SDK's filesystem auto-memory actually WRITE to
 * `autoMemoryDirectory` during a single query() turn?
 *
 * Runs one query() telling the model to remember a durable fact, with
 * autoMemoryEnabled=true pointed at a fresh temp dir, settingSources:[] so the
 * agent cannot see/touch the host's real ~/.claude config. Then snapshots the
 * temp dir.
 *
 * Usage: node scripts/memory-repro.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const memDir = mkdtempSync(join(tmpdir(), 'mem-repro-'));
const cwd = mkdtempSync(join(tmpdir(), 'mem-cwd-'));
console.log('[repro] memoryDir =', memDir);
console.log('[repro] cwd       =', cwd);

function walk(dir, depth = 0) {
  let out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    out.push('  '.repeat(depth) + (st.isDirectory() ? e + '/' : `${e} (${st.size}b)`));
    if (st.isDirectory()) out = out.concat(walk(p, depth + 1));
    else if (st.size < 2000) out.push('    ↳ ' + readFileSync(p, 'utf8').replace(/\n/g, '\\n'));
  }
  return out;
}

const PROMPT = 'Please remember this durable fact about me for all future sessions: my favorite color is teal (青色). Store it in your long-term memory.';

let sawRecall = false;
let turns = 0;
const t0 = Date.now();

const q = query({
  prompt: PROMPT,
  options: {
    cwd,
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'bypassPermissions',
    settingSources: [],
    // KEY: preset systemPrompt so the auto-memory dynamic section is injected.
    // A raw-string systemPrompt suppresses it (sdk.d.ts:2928).
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are a helpful assistant in a chat gateway.' },
    settings: { autoMemoryEnabled: true, autoMemoryDirectory: memDir },
  },
});

for await (const msg of q) {
  turns++;
  if (msg.type === 'system') {
    console.log(`[repro] system msg subtype=${msg.subtype ?? '(none)'}`);
    if (msg.subtype === 'memory_recall') sawRecall = true;
  }
  if (msg.type === 'assistant') {
    const text = (msg.message?.content ?? [])
      .filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) console.log('[repro] assistant:', text.slice(0, 200).replace(/\n/g, ' '));
    const tools = (msg.message?.content ?? []).filter((b) => b.type === 'tool_use');
    for (const t of tools) console.log(`[repro] tool_use: ${t.name} input=${JSON.stringify(t.input).slice(0, 160)}`);
  }
  if (msg.type === 'result') {
    console.log(`[repro] result: ${msg.subtype} in ${Date.now() - t0}ms`);
  }
}

console.log(`\n[repro] === DONE: ${turns} msgs, memory_recall seen=${sawRecall} ===`);
console.log('[repro] memoryDir tree:');
const tree = walk(memDir);
console.log(tree.length ? tree.join('\n') : '  (EMPTY — nothing written)');
console.log('[repro] cwd tree:');
const ctree = walk(cwd);
console.log(ctree.length ? ctree.join('\n') : '  (EMPTY)');
