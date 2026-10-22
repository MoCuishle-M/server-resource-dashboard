import { lingshuStatusLabels } from "./lingshu";
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
export type ResourceImportRow = {
  ip: string;
  name?: string;
  type?: string;
  accessMode?: string;
  lingshuStatus?: string;
  sharingMode?: string;
  location?: string;
  note?: string;
  faultDescription?: string;
  status?: string;
  hidden?: boolean;
};
export function resourceTableRows(
  input: string[][],
  mode: "add" | "update" = "add",
): ResourceImportRow[] {
  const table = input.filter((row) => row.some((cell) => cell.trim()));
  if (table.length < 2) throw new Error("请包含表头和至少一行数据");
  if (table.length > 201) throw new Error("每批最多200行，请分批导入");
  const aliases: Record<string, string[]> = {
    name: ["名称", "服务器名称", "name"],
    type: ["类型", "服务器类型", "type"],
    ip: ["ip", "IP", "IP地址"],
    accessMode: ["使用方式", "accessMode", "使用模式"],
    lingshuStatus: ["灵枢平台状态", "平台状态", "lingshuStatus"],
    sharingMode: ["占用模式", "共享模式", "sharingMode"],
    location: ["位置", "机房", "location"],
    note: ["备注", "note"],
    faultDescription: ["故障说明", "故障原因", "faultDescription"],
    status: ["状态", "资源状态", "status"],
    hidden: ["隐藏", "是否隐藏", "仅管理员可见", "hidden"],
  };
  const header = table[0].map((h) => h.replace(/^\uFEFF/, "").trim());
  const index = Object.fromEntries(
    Object.entries(aliases).map(([key, names]) => {
      const matches = header.flatMap((h, i) => (names.includes(h) ? [i] : []));
      if (matches.length > 1) throw new Error(`表头重复：${names[0]}`);
      return [key, matches[0] ?? -1];
    }),
  );
  for (const key of mode === "add"
    ? ["name", "type", "ip", "accessMode"]
    : ["ip"])
    if (index[key] < 0) throw new Error(`缺少列：${aliases[key][0]}`);
  const access: Record<string, string> = {
    裸机: "bare",
    bare: "bare",
    通过裸机使用: "bare",
    灵枢: "lingshu",
    灵枢平台: "lingshu",
    lingshu: "lingshu",
    通过灵枢平台使用: "lingshu",
  };
  const sharing: Record<string, string> = {
    独占: "exclusive",
    exclusive: "exclusive",
    共享: "shared",
    shared: "shared",
  };
  const status: Record<string, string> = {
    可申请: "available",
    可用: "available",
    available: "available",
    维护中: "maintenance",
    maintenance: "maintenance",
    不可用: "unavailable",
    unavailable: "unavailable",
    故障: "fault",
    故障中: "fault",
    fault: "fault",
  };
  const lingshu: Record<string, string> = Object.fromEntries(
    Object.entries(lingshuStatusLabels).flatMap(([key, label]) => [[key, key], [label, key]]),
  );
  return table.slice(1).map((row, i) => {
    const get = (key: string) => (row[index[key]] ?? "").trim();
    const out: Record<string, string | boolean> = { ip: get("ip") };
    if (!out.ip) throw new Error(`第${i + 2}行：IP不能为空`);
    for (const key of Object.keys(aliases).filter((k) => k !== "ip")) {
      const value = get(key);
      if (mode === "update" && !value) continue;
      if (key === "accessMode") {
        if (!access[value])
          throw new Error(`第${i + 2}行：使用方式应为“裸机”或“灵枢平台”`);
        out[key] = access[value];
      } else if (key === "lingshuStatus") {
        if (!value) continue;
        if (!Object.hasOwn(lingshu, value)) throw new Error(`第${i + 2}行：灵枢平台状态不正确`);
        out[key] = lingshu[value];
      } else if (key === "sharingMode") {
        if (value && !sharing[value])
          throw new Error(`第${i + 2}行：占用模式应为“独占”或“共享”`);
        out[key] = sharing[value] ?? "exclusive";
      } else if (key === "status") {
        if (value && Object.hasOwn(lingshu, value)) {
          if (out.lingshuStatus && out.lingshuStatus !== lingshu[value]) throw new Error(`第${i + 2}行：状态与灵枢平台状态不一致`);
          out.lingshuStatus = lingshu[value];
          if (mode === "add") out.status = "available";
          continue;
        }
        if (value && !status[value])
          throw new Error(`第${i + 2}行：状态应为“可申请”、“维护中”、“不可用”或“故障中”`);
        out[key] = status[value] ?? "available";
      } else if (key === "faultDescription") {
        if (value) out[key] = value;
      } else if (key === "hidden") {
        if (!value && mode === "add") continue;
        if (["是", "隐藏", "仅管理员", "true", "1"].includes(value)) out.hidden = true;
        else if (["否", "公开", "显示", "false", "0"].includes(value)) out.hidden = false;
        else throw new Error(`第${i + 2}行：隐藏应填写“是”或“否”`);
      } else out[key] = value;
    }
    if (out.accessMode === "bare" && out.lingshuStatus) throw new Error(`第${i + 2}行：裸机不能填写灵枢平台状态`);
    if (mode === "update" && Object.keys(out).length === 1)
      throw new Error(`第${i + 2}行：除IP外至少填写一个要更新的字段`);
    return out as ResourceImportRow;
  });
}
export function importRows(input: string, mode: "add" | "update" = "add") {
  return resourceTableRows(parseTable(input), mode);
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
