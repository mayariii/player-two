# Player Two

Initial thought doodles [here](https://www.tldraw.com/f/Isz1U_UwXu8DBmoO5NBtr?d=v9479.-1591.9131.5114.page)

[Research prototype - a work in progress, plenty of room for improvement]

A local, game-inspired chat interface for Codex, exploring human oversight of coding agents.

When a conversation gets long, understanding what the agent is doing can mean scrolling back through it. Player Two explores whether a small HUD can help you return to a task and see what happened, what the goal is, and what needs your input.

Chat stays central. Around it, the HUD keeps recent activity, decisions and current execution visible. The agent can update the mission as its understanding evolves, propose decisions for you to confirm, and leave suggested next steps. You can follow command status, respond to permission requests, steer the conversation and stop work.

https://github.com/user-attachments/assets/105b2270-f9c1-4938-8ef4-e49f96da5e36

https://github.com/user-attachments/assets/11600593-1525-4d27-9d62-e9c05e564083

- Mission: the current goal, updated by the agent as the conversation evolves, with earlier versions in History.
- Recent activity: commands and file changes, so you can follow what has happened.
- Now: the current execution state and anything needing your input.
- Decisions: the agent proposes a choice and rationale. **Confirm & send** sends your choice back into the conversation so the agent can act on it.

## Run locally

Tested on macOS with Node 20.20.0 and Codex CLI 0.159.2. Install the Codex CLI separately and make sure `codex` is on your PATH. From this repository:

```sh
codex login # skip if already authenticated
npm ci
npm run dev
```

Open `http://localhost:5173`, or the URL printed by Vite. The app runs locally on your computer.

Choose **New chat**, select a project folder, review the permissions and send a message. Player Two uses your existing Codex account and configuration. Model calls require network access and use your account's allowance.

## Try it

Prepare the included demo project:

```sh
npm run demo:prepare
```

Create a chat in the folder it prints, with project-file editing enabled, and send:

> Fix cartTotal so it respects quantities, following this project's README. Run the existing tests first. Before editing, use player_two_propose_decision to propose your approach, then wait for my confirmation. Keep the tests unchanged. After confirmation, implement the fix and rerun them. Do not commit.

Follow the test activity, then choose **Confirm & send** on the proposed decision. Follow the changes and results. The fixture starts with 1 passing test and 2 failures; a correct fix should produce 3 passes.

A real browser demo exercised the cart fix, decision confirmation sent through the HUD, and a subsequent mission change with history. The agent reported three passing tests; that recording did not include an independent test rerun.

## How it works

```text
SvelteKit chat + HUD ↔ local server ↔ Codex App Server ↔ agent/tools
                           ↕
                       local SQLite
```

The server starts `codex app-server`, sends user actions and streams observed state to the browser. Three tools let the agent contribute directly to the interface:

- `player_two_propose_decision`: propose a choice for human confirmation.
- `player_two_update_mission`: revise the current goal, with version history.
- `player_two_next_step`: leave a suggested next step or unresolved check.

Confirming a decision sends a message back to the agent. Permission approvals use a separate App Server channel. A proposed decision is not an enforced execution gate, and a finished response does not establish that the goal was achieved.

## Development

```sh
npm run check
npm test
npm run build
```

This prototype supports one active chat per server and uses the experimental Codex App Server API. Closing the browser does not stop the agent. Local conversations are stored in `.player-two/`; keep this folder private.
