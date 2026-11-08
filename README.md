# clickup-mcp-server

Self-hosted ClickUp MCP server: zero-dependency Node over stdio (server name
`clickup-selfhosted`). It exists because the hosted claude.ai ClickUp connector rate-limits.
This server paces itself to ≤90 requests/min, retries on 429, and has no daily cap.

**Every operation in ClickUp's public API is a tool**: all 172 of the v2 and v3 specs (the OAuth
code exchange is the one left out, as this server uses personal tokens). If ClickUp's API can do
it, there is a tool for it; what the API cannot do is listed under
[Not in the public API](#not-in-the-public-api).

## Install (any machine)

```bash
git clone https://github.com/jeff-fichtner/clickup-mcp-server.git
cd clickup-mcp-server
claude mcp add --scope user clickup -- node "$PWD/clickup-stdio.js"
```

No `npm install`; it uses Node built-ins only. User scope makes it available in every project.
Any other MCP client works the same way: run `node clickup-stdio.js` as a stdio server.

## Tokens: one per workspace

A ClickUp personal token reaches only the workspace it was generated in (observed 2026-10-20:
the same user's token from one workspace gets `401 OAUTH_023 "Team(s) not authorized"` in
another). So the server holds a map of workspace id → token and sends every call with the token
of the workspace it belongs to.

The map is JSON: workspace id → personal token.

```json
{"1234567": "pk_…", "7654321": "pk_…"}
```

- **Token**: in ClickUp, *Settings → Apps → API Token*, generated while in the workspace it is
  for. Repeat in each workspace you want to reach.
- **Workspace id**: the number after `app.clickup.com/` in any URL inside that workspace.

Where the server reads the map, first match wins:

- **env `CLICKUP_TOKENS`**: the JSON above, in the environment your MCP client starts from.
- **macOS Keychain**, service `clickup_tokens`. Store it with
  `security add-generic-password -U -s clickup_tokens -a "$USER" -w` (a bare `-w` last prompts
  for the JSON, so it stays out of shell history), and check it with `security find-generic-password -s clickup_tokens >/dev/null && echo present`.

A missing or malformed map is an error on startup (stderr) and on every call; nothing goes out
without a token. Keep tokens out of shell history and out of the repo.

**Routing.** A call that names a workspace (`team_id`) uses that workspace's token. A call that
names only a task, list, folder or space asks each workspace in turn and remembers the one that
owns it; every object tool also takes an optional `team_id` to skip that. Only
`401 OAUTH_023`/`OAUTH_027` count as "wrong workspace, try the next": any other error, a revoked
token (`401 OAUTH_025`) included, fails at once. A wrong-workspace attempt is refused by ClickUp
before it does anything, so trying a write is safe. `list_workspaces` merges every workspace the
map reaches.

Unit tests: `node --test` (built-in runner, no install).

## Smoke test

Call `clickup_list_workspaces`. Your workspaces coming back means you're live.

Without the MCP loaded, drive it over stdio from the repo folder:

```bash
{ echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"clickup_list_workspaces","arguments":{}}}'
  sleep 5; } | node clickup-stdio.js
```

## Tools

171 tools: one per operation (two pairs share a tool, below), plus `get_hierarchy`. Names are
`clickup_<verb>_<object>`: `list_` for collections, `get_` for one, `create_`, `update_`,
`delete_`, plus `add_`/`remove_` for memberships and relations. Arguments are the operation's
path, query and body fields by their ClickUp names, at the top level.

- **How they're made.** `spec/` holds ClickUp's published OpenAPI specs; `names.js` names each
  operation; `scripts/generate-tools.js` builds `tools.generated.json` from both. The server serves
  that file, and `OVERRIDES` in `clickup-stdio.js` add behaviour to a few tools.
- **Refreshing.** Fetch the specs again (commands at the top of the generator) and run
  `node scripts/generate-tools.js`. It fails on an operation `names.js` doesn't name, so a new
  ClickUp endpoint is noticed, not skipped. `node --test` checks that the committed file
  matches the generator's output.
- **Spec errors** found against the live API are corrected in `SPEC_FIXES` in the generator,
  each with what was observed.
- **Two operations, one tool**: `create_list` and `create_list_from_template` take `folder_id` or
  `space_id`, and call the operation that parent belongs to.
- **Workspace.** The workspace parameter is `team_id` everywhere (the specs also say `team_Id`
  and `workspace_id`). It is required where the path holds it and optional elsewhere, where it
  only skips finding the owning workspace.
- **Query arrays** go out as ClickUp reads them: `statuses[]=a&statuses[]=b`;
  `task_ids=a&task_ids=b` and `group_ids` repeated bare; `custom_fields` as one JSON value.
- **Uploads** (`create_task_attachment`, `create_attachment`) take a local `file_path`.
- **Deletes and removals** say in their description to confirm the exact id with the user first.
- **Kept from before, unchanged for callers** (existing callers rely on these):
  `create_task`/`update_task` also take `markdown_description`, `priority` as a word, `due_date`
  as `YYYY-MM-DD`; `filter_tasks` takes `folder_ids` (sent as `project_ids`);
  `filter_tasks`, `list_tasks` and `get_list` return summaries unless given `raw: true`;
  `update_list` keeps the current name when only `content` is given.

## Behaviour notes

These were verified 2026-08-30 against a live workspace, except where dated otherwise.

- **move_task** is a REAL move: `PUT /api/v3/workspaces/{team}/tasks/{task}/home_list/{list}`
  reassigns the task's *home* list, and needs `team_id`. (v2's `POST /list/{id}/task/{id}` only
  adds an additional list.)
  - Only **root** tasks can move. A subtask follows its parent.
  - `status_mappings` is only needed when the current status doesn't exist in the destination
    list.
  - Moving a task archived *by inheritance from an archived list* un-archives it. An
    individually archived task stays archived; clear it with `update_task archived:false`.
