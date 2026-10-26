import type { State, WeeklyPlan } from "./types";
import { tableAllocations, tableDemands, tableRows } from "./weekly-table";
export async function exportWeeklyWorkbook(s: State, p: WeeklyPlan) {
  const ExcelJS = await import("exceljs"), workbook = new ExcelJS.default.Workbook();
  const name = (id: string) => s.groups.find(g => g.id === id)?.name ?? id;
  const schedule = workbook.addWorksheet("服务器预排期"), demands = workbook.addWorksheet("需求收集");
  schedule.columns = ["周起始日期", "区域", "柜号", "服务器类型", "使用方式", "服务器名称", "OS/IP", "使用组别", "使用用途", "特殊用途", "状态"].map((header, i) => ({ header, width: [16, 12, 20, 28, 12, 28, 20, 28, 40, 64, 20][i] }));
  for (const row of tableRows(s, p)) {
    const r = s.resources.find(r => r.id === row.resourceId && !r.hidden && !r.deleted); if (!r) continue;
    schedule.addRow([p.weekStart, r.zone === "green" ? "绿区" : r.zone === "blue" ? "蓝区" : "未登记", r.rack || "", r.type, r.accessMode === "bare" ? "裸机" : "灵枢", r.name, r.ip, row.assignments.map(a => name(a.groupId)).join(" / "), row.assignments.map(a => `${name(a.groupId)}：${a.purpose}`).join("\n"), row.specialNote, p.clearedResourceIds?.includes(r.id) ? "未来排期已清空" : p.status === "published" ? "已发布" : "预排期"]);
  }
  demands.columns = ["周起始日期", "使用用途", "组名", "申请人", "服务器类型", "使用方式", "理想数量", "协商后数量", "支持共用数量", "同柜数量要求", "需要同柜的组", "其他要求", "已分配数量", "已分配IP"].map((header, i) => ({ header, width: [16, 40, 24, 18, 28, 12, 14, 16, 18, 18, 30, 56, 16, 48][i] }));
  const allocations = tableAllocations(s, p);
  for (const d of tableDemands(s, p)) for (const l of d.lines) {
    const a = allocations.find(a => a.demandId === d.id && a.lineId === l.id);
    demands.addRow([p.weekStart, d.title, name(d.groupId), d.applicantName || "", l.resourceType ?? `${l.zone === "green" ? "绿区" : "蓝区"} ${l.family}`, l.accessMode === "bare" ? "裸机" : "灵枢", l.desired, l.negotiated ?? null, l.shareCount, l.sameRackCount ?? 0, (l.sameRackGroupIds ?? []).map(name).join(" / "), l.requirements || "", a?.resourceIds.length ?? 0, a?.resourceIds.map(id => s.resources.find(r => r.id === id)?.ip).filter(Boolean).join("\n") ?? ""]);
  }
  for (const sheet of [schedule, demands]) {
    sheet.views = [{ state: "frozen", ySplit: 1 }]; sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
    sheet.eachRow(row => { row.alignment = { vertical: "middle", wrapText: true }; let lines = 1;
      row.eachCell((cell, col) => { const width = Math.max(5, (sheet.getColumn(col).width ?? 15) - 2); lines = Math.max(lines, cell.text.split("\n").reduce((total, text) => total + Math.max(1, Math.ceil([...text].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0) / width)), 0)); });
      row.height = Math.max(28, Math.min(400, lines * 17 + 10));
    });
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF354F65" } };
  }
  const bytes = await workbook.xlsx.writeBuffer(), url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a"); a.href = url; a.download = `${p.weekStart}周需求与排期.xlsx`; a.click(); URL.revokeObjectURL(url);
}
