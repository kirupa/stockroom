# stockroom

A tiny, open-source context system. It catalogs everything your agents need to know (code, design tokens, written rules, and approved and rejected examples) into one SQLite file, and gives agents eight small tools to ask it precise questions.

It's the companion to the kirupa.com article [Building Your Own Context System](https://www.kirupa.com/ai_fundamentals/building_your_own_context_system.htm), which walks through how and why every piece works. The short version of the idea is in [Context Systems: How an AI Factory Knows What It Needs](https://www.kirupa.com/ai_fundamentals/context_systems.htm).

- **No dependencies.** It uses the SQLite that ships inside Node.js (22.13 or newer).
- **One file.** The whole catalog is `.stockroom/context.db`. Delete it and rebuild any time.
- **Works with any agent.** `stockroom serve` is a Model Context Protocol (MCP) server.
- **Honest about what it doesn't know.** A stale index refuses to answer, and files it skipped on purpose say why.

## Start a project with it

The quickest way to use stockroom on your own work is the **[stockroom-starter](https://github.com/kirupa/stockroom-starter)** template. It comes with empty shelves, starter rules for web pages, slide decks, and figures, an agent for each kind of work (for GitHub Copilot and Claude Code), MCP configs, Git hooks, and a CI check. Click **Use this template** on GitHub, or:

```bash
gh repo create my-context --template kirupa/stockroom-starter --private --clone
cd my-context && npm install && npm run setup
```

## Try it in a minute

```bash
git clone https://github.com/kirupa/stockroom.git
cd stockroom/examples/crumb-and-co
node ../../bin/stockroom.js build
node ../../bin/stockroom.js report
node ../../bin/stockroom.js rules illustration arrow
node ../../bin/stockroom.js symbol --primary
```

The `examples/crumb-and-co` folder is a pretend bakery's Context Environment: a small website, a slide deck, a figure library, icons, five guidance files, and approved and rejected examples. A few problems are planted in it on purpose, and `stockroom report` finds them.

## Lay out your shelves

A Context Environment is a folder. A `stockroom.json` at its top level says which subfolders (shelves) to catalog and what kind of work each one is for:

```json
{
  "name": "Crumb & Co.",
  "shelves": [
    { "path": "site", "kind": "code", "for": ["web"] },
    { "path": "decks", "kind": "code", "for": ["slides"] },
    { "path": "figures", "kind": "code", "for": ["illustration"] },
    { "path": "icons", "kind": "code", "for": ["illustration", "slides", "web"] },
    { "path": "guidance", "kind": "guidance" },
    { "path": "examples", "kind": "example" }
  ],
  "maxFileBytes": 262144
}
```

Without a `stockroom.json`, everything under the folder is cataloged, Markdown files count as guidance, and everything else counts as code.

**Guidance** is Markdown. Front matter says which kinds of work it applies to, and every heading becomes a section an agent can read on its own:

```markdown
---
for: [illustration, slides]
summary: How arrows start, bend, and land in figures and slides.
---

# Arrows

## Callout arrows

- A callout arrow starts at the middle of its caption...
```

**Examples** go in `examples/<kind of work>/<approved or rejected>/`. A Markdown file with the same name next to an example (a sidecar) holds the reason:

```
examples/illustration/rejected/order-flow-v1.svg
examples/illustration/rejected/order-flow-v1.md   <- verdict, note, and the story
```

## Commands

| Command | What it does |
|---|---|
| `stockroom build` | Catalogs every shelf into `.stockroom/context.db`, then swaps the new file in all at once. |
| `stockroom watch` | Rebuilds whenever a file on a shelf changes. |
| `stockroom status` | Shows what's in the index and which files changed since the last build. |
| `stockroom report` | Lists broken references, classes, ids, and tokens that are used but never defined, figure colors that aren't in the palette, and files skipped on purpose. Add `--strict` to exit with an error when it finds a problem, which is handy in CI. |
| `stockroom verify <path> <sha256>` | Checks that a file still matches the hash an edit was based on. |
| `stockroom serve` | Runs the MCP server over stdio. Add `--watch` and the server builds the index itself and keeps it current, so you don't need a separate `watch`. |

Every tool is also a command, so you can ask the same questions your agents ask: `search`, `symbol`, `read`, `ls`, `uses`, `used-by`, `rules`, and `examples`. Run `stockroom help` for the details. Add `--json` for structured output, and `--root=<dir>` to point at a different Context Environment.

## The tools

| Tool | The question it answers |
|---|---|
| `search_source` | Which files and lines contain this text? |
| `find_symbol` | Where is this class, id, token, function, or color defined, and where is it used? |
| `read_source` | Show me these lines of this file, or this one section of a guidance file. |
| `list_source` | What's in this folder, with a one-line summary of each file? |
| `follow_references` | What does this file pull in, and does each one exist? |
| `who_references` | Which files pull in this file? |
| `find_rules` | Which rules apply to this kind of work, about this topic? |
| `find_examples` | What has been approved and rejected for this kind of work, and why? |

Each MCP session gets 40 lookups by default (set `STOCKROOM_MAX_CALLS` to change it), and each answer is capped at 16,000 characters. `read_source` returns at most 200 lines and always includes the file's sha256.

## Plug in an agent

Install it once:

```bash
npm install -g github:kirupa/stockroom
```

**GitHub Copilot CLI** (`~/.copilot/mcp-config.json`):

```json
{
  "mcpServers": {
    "stockroom": {
      "type": "local",
      "command": "stockroom",
      "args": ["serve", "--watch", "--root=/path/to/your/context"],
      "tools": ["*"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "stockroom": {
      "type": "stdio",
      "command": "stockroom",
      "args": ["serve", "--watch", "--root=${workspaceFolder}"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add stockroom -- stockroom serve --watch --root=/path/to/your/context
```

## Keep it current

An out-of-date index is worse than none, because agents trust it. stockroom guards against that in three ways:

- Every tool call compares the shelves with the fingerprint the index recorded. If anything changed, the tool refuses to answer and names the files that changed.
- A rebuild writes a new file next to the old one and renames it into place, so a reader never sees a half-built index. A running MCP server notices the new file and switches to it.
- `read_source` returns a sha256 for the file it read. Keep it with any edit you propose, and run `stockroom verify` before applying the edit.

Tie `stockroom build` to the one path every change already takes, like a Git hook, a CI step, or `stockroom watch` on the machine your agents run on. With `stockroom serve --watch`, the server is its own clerk: it rebuilds when a file changes, and if a question arrives before that rebuild finishes, it rebuilds on the spot instead of refusing.

## Benchmark

`npm install && npm run bench` runs eight tasks against the Crumb & Co. sample twice: once with plain `ls`, `grep`, and `cat`, and once through stockroom. It counts tokens with the o200k_base encoding and checks that each world actually found the evidence the task needed. The sample is small, so the timing difference is too small to matter there. The token difference is the part that carries over to bigger projects.

## How it works

`src/walk.js` walks the shelves. `src/extract.js` pulls names, references, sections, and summaries out of HTML, SVG, CSS, JavaScript, Markdown, and JSON with regular expressions (accurate enough for "where is this defined?" without a parser per language). `src/build.js` writes them into the tables in `src/schema.sql`, including a trigram full-text index. `src/counter.js` answers the questions, and `src/mcp.js` serves them over MCP.

## License

MIT
