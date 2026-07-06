import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config (set these as environment variables in Render)
// ---------------------------------------------------------------------------
const FOUNDRY_HOST = process.env.FOUNDRY_HOST; // e.g. pb.palantirfoundry.com
const FOUNDRY_TOKEN = process.env.FOUNDRY_TOKEN; // your personal Foundry API token
const FOUNDRY_ONTOLOGY_RID = process.env.FOUNDRY_ONTOLOGY_RID; // ri.ontology.main.ontology....
const CONNECTOR_SECRET = process.env.CONNECTOR_SECRET; // random string you choose, used in the connector URL

// Object type + action API names (defaults match the Selkirk "SBS" ontology;
// override via env vars if your org's names ever change).
const TASK_OBJECT_TYPE = process.env.FOUNDRY_TASK_OBJECT_TYPE || "Deliverable";
const STATUS_ACTION = process.env.FOUNDRY_STATUS_ACTION || "update-deliverable-status";
const RESPONSE_ACTION = process.env.FOUNDRY_RESPONSE_ACTION || "add-feedback-to-deliverable";

// Used as the default "teammemberid" when posting a response, if the caller
// doesn't supply one explicitly.
const DEFAULT_TEAM_MEMBER_ID = process.env.FOUNDRY_TEAM_MEMBER_ID || "";

const ALLOWED_STATUSES = [
  "Backlog",
  "Pending",
  "Active",
  "Triage",
  "Delivered",
  "Approved",
  "Abandoned",
];

for (const [name, value] of Object.entries({
  FOUNDRY_HOST,
  FOUNDRY_TOKEN,
  FOUNDRY_ONTOLOGY_RID,
  CONNECTOR_SECRET,
})) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Foundry Ontology API helper
// ---------------------------------------------------------------------------
async function foundryFetch(path, init = {}) {
  const url = `https://${FOUNDRY_HOST}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${FOUNDRY_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const message =
      body && typeof body === "object" && (body.message || body.errorName)
        ? body.message || body.errorName
        : `Foundry request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

function objectsBasePath() {
  return `/api/v2/ontologies/${FOUNDRY_ONTOLOGY_RID}/objects/${TASK_OBJECT_TYPE}`;
}

function actionsApplyPath(actionApiName) {
  return `/api/v2/ontologies/${FOUNDRY_ONTOLOGY_RID}/actions/${actionApiName}/apply`;
}

// Simplifies a raw Foundry object payload down to the fields most useful to
// a chat client. Foundry's Ontology API v2 returns objects as a flat map of
// propertyApiName -> value, plus reserved metadata keys prefixed with `__`
// (e.g. __rid, __primaryKey, __apiName) -- there is no nested "properties"
// object.
function simplifyTask(obj) {
  if (!obj) return obj;
  const { __rid, __primaryKey, __apiName, ...properties } = obj;
  return {
    id: obj.primaryKey_ ?? __primaryKey,
    name: obj.name,
    status: obj.status,
    owner: obj.owner,
    rid: __rid,
    properties,
  };
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "foundry-tasks",
  version: "1.2.0",
});

