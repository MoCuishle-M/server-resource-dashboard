"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  Activity,
  Megaphone,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Clock3,
  Copy,
  Database,
  Filter,
  History,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  LogOut,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
  AlertTriangle,
  Pencil,
  ExternalLink,
  CheckCircle2,
} from "lucide-react";
import {
  activeBookings,
  approvalConflicts,
  currentResourceUsage,
  groupUsage,
  resourceSharingMode,
  chinaDate,
  emptyState,
  mutate,
  overlaps,
  priorityLabel,
  priorityRank,
  slots,
  timeRange,
} from "@/lib/domain";
import { demoState, demoAdmin, demoContact } from "@/lib/demo";
import ScheduleTimeline from "./schedule-timeline";
import type { TimelineRange } from "@/lib/schedule";
import { resourceSearch } from "@/lib/resource-search";
import { auditRange, auditTime, filterAudits, type AuditRange } from "@/lib/audit-search";
import ResourceTypeFilter from "./resource-type-filter";
import FontSizeControl from "./font-size-control";
import AdminSettings from "./admin-settings";
import { downloadCSV, importRows } from "@/lib/csv";
import {
  readResourceWorkbook,
  workbookResourceRows,
  downloadResourceTemplate,
  type ImportWorkbook,
} from "@/lib/excel";
import type {
  Action,
  Actor,
  Booking,
  Group,
  PublicState,
  Resource,
  UsageRequest,
} from "@/lib/types";

type View =
  | "overview"
  | "resources"
  | "schedule"
  | "requests"
  | "groups"
  | "history"
  | "settings";
const nav = [
  { id: "overview", label: "资源总览", icon: LayoutDashboard },
  { id: "resources", label: "服务器资源", icon: Server },
  { id: "schedule", label: "使用排期", icon: CalendarDays },
  { id: "requests", label: "申请与审批", icon: ClipboardList },
  { id: "groups", label: "团队与接口人", icon: Users },
  { id: "history", label: "变更历史", icon: History },
  { id: "settings", label: "网站设置", icon: Settings2 },
] as const;
const titles: Record<View, { title: string; sub: string }> = {
  overview: { title: "资源总览", sub: "让每一份算力，都有清晰的去向。" },
  resources: { title: "服务器资源", sub: "统一管理服务器清单与访问方式。" },
  schedule: {
    title: "使用排期",
    sub: "按时间查看资源分配，协调每个团队的计划。",
  },
  requests: {
    title: "申请与审批",
    sub: "从使用诉求到资源分配，每一步都有记录。",
  },
  groups: { title: "团队与接口人", sub: "10个团队，一个共享的资源空间。" },
  history: { title: "变更历史", sub: "每次分配、调整和释放，都有迹可循。" },
  settings: { title: "网站设置", sub: "维护公开信息与管理员权限。" },
};
const fmt = (s: string, withDate = true) =>
  s
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        ...(withDate ? { month: "2-digit", day: "2-digit" } : {}),
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(s))
    : "—";
const localInput = (s: string) =>
  new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 16);
