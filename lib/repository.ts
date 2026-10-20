import type { State } from "./types";
import { emptyState, DomainError } from "./domain";
const tables = [
  "resources",
  "groups",
  "accounts",
  "requests",
  "bookings",
  "audits",
] as const;
export async function loadState(db: D1Database): Promise<State> {
  const results = await db.batch([
    db.prepare("SELECT revision FROM meta WHERE id='main'"),
    ...tables.map((t) => db.prepare(`SELECT payload FROM ${t}`)),
  ]);
  const s = emptyState();
  s.revision =
    (results[0].results[0] as { revision?: number } | undefined)?.revision ?? 0;
  tables.forEach((t, i) => {
    const rows = results[i + 1].results as { payload: string }[];
    if (rows.length || t !== "groups")
      (s[t] as unknown[]) = rows.map((r) => JSON.parse(r.payload));
  });
  s.audits.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return s;
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
              `INSERT INTO ${t}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
            )
            .bind(row.id, data),
        );
    }
  }
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
