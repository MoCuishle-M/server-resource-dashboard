import type { State, WeeklyPlan } from "./types";
import { tableAllocations, tableDemands, tableRows } from "./weekly-table";
import { weeklyPlanRange } from "./schedule";
import { chinaStamp, demandAssigned, workspaceCapacity } from "./weekly-workspace";
export async function exportWeeklyWorkbook(s: State, p: WeeklyPlan) {
  const ExcelJS = await import("exceljs"), workbook = new ExcelJS.default.Workbook();
  if (p.v2) {
    const w = p.v2, group = (id: string) => s.groups.find(g => g.id === id)?.name ?? id;
    const sheet = (title: string, headers: string[]) => { const sh = workbook.addWorksheet(title); sh.columns = headers.map(header => ({ header, width: /事项|时段|用途|IP|说明/.test(header) ? 38 : 20 })); return sh; };
    const day = sheet("白天分配", ["周起始日期", "状态", "机柜", "服务器", "IP", "上周归属", "本周归属", "变化", "使用事项", "特殊用途", "排期开始", "排期结束"]);
    for (const row of w.sections.day.rows) {
      const r = s.resources.find(r => r.id === row.resourceId && !r.hidden && !r.deleted); if (!r) continue;
      const previous = w.previousRows.find(x => x.resourceId === r.id)?.assignments ?? [], before = previous.map(x => x.groupId).sort().join(","), after = row.assignments.map(x => x.groupId).sort().join(",");
      day.addRow([p.weekStart, w.sections.day.status, r.rack, r.name, r.ip, previous.map(x => group(x.groupId)).join("、"), row.assignments.map(x => group(x.groupId)).join("、"), before === after ? "沿用" : !before ? "新增" : !after ? "释放" : "换组", row.assignments.map(x => `${group(x.groupId)}：${x.purpose}`).join("\n"), row.specialNote, chinaStamp(w.startAt), chinaStamp(p.endAt!)]);
    }
    const dayDemands = sheet("白天需求", ["组别", "事项", "申请人", "申请总台数", "协商台数", "可共用台数", "同柜数量", "已分配", "缺口", "模型", "要求"]);
    for (const d of w.sections.day.demands) { const n = demandAssigned(w.sections.day, d).length; dayDemands.addRow([group(d.groupId), d.title, d.applicantName, d.desired, d.negotiated ?? null, d.shareCount, d.sameRackCount, n, d.negotiated === undefined ? null : Math.max(0, d.negotiated - n), d.model, d.requirements]); }
    const demands = sheet("多机需求", ["组别", "事项", "申请人", "时段", "开始时间", "结束时间", "申请总台数", "协商台数", "同批连续使用", "同柜数量", "模型", "要求", "已分配", "缺口"]);
    const allocations = sheet("多机分配", ["时段", "开始时间", "结束时间", "机柜", "服务器", "IP", "组别", "事项", "锁定"]);
    const sec = w.sections.multi;
    for (const d of sec.demands) for (const id of d.slotIds) { const slot = w.slots.find(x => x.id === id); if (!slot) continue; const n = demandAssigned(sec, d, id).length; demands.addRow([group(d.groupId), d.title, d.applicantName, slot.label, chinaStamp(slot.startAt), chinaStamp(slot.endAt), d.desired, d.negotiated ?? null, d.continuous ? "是" : "否", d.sameRackCount, d.model, d.requirements, n, d.negotiated === undefined ? null : Math.max(0, d.negotiated - n)]); }
    for (const a of sec.allocations) { const slot = w.slots.find(x => x.id === a.slotId), d = sec.demands.find(x => x.id === a.demandId); if (!slot || !d) continue; for (const id of a.resourceIds) { const r = s.resources.find(r => r.id === id && !r.hidden && !r.deleted); if (r) allocations.addRow([slot.label, chinaStamp(slot.startAt), chinaStamp(slot.endAt), r.rack, r.name, r.ip, group(d.groupId), d.title, a.locked ? "是" : "否"]); } }
    const capacity = sheet("时段容量", ["时段", "开放多机", "池总量", "不可调配", "可调配", "申请总量", "申请超额", "协商总量", "协商后余量", "协商超额", "已分配", "分配后剩余", "待协商项数"]);
    for (const slot of w.slots) { const c = workspaceCapacity(s, p, slot); capacity.addRow([slot.label, slot.enabled ? "是" : "否（沿用白天）", c.total, c.unavailable, c.available, c.requested, c.requestExcess, c.negotiated, c.negotiatedRemaining, c.excess, c.assigned, c.remaining, c.pending]); }
    const notes = sheet("发布与使用说明", ["项目", "内容"]);
    notes.addRows([["白天草稿状态", w.sections.day.status], ["白天线上版本", w.sections.day.published ? chinaStamp(w.sections.day.published.publishedAt) : "尚未发布"], ["多机草稿状态", sec.status], ["多机线上版本", sec.published ? chinaStamp(sec.published.publishedAt) : "尚未发布"], ["数量口径", "需求台数包含常态机；容量按物理服务器去重。"], ["优先级说明", w.priorityNote], ["释放记录", `${w.suppressions.length}项；实际生效结果见网站使用排期。`]]);
    for (const sh of workbook.worksheets) { sh.views = [{ state: "frozen", ySplit: 1 }]; sh.autoFilter = { from: { row: 1, column: 1 }, to: { row: sh.rowCount, column: sh.columnCount } }; sh.eachRow((row, index) => { row.alignment = { vertical: "middle", wrapText: true }; row.height = index === 1 ? 32 : 64; }); sh.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; sh.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF354F65" } }; }
    const bytes = await workbook.xlsx.writeBuffer(), url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a"); link.href = url; link.download = `${p.weekStart}蓝区A5双流程排期.xlsx`; link.click(); URL.revokeObjectURL(url); return;
  }
  const name = (id: string) => s.groups.find(g => g.id === id)?.name ?? id;
  const schedule = workbook.addWorksheet("服务器预排期"), demands = workbook.addWorksheet("需求收集");
  schedule.columns = ["周起始日期", "区域", "柜号", "服务器类型", "使用方式", "服务器名称", "OS/IP", "使用组别", "使用用途", "特殊用途", "状态"].map((header, i) => ({ header, width: [16, 12, 20, 28, 12, 28, 20, 28, 40, 64, 20][i] }));
  for (const row of tableRows(s, p)) {
    const r = s.resources.find(r => r.id === row.resourceId && !r.hidden && !r.deleted); if (!r) continue;
    schedule.addRow([p.weekStart, r.zone === "green" ? "绿区" : r.zone === "blue" ? "蓝区" : "未登记", r.rack || "", r.type, r.accessMode === "bare" ? "裸机" : "灵枢", r.name, r.ip, row.assignments.map(a => name(a.groupId)).join(" / "), row.assignments.map(a => `${name(a.groupId)}：${a.purpose}`).join("\n"), row.specialNote, p.clearedResourceIds?.includes(r.id) ? "未来排期已清空" : p.status === "published" ? "已发布" : "预排期"]);
  }
  schedule.getColumn(12).header = "排期结束时间（北京时间）";
  schedule.getColumn(12).width = 28;
  for (let row = 2; row <= schedule.rowCount; row++) schedule.getCell(row, 12).value = new Date(Date.parse(weeklyPlanRange(p).endAt) + 28800000).toISOString().slice(0, 16).replace("T", " ");
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