- **move_folder** moves a folder, its lists and its tasks to the top level of another space
  (`PUT /api/v2/folder/{id}/position`). ClickUp answers with an empty body, so the tool reads the
  folder back and returns the space it is now in.
- **update_space** renames a space. `PUT /api/v2/space/{id}` takes the whole space, so the tool
  reads it first and sends every setting back unchanged.
- **create_space** copies the settings of an existing space (`like_space_id`), except colour,
  which the create call ignores. It cannot set statuses: a new space gets "to do" (open) and
  "complete" (closed). The claude.ai connector's `space_status update_many` can rename and add
  open, closed and custom statuses, but not a **done**-type one; that one is added in the UI
  (observed 2026-10-25; `PUT /space` with a `statuses` array answers 200 and ignores it).
- **list_tasks** is the only way to see tasks inside an ARCHIVED list (`filter_tasks` cannot).
  It paginates fully.
- **Responses** containing raw control characters (invalid JSON from ClickUp) are cleaned and
  retried once, then fail loudly.
- **tools/call runs strictly in order**, one at a time, so a write followed by a read-back is
  safe to pipeline. `initialize` / `tools/list` / `ping` are not queued; match responses by `id`.
- **delete_list** and **delete_folder** are soft (observed 2026-10-11 and 2026-10-25): they leave
  the hierarchy and go to ClickUp's Trash, and a GET by ID still returns them until Trash is
  emptied. Deleted tasks, goals, views, chat channels and spaces read back as not found.
- **Comments on a chat view** are chat messages: `delete_comment` answers 404 for them; delete
  them with `delete_chat_message` (observed 2026-10-25).
- **Time-entry tags** outlive their entries: `remove_time_entry_tags` takes a tag off entries, and
  no endpoint deletes the tag itself, so it stays in the workspace's tag list.
- **merge_tasks** deletes the source tasks into the target (observed 2026-10-25).
- A task's status is set by **name**. ClickUp rejects status IDs
  (`400 ITEM_114 Status does not exist`, observed 2026-10-11).

## Not in the public API

Checked 2026-10-25 against both specs and, where noted, the live API. No tool can do these;
use the ClickUp UI.

- **Statuses** of a space, folder or list: no endpoint. A new space gets "to do" and "complete";
  `PUT /space` with `statuses` answers 200 and ignores them (observed). The claude.ai connector's
  `space_status update_many` can add open, closed and custom statuses, but not **done**-type ones.
- **Moving a list** to another folder or space: no endpoint (folders and tasks can move).
- **Creating custom fields**: only reading them and setting values on tasks.
- **Deleting a doc or a doc page**, and archiving one.
- **Space colour on create**: the create call ignores it; `update_space` sets it.

## Live verification (2026-10-25, snackbyte workspace, Core plan)

Run against a throwaway space with the server driven over stdio.

- **Deletes, all read back** (2026-10-25): space, folder (Trash), lists (Trash), tasks, merge,
  space tag, task tags, checklist and item, task and list comments and replies, task link,
  views at every level, time entries, legacy tracked time, time-entry tag removal, goal, key
  result, webhook, chat channel, messages and reaction. `delete_dependency` after the spec fix
  and `remove_task_from_list` are covered by unit tests only.
- **Working:** workspaces, plan, seats, authorized user, shared hierarchy, custom roles and task
  types; spaces (create like another, update, get, list), space tags; folders (create, rename,
  move across spaces and back); lists (both parents, content-only update keeping the name); tasks
  (create with every shorthand, subtasks, update incl. `priority: null`, get, list, filter,
  move, add to a second list); tags; dependencies and links; checklists and items; task, list,
  view and threaded comments; views at list, folder, space and workspace level, view tasks;
  time entries (create, update, get, history, tags add and rename, timer start and stop) and
  legacy tracked time; goals and key results; webhooks; attachments (v2 upload, v3 upload with
  rename, v3 list); chat (location channel, update, members, followers, message, edit, reply,
  reaction, lists); ACL (space private and back); docs search; templates and custom field lists.
- **Refused by the plan** (the tool works; ClickUp says the plan lacks it): `get_time_in_status`,
  `get_bulk_time_in_status` (empty), `get_user` (Enterprise), `query_audit_logs`.
- **Refused for this workspace by ClickUp, from this server and the claude.ai connector alike**:
  `create_doc` (`403 EXTRA_AUTHZ_002`), so the doc page tools are unexercised.
- **Answered "Invalid Request"** with the spec's exact body: `update_time_estimates_by_user`,
  `replace_time_estimates_by_user`. Likely a ClickApp or plan setting; not resolved.
- **Not run, by design** (they email people or change who can see what): invites, guest and user
  edits, user groups.
- **Left in the workspace by the test**: time-entry tags `mcp-time-tag` and `mcp-time-tag-3` (no
  endpoint deletes one).
- **Not run for lack of objects**: custom field values (no fields exist and the API can't create
  one), `*_from_template` (no templates).

## License

MIT. See [LICENSE](LICENSE).
