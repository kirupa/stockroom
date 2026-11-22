// A Model Context Protocol server over stdio, with no dependencies. Any agent
// that speaks MCP (Copilot, Claude Code, Cursor, VS Code, and friends) can
// plug into the counter and ask its questions.

import readline from 'node:readline';
import { Counter, TOOLS } from './counter.js';
import { TOOL_VERSION } from './walk.js';

const INSTRUCTIONS = `This server is the counter of a context system: a catalog of the code, design tokens, rules, and approved and rejected examples for this project.
Ask before you read. Small, precise questions beat reading whole files.
- Making or changing something (a page, a slide deck, a figure)? Start with find_rules for that kind of work, then read only the sections you need with read_source. Check find_examples to see what has been approved and rejected, and why.
- Fixing something? Use search_source for the error text or the wrong words, find_symbol for a class, id, token, function, or color, and who_references before changing anything shared.
- Use the values the index gives you (token names, file paths, line numbers). Don't guess them.
- read_source returns a sha256. Keep it with any edit you propose, so the edit can be refused if the file changed.
- If a tool says something isn't in the index, say so instead of guessing.`;

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function serve({ root, dbPath, maxCalls, rebuild = null, input = process.stdin, output = process.stdout }) {
  let counter = null;
  let startupError = null;
  try {
    counter = new Counter({ root, dbPath, maxCalls, rebuild });
  } catch (err) {
    startupError = err.message;
  }

  const send = (msg) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      send({ id: null, error: { code: -32600, message: 'Invalid Request: send one JSON-RPC object per line.' } });
      return;
    }
    const { id, method } = msg;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    const reply = (result) => id !== undefined && send({ id, result });
    const fail = (code, message) => id !== undefined && send({ id, error: { code, message } });

    try {
      handle(method, params, reply, fail);
    } catch (err) {
      fail(-32603, `stockroom hit an unexpected error: ${err.message}`);
    }
  });

  function handle(method, params, reply, fail) {
    switch (method) {
      case 'initialize':
        reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'stockroom', version: TOOL_VERSION },
          instructions: INSTRUCTIONS,
        });
        break;
      case 'ping':
        reply({});
        break;
      case 'tools/list':
        reply({ tools: TOOLS });
        break;
      case 'tools/call': {
        if (!counter) {
          try {
            counter = new Counter({ root, dbPath, maxCalls, rebuild });
            startupError = null;
          } catch (err) {
            startupError = err.message;
          }
        }
        if (!counter) {
          reply({ content: [{ type: 'text', text: startupError }], isError: true });
          break;
        }
        try {
          const result = counter.call(params.name, params.arguments ?? {});
          reply({ content: [{ type: 'text', text: result.text }], isError: result.isError });
        } catch (err) {
          reply({ content: [{ type: 'text', text: `stockroom hit an unexpected error: ${err.message}` }], isError: true });
        }
        break;
      }
      default:
        if (typeof method === 'string' && method.startsWith('notifications/')) break;
        fail(-32601, `Method not found: ${method}`);
    }
  }

  return new Promise((resolve) => rl.on('close', () => {
    counter?.close();
    resolve();
  }));
}
