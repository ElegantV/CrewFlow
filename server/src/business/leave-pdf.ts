import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
import { config } from "../config.js";

export type LeavePdfData = {
  applicantName: string;
  agentName: string;
  leaveTypeLabel: string;
  startDate: string;
  endDate: string;
  startPeriod: "morning" | "afternoon" | "day";
  endPeriod: "morning" | "afternoon" | "day";
  requestedDays: number;
  approvalText: string;
  approvalComment: string | null;
  approverName: string;
  decidedAt: string;
  signatureData: Buffer;
};

const PAGE_WIDTH = 753.133;
const PAGE_HEIGHT = 592.27;

function resolveFont() {
  if (config.PDF_FONT_PATH) {
    if (!existsSync(config.PDF_FONT_PATH)) {
      throw new Error(`PDF_FONT_PATH does not exist: ${config.PDF_FONT_PATH}`);
    }
    return { path: config.PDF_FONT_PATH, family: config.PDF_FONT_FAMILY || undefined };
  }

  const candidates = [
    { path: "/System/Library/Fonts/Hiragino Sans GB.ttc", family: "HiraginoSansGB-W3" },
    { path: "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc", family: "NotoSansCJKsc-Regular" },
    { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "NotoSansCJKsc-Regular" },
    { path: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", family: "WenQuanYiZenHei" },
  ];
  const found = candidates.find((candidate) => existsSync(candidate.path));
  if (!found) {
    throw new Error("未找到中文 PDF 字体，请设置 PDF_FONT_PATH");
  }
  return found;
}

function compactNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function slashDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${year}/${Number(month)}/${Number(day)}`;
}

function chineseDate(value: string) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")} 年 ${part("month")} 月 ${part("day")} 日`;
}

function startTime(period: LeavePdfData["startPeriod"]) {
  return period === "afternoon" ? "13:30" : "08:30";
}

function endTime(period: LeavePdfData["endPeriod"]) {
  return period === "morning" ? "12:00" : "17:30";
}