server.tool(
  "list_tasks",
  "List Deliverables (tasks/to-dos) from Foundry, optionally filtered by status(es), owner, and/or overall involvement (owner, finalizer, or collaborator).",
  {
    status: z
      .enum(ALLOWED_STATUSES)
      .optional()
      .describe("Only return tasks in this single status."),
    statuses: z
      .array(z.enum(ALLOWED_STATUSES))
      .optional()
      .describe(
        "Only return tasks in any of these statuses (OR'd together). Use this instead of `status` to fetch several statuses at once, e.g. everything still open."
      ),
    ownerId: z
      .string()
      .optional()
      .describe("Only return tasks owned by this user id."),
    involvingUserId: z
      .string()
      .optional()
      .describe(
        "Only return tasks where this user id is the owner, the finalizer (finalizerS_), OR listed in collaborators. Use this to get everything a person is on the hook for, not just what they own."
      ),
    pageSize: z.number().int().min(1).max(200).optional().default(50),
    pageToken: z
      .string()
      .optional()
      .describe(
        "Token from a previous response's nextPageToken, to fetch the next page of results."
      ),
  },
  async ({ status, statuses, ownerId, involvingUserId, pageSize, pageToken }) => {
    const conditions = [];
    if (status) {
      conditions.push({ type: "eq", field: "status", value: status });
    }
    if (statuses && statuses.length > 0) {
      conditions.push({
        type: "or",
        value: statuses.map((s) => ({ type: "eq", field: "status", value: s })),
      });
    }
    if (ownerId) {
      conditions.push({ type: "eq", field: "owner", value: ownerId });
    }
    if (involvingUserId) {
      conditions.push({
        type: "or",
        value: [
          { type: "eq", field: "owner", value: involvingUserId },
          { type: "eq", field: "finalizerS_", value: involvingUserId },
          { type: "contains", field: "collaborators", value: involvingUserId },
        ],
      });
    }

    let result;
    if (conditions.length > 0) {
      const where =
        conditions.length === 1
          ? conditions[0]
          : { type: "and", value: conditions };

      const body = { where, pageSize };
      if (pageToken) body.pageToken = pageToken;

      result = await foundryFetch(`${objectsBasePath()}/search`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } else {
      const qs = new URLSearchParams({ pageSize: String(pageSize) });
      if (pageToken) qs.set("pageToken", pageToken);
      result = await foundryFetch(`${objectsBasePath()}?${qs.toString()}`);
    }

    const tasks = (result.data || []).map(simplifyTask);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { tasks, nextPageToken: result.nextPageToken },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_task",
  "Get a single Deliverable (task) by its id.",
  {
    id: z.string().describe("The task's primary key / id."),
  },
  async ({ id }) => {
    const obj = await foundryFetch(
      `${objectsBasePath()}/${encodeURIComponent(id)}`
    );
    return {
      content: [
        { type: "text", text: JSON.stringify(simplifyTask(obj), null, 2) },
      ],
    };
  }
);

server.tool(
  "update_task_status",
  "Update a Deliverable's status, optionally acknowledging related messages.",
  {
    id: z.string().describe("The task's primary key / id."),
    status: z.enum(ALLOWED_STATUSES),
    acknowledgeMessageIds: z
      .array(z.string())
      .optional()
      .describe(
        "Ids of Internal Message records to mark acknowledged. Leave empty if none."
      ),
  },
  async ({ id, status, acknowledgeMessageIds }) => {
    const parameters = { deliverable: id, status };
    if (acknowledgeMessageIds && acknowledgeMessageIds.length > 0) {
      parameters.feedbackToAcknowledge = acknowledgeMessageIds;
    }

    const result = await foundryFetch(actionsApplyPath(STATUS_ACTION), {
      method: "POST",
      body: JSON.stringify({ parameters }),
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "post_task_response",
  "Post a response / message on a Deliverable (task).",
  {
    id: z.string().describe("The task's primary key / id."),
    message: z.string().describe("The response text to add."),
    teamMemberId: z
      .string()
      .optional()
      .describe(
        "Id of the team member posting the message. Defaults to FOUNDRY_TEAM_MEMBER_ID env var if not supplied."
      ),
  },
  async ({ id, message, teamMemberId }) => {
    const resolvedTeamMemberId = teamMemberId || DEFAULT_TEAM_MEMBER_ID;
    if (!resolvedTeamMemberId) {
      throw new Error(
        "No teamMemberId supplied and FOUNDRY_TEAM_MEMBER_ID is not set."
      );
    }

    const result = await foundryFetch(actionsApplyPath(RESPONSE_ACTION), {
      method: "POST",
      body: JSON.stringify({
        parameters: {
          id,
          teammemberid: resolvedTeamMemberId,
          message,
        },
      }),
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// HTTP transport
//
// Claude's custom connector setup takes a single URL (no custom headers), so
// auth is done via a secret path segment instead of an Authorization header:
//   https://<your-app>.onrender.com/mcp/<CONNECTOR_SECRET>
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).send("foundry-mcp-connector is running");
});

app.all("/mcp/:secret", async (req, res) => {
  if (!CONNECTOR_SECRET || req.params.secret !== CONNECTOR_SECRET) {
    res.status(404).send("Not found");
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal error handling MCP request" });
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`foundry-mcp-connector listening on port ${port}`);
});
