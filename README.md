# skill-graph

Portable, contract-checked workflows for agents.

Skill Graph separates orchestration from the agent runtime. A graph declares
stages, inputs, outputs, artifact contracts, branches, loops, and budgets. Each
stage still runs in the host agent, so the same graph can work with Pi, an MCP
client, a CLI agent, or a custom orchestrator.

## What This Provides

- YAML workflow graphs with deterministic routing and bounded execution.
- Progressive `SKILL.md` loading: only the active stage skill is needed.
- SHA-256 skill pinning so a run cannot silently continue after a skill changes.
- Artifact validation, JSON Schema checks, atomic state writes, and file locks.
- A small CLI and an MCP stdio server for other agents.
- A structured question protocol for missing or ambiguous user input.

## Quick Start

```bash
npm install
npm run build
```

List workflows from a project root:

```bash
set SKILL_GRAPH_PROJECT_ROOTS=C:\path\to\project\.skill-workflows
node dist/cli.js list --cwd C:\path\to\project
```

Start a run and pass the returned stage context to an agent:

```bash
node dist/cli.js run research "{\"topic\":\"agent reliability\"}" --cwd C:\path\to\project
```

On PowerShell, use an input file when shell quoting would be inconvenient:

```bash
node dist/cli.js run research --input-file input.json --cwd C:\path\to\project
```

The CLI stages are:

```text
skill-graph list
skill-graph run <workflow-id> <json-input>
skill-graph context <run-id>
skill-graph submit <run-id> <node-id> <visit-id> [result-path]
skill-graph resume <run-id>
```

## Project Layout

```text
.skill-workflows/
  graph/skills.yaml       # skill contracts and versions
  workflows/*.yaml        # graph definitions
  schemas/*.json          # optional artifact schemas
  runs/                    # generated run state, ignored by git
skills/
  <skill-id>/SKILL.md     # agent instructions loaded on demand
```

The loader also accepts `.skill-graph` as a project root. Configure roots with:

```text
SKILL_GRAPH_PROJECT_ROOTS=path1:path2
SKILL_GRAPH_USER_ROOTS=path1:path2
SKILL_GRAPH_HOME=path
SKILL_GRAPH_SKILL_PATHS=path1:path2
```

On Windows, use `;` instead of `:` in multi-path variables.

## Workflow Contract

```yaml
schema_version: 1
id: research
version: 1
mode: agent
required_inputs: [topic]
entry: topic_selection
nodes:
  - id: topic_selection
    type: agent
    skill: topic-selection
    task: Create a focused research plan.
    inputs:
      topic: "{{input:topic}}"
    outputs:
      - name: topic_plan
        required: true
    terminal: true
```

Each stage writes `node_result.json` to the supplied result path:

```json
{
  "schema_version": 1,
  "node_id": "topic_selection",
  "visit_id": "v-123",
  "status": "success",
  "summary": "Created the research plan",
  "artifacts": [{ "name": "topic_plan", "path": "topic-plan.md" }],
  "issues": []
}
```

Artifact paths are relative to the stage output directory. Required artifacts,
file boundaries, size limits, hashes, and optional JSON Schemas are checked
before the graph advances.

## MCP Adapter

Build the package and configure an MCP client to run the stdio server:

```json
{
  "mcpServers": {
    "skill-graph": {
      "command": "node",
      "args": ["E:/skill-graph/dist/adapters/mcp/server.js"],
      "env": {
        "SKILL_GRAPH_CWD": "E:/your-project",
        "SKILL_GRAPH_PROJECT_ROOTS": "E:/your-project/.skill-workflows",
        "SKILL_GRAPH_USER_ROOTS": "C:/Users/you/.skill-graph"
      }
    }
  }
}
```

The MCP server exposes five small tools:

- `workflow_list`
- `workflow_execute`
- `workflow_submit_stage`
- `workflow_resume`
- `question`

The host agent remains responsible for reading the active `SKILL.md`, doing the
work, writing artifacts, and submitting the result. The graph engine never
pretends to execute an LLM stage itself.

## Agent Adapters

`src/adapters/skills.ts` loads a bounded `SKILL.md` and builds an active-stage
prompt. `src/adapters/agent-protocol.ts` provides the result template. A host
that already has a native tool API can use these two adapters directly without
running MCP.

When a stage is missing information, use the question protocol instead of
guessing:

```json
{
  "mode": "select",
  "title": "Choose a research audience",
  "options": ["Consumers", "Operators", "Both"]
}
```

For free text, use `mode: "input"` and a `placeholder`. MCP clients receive a
`needs_user` response and can collect the answer through their own UI; Pi Web
uses its native select/input dialog.

## Security And Stability

- Workflow and skill paths are bounded to configured roots.
- A run records the graph hash and every skill hash.
- Changed graphs or skills refuse to resume an existing run.
- Run state updates use atomic files and per-run locks.
- Budgets cap visits, agent turns, loops, and duration.
- The expression language is deliberately small and does not execute code.

## License

MIT
