export function parseTable(input: string) {
  const delimiter = input.split(/\r?\n/)[0]?.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  const data = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '"') {
      if (quoted && data[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && ch === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && data[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("存在未闭合的引号");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
export function importRows(input: string) {
  const table = parseTable(input);
  if (table.length < 2) throw new Error("请包含表头和至少一行数据");
  const aliases: Record<string, string[]> = {
    name: ["名称", "服务器名称", "name"],
    type: ["类型", "服务器类型", "type"],
    ip: ["ip", "IP", "IP地址"],
    accessMode: ["使用方式", "accessMode", "使用模式"],
    sharingMode: ["占用模式", "共享模式", "sharingMode"],
    location: ["位置", "机房", "location"],
    note: ["备注", "note"],
  };
  const header = table[0];
  const index = Object.fromEntries(
    Object.entries(aliases).map(([key, names]) => [
      key,
      header.findIndex((h) => names.includes(h)),
    ]),
  );
  for (const key of ["name", "type", "ip", "accessMode"])
    if (index[key] < 0) throw new Error(`缺少列：${aliases[key][0]}`);
  return table.slice(1).map((r, i) => {
    const get = (key: string) => r[index[key]] ?? "";
    let mode = get("accessMode");
    if (["裸机", "bare", "通过裸机使用"].includes(mode)) mode = "bare";
    else if (["灵枢", "灵枢平台", "lingshu", "通过灵枢平台使用"].includes(mode))
      mode = "lingshu";
    else throw new Error(`第${i + 2}行：使用方式应为“裸机”或“灵枢平台”`);
    const sharing = get("sharingMode");
    let sharingMode = "exclusive";
    if (["共享", "shared"].includes(sharing)) sharingMode = "shared";
    else if (!["", "独占", "exclusive"].includes(sharing))
      throw new Error(`第${i + 2}行：占用模式应为“独占”或“共享”`);
    return {
      sharingMode,
      name: get("name"),
      type: get("type"),
      ip: get("ip"),
      accessMode: mode,
      location: get("location"),
      note: get("note"),
      status: "available",
    };
  });
}
export function csvCell(v: unknown) {
  let s = String(v ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export function downloadCSV(filename: string, rows: unknown[][]) {
  const blob = new Blob(
    ["\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