export async function renderLeavePdf(data: LeavePdfData) {
  const doc = new PDFDocument({
    autoFirstPage: false,
    compress: true,
    info: { Title: `${data.applicantName}请假单`, Author: "CrewFlow" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.addPage({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 0 });
  const font = resolveFont();
  doc.registerFont("CJK", font.path, font.family);
  doc.font("CJK");
  doc.lineWidth(0.6).strokeColor("#111111").fillColor("#111111");

  const cell = (
    x: number,
    y: number,
    width: number,
    height: number,
    text: string,
    options: { fontSize?: number; align?: "left" | "center" | "right"; padding?: number } = {},
  ) => {
    const padding = options.padding ?? 3;
    const fontSize = options.fontSize ?? 9;
    doc.rect(x, y, width, height).stroke();
    doc.fontSize(fontSize);
    const textWidth = Math.max(1, width - padding * 2);
    const textHeight = doc.heightOfString(text, { width: textWidth, align: options.align ?? "center" });
    const textY = y + Math.max(padding, (height - textHeight) / 2);
    doc.text(text, x + padding, textY, {
      width: textWidth,
      height: Math.max(1, height - padding * 2),
      align: options.align ?? "center",
      lineGap: 0,
    });
  };

  const x = 54;
  const top = 72;
  const widths = [22, 65, 42, 65, 45, 44, 63, 43, 141, 39, 76];
  const positions = [x];
  for (const width of widths) positions.push(positions[positions.length - 1]! + width);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);

  cell(x, top, totalWidth, 41, "科技开发与运行中心华银数科员工请假、调休、公出审批表", { fontSize: 15 });

  const infoY = top + 41;
  cell(positions[0]!, infoY, widths[0]!, 35, "公司\n名称", { fontSize: 6.8, padding: 1 });
  cell(positions[1]!, infoY, positions[5]! - positions[1]!, 35, config.PDF_COMPANY_NAME, { fontSize: 9 });
  cell(positions[5]!, infoY, widths[5]!, 35, "项目组", { fontSize: 8 });
  cell(positions[6]!, infoY, widths[6]!, 35, config.PDF_PROJECT_TEAM, { fontSize: 8 });
  cell(positions[7]!, infoY, widths[7]!, 35, "姓名", { fontSize: 8 });
  cell(positions[8]!, infoY, widths[8]!, 35, data.applicantName, { fontSize: 9 });
  cell(positions[9]!, infoY, widths[9]!, 35, "工作代\n理人", { fontSize: 8 });
  cell(positions[10]!, infoY, widths[10]!, 35, data.agentName, { fontSize: 9 });

  const headerY = infoY + 35;
  cell(positions[0]!, headerY, widths[0]!, 36, "未出\n勤原\n因", { fontSize: 6.5, padding: 1 });
  cell(positions[1]!, headerY, positions[3]! - positions[1]!, 36, "起始日期\n（某月某日上午/下午）", { fontSize: 8 });
  cell(positions[3]!, headerY, positions[5]! - positions[3]!, 36, "结束日期\n（某月某日上午/下午）", { fontSize: 8 });
  cell(positions[5]!, headerY, widths[5]!, 36, "累计时间\n（天或小时）", { fontSize: 7.5 });
  cell(positions[6]!, headerY, widths[6]!, 36, "地点", { fontSize: 8 });
  cell(positions[7]!, headerY, widths[7]!, 36, "对方单位", { fontSize: 7.5 });
  cell(positions[8]!, headerY, widths[8]!, 36, "事由", { fontSize: 9 });
  cell(positions[9]!, headerY, widths[9]!, 36, "对方\n联系人", { fontSize: 7.5 });
  cell(positions[10]!, headerY, widths[10]!, 36, "对方\n联系电话", { fontSize: 7.5 });

  const bodyY = headerY + 36;
  const bodyHeight = 228;
  cell(positions[0]!, bodyY, widths[0]!, bodyHeight, data.leaveTypeLabel, { fontSize: 8 });
  cell(positions[1]!, bodyY, widths[1]!, bodyHeight, slashDate(data.startDate), { fontSize: 8 });
  cell(positions[2]!, bodyY, widths[2]!, bodyHeight, startTime(data.startPeriod), { fontSize: 8 });
  cell(positions[3]!, bodyY, widths[3]!, bodyHeight, slashDate(data.endDate), { fontSize: 8 });
  cell(positions[4]!, bodyY, widths[4]!, bodyHeight, endTime(data.endPeriod), { fontSize: 8 });
  cell(positions[5]!, bodyY, widths[5]!, bodyHeight, `${compactNumber(data.requestedDays)} / 天`, { fontSize: 8 });
  cell(positions[6]!, bodyY, widths[6]!, bodyHeight, config.PDF_WORK_LOCATION, { fontSize: 9 });
  cell(positions[7]!, bodyY, widths[7]!, bodyHeight, "", { fontSize: 8 });
  cell(positions[8]!, bodyY, widths[8]!, bodyHeight, data.approvalText, {
    fontSize: data.approvalText.length > 170 ? 7 : data.approvalText.length > 110 ? 7.8 : 8.5,
    padding: 6,
  });
  cell(positions[9]!, bodyY, widths[9]!, bodyHeight, "", { fontSize: 8 });
  cell(positions[10]!, bodyY, widths[10]!, bodyHeight, "", { fontSize: 8 });

  const opinionY = bodyY + bodyHeight;
  const opinionHeight = 95;
  cell(positions[0]!, opinionY, widths[0]!, opinionHeight, "审核\n意见", { fontSize: 8 });
  cell(positions[1]!, opinionY, totalWidth - widths[0]!, opinionHeight, "", { fontSize: 8 });
  doc.fontSize(9).text("所在公司负责人意见：", positions[1]! + 84, opinionY + 16);
  doc.fontSize(9).text("项目组负责人意见：", positions[7]! + 34, opinionY + 16);
  doc.fontSize(8).text(data.approvalComment || "同意", positions[7]! + 34, opinionY + 33, { width: 95 });
  doc.image(data.signatureData, positions[9]! - 5, opinionY + 27, {
    fit: [95, 38],
    align: "center",
    valign: "center",
  });
  doc.fontSize(7.5).text(data.approverName, positions[9]! + 7, opinionY + 64, { width: 62, align: "center" });
  const approvalDate = chineseDate(data.decidedAt);
  doc.fontSize(8).text(approvalDate, positions[3]! - 12, opinionY + 77, { width: 115, align: "center" });
  doc.fontSize(8).text(approvalDate, positions[9]! - 8, opinionY + 77, { width: 115, align: "center" });

  const noteY = opinionY + opinionHeight;
  cell(x, noteY, totalWidth, 13, "备注：除审核意见栏外，其余项目均须打印，手填无效。", { fontSize: 7.5, align: "left" });

  doc.end();
  return completed;
}
