# Foundry Tasks MCP Connector

A small MCP server that wraps your Foundry Ontology API so Claude can list your
Deliverables (to-dos), check one, update its status, and post a response —
all against the real objects in your "SBS - Selkirk Business System" app.

Tools exposed:

- `list_tasks` — list Deliverables, optionally filtered by `status` and/or `ownerId`.
- `get_task` — fetch one Deliverable by id.
- `update_task_status` — move a Deliverable to a new status (Backlog, Pending,
  Active, Triage, Delivered, Approved, Abandoned), optionally acknowledging
  related messages.
- `post_task_response` — add a message/response to a Deliverable.

## 1. Get your Foundry details

You already have most of these from setup:

| Value | Where it came from |
|---|---|
| Host | `pb.palantirfoundry.com` |
| Ontology RID | `ri.ontology.main.ontology.6af965ea-6e8c-4677-8bff-84eab0928a7a` |
| Object type API name | `Deliverable` |
| Status action API name | `update-deliverable-status` |
| Response action API name | `add-feedback-to-deliverable` |

The one thing you still need to get yourself is the **API token**:

1. In Foundry, click your avatar (bottom-left) → **Settings** → **Tokens**.
2. Click **Create token**, give it a name (e.g. `foundry-mcp-connector`), and a
   sensible expiry.
3. Click **Generate** and **copy the token immediately** — Foundry only shows
   it once.
4. Paste it straight into Render's environment variables in the next step —
   don't paste it into a chat or a file that gets saved anywhere shared.

Note: while testing this earlier, two throwaway tokens may have been created
in your account (`foundry-mcp-connector` and "Token for Claude MCP task
connector (Render-hosted)"), both expiring 11 Jul 2026. Neither has a captured
secret, so they're inert — you can revoke them from Settings → Tokens whenever
convenient.

You'll also want your own **team member id** (used when posting a response) —
ask your Foundry admin if you're not sure where that's surfaced for your org,
or just pass a `teamMemberId` explicitly on each `post_task_response` call.

## 2. Deploy to Render

1. Push this folder (`index.js`, `package.json`) to a new GitHub repo.
2. Go to [render.com](https://render.com), sign in, and click **New +** →
   **Web Service**.
3. Connect the GitHub repo.
4. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
5. Add environment variables:
   - `FOUNDRY_HOST` = `pb.palantirfoundry.com`
   - `FOUNDRY_TOKEN` = *(the token you generated in step 1 — paste directly here)*
   - `FOUNDRY_ONTOLOGY_RID` = `ri.ontology.main.ontology.6af965ea-6e8c-4677-8bff-84eab0928a7a`
   - `CONNECTOR_SECRET` = *(any random string you make up — this is your connector's "password")*
   - `FOUNDRY_TEAM_MEMBER_ID` = *(optional, your team member id, used as a default for responses)*
6. Deploy. Render will give you a public URL like
   `https://foundry-mcp-connector.onrender.com`.

## 3. Add it as a custom connector in Claude

In Claude, go to **Settings → Connectors → Add custom connector**, and use:

```
https://<your-app>.onrender.com/mcp/<CONNECTOR_SECRET>
```

(the same `CONNECTOR_SECRET` value you set in Render).

This connector is account-wide once added — it'll show up as available in
both claude.ai chats and Cowork sessions.

## Notes / things to double check

- The object type and action API names above are current as of this setup —
  if your Foundry admin ever renames them, override via the
  `FOUNDRY_TASK_OBJECT_TYPE`, `FOUNDRY_STATUS_ACTION`, or
  `FOUNDRY_RESPONSE_ACTION` environment variables instead of editing code.
- `update_task_status` and `post_task_response` both call real Foundry
  Actions, which change live data — have your Foundry admin sanity-check the
  action permissions before this connector sees broad use.
- If you get a permissions error calling an action, it likely means your
  Foundry token's user doesn't have edit rights on Deliverable — check with
  your Foundry admin.