const isoInput = (s: string) => new Date(`${s}:00+08:00`).toISOString();
const statusLabel: Record<string, string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  cancelled: "已取消",
};
function duration(start: string, end: string) {
  const h = (Date.parse(end) - Date.parse(start)) / 3600000;
  return `${Number(h.toFixed(1))}小时`;
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Database size={32} />
      <h3>{title}</h3>
      {sub && <p>{sub}</p>}
      {action}
    </div>
  );
}
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function Modal({
  title,
  sub,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    d?.showModal();
    return () => {
      d?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "modal-wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export default function Dashboard({ demo = false }: { demo?: boolean }) {
  const [s, setS] = useState<PublicState | null>(null),
    [view, setView] = useState<View>("overview"),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState("");
  const [search, setSearch] = useState(""),
    [typeFilter, setTypeFilter] = useState<string[] | null>(null),
    [modeFilter, setModeFilter] = useState(""),
    [stateFilter, setStateFilter] = useState(""),
    [groupFilter, setGroupFilter] = useState(""),
    [requestFilter, setRequestFilter] = useState("all");
  const [historyTypes, setHistoryTypes] = useState<string[] | null>(null);
  const [historyStart, setHistoryStart] = useState("");
  const [historyEnd, setHistoryEnd] = useState("");
  const [historyRange, setHistoryRange] = useState<AuditRange>({});
  const [historyError, setHistoryError] = useState("");
  const [selected, setSelected] = useState<string[]>([]),
    [modal, setModal] = useState<string | null>(null),
    [editResource, setEditResource] = useState<Resource | null>(null),
    [editGroup, setEditGroup] = useState<Group | null>(null),
    [detail, setDetail] = useState<Resource | null>(null),
    [review, setReview] = useState<UsageRequest | null>(null),
    [reviewApprove, setReviewApprove] = useState(true),
    [reviewNote, setReviewNote] = useState(""),
    [preempt, setPreempt] = useState(false),
    [cancelRequest, setCancelRequest] = useState<UsageRequest | null>(null),
    [bulkText, setBulkText] = useState(""),
    [bulkError, setBulkError] = useState(""),
    [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [bulkFields, setBulkFields] = useState<Record<string, boolean>>({});
  const [bulkValues, setBulkValues] = useState<Record<string, string>>({});
  const [importMode, setImportMode] = useState<"add" | "update">("add");
  const [workbook, setWorkbook] = useState<ImportWorkbook>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [importFileName, setImportFileName] = useState("");
  const [readingFile, setReadingFile] = useState(false);
  const [requestResources, setRequestResources] = useState<string[]>([]),
    [requestGroup, setRequestGroup] = useState("g1"),
    [requestDate, setRequestDate] = useState(chinaDate()),
    [requestSlot, setRequestSlot] = useState<number | null>(null),
    [requestStart, setRequestStart] = useState(""),
    [requestEnd, setRequestEnd] = useState(""),
    [purpose, setPurpose] = useState(""),
    [priority, setPriority] = useState("normal");
  const [clock, setClock] = useState(new Date().toISOString());
  async function refresh(initial = false) {
    try {
      if (demo) {
        if (initial) setS(demoState());
      } else {
        const r = await fetch("/api/state", { cache: "no-store" });
        const data = (await r.json()) as PublicState & { error?: string };
        if (!r.ok) throw new Error(data.error);
        setS(data);
      }
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh(true);
    const t = setInterval(() => {
      setClock(new Date().toISOString());
      if (!demo) refresh();
    }, 30000);
    return () => clearInterval(t);
  }, [demo]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setModal(null);
        setDetail(null);
        setReview(null);
        setCancelRequest(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  async function run(action: Action, message = "操作已保存") {
    if (!s || busy) return false;
    setBusy(true);
    try {
      let next: PublicState;
      if (demo) {
        next = {
          ...mutate(s, s.actor, action),
          actor: s.actor,
          now: new Date().toISOString(),
          adminConfigured: true,
          demo: true,
        };
      } else {
        const r = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...action, revision: s.revision }),
        });
        const d = (await r.json()) as PublicState & { error?: string };
        if (!r.ok) throw new Error(d.error);
        next = d;
      }
      setS(next);
      setToast(message);
      return true;
    } catch (e) {
      setToast(e instanceof Error ? e.message : "操作失败");
      if (!demo) await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const actor = s?.actor ?? {
    role: "visitor",
    groupId: "",
    userId: "",
    displayName: "访客",
    email: "",
    employeeId: "",
  };
  const admin = actor.role === "admin";
  useEffect(() => {
    if (!loading && !admin && view === "settings") setView("overview");
  }, [admin, loading, view]);
  const canApply = admin || actor.role === "contact";
  const resources = s?.resources.filter((r) => !r.deleted) ?? [],
    current = s ? activeBookings(s, clock) : [];
  const used = new Set(current.map((b) => b.resourceId));
  const available = resources.filter(
    (r) => r.status === "available" && !used.has(r.id),
  );
  const pending = s?.requests.filter((r) => r.status === "pending") ?? [];
  const resourceName = (id: string) =>
    s?.resources.find((r) => r.id === id)?.name ?? "历史资源";
  const groupName = (id: string) =>
    s?.groups.find((g) => g.id === id)?.name ?? "未分组";
  const types = [...new Set(resources.map((r) => r.type))];
  const matchesSearch = resourceSearch(search);
  const filtered = resources.filter(
    (r) =>
      matchesSearch(r) &&
      (typeFilter === null || typeFilter.includes(r.type)) &&
      (!modeFilter || r.accessMode === modeFilter) &&
      (!stateFilter ||
        (stateFilter === "used"
          ? used.has(r.id)
          : stateFilter === "free"
            ? r.status === "available" && !used.has(r.id)
            : r.status === "maintenance")) &&
      (!groupFilter ||
        current.some(
          (b) => b.resourceId === r.id && b.groupId === groupFilter,
        )),
  );
  const historyTypeOptions = [...new Set((s?.audits ?? []).map(a => a.action))];
  const visibleAudits = filterAudits(s?.audits ?? [], { types: historyTypes, search, ...historyRange });
  const orderedRequests = [...(s?.requests ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const visibleRequests = orderedRequests.filter(
    (r) =>
      (requestFilter === "all" || requestFilter === "mine"
        ? requestFilter !== "mine" || r.groupId === actor.groupId
        : r.status === requestFilter) &&
      (!groupFilter || r.groupId === groupFilter) &&
      (!search ||
        `${r.purpose} ${r.applicantName} ${groupName(r.groupId)} ${r.resourceIds.map(resourceName).join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  let parsedRows: ReturnType<typeof importRows> = [];
  let parseError = "";
  if (workbook.length || bulkText.trim()) {
    try {
      parsedRows = workbook.length
        ? workbookResourceRows(workbook[sheetIndex], importMode)
        : importRows(bulkText, importMode);
    } catch (e) {
      parseError = (e as Error).message;
    }
  }
  function navigate(v: View) {
    setView(v);
    setSearch("");
    setGroupFilter("");
    setSelected([]);
  }
  function openRequest(ids: string[] = [], range?: TimelineRange) {
    if (!canApply) {
      setModal(actor.userId ? "identity" : "login");
      return;
    }
    const start = new Date(Date.now() + 3600000);
    start.setMinutes(0, 0, 0);
    setRequestResources(ids);
    setRequestGroup(actor.groupId || "g1");
    setRequestDate(chinaDate(start));
    setRequestSlot(null);
    const startAt = range
      ? new Date(Math.max(Date.parse(range.startAt), Date.now() + 60000))
      : start;
    const endAt = new Date(Math.min(
      startAt.getTime() + 3 * 3600000,
      range ? Date.parse(range.endAt) : Infinity,
    ));
    setRequestDate(chinaDate(startAt));
    setRequestStart(localInput(startAt.toISOString()));
    setRequestEnd(localInput(endAt.toISOString()));
    setPriority("normal");
    setPurpose("");
    setModal("request");
  }
  function changeSlot(slot: number, dateValue = requestDate) {
    setRequestSlot(slot);
    const t = timeRange(dateValue, slot);
    setRequestStart(localInput(t.startAt));
    setRequestEnd(localInput(t.endAt));
  }
  function exportResources() {
    downloadCSV("服务器资源.csv", [
      ["名称", "类型", "IP", "使用方式", "占用模式", "位置", "备注"],
      ...filtered.map((r) => [
        r.name,
        r.type,
        r.ip,
        r.accessMode === "bare" ? "裸机" : "灵枢平台",
        resourceSharingMode(r) === "shared" ? "共享" : "独占",
        r.location,
        r.note,
      ]),
    ]);
  }
  const submitResource = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (
      await run(
        {
          type: "resource.save",
          id: editResource?.id,
          resource: Object.fromEntries(f),
        },
        "服务器已保存",
      )
    ) {
      setModal(null);
      setEditResource(null);
    }
  };
  const groupStats =
    s?.groups.map((g) => ({
      group: g,
      ...groupUsage(s, g.id, clock),
      future: s.bookings.filter(
        (b) =>
          b.status === "scheduled" && b.groupId === g.id && b.startAt > clock,
      ).length,
    })) ?? [];
  const conflicts = review && s ? approvalConflicts(s, review) : [];
  const showResourceTable = (limit?: number) => (
    <div className="table-scroll">
      <table className="resource-table">
        <thead>
          <tr>
            {admin && view === "resources" && (
              <th className="check-cell">
                <input
                  aria-label="全选当前结果"
                  type="checkbox"
                  checked={
                    filtered.length > 0 &&
                    filtered.every((r) => selected.includes(r.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? filtered.map((r) => r.id) : [],
                    )
                  }
                />
              </th>
            )}
            <th>服务器 / IP</th>
            <th>资源类型</th>
            <th>使用方式</th>
            <th>占用模式</th>
            <th>当前状态</th>
            <th>使用团队 / 用途</th>
            <th>释放时间</th>
            <th className="align-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {filtered.slice(0, limit).map((r) => {
            const usage = currentResourceUsage(s!, r.id, clock);
            const b = usage.bookings[0];
            return (
              <tr key={r.id}>
                {admin && view === "resources" && (
                  <td>
                    <input
                      aria-label={`选择 ${r.name}`}
                      type="checkbox"
                      checked={selected.includes(r.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, r.id]
                            : selected.filter((id) => id !== r.id),
                        )
                      }
                    />
                  </td>
                )}
                <td>
                  <button
                    className="resource-name"
                    onClick={() => setDetail(r)}
                  >
                    <span className={`server-icon ${b ? "occupied" : ""}`}>
                      <Server size={17} />
                    </span>
                    <span>
                      <strong>{r.name}</strong>
                      <small className="mono">{r.ip}</small>
                    </span>
                  </button>
                </td>
                <td>
                  <span className="type-text">{r.type}</span>
                  <small>{r.location || "未填写位置"}</small>
                </td>
                <td>
                  <Badge tone={r.accessMode === "lingshu" ? "blue" : "neutral"}>
                    {r.accessMode === "bare" ? "裸机" : "灵枢平台"}
                  </Badge>
                </td>
                <td>
                  <Badge
                    tone={
                      resourceSharingMode(r) === "shared" ? "blue" : "neutral"
                    }
                  >
                    {resourceSharingMode(r) === "shared" ? "共享" : "独占"}
                  </Badge>
                </td>
                <td>
                  <Badge
                    tone={
                      r.status === "maintenance"
                        ? "neutral"
                        : b
                          ? "orange"
                          : "green"
                    }
                  >
                    <i />
                    {r.status === "maintenance"
                      ? "维护中"
                      : b
                        ? "使用中"
                        : "空闲"}
                  </Badge>
                </td>
                <td>
                  {b ? (
                    <>
                      <span
                        className="group-label"
                        title={usage.groupIds.map(groupName).join("、")}
                      >
                        <span
                          className={`dot group-${Number(b.groupId.replace("g", "")) % 5}`}
                        />
                        {usage.groupIds.map(groupName).join("、")}
                        {usage.bookings.some(
                          (item) => item.priority !== "normal",
                        ) && <Zap size={13} className="orange-text" />}
                      </span>
                      <small
                        className="task-ellipsis"
                        title={usage.bookings
                          .map(
                            (item) =>
                              `${groupName(item.groupId)}：${item.purpose}`,
                          )
                          .join("；")}
                      >
                        {usage.bookings
                          .map(
                            (item) =>
                              `${groupName(item.groupId)}：${item.purpose}`,
                          )
                          .join("；")}
                      </small>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {b ? (
                    <>
                      <span className="mono">{fmt(usage.releaseAt!)}</span>
                      <small>
                        {usage.groupIds.length > 1
                          ? "当前占用全部结束 · 北京时间"
                          : "北京时间"}
                      </small>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="align-right">
                  <div className="row-actions">
                    <button
                      className="text-button"
                      onClick={() => setDetail(r)}
                    >
                      详情
                    </button>
                    {admin ? (
                      <button
                        className="icon-button"
                        aria-label={`编辑 ${r.name}`}
                        onClick={() => {
                          setEditResource(r);
                          setModal("resource");
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                    ) : (
                      r.status === "available" && (
                        <button
                          className="text-button orange-text"
                          onClick={() => openRequest([r.id])}
                        >
                          申请
                        </button>
                      )
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!filtered.length && (
        <Empty
          title={resources.length ? "没有符合条件的服务器" : "还没有服务器资源"}
          sub={
            resources.length
              ? "试试调整搜索词或筛选条件。"
              : "由管理员添加服务器，或从表格批量导入。"
          }
          action={
            admin ? (
              <button
                className="button primary"
                onClick={() => {
                  setEditResource(null);
                  setModal("resource");
                }}
              >
                <Plus size={16} />
                添加服务器
              </button>
            ) : (
              <a className="button" href="/demo">
                查看交互演示 <ArrowRight size={16} />
              </a>
            )
          }
        />
      )}
    </div>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href={demo ? "/demo" : "/"}>
          <span className="brand-mark">
            <Server size={21} />
          </span>
          <span>
            算力资源台<small>RESOURCE CONSOLE</small>
          </span>
        </a>
        <div className="workspace-label">
          工作空间 <span>共享资源</span>
        </div>
        <nav>
          {nav.filter(n => n.id !== "settings" || admin).map((n) => (
            <button
              key={n.id}
              aria-label={n.label}
              className={view === n.id ? "active" : ""}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={19} />
              <span>{n.label}</span>
              {n.id === "requests" && pending.length > 0 && (
                <em>{pending.length}</em>
              )}
              {view === n.id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-note">
            <span className="live-dot" />
            <span>资源透明，协作有序</span>
            <small>所有时间均为北京时间</small>
          </div>
          <button
            className="profile"
            onClick={() => setModal(actor.userId ? "identity" : "login")}
          >
            <span className="avatar">
              {admin ? (
                <ShieldCheck size={19} />
              ) : (
                actor.displayName.slice(0, 1)
              )}
            </span>
            <span>
              <strong>{actor.displayName}</strong>
              <small>
                {admin
                  ? "服务器管理员"
                  : actor.role === "contact"
                    ? `${groupName(actor.groupId)} · 接口人`
                    : actor.userId
                      ? "已登录 · 待认证"
                      : "公开访问 · 只读"}
              </small>
            </span>
            <Settings2 size={16} />
          </button>
          {actor.userId && !demo && (
            <a
              href="/signout-with-chatgpt?return_to=/"
              target="_top"
              className="logout"
            >
              <LogOut size={13} />
              退出登录
            </a>
          )}
        </div>
      </aside>
      <div className="main-shell">
        <div className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={13} />{" "}
            <span>{titles[view].title}</span>
          </div>
          <div className="topbar-right">
            {demo ? (
              <>
                <Badge tone="orange">独立演示 · 不写入真实数据</Badge>
                <select
                  aria-label="演示角色"
                  value={actor.role}
                  onChange={(e) =>
                    setS((prev) =>
                      prev
                        ? {
                            ...prev,
                            actor:
                              e.target.value === "admin"
                                ? demoAdmin
                                : e.target.value === "contact"
                                  ? demoContact
                                  : {
                                      userId: "",
                                      displayName: "访客",
                                      email: "",
                                      role: "visitor",
                                      groupId: "",
                                      employeeId: "",
                                    },
                          }
                        : prev,
                    )
                  }
                >
                  <option value="admin">演示管理员</option>
                  <option value="contact">演示组接口人</option>
                  <option value="visitor">演示访客</option>
                </select>
                <a href="/" className="text-button">
                  进入真实看板 <ArrowUpRight size={14} />
                </a>
              </>
            ) : (
              <>
                <span className="public-label">
                  <span className="live-dot" />
                  公开看板
                </span>
                {!actor.userId && (
                  <a
                    className="button small"
                    href="/signin-with-chatgpt?return_to=/"
                    target="_top"
                  >
                    <LogIn size={14} />
                    登录
                  </a>
                )}
              </>
            )}
          </div>
        </div>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">SERVER RESOURCE MANAGEMENT</div>
              <h1>
                {titles[view].title}
                <span className="heading-dot">.</span>
              </h1>
              <p>{titles[view].sub}</p>
            </div>
            <div className="heading-actions">
              <FontSizeControl />
              <span className="date-chip">
                <CalendarDays size={15} />
                {chinaDate()}
                <span>UTC+8</span>
              </span>
              <button className="button primary" onClick={() => openRequest()}>
                <Plus size={17} />
                申请资源
              </button>
            </div>
          </div>
          {error && (
            <div className="notice danger">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button className="text-button" onClick={() => refresh()}>
                重新加载
              </button>
            </div>
          )}
          {!demo && s && !s.adminConfigured && (
            <div className="notice">
              <ShieldCheck size={18} />
              <span>
                等待配置管理员登录邮箱。公开查看已开放，写入操作需要经过身份认证。
              </span>
            </div>
          )}
          {loading ? (
            <div className="loading">
              <LoaderCircle className="spin" />
              正在读取资源与排期…
            </div>
          ) : (
            s && (
              <>
                <section className="announcement-bar" aria-label="公告栏">
                  <Megaphone size={20} />
                  <div><h2>公告栏</h2><p>{s.settings.announcement || "暂无公告"}</p></div>
                  {admin && <button className="text-button" onClick={() => navigate("settings")}>编辑公告与签名</button>}
                </section>
                {view === "settings" && admin && <AdminSettings state={s} busy={busy} onAction={run} />}
                {view === "overview" && (
                  <>
                    <section className="kpi-grid">
                      <article className="kpi">
                        <div>
                          <span>服务器总量</span>
                          <Server size={18} />
                        </div>
                        <strong>
                          {resources.length}
                          <small>台</small>
                        </strong>
                        <footer>
                          <span className="tiny-dot" />
                          统一纳管的服务器资源
                        </footer>
                      </article>
                      <article className="kpi">
                        <div>
                          <span>正在使用</span>
                          <Activity size={18} />
                        </div>
                        <strong>
                          {used.size}
                          <small>台</small>
                        </strong>
                        <footer>
                          <span className="orange-text">
                            {resources.length
                              ? Math.round((used.size / resources.length) * 100)
                              : 0}
                            %
                          </span>{" "}
                          当前资源使用率
                          <div className="mini-bar">
                            <i
                              style={{
                                width: `${resources.length ? (used.size / resources.length) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        </footer>
                      </article>
                      <article className="kpi">
                        <div>
                          <span>可用资源</span>
                          <CheckCircle2 size={18} />
                        </div>
                        <strong>
                          {available.length}
                          <small>台</small>
                        </strong>
                        <footer>
                          <span className="tiny-dot green-bg" />
                          {
                            resources.filter((r) => r.status === "maintenance")
                              .length
                          }
                          台维护中 · 空闲资源可申请
                        </footer>
                      </article>
                      <article className="kpi kpi-accent">
                        <div>
                          <span>待审批申请</span>
                          <ClipboardList size={18} />
                        </div>
                        <strong>
                          {pending.length}
                          <small>项</small>
                        </strong>
                        <footer>
                          <button
                            onClick={() => {
                              navigate("requests");
                              setRequestFilter("pending");
                            }}
                          >
                            {
                              pending.filter((r) => r.priority !== "normal")
                                .length
                            }
                            项高优任务等待处理 <ArrowRight size={14} />
                          </button>
                        </footer>
                      </article>
                    </section>
                    <section className="overview-split">
                      <article className="panel slot-panel">
                        <div className="section-heading">
                          <div>
                            <h2>
                              今日时间窗口 <span>TODAY</span>
                            </h2>
                            <p>固定时段覆盖全天，跨夜窗口延续至次日。</p>
                          </div>
                          <button
                            className="text-button"
                            onClick={() => navigate("schedule")}
                          >
                            完整排期 <ArrowUpRight size={15} />
                          </button>
                        </div>
                        <div className="slot-cards">
                          {slots.map((slot, i) => {
                            const range = timeRange(chinaDate(), i);
                            const bookings = s.bookings.filter(
                              (b) =>
                                b.status === "scheduled" && overlaps(b, range),
                            );
                            const count = new Set(
                              bookings.map((b) => b.resourceId),
                            ).size;
                            const active =
                              range.startAt <= clock && range.endAt > clock;
                            return (
                              <button
                                key={i}
                                className={`slot-card ${active ? "current-slot" : ""}`}
                                onClick={() => {
                                  navigate("schedule");
                                }}
                              >
                                <span>
                                  {slot.label}
                                  {active && <i>当前</i>}
                                </span>
                                <strong>
                                  {slot.start}
                                  <em>
                                    — {slot.end}
                                    {i === 4 ? " +1" : ""}
                                  </em>
                                </strong>
                                <div className="slot-track">
                                  <i
                                    style={{
                                      width: `${resources.length ? (count / resources.length) * 100 : 0}%`,
                                    }}
                                  />
                                </div>
                                <small>
                                  <b>{count}</b> 台已排期
                                </small>
                              </button>
                            );
                          })}
                        </div>
                        <div className="subtle-foot">
                          <Clock3 size={13} /> 支持自定义起止时间 ·
                          相邻时段可连续使用
                        </div>
                      </article>
                      <article className="panel distribution">
                        <div className="section-heading">
                          <div>
                            <h2>团队当前占用</h2>
                            <p>按正在使用的服务器计数</p>
                          </div>
                          <Users size={18} />
                        </div>
                        <div className="group-bars">
                          {[...groupStats]
                            .sort((a, b) => b.count - a.count)
                            .slice(0, 4)
                            .map((g, i) => (
                              <div className="group-bar" key={g.group.id}>
                                <span
                                  className={`dot group-${Number(g.group.id.slice(1)) % 5}`}
                                />
                                <label>{g.group.name}</label>
                                <div>
                                  <i
                                    className={`group-${Number(g.group.id.slice(1)) % 5}`}
                                    style={{
                                      width: `${g.count ? Math.max(5, (g.count / Math.max(1, used.size)) * 100) : 0}%`,
                                    }}
                                  />
                                </div>
                                <strong>
                                  {g.count}
                                  <small>台</small>
                                </strong>
                              </div>
                            ))}
                        </div>
                        <button
                          className="text-button"
                          onClick={() => navigate("groups")}
                        >
                          查看全部10个组 <ArrowRight size={14} />
                        </button>
                      </article>
                    </section>
                    <section className="panel">
                      <div className="section-heading">
                        <div>
                          <h2>
                            资源实时状态{" "}
                            <span className="count-pill">
                              {resources.length}
                            </span>
                          </h2>
                          <p>服务器当前由谁使用，正在做什么。</p>
                        </div>
                        <div className="section-tools">
                          <div className="search compact">
                            <Search size={16} />
                            <input
                              aria-label="搜索服务器"
                              placeholder="搜索服务器或 IP"
                              value={search}
                              onChange={(e) => setSearch(e.target.value)}
                            />
                          </div>
                          <button
                            className="text-button"
                            onClick={() => navigate("resources")}
                          >
                            全部资源 <ArrowUpRight size={15} />
                          </button>
                        </div>
                      </div>
                      {showResourceTable(8)}
                      {resources.length > 8 && (
                        <button
                          className="table-footer"
                          onClick={() => navigate("resources")}
                        >
                          查看全部 {resources.length} 台服务器{" "}
                          <ChevronRight size={14} />
                        </button>
                      )}
                    </section>
                    <div className="bottom-note">
                      <span className="live-dot" />
                      每30秒自动更新 <span>·</span> 最近更新 {fmt(s.now, false)}
                      {demo && <span>· 示例 IP 使用文档保留地址段</span>}
                    </div>
                  </>
                )}
                {view === "resources" && (
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <h2>
                          资源清单{" "}
                          <span className="count-pill">{filtered.length}</span>
                        </h2>
                        <p>类型、访问方式和占用状态，一目了然。</p>
                      </div>
                      <div className="section-tools">
                        <button className="button" onClick={exportResources}>
                          <ArrowDownToLine size={15} />
                          导出表格
                        </button>
                        {admin && (
                          <>
                            <button
                              className="button"
                              onClick={() => {
                                setBulkText("");
                                setBulkError("");
                                setWorkbook([]);
                                setImportFileName("");
                                setSheetIndex(0);
                                setImportMode("add");
                                setModal("import");
                              }}
                            >
                              <Upload size={15} />
                              批量导入
                            </button>
                            <button
                              className="button primary"
                              onClick={() => {
                                setEditResource(null);
                                setModal("resource");
                              }}
                            >
                              <Plus size={16} />
                              添加服务器
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="filters">
                      <div className="search">
                        <Search size={17} />
                        <textarea
                          aria-label="搜索资源"
                          aria-describedby="resource-search-help"
                          placeholder="搜索名称、IP、类型或备注"
                          rows={2}
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      <ResourceTypeFilter
                        types={types}
                        selected={typeFilter}
                        onChange={setTypeFilter}
                      />
                      <select
                        aria-label="使用方式筛选"
                        value={modeFilter}
                        onChange={(e) => setModeFilter(e.target.value)}
                      >
                        <option value="">全部使用方式</option>
                        <option value="bare">裸机</option>
                        <option value="lingshu">灵枢平台</option>
                      </select>
                      <select
                        aria-label="状态筛选"
                        value={stateFilter}
                        onChange={(e) => setStateFilter(e.target.value)}
                      >
                        <option value="">全部状态</option>
                        <option value="used">使用中</option>
                        <option value="free">空闲</option>
                        <option value="maintenance">维护中</option>
                      </select>
                    </div>
                    <p id="resource-search-help" className="resource-search-help">
                      多个IP可用空格、英文逗号或换行分隔，匹配任意一个IP。
                    </p>
                    {selected.length > 0 && admin && (
                      <div className="selection-bar">
                        <span>
                          已选择 <strong>{selected.length}</strong> 台服务器
                        </span>
                        <button
                          className="text-button"
                          onClick={() => openRequest(selected)}
                        >
                          申请所选资源
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            const rows = resources.filter((r) =>
                              selected.includes(r.id),
                            );
                            const values: Record<string, string> = {
                              name: "{name}",
                            };
                            for (const key of [
                              "type",
                              "accessMode",
                              "sharingMode",
                              "location",
                              "note",
                              "status",
                            ] as const) {
                              values[key] = rows.every(
                                (r) => r[key] === rows[0][key],
                              )
                                ? rows[0][key]
                                : "";
                            }
                            setBulkValues(values);
                            setBulkFields({});
                            setModal("bulk-edit");
                          }}
                        >
                          <Pencil size={14} />
                          批量修改
                        </button>
                        <button
                          className="text-button danger-text"
                          onClick={() => {
                            setDeleteIds(selected);
                            setModal("delete");
                          }}
                        >
                          <Trash2 size={14} />
                          批量删除
                        </button>
                        <button
                          className="text-button"
                          onClick={() => setSelected([])}
                        >
                          取消选择
                        </button>
                      </div>
                    )}
                    {showResourceTable()}
                  </section>
                )}
                {view === "schedule" && (
                  <ScheduleTimeline
                    resources={resources}
                    bookings={s.bookings}
                    groups={s.groups}
                    now={clock}
                    onDetail={setDetail}
                    onRequest={openRequest}
                  />
                )}
                {view === "requests" && (
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <h2>资源使用申请</h2>
                        <p>
                          申请需经管理员批准后生效；共享服务器允许多个组同时使用。
                        </p>
                      </div>
                      <button
                        className="button primary"
                        onClick={() => openRequest()}
                      >
                        <Plus size={16} />
                        新建申请
                      </button>
                    </div>
                    <div className="tabs">
                      {[
                        ["all", "全部申请"],
                        ["pending", `待审批 ${pending.length}`],
                        ["approved", "已批准"],
                        ["rejected", "已拒绝"],
                        ["cancelled", "已取消"],
                        ...(actor.groupId ? [["mine", "本组申请"]] : []),
                      ].map(([k, l]) => (
                        <button
                          key={k}
                          onClick={() => setRequestFilter(k)}
                          className={requestFilter === k ? "active" : ""}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                    <div className="filters">
                      <div className="search">
                        <Search size={16} />
                        <input
                          aria-label="搜索申请"
                          placeholder="搜索用途、团队、申请人或服务器"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      <select
                        aria-label="申请组筛选"
                        value={groupFilter}
                        onChange={(e) => setGroupFilter(e.target.value)}
                      >
                        <option value="">全部团队</option>
                        {s.groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>任务用途 / 申请人</th>
                            <th>申请资源</th>
                            <th>使用时间</th>
                            <th>优先级</th>
                            <th>状态</th>
                            <th className="align-right">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleRequests.map((r) => (
                            <tr key={r.id}>
                              <td>
                                <strong className="task-title">
                                  {r.purpose}
                                </strong>
                                <small>
                                  {groupName(r.groupId)} · {r.applicantName}
                                </small>
                              </td>
                              <td>
                                <span>{r.resourceIds.length} 台服务器</span>
                                <small
                                  className="task-ellipsis"
                                  title={r.resourceIds
                                    .map(resourceName)
                                    .join("、")}
                                >
                                  {r.resourceIds.map(resourceName).join("、")}
                                </small>
                              </td>
                              <td>
                                <span className="mono">
                                  {fmt(r.startAt)} → {fmt(r.endAt)}
                                </span>
                                <small>{duration(r.startAt, r.endAt)}</small>
                              </td>
                              <td>
                                <Badge
                                  tone={
                                    r.priority === "normal"
                                      ? "neutral"
                                      : "orange"
                                  }
                                >
                                  {r.priority !== "normal" && <Zap size={12} />}{" "}
                                  {priorityLabel[r.priority]}
                                </Badge>
                              </td>
                              <td>
                                <Badge
                                  tone={
                                    r.status === "pending"
                                      ? "orange"
                                      : r.status === "approved"
                                        ? "green"
                                        : r.status === "rejected"
                                          ? "red"
                                          : "neutral"
                                  }
                                >
                                  {statusLabel[r.status]}
                                </Badge>
                                {r.reviewNote && (
                                  <small
                                    title={r.reviewNote}
                                    className="task-ellipsis"
                                  >
                                    {r.reviewNote}
                                  </small>
                                )}
                              </td>
                              <td className="align-right">
                                <div className="row-actions">
                                  {admin && r.status === "pending" && (
                                    <>
                                      <button
                                        className="text-button orange-text"
                                        onClick={() => {
                                          setReview(r);
                                          setReviewApprove(true);
                                          setReviewNote("");
                                          setPreempt(false);
                                        }}
                                      >
                                        审批
                                      </button>
                                      <button
                                        className="text-button danger-text"
                                        onClick={() => {
                                          setReview(r);
                                          setReviewApprove(false);
                                          setReviewNote("");
                                          setPreempt(false);
                                        }}
                                      >
                                        拒绝
                                      </button>
                                    </>
                                  )}
                                  {(admin || actor.groupId === r.groupId) &&
                                    ["pending", "approved"].includes(
                                      r.status,
                                    ) &&
                                    r.endAt > clock && (
                                      <button
                                        className="text-button"
                                        onClick={() => {
                                          setCancelRequest(r);
                                          setReviewNote("");
                                        }}
                                      >
                                        {r.status === "approved" &&
                                        r.startAt < clock
                                          ? "释放"
                                          : "取消"}
                                      </button>
                                    )}
                                  <button
                                    className="text-button"
                                    onClick={() => {
                                      setReview(r);
                                      setReviewApprove(true);
                                      setReviewNote("");
                                      setPreempt(false);
                                    }}
                                  >
                                    详情
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!visibleRequests.length && (
                        <Empty
                          title="暂无符合条件的申请"
                          sub="选择服务器和时间段，提交你的资源使用计划。"
                          action={
                            <button
                              className="button"
                              onClick={() => openRequest()}
                            >
                              申请资源 <ArrowRight size={15} />
                            </button>
                          }
                        />
                      )}
                    </div>
                  </section>
                )}
                {view === "groups" && (
                  <>
                    <div className="group-intro">
                      <span>
                        <Users size={18} />
                        共10个使用组
                      </span>
                      <span>
                        <span className="live-dot" />
                        {groupStats.filter((g) => g.count).length}
                        个组正在使用资源
                      </span>
                      <p>
                        累计使用按有效占用时间计算，未来预约与被抢占时段不计入。
                      </p>
                    </div>
                    <div className="groups-grid">
                      {groupStats.map((g, i) => (
                        <article className="panel group-card" key={g.group.id}>
                          <div className="group-card-heading">
                            <span
                              className={`group-avatar color-${(i + 1) % 5}`}
                            >
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <div>
                              <h2>{g.group.name}</h2>
                              <small>资源使用组</small>
                            </div>
                            {admin && (
                              <button
                                className="icon-button"
                                aria-label={`编辑${g.group.name}`}
                                onClick={() => {
                                  setEditGroup(g.group);
                                  setModal("group");
                                }}
                              >
                                <Pencil size={16} />
                              </button>
                            )}
                          </div>
                          <div className="contact-row">
                            <span>接口人</span>
                            <strong>{g.group.contactName || "待配置"}</strong>
                            <span className="mono">
                              {g.group.employeeId || "工号待配置"}
                            </span>
                          </div>
                          <div className="group-numbers">
                            <div>
                              <strong>
                                {g.count}
                                <small>台</small>
                              </strong>
                              <span>当前占用</span>
                            </div>
                            <div>
                              <strong>
                                {g.future}
                                <small>段</small>
                              </strong>
                              <span>未来预约</span>
                            </div>
                            <div>
                              <strong>
                                {Number(g.hours.toFixed(1))}
                                <small>时</small>
                              </strong>
                              <span>累计使用</span>
                            </div>
                          </div>
                          <button
                            className="group-card-footer"
                            onClick={() => {
                              navigate("requests");
                              setGroupFilter(g.group.id);
                              setRequestFilter("all");
                            }}
                          >
                            查看本组申请 <ArrowUpRight size={14} />
                          </button>
                        </article>
                      ))}
                    </div>
                    {admin && (
                      <section className="panel account-panel">
                        <div className="section-heading">
                          <div>
                            <h2>
                              接口人身份审核{" "}
                              <span className="count-pill">
                                {
                                  s.accounts.filter(
                                    (a) =>
                                      a.role === "contact" &&
                                      a.status === "pending",
                                  ).length
                                }
                              </span>
                            </h2>
                            <p>
                              核验工号与姓名后授予权限，登录本身不会获得申请资格。
                            </p>
                          </div>
                        </div>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>姓名 / 工号</th>
                                <th>所属组</th>
                                <th>登录邮箱</th>
                                <th>认证状态</th>
                                <th className="align-right">操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {s.accounts
                                .filter((a) => a.role === "contact")
                                .map((a) => (
                                  <tr key={a.id}>
                                    <td>
                                      <strong>{a.displayName}</strong>
                                      <small>{a.employeeId}</small>
                                    </td>
                                    <td>{groupName(a.groupId)}</td>
                                    <td>{a.email}</td>
                                    <td>
                                      <Badge
                                        tone={
                                          a.status === "approved"
                                            ? "green"
                                            : a.status === "pending"
                                              ? "orange"
                                              : "red"
                                        }
                                      >
                                        {a.status === "approved"
                                          ? "已认证"
                                          : a.status === "pending"
                                            ? "待审核"
                                            : "已拒绝 / 已撤销"}
                                      </Badge>
                                    </td>
                                    <td className="align-right">
                                      <div className="row-actions">
                                        {a.status === "pending" ? (
                                          <>
                                            <button
                                              disabled={busy}
                                              className="text-button orange-text"
                                              onClick={() =>
                                                run(
                                                  {
                                                    type: "account.review",
                                                    id: a.id,
                                                    approve: true,
                                                  },
                                                  "接口人身份已认证",
                                                )
                                              }
                                            >
                                              通过认证
                                            </button>
                                            <button
                                              disabled={busy}
                                              className="text-button danger-text"
                                              onClick={() =>
                                                run(
                                                  {
                                                    type: "account.review",
                                                    id: a.id,
                                                    approve: false,
                                                  },
                                                  "已拒绝认证",
                                                )
                                              }
                                            >
                                              拒绝
                                            </button>
                                          </>
                                        ) : (
                                          a.status === "approved" && (
                                            <button
                                              className="text-button danger-text"
                                              onClick={() => {
                                                setModal(`revoke:${a.id}`);
                                              }}
                                            >
                                              撤销权限
                                            </button>
                                          )
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                          {!s.accounts.some((a) => a.role === "contact") && (
                            <Empty
                              title="暂无接口人认证申请"
                              sub="组接口人登录后，填写工号和姓名提交认证。"
                            />
                          )}
                        </div>
                      </section>
                    )}
                  </>
                )}
                {view === "history" && (
                  <section className="panel">
                    <div className="section-heading">
                      <div>
                        <h2>操作与分配记录</h2>
                        <p>
                          保留服务器变更、申请审批、取消释放与高优抢占记录。
                        </p>
                      </div>
                      <button
                        className="button"
                        disabled={!visibleAudits.length}
                        onClick={() =>
                          downloadCSV("变更历史.csv", [
                            ["时间（北京时间）", "操作人", "操作", "详情"],
                            ...visibleAudits.map((a) => [
                                auditTime(a.at),
                                a.actorName,
                                a.action,
                                a.summary,
                              ]),
                          ])
                        }
                      >
                        <ArrowDownToLine size={15} />
                        导出历史
                      </button>
                    </div>
                    <div className="filters">
                      <div className="search">
                        <Search size={16} />
                        <input
                          aria-label="搜索历史"
                          placeholder="搜索服务器、操作人或变更内容"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      <ResourceTypeFilter types={historyTypeOptions} selected={historyTypes} onChange={setHistoryTypes}
                        label="变更类型筛选" allLabel="全部变更类型" emptyMessage="暂无变更类型" />
                    </div>
                    <form className="history-time-filter" onSubmit={e => {
                      e.preventDefault();
                      try { setHistoryRange(auditRange(historyStart, historyEnd)); setHistoryError(""); }
                      catch (e) { setHistoryError((e as Error).message); }
                    }}>
                      <label>执行开始时间<input aria-label="历史开始时间" type="datetime-local" step={1} value={historyStart} onChange={e => setHistoryStart(e.target.value)} /></label>
                      <label>执行结束时间<input aria-label="历史结束时间" type="datetime-local" step={1} value={historyEnd} onChange={e => setHistoryEnd(e.target.value)} /></label>
                      <button className="button primary" type="submit">查询时间段</button>
                      <button className="button" type="button" onClick={() => {
                        setSearch(""); setHistoryTypes(null); setHistoryStart(""); setHistoryEnd(""); setHistoryRange({}); setHistoryError("");
                      }}>重置筛选</button>
                      <p className="muted">按操作发生时间筛选 · 北京时间 · 可只填开始或结束时间，包含结束时刻所在的分钟或秒</p>
                      {historyError && <p className="history-filter-error" role="alert">{historyError}</p>}
                    </form>
                    <p className="history-result-count" role="status">匹配 {visibleAudits.length} 条 / 共 {s.audits.length} 条记录 · 导出仅包含当前筛选结果</p>
                    <div className="audit-list">
                      {visibleAudits.map((a) => (
                          <article className="audit-item" key={a.id}>
                            <span
                              className={`audit-icon ${a.action.includes("抢占") ? "alert" : ""}`}
                            >
                              {a.action.includes("抢占") ? (
                                <Zap size={16} />
                              ) : a.action.includes("审批") ||
                                a.action.includes("批准") ? (
                                <Check size={16} />
                              ) : (
                                <History size={16} />
                              )}
                            </span>
                            <div>
                              <div className="audit-title">
                                <strong>{a.action}</strong>
                                <span>{a.actorName}</span>
                                <time dateTime={a.at}>{auditTime(a.at)}</time>
                              </div>
                              <p>{a.summary}</p>
                              {admin && a.before && (
                                <details>
                                  <summary>查看变更前后</summary>
                                  <div className="diff-grid">
                                    <div>
                                      <small>变更前</small>
                                      <pre>
                                        {JSON.stringify(
                                          JSON.parse(a.before),
                                          null,
                                          2,
                                        )}
                                      </pre>
                                    </div>
                                    <div>
                                      <small>变更后</small>
                                      <pre>
                                        {JSON.stringify(
                                          JSON.parse(a.after),
                                          null,
                                          2,
                                        )}
                                      </pre>
                                    </div>
                                  </div>
                                </details>
                              )}
                            </div>
                          </article>
                        ))}
                      {!visibleAudits.length && (
                        <Empty
                          title={s.audits.length ? "没有符合条件的变更记录" : "还没有变更记录"}
                          sub={s.audits.length ? "请调整变更类型、时间范围或搜索关键词。" : "真实操作发生后，记录会自动出现在这里。"}
                        />
                      )}
                    </div>
                  </section>
                )}
              </>
            )
          )}
          {s && <section className="author-signature" aria-label="作者签名栏">
            <div><span>作者签名</span><p>{s.settings.authorSignature || "待管理员填写"}</p></div>
            {admin && <button className="text-button" onClick={() => navigate("settings")}>编辑签名</button>}
          </section>}
          <footer className="page-footer">
            <span>
              算力资源台 <span> / </span> SERVER RESOURCE CONSOLE
            </span>
            <span>公开可见 · 授权操作 · 全程留痕</span>
          </footer>
        </main>
      </div>
      {modal === "resource" && (
        <Modal
          title={editResource ? "编辑服务器" : "添加服务器"}
          sub="服务器名称和 IP 需保持唯一。"
          onClose={() => setModal(null)}
        >
          <form onSubmit={submitResource}>
            <div className="form-grid">
              <Field label="服务器名称 *">
                <input
                  autoFocus
                  required
                  name="name"
                  maxLength={80}
                  defaultValue={editResource?.name}
                  placeholder="例如 Atlas-910B-01"
                />
              </Field>
              <Field label="服务器类型 *">
                <input
                  required
                  name="type"
                  maxLength={80}
                  defaultValue={editResource?.type}
                  placeholder="例如 Ascend 910B · 8卡"
                  list="resource-types"
                />
                <datalist id="resource-types">
                  {types.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Field>
              <Field label="IP 地址 *">
                <input
                  required
                  name="ip"
                  maxLength={64}
                  defaultValue={editResource?.ip}
                  placeholder="支持 IPv4 / IPv6"
                />
              </Field>
              <Field label="使用方式 *">
                <select
                  name="accessMode"
                  defaultValue={editResource?.accessMode ?? "bare"}
                >
                  <option value="bare">通过裸机使用</option>
                  <option value="lingshu">通过灵枢平台使用</option>
                </select>
              </Field>
              <Field label="占用模式 *">
                <select
                  name="sharingMode"
                  defaultValue={resourceSharingMode(editResource ?? undefined)}
                >
                  <option value="exclusive">
                    独占 · 同一时间只批准一个预约
                  </option>
                  <option value="shared">共享 · 允许多个组同时使用</option>
                </select>
              </Field>
              <Field label="机房 / 位置">
                <input
                  name="location"
                  maxLength={100}
                  defaultValue={editResource?.location}
                  placeholder="可选"
                />
              </Field>
              <Field label="资源状态">
                <select
                  name="status"
                  defaultValue={editResource?.status ?? "available"}
                >
                  <option value="available">可申请</option>
                  <option value="maintenance">维护中</option>
                </select>
              </Field>
              <Field label="备注" wide>
                <textarea
                  name="note"
                  maxLength={1000}
                  defaultValue={editResource?.note}
                  rows={3}
                  placeholder="访问说明或其他资源信息，请勿填写密码。"
                />
              </Field>
            </div>
            <div className="modal-footer">
              {editResource && (
                <button
                  type="button"
                  className="button danger"
                  onClick={() => {
                    setDeleteIds([editResource.id]);
                    setModal("delete");
                  }}
                >
                  <Trash2 size={15} />
                  删除服务器
                </button>
              )}
              <span className="spacer" />
              <button
                type="button"
                className="button"
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                保存服务器
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "bulk-edit" && (
        <Modal
          wide
          title={`批量修改${selected.length}台服务器`}
          sub="每批最多200台，只修改勾选字段，IP保持不变。位置和备注勾选后留空可清除。"
          onClose={() => setModal(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const changes = Object.fromEntries(
                Object.keys(bulkFields)
                  .filter((key) => bulkFields[key])
                  .map((key) => [key, bulkValues[key] ?? ""]),
              );
              if (
                await run(
                  { type: "resource.bulkUpdate", ids: selected, changes },
                  `已批量修改${selected.length}台服务器`,
                )
              ) {
                setModal(null);
                setSelected([]);
              }
            }}
          >
            <div className="bulk-edit-grid">
              {[
                { key: "name", label: "名称模板" },
                { key: "type", label: "类型" },
                { key: "accessMode", label: "使用方式" },
                { key: "sharingMode", label: "占用模式" },
                { key: "location", label: "位置" },
                { key: "note", label: "备注" },
                { key: "status", label: "资源状态" },
              ].map((field) => (
                <div className="bulk-edit-field" key={field.key}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      aria-label={`修改${field.label}`}
                      checked={!!bulkFields[field.key]}
                      onChange={(e) =>
                        setBulkFields({
                          ...bulkFields,
                          [field.key]: e.target.checked,
                        })
                      }
                    />
                    {field.label}
                  </label>
                  <Field label={field.label}>
                    {["accessMode", "sharingMode", "status"].includes(
                      field.key,
                    ) ? (
                      <select
                        aria-label={`批量${field.label}`}
                        disabled={!bulkFields[field.key]}
                        required={!!bulkFields[field.key]}
                        value={bulkValues[field.key] ?? ""}
                        onChange={(e) =>
                          setBulkValues({
                            ...bulkValues,
                            [field.key]: e.target.value,
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {(field.key === "accessMode"
                          ? [
                              ["bare", "通过裸机使用"],
                              ["lingshu", "通过灵枢平台使用"],
                            ]
                          : field.key === "sharingMode"
                            ? [
                                ["exclusive", "独占"],
                                ["shared", "共享"],
                              ]
                            : [
                                ["available", "可申请"],
                                ["maintenance", "维护中"],
                              ]
                        ).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={`批量${field.label}`}
                        disabled={!bulkFields[field.key]}
                        required={
                          !!bulkFields[field.key] &&
                          ["name", "type"].includes(field.key)
                        }
                        maxLength={
                          field.key === "note"
                            ? 1000
                            : field.key === "location"
                              ? 100
                              : 80
                        }
                        value={bulkValues[field.key] ?? ""}
                        onChange={(e) =>
                          setBulkValues({
                            ...bulkValues,
                            [field.key]: e.target.value,
                          })
                        }
                      />
                    )}
                  </Field>
                </div>
              ))}
            </div>
            <p className="import-help">
              名称支持 {"{name}"} 原名称、{"{ip}"} 原IP、{"{index}"}{" "}
              选中序号。例如“苏州服务器-{"{ip}"}”。最终名称仍需唯一。
            </p>
            <div className="table-scroll bulk-edit-preview">
              <table>
                <thead>
                  <tr>
                    <th>当前名称</th>
                    <th>IP（保持不变）</th>
                    {bulkFields.name && <th>修改后名称预览</th>}
                  </tr>
                </thead>
                <tbody>
                  {selected.map((id, index) => {
                    const r = resources.find((r) => r.id === id);
                    return r ? (
                      <tr key={id}>
                        <td>{r.name}</td>
                        <td className="mono">{r.ip}</td>
                        {bulkFields.name && (
                          <td>
                            {(bulkValues.name ?? "").replace(
                              /\{(name|ip|index)\}/g,
                              (_, key) =>
                                key === "name"
                                  ? r.name
                                  : key === "ip"
                                    ? r.ip
                                    : String(index + 1),
                            )}
                          </td>
                        )}
                      </tr>
                    ) : null;
                  })}
                </tbody>
              </table>
            </div>
            <div className="modal-footer">
              <span className="muted text-small">
                任一资源校验失败，整批不修改。
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="button"
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={
                  busy ||
                  !Object.values(bulkFields).some(Boolean) ||
                  selected.length > 200
                }
              >
                <Check size={15} />
                确认批量修改
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "import" && (
        <Modal
          wide
          title="从表格批量导入"
          sub="支持 Excel（.xlsx）、CSV及粘贴表格，每批最多200行。选择新增资源或按IP更新，确认预览后整批写入。"
          onClose={() => setModal(null)}
        >
          <div className="filters import-mode">
            <Field label="导入方式">
              <select
                aria-label="导入方式"
                value={importMode}
                onChange={(e) =>
                  setImportMode(e.target.value as "add" | "update")
                }
              >
                <option value="add">新增服务器资源</option>
                <option value="update">按IP更新已有资源（IP保持不变）</option>
              </select>
            </Field>
          </div>
          <div className="import-toolbar">
            <button
              className="button"
              disabled={readingFile}
              onClick={async () => {
                try {
                  await downloadResourceTemplate();
                } catch {
                  setBulkError("Excel模板生成失败，请稍后重试");
                }
              }}
            >
              <ArrowDownToLine size={15} />
              下载 Excel 模板
            </button>
            <button
              className="button"
              onClick={() =>
                downloadCSV("服务器导入模板.csv", [
                  [
                    "名称",
                    "类型",
                    "IP",
                    "使用方式",
                    "占用模式",
                    "位置",
                    "备注",
                    "状态",
                  ],
                  [
                    "Atlas-示例-01",
                    "Ascend 910B · 8卡",
                    "192.0.2.10",
                    "裸机",
                    "独占",
                    "机房A",
                    "请替换示例内容",
                    "可申请",
                  ],
                ])
              }
            >
              <ArrowDownToLine size={15} />
              下载 CSV 模板
            </button>
            <label className="button file-button">
              <Upload size={15} />
              {readingFile ? "正在读取…" : "上传 Excel / CSV"}
              <input
                aria-label="上传资源表格"
                disabled={readingFile}
                type="file"
                accept=".xlsx,.csv,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/tab-separated-values"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  setReadingFile(true);
                  setBulkError("");
                  setWorkbook([]);
                  setBulkText("");
                  setImportFileName("");
                  setSheetIndex(0);
                  try {
                    if (file.size > 5 * 1024 * 1024)
                      throw new Error("文件不能超过5MB，请分批导入");
                    if (/\.xlsx$/i.test(file.name)) {
                      const sheets = await readResourceWorkbook(
                        await file.arrayBuffer(),
                      );
                      setWorkbook(sheets);
                    } else if (/\.(csv|tsv)$/i.test(file.name)) {
                      setBulkText(await file.text());
                    } else
                      throw new Error(
                        "请选择 .xlsx、.csv 或 .tsv 文件；旧版 .xls 请先另存为 .xlsx",
                      );
                    setImportFileName(file.name);
                  } catch (e) {
                    setBulkError(
                      e instanceof Error ? e.message : "文件读取失败",
                    );
                  } finally {
                    setReadingFile(false);
                  }
                }}
              />
            </label>
          </div>
          {importFileName && (
            <div className="import-file">
              <span>{importFileName}</span>
              <button
                className="text-button"
                onClick={() => {
                  setWorkbook([]);
                  setBulkText("");
                  setImportFileName("");
                  setBulkError("");
                }}
              >
                清除文件
              </button>
            </div>
          )}
          {workbook.length > 0 && (
            <Field label="选择工作表">
              <select
                aria-label="选择工作表"
                value={sheetIndex}
                onChange={(e) => setSheetIndex(Number(e.target.value))}
              >
                {workbook.map((sheet, i) => (
                  <option key={i} value={i}>
                    {sheet.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <p className="import-help">
            {importMode === "add"
              ? "必填：名称、类型、IP、使用方式。占用模式和状态默认独占、可申请。"
              : "按IP匹配已有服务器，填写要更新的列；空白单元格保留原值，未匹配IP将阻止整批更新。"}
          </p>
          <textarea
            className="bulk-text"
            aria-label="粘贴导入表格"
            placeholder={
              "名称\t类型\tIP\t使用方式\t位置\t备注\n服务器01\tAscend 910B\t192.0.2.10\t裸机\t机房A\t"
            }
            disabled={readingFile || workbook.length > 0}
            value={bulkText}
            onChange={(e) => {
              setBulkText(e.target.value);
              setBulkError("");
              setImportFileName("");
            }}
          />
          {(parseError || bulkError) && (
            <div className="notice danger">
              <AlertTriangle size={16} />
              {parseError || bulkError}
            </div>
          )}
          {parsedRows.length > 0 && (
            <>
              <div className="preview-caption">
                <CheckCircle2 size={15} />
                识别到 {parsedRows.length} 行，导入前请确认预览
              </div>
              <div className="table-scroll import-preview">
                <table>
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>类型</th>
                      <th>IP</th>
                      <th>使用方式</th>
                      <th>占用模式</th>
                      <th>位置</th>
                      <th>备注</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedRows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          {r.name || (
                            <span
                              className={
                                importMode === "add" ? "danger-text" : "muted"
                              }
                            >
                              {importMode === "add" ? "缺少名称" : "保留原值"}
                            </span>
                          )}
                        </td>
                        <td>{r.type ?? "保留原值"}</td>
                        <td className="mono">{r.ip}</td>
                        <td>
                          {r.accessMode
                            ? r.accessMode === "bare"
                              ? "裸机"
                              : "灵枢平台"
                            : "保留原值"}
                        </td>
                        <td>
                          {r.sharingMode
                            ? r.sharingMode === "shared"
                              ? "共享"
                              : "独占"
                            : "保留原值"}
                        </td>
                        <td>{r.location ?? "保留原值"}</td>
                        <td>{r.note ?? "保留原值"}</td>
                        <td>
                          {r.status
                            ? r.status === "maintenance"
                              ? "维护中"
                              : "可申请"
                            : "保留原值"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="modal-footer">
            <span className="muted text-small">
              {importMode === "add"
                ? "新增不会覆盖已有服务器；重复IP或名称将整批阻止导入。"
                : "按IP更新已有资源；IP不修改，空白保留原值。"}
            </span>
            <span className="spacer" />
            <button className="button" onClick={() => setModal(null)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                readingFile ||
                !!bulkError ||
                !parsedRows.length ||
                !!parseError ||
                parsedRows.length > 200
              }
              onClick={async () => {
                if (
                  await run(
                    {
                      type:
                        importMode === "add"
                          ? "resource.import"
                          : "resource.updateByIp",
                      rows: parsedRows,
                    },
                    `已${importMode === "add" ? "导入" : "更新"}${parsedRows.length}台服务器`,
                  )
                )
                  setModal(null);
              }}
            >
              <Upload size={15} />
              确认导入
            </button>
          </div>
        </Modal>
      )}
      {modal === "delete" && (
        <Modal
          title={`删除${deleteIds.length}台服务器`}
          sub="已删除的服务器不再参与分配，已有使用与变更历史会保留。"
          onClose={() => setModal(null)}
        >
          <div className="notice danger">
            <AlertTriangle size={18} />
            仍有有效预约的服务器无法删除，请先取消或释放预约。
          </div>
          <div className="delete-list">
            {deleteIds.map((id) => (
              <span key={id}>{resourceName(id)}</span>
            ))}
          </div>
          <div className="modal-footer">
            <button className="button" onClick={() => setModal(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                if (
                  await run(
                    { type: "resource.delete", ids: deleteIds },
                    "服务器已删除，历史记录已保留",
                  )
                ) {
                  setModal(null);
                  setSelected([]);
                  setDetail(null);
                }
              }}
            >
              <Trash2 size={15} />
              确认删除
            </button>
          </div>
        </Modal>
      )}
      {modal === "request" && (
        <Modal
          wide
          title="申请服务器资源"
          sub="提交使用计划，管理员批准后生效。所有时间均为北京时间 UTC+8。"
          onClose={() => setModal(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                if (
                  await run(
                    {
                      type: "request.create",
                      groupId: requestGroup,
                      resourceIds: requestResources,
                      startAt: isoInput(requestStart),
                      endAt: isoInput(requestEnd),
                      purpose,
                      priority,
                    },
                    "申请已提交，等待管理员审批",
                  )
                ) {
                  setModal(null);
                  navigate("requests");
                  setRequestFilter("pending");
                }
              } catch {
                setToast("请填写有效的起止时间");
              }
            }}
          >
            <div className="request-layout">
              <div>
                <div className="field">
                  <span>选择服务器 *</span>
                  <div className="resource-picker">
                    {resources
                      .filter((r) => r.status === "available")
                      .map((r) => (
                        <label
                          key={r.id}
                          className={
                            requestResources.includes(r.id) ? "chosen" : ""
                          }
                        >
                          <input
                            type="checkbox"
                            checked={requestResources.includes(r.id)}
                            onChange={(e) =>
                              setRequestResources(
                                e.target.checked
                                  ? [...requestResources, r.id]
                                  : requestResources.filter(
                                      (id) => id !== r.id,
                                    ),
                              )
                            }
                          />
                          <span>
                            <strong>{r.name}</strong>
                            <small>
                              {r.type} ·{" "}
                              {r.accessMode === "bare" ? "裸机" : "灵枢平台"} ·{" "}
                              {resourceSharingMode(r) === "shared"
                                ? "共享"
                                : "独占"}
                            </small>
                          </span>
                          <Badge tone={used.has(r.id) ? "orange" : "green"}>
                            {used.has(r.id) ? "使用中" : "空闲"}
                          </Badge>
                        </label>
                      ))}
                    {!resources.filter((r) => r.status === "available")
                      .length && <p className="muted">暂无可申请服务器</p>}
                  </div>
                </div>
                <span className="text-small muted">
                  已选 {requestResources.length} 台 ·
                  共享资源可同时申请；独占资源审批时检查时间冲突。
                </span>
              </div>
              <div className="request-fields">
                <Field label="使用团队 *">
                  <select
                    disabled={!admin}
                    value={requestGroup}
                    onChange={(e) => setRequestGroup(e.target.value)}
                  >
                    {s?.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="快速选择时间窗口">
                  <input
                    aria-label="时间窗口日期"
                    type="date"
                    value={requestDate}
                    onChange={(e) => {
                      setRequestDate(e.target.value);
                      if (requestSlot !== null && e.target.value)
                        changeSlot(requestSlot, e.target.value);
                    }}
                  />
                </Field>
                <div className="slot-options">
                  {slots.map((slot, i) => (
                    <button
                      type="button"
                      key={i}
                      className={requestSlot === i ? "selected" : ""}
                      onClick={() => changeSlot(i)}
                    >
                      {slot.start}–{slot.end}
                      {i === 4 ? " +1" : ""}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={requestSlot === null ? "selected" : ""}
                    onClick={() => setRequestSlot(null)}
                  >
                    自定义
                  </button>
                </div>
                <div className="form-grid">
                  <Field label="开始时间 *">
                    <input
                      required
                      type="datetime-local"
                      value={requestStart}
                      onChange={(e) => {
                        setRequestSlot(null);
                        setRequestStart(e.target.value);
                      }}
                    />
                  </Field>
                  <Field label="结束时间 *">
                    <input
                      required
                      type="datetime-local"
                      value={requestEnd}
                      onChange={(e) => {
                        setRequestSlot(null);
                        setRequestEnd(e.target.value);
                      }}
                    />
                  </Field>
                </div>
                <Field label="任务优先级">
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                  >
                    <option value="normal">普通</option>
                    <option value="high">
                      高优 · 管理员可确认抢占低优预约
                    </option>
                    <option value="urgent">
                      紧急 · 管理员可确认抢占较低优预约
                    </option>
                  </select>
                </Field>
                <Field label="任务用途 *">
                  <textarea
                    required
                    maxLength={1000}
                    rows={3}
                    placeholder="描述要运行的任务、实验或项目，方便协调资源。"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                  />
                </Field>
              </div>
            </div>
            <div className="modal-footer">
              <span className="muted text-small">
                共享服务器可并行使用；独占服务器审批时检查冲突。
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="button"
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy || !requestResources.length}
              >
                <ArrowRight size={16} />
                提交申请
              </button>
            </div>
          </form>
        </Modal>
      )}
      {review && (
        <Modal
          wide
          title={
            admin && review.status === "pending"
              ? reviewApprove
                ? "审批资源申请"
                : "拒绝资源申请"
              : "申请详情"
          }
          sub={`${groupName(review.groupId)} · ${review.applicantName} · 提交于 ${fmt(review.createdAt)}`}
          onClose={() => setReview(null)}
        >
          <div className="request-summary">
            <Badge tone={review.priority === "normal" ? "neutral" : "orange"}>
              {priorityLabel[review.priority]}
            </Badge>
            <Badge tone={review.status === "approved" ? "green" : "neutral"}>
              {statusLabel[review.status]}
            </Badge>
            <h3>{review.purpose}</h3>
            <p>
              <Clock3 size={15} />
              {fmt(review.startAt)} → {fmt(review.endAt)}{" "}
              <strong>{duration(review.startAt, review.endAt)}</strong>
            </p>
            <div className="chips">
              {review.resourceIds.map((id) => (
                <span key={id}>
                  {resourceName(id)} ·{" "}
                  {resourceSharingMode(
                    s?.resources.find((r) => r.id === id),
                  ) === "shared"
                    ? "共享"
                    : "独占"}
                </span>
              ))}
            </div>
            {review.reviewer && (
              <p>
                审批人：{review.reviewer} · {fmt(review.reviewedAt)}
              </p>
            )}
            {review.reviewNote && (
              <div className="notice">审批说明：{review.reviewNote}</div>
            )}
          </div>
          {admin && review.status === "pending" && (
            <>
              <div className="review-switch">
                <button
                  className={reviewApprove ? "selected" : ""}
                  onClick={() => setReviewApprove(true)}
                >
                  <Check size={15} />
                  批准申请
                </button>
                <button
                  className={!reviewApprove ? "selected reject" : ""}
                  onClick={() => setReviewApprove(false)}
                >
                  <X size={15} />
                  拒绝申请
                </button>
              </div>
              {reviewApprove && conflicts.length > 0 && (
                <div className="conflict-panel">
                  <h4>
                    <AlertTriangle size={17} />与 {conflicts.length}{" "}
                    条已批准预约冲突
                  </h4>
                  {conflicts.map((b) => (
                    <div key={b.id}>
                      <strong>{resourceName(b.resourceId)}</strong>
                      <span>
                        {groupName(b.groupId)} · {priorityLabel[b.priority]}
                      </span>
                      <small>
                        {fmt(b.startAt)} → {fmt(b.endAt)} · {b.purpose}
                      </small>
                    </div>
                  ))}
                  {conflicts.every(
                    (b) =>
                      priorityRank[b.priority] < priorityRank[review.priority],
                  ) ? (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={preempt}
                        onChange={(e) => setPreempt(e.target.checked)}
                      />
                      确认抢占低优先级预约，保留前后未冲突时段及完整历史
                    </label>
                  ) : (
                    <p className="danger-text">
                      存在同等或更高优先级任务，不能批准抢占。
                    </p>
                  )}
                </div>
              )}
              <Field
                label={
                  !reviewApprove || preempt ? "处理原因 *" : "审批说明（可选）"
                }
              >
                <textarea
                  rows={3}
                  maxLength={1000}
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  placeholder={
                    preempt
                      ? "请说明高优任务抢占的原因"
                      : "填写审批说明，拒绝申请时必须填写。"
                  }
                />
              </Field>
            </>
          )}
          <div className="modal-footer">
            <button className="button" onClick={() => setReview(null)}>
              关闭
            </button>
            {admin && review.status === "pending" && (
              <button
                disabled={
                  busy ||
                  (reviewApprove &&
                    conflicts.length > 0 &&
                    (!preempt ||
                      conflicts.some(
                        (b) =>
                          priorityRank[b.priority] >=
                          priorityRank[review.priority],
                      )))
                }
                className={`button ${reviewApprove ? "primary" : "danger"}`}
                onClick={async () => {
                  if (
                    await run(
                      {
                        type: "request.review",
                        id: review.id,
                        approve: reviewApprove,
                        note: reviewNote,
                        preempt,
                      },
                      reviewApprove ? "申请已批准，资源已排期" : "申请已拒绝",
                    )
                  )
                    setReview(null);
                }}
              >
                {reviewApprove ? <Check size={16} /> : <X size={16} />}确认
                {reviewApprove ? (preempt ? "抢占并批准" : "批准") : "拒绝"}
              </button>
            )}
          </div>
        </Modal>
      )}
      {cancelRequest && (
        <Modal
          title={
            cancelRequest.startAt < clock && cancelRequest.status === "approved"
              ? "提前释放资源"
              : "取消使用申请"
          }
          sub="本次操作会影响该申请的全部剩余预约，使用历史将保留。"
          onClose={() => setCancelRequest(null)}
        >
          <div className="request-summary">
            <h3>{cancelRequest.purpose}</h3>
            <p>
              {groupName(cancelRequest.groupId)} ·{" "}
              {cancelRequest.resourceIds.length}台服务器
            </p>
          </div>
          <Field label="取消 / 释放说明">
            <textarea
              maxLength={1000}
              rows={3}
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder="例如任务提前完成，归还剩余时段。"
            />
          </Field>
          <div className="modal-footer">
            <button className="button" onClick={() => setCancelRequest(null)}>
              返回
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                if (
                  await run(
                    {
                      type: "request.cancel",
                      id: cancelRequest.id,
                      note: reviewNote,
                    },
                    "申请已取消，剩余资源已释放",
                  )
                )
                  setCancelRequest(null);
              }}
            >
              确认处理
            </button>
          </div>
        </Modal>
      )}
      {modal === "group" && editGroup && (
        <Modal
          title="编辑组与接口人信息"
          sub="信息维护不会直接授予账号权限；接口人登录后仍需通过身份认证。"
          onClose={() => setModal(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await run(
                  {
                    type: "group.save",
                    id: editGroup.id,
                    ...Object.fromEntries(new FormData(e.currentTarget)),
                  },
                  "组信息已更新",
                )
              )
                setModal(null);
            }}
          >
            <div className="form-grid">
              <Field label="组名称 *" wide>
                <input
                  required
                  name="name"
                  maxLength={50}
                  defaultValue={editGroup.name}
                />
              </Field>
              <Field label="接口人姓名">
                <input
                  name="contactName"
                  maxLength={50}
                  defaultValue={editGroup.contactName}
                  placeholder="待配置"
                />
              </Field>
              <Field label="接口人工号">
                <input
                  name="employeeId"
                  maxLength={50}
                  defaultValue={editGroup.employeeId}
                  placeholder="待配置"
                />
              </Field>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button"
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button className="button primary" disabled={busy}>
                保存信息
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "login" && (
        <Modal
          title="登录后申请资源"
          sub="所有人均可查看看板。资源申请与管理需要登录并获得对应权限。"
          onClose={() => setModal(null)}
        >
          <div className="login-content">
            <div className="login-icon">
              <ShieldCheck size={30} />
            </div>
            <h3>各司其职，协作有序</h3>
            <p>
              使用你自己的 ChatGPT
              账号登录，再填写组别、工号和姓名。管理员确认接口人身份后，即可提交本组资源申请。
            </p>
            {demo ? (
              <button
                className="button primary"
                onClick={() => {
                  setS((p) => (p ? { ...p, actor: demoContact } : p));
                  setModal(null);
                }}
              >
                以演示接口人体验
              </button>
            ) : (
              <a
                className="button primary"
                href="/signin-with-chatgpt?return_to=/"
                target="_top"
              >
                <LogIn size={16} />
                使用 ChatGPT 登录
              </a>
            )}
          </div>
        </Modal>
      )}
      {modal === "identity" && (
        <Modal
          title={admin ? "管理员账号" : "组接口人认证"}
          sub={`${actor.displayName} · ${actor.email}`}
          onClose={() => setModal(null)}
        >
          {admin ? (
            <div className="notice">
              <ShieldCheck size={18} />
              你拥有服务器资源维护、申请审批、组信息管理和接口人认证权限。
            </div>
          ) : actor.role === "contact" ? (
            <div className="notice">
              <CheckCircle2 size={18} />
              已认证为 {groupName(actor.groupId)} 接口人 · 工号{" "}
              {actor.employeeId}
            </div>
          ) : s?.accounts.find((a) => a.userId === actor.userId)?.status ===
            "pending" ? (
            <div className="notice">
              <Clock3 size={18} />
              认证申请已提交，等待服务器管理员审核。
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await run(
                    {
                      type: "account.apply",
                      ...Object.fromEntries(new FormData(e.currentTarget)),
                    },
                    "身份认证申请已提交",
                  )
                )
                  setModal(null);
              }}
            >
              <div className="form-grid">
                <Field label="所属组 *" wide>
                  <select name="groupId">
                    {s?.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="真实姓名 *">
                  <input
                    required
                    name="displayName"
                    maxLength={50}
                    placeholder="请输入接口人姓名"
                  />
                </Field>
                <Field label="工号 *">
                  <input
                    required
                    name="employeeId"
                    maxLength={50}
                    placeholder="请输入工号"
                  />
                </Field>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="button"
                  onClick={() => setModal(null)}
                >
                  取消
                </button>
                <button className="button primary" disabled={busy}>
                  提交认证
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {modal?.startsWith("revoke:") && (
        <Modal
          title="撤销接口人权限"
          sub="该账号将无法继续申请或取消本组预约，已有预约会保留。"
          onClose={() => setModal(null)}
        >
          <div className="modal-footer">
            <button className="button" onClick={() => setModal(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                if (
                  await run(
                    { type: "account.revoke", id: modal.slice(7) },
                    "接口人权限已撤销",
                  )
                )
                  setModal(null);
              }}
            >
              确认撤销
            </button>
          </div>
        </Modal>
      )}
      {detail && s && (
        <Modal
          wide
          title={detail.name}
          sub={`${detail.type} · ${detail.accessMode === "bare" ? "通过裸机使用" : "通过灵枢平台使用"} · ${resourceSharingMode(detail) === "shared" ? "共享" : "独占"} · ${detail.location || "未填写位置"}`}
          onClose={() => setDetail(null)}
        >
          <div className="detail-top">
            <span className="mono">{detail.ip}</span>
            <button
              className="text-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(detail.ip);
                  setToast("IP 已复制");
                } catch {
                  setToast("浏览器未授权剪贴板，请手动复制 IP");
                }
              }}
            >
              <Copy size={14} />
              复制 IP
            </button>
            <span className="spacer" />
            {!detail.deleted && (
              <button
                className="button primary small"
                onClick={() => {
                  setDetail(null);
                  openRequest([detail.id]);
                }}
              >
                申请此服务器
              </button>
            )}
          </div>
          {detail.note && <p className="detail-note">{detail.note}</p>}
          <h3 className="detail-section-title">当前与未来预约</h3>
          <div className="booking-list">
            {s.bookings
              .filter(
                (b) =>
                  b.resourceId === detail.id &&
                  b.status === "scheduled" &&
                  b.endAt > clock,
              )
              .sort((a, b) => a.startAt.localeCompare(b.startAt))
              .map((b) => (
                <div key={b.id}>
                  <Badge tone={b.startAt <= clock ? "orange" : "blue"}>
                    {b.startAt <= clock ? "正在使用" : "待开始"}
                  </Badge>
                  <div>
                    <strong>
                      {groupName(b.groupId)} · {b.purpose}
                    </strong>
                    <small>
                      {fmt(b.startAt)} → {fmt(b.endAt)} ·{" "}
                      {priorityLabel[b.priority]}
                    </small>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => {
                      const r = s.requests.find((r) => r.id === b.requestId);
                      if (r) {
                        setDetail(null);
                        setReview(r);
                      }
                    }}
                  >
                    申请详情
                  </button>
                </div>
              ))}
            {!s.bookings.some(
              (b) =>
                b.resourceId === detail.id &&
                b.status === "scheduled" &&
                b.endAt > clock,
            ) && <p className="muted">暂无有效预约</p>}
          </div>
          <h3 className="detail-section-title">历史使用</h3>
          <div className="table-scroll detail-history">
            <table>
              <thead>
                <tr>
                  <th>使用团队 / 用途</th>
                  <th>时间</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {s.bookings
                  .filter(
                    (b) =>
                      b.resourceId === detail.id &&
                      (b.status !== "scheduled" || b.endAt <= clock),
                  )
                  .sort((a, b) => b.startAt.localeCompare(a.startAt))
                  .map((b) => (
                    <tr key={b.id}>
                      <td>
                        <strong>{groupName(b.groupId)}</strong>
                        <small>{b.purpose}</small>
                      </td>
                      <td className="mono">
                        {fmt(b.startAt)} → {fmt(b.endAt)}
                      </td>
                      <td>
                        <Badge
                          tone={b.status === "preempted" ? "orange" : "neutral"}
                        >
                          {b.status === "scheduled"
                            ? "已结束"
                            : b.status === "preempted"
                              ? "被高优任务抢占"
                              : b.status === "released"
                                ? "提前释放"
                                : "已取消"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!s.bookings.some(
              (b) =>
                b.resourceId === detail.id &&
                (b.status !== "scheduled" || b.endAt <= clock),
            ) && <p className="muted padded">暂无历史使用记录</p>}
          </div>
          <h3 className="detail-section-title">相关变更</h3>
          <div className="related-audits">
            {[...s.audits]
              .reverse()
              .filter(
                (a) =>
                  a.entityId === detail.id ||
                  a.entityId.split(",").includes(detail.id) ||
                  (a.entityType === "booking" &&
                    s.bookings.some(
                      (b) => b.id === a.entityId && b.resourceId === detail.id,
                    )) ||
                  (a.entityType === "request" &&
                    s.requests.some(
                      (r) =>
                        r.id === a.entityId &&
                        r.resourceIds.includes(detail.id),
                    )),
              )
              .map((a) => (
                <div key={a.id}>
                  <time dateTime={a.at}>{auditTime(a.at)}</time>
                  <strong>{a.action}</strong>
                  <p>{a.summary}</p>
                  <small>{a.actorName}</small>
                </div>
              ))}
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
