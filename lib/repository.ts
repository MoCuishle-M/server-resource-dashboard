import type { State } from "./types";
import { emptyState, DomainError } from "./domain";
import { platformGroup, PLATFORM_GROUP_ID } from "./lingshu";
import { currentGroupContacts } from "./group-contact";
const tables = [
  "resources",
  "groups",
  "accounts",
  "requests",
  "bookings",
  "audits",
  "invitations",
  "weeklyPlans",
  "weeklyDemands",
] as const;
const tableName = (name: typeof tables[number]) => (name === "invitations" ? "admin_invitations" : name === "weeklyPlans" ? "weekly_plans" : name === "weeklyDemands" ? "weekly_demands" : name);
export async function loadState(db: D1Database): Promise<State> {
  const results = await db.batch([
    db.prepare("SELECT revision FROM meta WHERE id='main'"),
    ...tables.map((t) => db.prepare(`SELECT payload FROM ${tableName(t)}`)),
    db.prepare("SELECT payload FROM site_settings WHERE id='main'"),
  ]);
  const s = emptyState();
  s.revision =
    (results[0].results[0] as { revision?: number } | undefined)?.revision ?? 0;
  tables.forEach((t, i) => {
    const rows = results[i + 1].results as { payload: string }[];
    if (rows.length || t !== "groups")
      (s[t] as unknown[]) = rows.map((r) => JSON.parse(r.payload));
  });
  if (!s.groups.some(g => g.id === PLATFORM_GROUP_ID)) s.groups.push(platformGroup());
  s.groups = currentGroupContacts(s);
  const settingsRow = results[tables.length + 1].results[0] as { payload: string } | undefined;
  if (settingsRow) s.settings = { ...s.settings, ...JSON.parse(settingsRow.payload) };
  s.resources = s.resources.map((r) => ({
    ...r,
    sharingMode: r.sharingMode ?? "exclusive",
    ...(r.accessMode === "lingshu" ? { lingshuStatus: r.lingshuStatus ?? "platform" } : {}),
  }));
  s.audits.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return s;
}

export async function loadCurrentUseState(db: D1Database, userId: string | null, email: string | null, since: string): Promise<State> {
  const [resources, groups, accounts, invitations, requests, bookings] = await db.batch<{ payload: string }>([
    db.prepare("SELECT payload FROM resources"),
    db.prepare("SELECT payload FROM groups"),
    db.prepare("SELECT payload FROM accounts WHERE json_extract(payload, '$.userId') = ?").bind(userId),
    db.prepare("SELECT payload FROM admin_invitations WHERE json_extract(payload, '$.status') = 'pending' AND json_extract(payload, '$.email') = ?")
      .bind(email),
    db.prepare(`SELECT json_object('id', id,
      'weeklySection', json_extract(payload, '$.weeklySection'),
      'sourceRequestId', json_extract(payload, '$.sourceRequestId')) AS payload FROM requests`),
    db.prepare("SELECT payload FROM bookings WHERE julianday(json_extract(payload, '$.endAt')) > julianday(?)").bind(since),
  ]);
  const state = emptyState();
  state.resources = resources.results.map(row => JSON.parse(row.payload));
  if (groups.results.length) state.groups = groups.results.map(row => JSON.parse(row.payload));
  if (!state.groups.some(group => group.id === PLATFORM_GROUP_ID)) state.groups.push(platformGroup());
  state.accounts = accounts.results.map(row => JSON.parse(row.payload));
  state.invitations = invitations.results.map(row => JSON.parse(row.payload));
  state.requests = requests.results.map(row => JSON.parse(row.payload));
  state.bookings = bookings.results.map(row => JSON.parse(row.payload));
  return state;
}
export async function saveState(db: D1Database, before: State, after: State) {
  const guard = crypto.randomUUID();
  const statements = [
    db
      .prepare(
        "INSERT INTO guards(id,valid) VALUES(?, COALESCE((SELECT revision FROM meta WHERE id='main'),0)=?)",
      )
      .bind(guard, before.revision),
  ];
  for (const t of tables) {
    const old = new Map(before[t].map((x) => [x.id, JSON.stringify(x)]));
    for (const row of after[t]) {
      const data = JSON.stringify(row);
      if ((t === "groups" && before.revision === 0) || old.get(row.id) !== data)
        statements.push(
          db
            .prepare(
              `INSERT INTO ${tableName(t)}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
            )
            .bind(row.id, data),
        );
    }
  }
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings))
    statements.push(db.prepare("INSERT INTO site_settings(id,payload) VALUES('main',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").bind(JSON.stringify(after.settings)));
  statements.push(
    db
      .prepare(
        "INSERT INTO meta(id,revision) VALUES('main',?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
      )
      .bind(after.revision),
  );
  statements.push(db.prepare("DELETE FROM guards WHERE id=?").bind(guard));
  try {
    await db.batch(statements);
  } catch (e) {
    if (
      String(e).includes("valid_revision") ||
      String(e).includes("CHECK constraint")
    )
      throw new DomainError(
        409,
        "数据刚刚发生变化，请刷新后重试；本次操作未写入",
      );
    throw e;
  }
}
