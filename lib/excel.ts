import { resourceTableRows, type ResourceImportRow } from "./csv";
export type ImportWorkbook = { name: string; rows: string[][] }[];
export async function readResourceWorkbook(
  data: ArrayBuffer,
): Promise<ImportWorkbook> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  try {
    await workbook.xlsx.load(data);
  } catch {
    throw new Error(
      "无法读取 Excel，请使用有效的 .xlsx 文件；加密文件请先另存为普通工作簿。",
    );
  }
  const sheets: ImportWorkbook = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.state !== "visible") continue;
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      if (rows.length >= 202)
        throw new Error(`工作表“${sheet.name}”超过200条数据，请分批导入`);
      if (row.cellCount > 50)
        throw new Error("表格列数过多，请只保留资源信息列");
      const cells: string[] = [];
      for (let i = 1; i <= row.cellCount; i++) {
        const cell = row.getCell(i);
        if (cell.type === ExcelJS.default.ValueType.Formula)
          throw new Error(`工作表“${sheet.name}”包含公式，请粘贴为纯值后导入`);
        cells.push(cell.text.trim());
      }
      if (cells.some(Boolean)) rows.push(cells);
    });
    if (rows.length) sheets.push({ name: sheet.name, rows });
  }
  if (!sheets.length) throw new Error("Excel没有可导入的可见工作表");
  return sheets;
}
export const workbookResourceRows = (
  sheet: ImportWorkbook[number],
  mode: "add" | "update" = "add",
): ResourceImportRow[] => resourceTableRows(sheet.rows, mode);
export async function downloadResourceTemplate() {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  const sheet = workbook.addWorksheet("服务器资源");
  sheet.columns = [
    { header: "名称", key: "name", width: 26 },
    { header: "类型", key: "type", width: 28 },
    { header: "IP", key: "ip", width: 20 },
    { header: "使用方式", key: "accessMode", width: 16 },
    { header: "占用模式", key: "sharingMode", width: 14 },
    { header: "位置", key: "location", width: 20 },
    { header: "备注", key: "note", width: 30 },
    { header: "状态", key: "status", width: 14 },
    { header: "故障说明", key: "faultDescription", width: 40 },
    { header: "灵枢平台状态", key: "lingshuStatus", width: 38 },
    { header: "隐藏", key: "hidden", width: 18 },
  ];
  sheet.addRow({
    name: "Atlas-示例-01",
    type: "Ascend 910B · 8卡",
    ip: "192.0.2.10",
    accessMode: "裸机",
    sharingMode: "独占",
    location: "机房A",
    note: "请替换示例内容",
    status: "可申请",
    hidden: "否",
  });
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const bytes = await workbook.xlsx.writeBuffer();
  const blob = new Blob([bytes as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "服务器导入模板.xlsx";
  a.click();
  URL.revokeObjectURL(url);
}
