import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Bug,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  FileInput,
  FileText,
  Folder,
  FolderPlus,
  GitBranch,
  History,
  LayoutDashboard,
  Layers3,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  TuGoApi,
  type AiConfiguration,
  type McpRecord,
  type ModelRecord,
  type SkillEditorSession,
  type SkillRecord,
  type StructuredRunEvent,
} from "./api";
import {
  InfiniteCanvas,
  type AiCanvasPlayback,
  type AiCanvasWork,
} from "./components/InfiniteCanvas";
import { CanvasInspector } from "./components/CanvasInspector";
import { AiCursorGlyph } from "./components/AiCursorGlyph";
import { ExportDialog } from "./components/ExportDialog";
import { BatchExportDialog } from "./components/BatchExportDialog";
import {
  applyBoardOperations,
  commit,
  normalizeDocument,
  redo,
  undo,
  type BoardHistory,
} from "./lib/boardState";
import {
  buildRegionsPptxBase64,
  renderRegionPngDataUrl,
  type ExportRegion,
} from "./lib/exportDocument";
import { insertDslDocument, parseDsl, toMermaid } from "./lib/dsl";
import {
  assistantRunPresentation,
  buildAgentRunRequest,
  finalizeAssistantRunError,
  mergeSteeredUserMessages,
  queueRunPresentation,
} from "./lib/chatRunState";
import {
  createRunPresentation,
  reduceRunPresentation,
  runDurationLabel,
  runElapsedLabel,
  runIsQuiet,
  runTokenLabel,
  summarizeRunPresentation,
} from "./lib/runPresentation";
import {
  describeToolActivity,
  toolPresentation as describeToolKind,
} from "./lib/toolActivity";
import { ConversationRunCoordinator } from "./lib/conversationRunCoordinator";
import { optimizeDiagramLayout, reflectDiagram } from "./lib/diagramQuality";
import { drawingCursorColors, drawingCursorThemes } from "./lib/cursorThemes";
import { contentBounds } from "./lib/miniMapGeometry";
import type {
  BoardDocument,
  BoardEdge,
  BoardElement,
  BoardOperation,
  BoardProject,
  BootstrapStatus,
  CanvasReference,
  ChatAttachment,
  ChatMessage,
  ChatPlan,
  ChatProcessItem,
  ChatRunStatus,
  ChatSkillMention,
  TuGoConfig,
  DslKind,
  ProjectFolder,
  ConversationIndex,
  ProjectConversation,
} from "./types";
import { emptyDocument, newId } from "./types";
import {
  effectiveLanguage,
  languageOptions,
  translate,
  type LanguagePreference,
} from "./i18n";
import tugoLogo from "../assets/tugo-logo.png";
import { I18nProvider, useI18n } from "./i18nContext";

export const copyTextToClipboard = async (value: string) => {
  // Electron's sandboxed renderer does not consistently grant the async Web
  // Clipboard API. execCommand runs synchronously inside the click gesture and
  // works in both the desktop shell and the browser preview.
  const area = document.createElement("textarea");
  area.value = value;
  area.readOnly = true;
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.left = "-10000px";
  area.style.top = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, area.value.length);
  try {
    if (
      typeof document.execCommand === "function" &&
      document.execCommand("copy")
    )
      return;
  } finally {
    area.remove();
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("当前环境不允许访问剪贴板");
};

// Replay rewrites chat history, not the canvas. The board is a durable side
// effect; the next Agent turn simply starts from the messages before the
// selected user instruction.
export const messagesBeforeReplay = (
  messages: ChatMessage[],
  messageIndex: number,
) =>
  messages
    .slice(0, Math.max(0, messageIndex))
    .filter(
      (message) =>
        !message.pending &&
        (message.role === "user" || message.role === "assistant"),
    );

// Project deletion cascades its conversations in the desktop database. A
// debounced renderer save that was already in flight is then stale work, not a
// user-visible failure; all other persistence errors must still surface.
export const isStaleConversationSaveError = (error: unknown) =>
  /(?:会话|项目)不存在/.test(
    error instanceof Error ? error.message : String(error),
  );

const browserStore = {
  folders: [] as ProjectFolder[],
  projects: [
    {
      id: "demo",
      folderId: null,
      name: "欢迎来到 TuGo",
      document: {
        version: 3,
        viewport: { x: 80, y: 95, zoom: 0.88 },
        elements: [
          {
            id: "idea",
            kind: "ellipse",
            x: 80,
            y: 190,
            width: 170,
            height: 92,
            text: "描述你的想法",
            fill: "#ede9fe",
            stroke: "#6457c7",
            strokeWidth: 2,
            fontSize: 16,
          },
          {
            id: "canvas",
            kind: "rectangle",
            x: 690,
            y: 90,
            width: 210,
            height: 92,
            text: "无限画布",
            fill: "#dcfce7",
            stroke: "#3a8f65",
            strokeWidth: 2,
            fontSize: 16,
          },
          {
            id: "dsl",
            kind: "note",
            x: 690,
            y: 280,
            width: 210,
            height: 105,
            text: "Mermaid · PlantUML\ndraw.io XML",
            fill: "#fef3c7",
            stroke: "#b68126",
            strokeWidth: 2,
            fontSize: 15,
          },
          {
            id: "result",
            kind: "diamond",
            x: 1010,
            y: 174,
            width: 190,
            height: 132,
            text: "清晰、可编辑\n可持续演进",
            fill: "#fce7f3",
            stroke: "#b65381",
            strokeWidth: 2,
            fontSize: 16,
          },
        ],
        edges: [
          {
            id: "e1",
            from: "idea",
            to: "canvas",
            label: "自动绘制",
            stroke: "#6b7280",
            strokeWidth: 2,
            arrowEnd: true,
          },
          {
            id: "e4",
            from: "canvas",
            to: "result",
            stroke: "#6b7280",
            strokeWidth: 2,
            arrowEnd: true,
          },
          {
            id: "e5",
            from: "dsl",
            to: "result",
            stroke: "#6b7280",
            strokeWidth: 2,
            arrowEnd: true,
          },
        ],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ] as BoardProject[],
};
const defaultConfig: TuGoConfig = {
  theme: "system",
  language: "system",
  drawingCursor: { style: "tugo", color: "#4F46E5" },
};
const initialStatus: BootstrapStatus = {
  l4: "starting",
  model: "missing",
  mcp: "missing",
  skill: "missing",
  agent: "missing",
};
const webPreviewStatus: BootstrapStatus = {
  l4: "error",
  model: "missing",
  mcp: "missing",
  skill: "missing",
  agent: "missing",
};
type TextDialogState = {
  title: string;
  label: string;
  initialValue: string;
  confirmLabel: string;
  onConfirm(value: string): void | Promise<void>;
} | null;

const textFrom = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map(textFrom).join("")
      : "";
const toolPresentation = (toolName: string, source = "") =>
  describeToolKind(toolName, source);
const toolActivity = (
  toolName: string,
  source: string,
  input: Record<string, unknown>,
  result?: unknown,
  description = "",
) =>
  describeToolActivity({
    toolName,
    source,
    input,
    result,
    purpose: description || String(input.description || ""),
    state: result === undefined ? "running" : "completed",
  }).label;
const referenceMeta = (reference: CanvasReference) =>
  reference.kind === "edge"
    ? `${reference.from || "自由端"} → ${reference.to || "自由端"}`
    : `${Math.round(reference.x || 0)}, ${Math.round(reference.y || 0)} · ${Math.round(reference.width || 0)}×${Math.round(reference.height || 0)}`;

const canvasReferencesForSelection = (
  document: BoardDocument,
  selectedIds: string[],
): CanvasReference[] => {
  if (!selectedIds.length) return [];
  const selected = new Set(selectedIds);
  const elements = document.elements.filter((item) => selected.has(item.id));
  const edges = document.edges.filter((item) => selected.has(item.id));
  const elementReferences: CanvasReference[] = elements.length > 1
    ? (() => {
        const x = Math.min(...elements.map((item) => item.x));
        const y = Math.min(...elements.map((item) => item.y));
        const right = Math.max(...elements.map((item) => item.x + item.width));
        const bottom = Math.max(...elements.map((item) => item.y + item.height));
        return [{
          kind: "region",
          id: `region:${elements.map((item) => item.id).join(",")}`,
          label: `当前选区（${elements.length} 个图形）`,
          x,
          y,
          width: right - x,
          height: bottom - y,
          elementIds: elements.map((item) => item.id),
        }];
      })()
    : elements.map((item) => ({
        kind: "element",
        id: item.id,
        label: item.text || item.kind,
        text: item.text || undefined,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      }));
  return [
    ...elementReferences,
    ...edges.map((edge) => ({
      kind: "edge" as const,
      id: edge.id,
      label: edge.label || "未命名连线",
      from: edge.from || undefined,
      to: edge.to || undefined,
    })),
  ];
};
export const appendProcessEvent = (
  items: ChatProcessItem[] = [],
  event: StructuredRunEvent,
): ChatProcessItem[] => {
  const type = event.type.toLowerCase();
  const payload = event.payload || {};
  const sequence = event.sequence;
  const finishRunning = (
    values: ChatProcessItem[],
    status: "success" | "error",
  ) =>
    values.map((item) =>
      item.status === "running" || item.status === "pending"
        ? { ...item, status }
        : item,
    );
  const milestone = (next: ChatProcessItem, replaceId?: string) => {
    const settled = finishRunning(items, "success");
    const index = settled.findIndex(
      (item) => item.id === (replaceId || next.id),
    );
    const merged =
      index >= 0
        ? settled.map((item, at) =>
            at === index
              ? { ...item, ...next, sequence: item.sequence || next.sequence }
              : item,
          )
        : [...settled, next];
    return merged.slice(-8);
  };
  const callId = String(payload.call_id || event.toolCallId || "");
  // A model-call boundary is not user-visible work. Keep the previous real
  // action until this turn emits text or chooses its next tool.
  if (type === "llm.call.started") return items;
  if (type === "run.steered") {
    const count = Array.isArray(payload.instructions)
      ? payload.instructions.length
      : Number(payload.count || 1);
    return milestone({
      id: `steer:${sequence}`,
      kind: "status",
      label: "已接收补充指引",
      detail: `${Math.max(1, count)} 条指引将在当前任务中生效`,
      status: "success",
      sequence,
    });
  }
  if (type === "context.summarization.started")
    return milestone({ id: "context:summary", kind: "status", label: "正在整理对话上下文", detail: "保留任务目标、关键决定和未完成事项", status: "running", sequence }, "context:summary");
  if (type === "context.summarization.completed" || type === "context.summarization.degraded")
    return milestone({ id: "context:summary", kind: "status", label: "已整理对话上下文", detail: type.endsWith("degraded") ? "已使用本地摘要继续任务" : "较早内容已压缩，任务继续运行", status: "success", sequence }, "context:summary");
  if (type === "agent.message.delta") {
    const contentDelta = String(payload.delta || "");
    const streamDelta = String(payload.reasoning_delta || "");
    const delta = contentDelta || streamDelta;
    if (!delta) return items;
    const id = `llm:${callId || sequence}`;
    const label = contentDelta ? "模型回应" : "模型思考";
    // Some providers stream reasoning before content in the same call. Once
    // content arrives it becomes the visible output instead of being appended
    // to the private reasoning stream.
    const current = [...items]
      .reverse()
      .find((item) => item.id === id && item.label === label);
    const combined = `${current?.detail || ""}${delta}`;
    const content = combined.length > 1200 ? `…${combined.slice(-1199)}` : combined;
    return milestone(
      {
        id,
        kind: "thinking",
        label,
        detail: content,
        status: "running",
        sequence: current?.sequence || sequence,
      },
      id,
    );
  }
  if (type === "agent.tool_preparing") {
    const toolName = String(payload.tool_name || payload.name || "");
    const source = String(payload.tool_source || "");
    const id = String(event.toolCallId || payload.tool_call_id || `tool:${sequence}:${toolName}`);
    return milestone(
      {
        id,
        kind: "tool",
        label: toolPresentation(toolName, source),
        detail: `准备${toolActivity(toolName, source, {}, undefined, "").replace(/^正在/, "")}`,
        status: "running",
        sequence,
      },
      id,
    );
  }
  if (type === "agent.tool_arguments.delta") {
    const id = String(event.toolCallId || payload.tool_call_id || "");
    const preview = String(payload.preview || "").trim();
    if (!id || !preview) return items;
    return items.map((item) =>
      item.id === id ? { ...item, detail: `准备：${preview}` } : item,
    );
  }
  if (type === "agent.tool_cancelled") {
    const id = String(event.toolCallId || payload.tool_call_id || "");
    return items.map((item) =>
      item.id === id
        ? { ...item, detail: "本次工具准备已取消，正在调整执行方式", status: "error" }
        : item,
    );
  }
  if (type === "agent.tool_use") {
    const toolName = String(payload.tool_name || payload.name || "");
    const input =
      payload.input && typeof payload.input === "object"
        ? (payload.input as Record<string, unknown>)
        : payload.arguments && typeof payload.arguments === "object"
          ? (payload.arguments as Record<string, unknown>)
          : {};
    const source = String(payload.tool_source || "");
    const description = String(
      payload.purpose ||
        input.description ||
        (source === "mcp" ? payload.tool_description : "") ||
        "",
    );
    const toolEventId = String(
      event.toolCallId ||
        payload.tool_call_id ||
        payload.call_id ||
        `tool:${sequence}:${toolName}`,
    );
    const next = {
      id: toolEventId,
      kind: "tool" as const,
      label: toolPresentation(toolName, source),
      detail: toolActivity(toolName, source, input, undefined, description),
      status: "running" as const,
      sequence,
    };
    return milestone(next);
  }
  if (type === "agent.tool_result") {
    const toolName = String(payload.tool_name || payload.name || "");
    const recovering =
      payload.recoverable === true ||
      String(payload.status || "").toLowerCase() === "recovering";
    const failed =
      !recovering &&
      (payload.is_error === true ||
        String(payload.status || "").toLowerCase() === "error");
    const id = String(
      event.toolCallId ||
        payload.tool_call_id ||
        payload.call_id ||
        `tool:${sequence ? sequence - 1 : ""}:${toolName}`,
    );
    const source = String(payload.tool_source || "");
    const input =
      payload.input && typeof payload.input === "object"
        ? (payload.input as Record<string, unknown>)
        : {};
    const description = String(
      payload.purpose ||
        input.description ||
        (source === "mcp" ? payload.tool_description : "") ||
        "",
    );
    const existing =
      items.find((item) => item.id === id) ||
      [...items]
        .reverse()
        .find(
          (item) =>
            item.kind === "tool" &&
            item.label === toolPresentation(toolName, source) &&
            item.status === "running",
        );
    // A successful tool may intentionally return no content. Pass a sentinel
    // so the activity renderer still moves from “正在…” to “已…”.
    const detail = recovering
      ? "正在修正本次绘图指令并重新执行…"
      : failed
        ? textFrom(
            payload.error_code || payload.error || payload.content,
          ).slice(0, 140)
        : toolActivity(
            toolName,
            source,
            input,
            payload.content ?? {},
            description,
          );
    return milestone(
      {
        id: existing?.id || id,
        kind: "tool",
        label: existing?.label || toolPresentation(toolName, source),
        detail: detail || existing?.detail,
        status: failed ? "error" : recovering ? "running" : "success",
        sequence: existing?.sequence || sequence,
      },
      existing?.id || id,
    );
  }
  if (type.startsWith("plan.")) {
    const rawPlan =
      payload.plan && typeof payload.plan === "object"
        ? (payload.plan as Record<string, unknown>)
        : payload;
    const steps = Array.isArray(rawPlan.steps)
      ? (rawPlan.steps as Array<Record<string, unknown>>)
      : [];
    const completed = steps.filter(
      (step) => String(step.status) === "completed",
    ).length;
    const title = String(rawPlan.title || payload.title || "执行计划");
    const done = type === "plan.completed" || type === "plan.abandoned";
    return milestone(
      {
        id: "plan:current",
        kind: "plan",
        label: done ? "计划已完成" : "正在按计划处理",
        detail: steps.length
          ? `${title} · ${completed}/${steps.length}`
          : title,
        status: done
          ? "success"
          : type === "plan.step.blocked"
            ? "error"
            : "running",
        sequence,
        plan: {
          id: String(rawPlan.plan_id || rawPlan.id || "current"),
          title,
          status: String(rawPlan.status || (done ? "completed" : "active")),
          currentStepId: rawPlan.current_step_id
            ? String(rawPlan.current_step_id)
            : undefined,
          steps: steps.map((step) => ({
            id: String(step.id || ""),
            title: String(step.title || step.description || step.instruction || ""),
            instruction: step.instruction ? String(step.instruction) : undefined,
            resultSummary: step.result_summary || step.resultSummary ? String(step.result_summary || step.resultSummary) : undefined,
            blocker: step.blocker ? String(step.blocker) : undefined,
            status: String(step.status || "pending"),
          })),
        },
      },
      "plan:current",
    );
  }
  if (type === "agent.message.completed") {
    const turnContent = String(
      payload.last_turn_content || payload.content || "",
    );
    if (turnContent)
      return milestone({
        id: `llm:completed:${sequence}`,
        kind: "thinking",
        label: "模型回应",
        detail: turnContent,
        status: "success",
        sequence,
      });
    return finishRunning(items, "success");
  }
  // `invalid_tool_calls` is a provider-stream parser diagnostic, not an MCP
  // action. L4 commonly emits it beside the valid tool call that it then runs
  // successfully. Showing it as a user-facing “recovery” step is misleading;
  // genuine failures are represented by agent.tool_result with is_error.
  if (type === "llm.call.failed") {
    if (payload.recoverable !== true) return items;
    return milestone({
      id: String(payload.call_id || `model:${sequence}`),
      kind: "status",
      label: "正在恢复模型响应",
      detail: String(payload.error_category || "模型响应中断，正在自动重试"),
      status: "running",
      sequence,
    });
  }
  if (type === "session.started")
    return milestone({
      id: event.eventId || `run:${sequence}`,
      kind: "status",
      label: "正在理解需求",
      status: "running",
      sequence,
    });
  if (type === "session.completed" || type === "session.complete")
    return finishRunning(items, "success");
  if (type === "session.failed" || type === "session.interrupted")
    return items.map((item) => ({ ...item, status: "error" }));
  return items;
};

export const restoreAssistantMessage = (
  message: ChatMessage,
  storedEvents: Array<Record<string, unknown>>,
): ChatMessage => {
  const events = storedEvents
    .map((raw) => ({
      type: String(raw.type || ""),
      payload:
        raw.payload && typeof raw.payload === "object"
          ? (raw.payload as Record<string, unknown>)
          : {},
      sequence: Number(raw.sequence || 0),
      eventId: String(raw.event_id || raw.eventId || ""),
      toolCallId:
        raw.tool_call_id || raw.toolCallId
          ? String(raw.tool_call_id || raw.toolCallId)
          : undefined,
    }))
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const process = events.reduce<ChatProcessItem[]>(
    (items, event) => appendProcessEvent(items, event),
    [],
  );
  const runStatus = events.length
    ? events.reduce<ChatRunStatus | undefined>(
        (status, event) => reduceRunPresentation(status, event),
        undefined,
      )
    : message.runStatus;
  const terminal = [...events]
    .reverse()
    .find((event) =>
      [
        "session.completed",
        "session.complete",
        "session.failed",
        "session.interrupted",
      ].includes(event.type.toLowerCase()),
    );
  const completedMessage = [...events]
    .reverse()
    .find((event) => event.type.toLowerCase() === "agent.message.completed");
  const restoredContent =
    message.content || textFrom(completedMessage?.payload.content);
  if (terminal) {
    const failed =
      terminal.type.toLowerCase() !== "session.completed" &&
      terminal.type.toLowerCase() !== "session.complete";
    return {
      ...message,
      process,
      runStatus,
      runSummary: failed ? undefined : summarizeRunPresentation(runStatus),
      pending: false,
      content:
        restoredContent ||
        (failed
          ? textFrom(
              terminal.payload.message || terminal.payload.error_detail,
            ) || "本次操作未完成。"
          : ""),
    };
  }
  return message.pending
    ? {
        ...message,
        process,
        runStatus,
        pending: false,
        content: restoredContent || "上一次 AI 操作在应用关闭前中断。",
      }
    : { ...message, process: process.length ? process : message.process };
};

const modelSaveMessage = (error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  if (/401|authentication|invalid token|api[_ ]?key/i.test(detail))
    return "无法验证模型密钥，请检查后再试。";
  if (/422|validation/i.test(detail))
    return "模型信息不完整或格式不正确，请检查后再试。";
  if (/409|already exists|conflict/i.test(detail))
    return "这个模型已存在，已为你更新现有设置。";
  // Keep the backend status/detail visible. A generic message made it
  // impossible to distinguish a model CRUD failure from bootstrap failure.
  return detail ? `保存失败：${detail}` : "暂时无法保存模型设置，请稍后重试。";
};

export default function App() {
  const [config, setConfig] = useState<TuGoConfig>(defaultConfig);
  const language = useMemo(
    () => effectiveLanguage(config.language),
    [config.language],
  );
  const t = useCallback((key: string) => translate(language, key), [language]);
  const [api, setApi] = useState(() => new TuGoApi(defaultConfig));
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [projects, setProjects] = useState<BoardProject[]>([]);
  const [activeId, setActiveId] = useState("");
  const [history, setHistory] = useState<BoardHistory>({
    current: emptyDocument(),
    past: [],
    future: [],
  });
  const historyRef = useRef(history);
  const activeIdRef = useRef(activeId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [chatReferences, setChatReferences] = useState<CanvasReference[]>([]);
  const [projectPanelOpen, setProjectPanelOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiConfigurationOpen, setAiConfigurationOpen] = useState(false);
  const [dslOpen, setDslOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [snapshotFocusIds, setSnapshotFocusIds] = useState<string[]>([]);
  const [boardVersionPosition, setBoardVersionPosition] = useState({
    x: 18,
    y: 78,
  });
  const [planPosition, setPlanPosition] = useState({ x: 24, y: 132 });
  const [debugTarget, setDebugTarget] = useState<{
    threadId: string;
    runId: string;
  } | null>(null);
  const [textDialog, setTextDialog] = useState<TextDialogState>(null);
  const [exportRegion, setExportRegion] = useState<ExportRegion | null>(null);
  const [exportModeRequest, setExportModeRequest] = useState(0);
  const [batchExportRegions, setBatchExportRegions] = useState<
    ExportRegion[] | null
  >(null);
  const [imageSources, setImageSources] = useState<Record<string, string>>({});
  const [aiPlaybackQueue, setAiPlaybackQueue] = useState<AiCanvasPlayback[]>(
    [],
  );
  const aiPlayback = aiPlaybackQueue[0] || null;
  const [status, setStatus] = useState<BootstrapStatus>(initialStatus);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [enabledSkills, setEnabledSkills] = useState<SkillRecord[]>([]);
  const [projectSkillIds, setProjectSkillIds] = useState<string[]>([]);
  const [projectSkillScopeConfigured, setProjectSkillScopeConfigured] =
    useState(false);
  const [projectSkillsOpen, setProjectSkillsOpen] = useState(false);
  const [conversations, setConversations] = useState<
    Record<string, ProjectConversation[]>
  >({});
  const conversationsRef = useRef(conversations);
  const [activeConversationIds, setActiveConversationIds] = useState<
    Record<string, string>
  >({});
  const [draftModelIds, setDraftModelIds] = useState<Record<string, string>>(
    {},
  );
  const [runningConversationIds, setRunningConversationIds] = useState<
    string[]
  >([]);
  const aiCanvasWork = useMemo<AiCanvasWork | null>(() => {
    if (!activeId) return null;
    const activeRun = (conversations[activeId] || [])
      .map((conversation) => ({
        conversation,
        message: [...conversation.messages]
          .reverse()
          .find((message) => message.role === "assistant" && message.pending),
      }))
      .find((item) => item.message);
    if (!activeRun?.message) return null;
    const status = activeRun.message.runStatus;
    const activity = status?.activity;
    const label =
      activity && activity.status !== "completed"
        ? activity.label
        : status?.headline || "AI 正在处理画板";
    return {
      id: `${activeRun.conversation.id}:${activeRun.message.id}`,
      label: label.replace(/\s+/g, " ").trim().slice(0, 72),
    };
  }, [activeId, conversations, runningConversationIds]);
  // Runtime emits `run.steered` only after it has durably added an in-flight
  // instruction to the Agent context. ChatPanel uses these IDs to move the
  // matching composer queue item into the visible user-message timeline.
  const [consumedSteerRequestIds, setConsumedSteerRequestIds] = useState<
    string[]
  >([]);
  const [downloads, setDownloads] = useState<
    Array<{
      id: string;
      fileName: string;
      path: string;
      status: string;
      received: number;
      total: number;
    }>
  >([]);
  const saveTimer = useRef<number | null>(null);
  const canvasStageRef = useRef<HTMLElement>(null);
  const suppressVersionClickRef = useRef(0);
  const projectsRef = useRef(projects);
  const runCoordinatorRef = useRef(new ConversationRunCoordinator());
  const queuedMessagesRef = useRef(new Map<string, string[]>());
  // A renderer reload does not stop the embedded Runtime. Keep a small
  // run-to-message map so the new renderer can continue receiving the
  // Runtime's existing event stream instead of falsely calling it interrupted.
  const recoveredRunsRef = useRef(
    new Map<
      string,
      {
        projectId: string;
        conversationId: string;
        messageId: string;
        threadId: string;
      }
    >(),
  );

  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);
  useEffect(() => {
    const attachmentIds = [
      ...new Set(
        history.current.elements
          .filter(
            (item) =>
              item.kind === "image" &&
              typeof item.metadata?.attachmentId === "string",
          )
          .map((item) => String(item.metadata?.attachmentId)),
      ),
    ];
    const missing = attachmentIds.filter((id) => !imageSources[id]);
    if (!missing.length || !window.tugo) return;
    let cancelled = false;
    void Promise.all(
      missing.map(
        async (id) =>
          [
            id,
            await api.attachmentImage(id).then((value) => value.data_url),
          ] as const,
      ),
    )
      .then((entries) => {
        if (!cancelled)
          setImageSources((current) => ({
            ...current,
            ...Object.fromEntries(entries),
          }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, history.current.elements, imageSources]);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = config.theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : config.theme;
    };
    apply();
    if (config.theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => apply();
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [config.theme]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = "ltr";
  }, [language]);
  useEffect(() => {
    if (
      config.boardVersionPosition &&
      Number.isFinite(config.boardVersionPosition.x) &&
      Number.isFinite(config.boardVersionPosition.y)
    )
      setBoardVersionPosition(config.boardVersionPosition);
  }, [config.boardVersionPosition?.x, config.boardVersionPosition?.y]);
  useEffect(() => {
    if (
      config.planPosition &&
      Number.isFinite(config.planPosition.x) &&
      Number.isFinite(config.planPosition.y)
    )
      setPlanPosition(config.planPosition);
  }, [config.planPosition?.x, config.planPosition?.y]);
  useEffect(
    () =>
      window.tugo?.system.onDownloadState((state) => {
        setDownloads((current) => {
          const next = current.some((item) => item.id === state.id)
            ? current.map((item) => (item.id === state.id ? state : item))
            : [state, ...current];
          return next.slice(0, 4);
        });
      }),
    [],
  );

  const persistConversation = useCallback(
    (conversation: ProjectConversation) => {
      if (!window.tugo) return Promise.resolve(conversation);
      return window.tugo.conversations
        .save(conversation)
        .catch((error) => {
          if (isStaleConversationSaveError(error)) return conversation;
          throw error;
        });
    },
    [],
  );

  const availableModels = useMemo(
    () => models.filter((model) => model.enabled !== false),
    [models],
  );
  const defaultModelId = useMemo(
    () =>
      availableModels.find((model) => model.is_default)?.model_id ||
      availableModels[0]?.model_id,
    [availableModels],
  );
  const resolveModelId = useCallback(
    (modelId?: string) =>
      availableModels.some((model) => model.model_id === modelId)
        ? modelId
        : defaultModelId,
    [availableModels, defaultModelId],
  );

  // A disabled/deleted model must not keep a conversation pointing at a dead
  // endpoint. Persist the fallback rather than merely resolving it in render.
  useEffect(() => {
    if (!window.tugo || !defaultModelId) return;
    const invalid = Object.values(conversationsRef.current)
      .flat()
      .filter(
        (conversation) =>
          conversation.modelId !== defaultModelId &&
          !availableModels.some(
            (model) => model.model_id === conversation.modelId,
          ),
      );
    if (!invalid.length) return;
    const next = { ...conversationsRef.current };
    for (const conversation of invalid) {
      const updated = {
        ...conversation,
        modelId: defaultModelId,
        updatedAt: new Date().toISOString(),
      };
      next[conversation.projectId] = (next[conversation.projectId] || []).map(
        (item) => (item.id === updated.id ? updated : item),
      );
      void persistConversation(updated);
    }
    conversationsRef.current = next;
    setConversations(next);
  }, [availableModels, defaultModelId, persistConversation]);

  useEffect(() => {
    const runtime = window.tugo?.runtime;
    if (!runtime) return;
    const updateRecovered = (
      runId: string,
      apply: (message: ChatMessage) => ChatMessage,
      finish = false,
    ) => {
      const target = recoveredRunsRef.current.get(runId);
      if (!target) return;
      const current = conversationsRef.current;
      const conversation = (current[target.projectId] || []).find(
        (item) => item.id === target.conversationId,
      );
      if (!conversation) return;
      const updated = {
        ...conversation,
        messages: conversation.messages.map((message) =>
          message.id === target.messageId ? apply(message) : message,
        ),
        updatedAt: new Date().toISOString(),
      };
      const next = {
        ...current,
        [target.projectId]: (current[target.projectId] || []).map((item) =>
          item.id === updated.id ? updated : item,
        ),
      };
      conversationsRef.current = next;
      setConversations(next);
      if (finish) {
        recoveredRunsRef.current.delete(runId);
        runCoordinatorRef.current.finish(target.conversationId);
        setRunningConversationIds((ids) =>
          ids.filter((id) => id !== target.conversationId),
        );
        void persistConversation(updated);
      }
    };
    const removeEvent = runtime.onEvent(({ event }) => {
      const runId = String(event.run_id || "");
      if (!recoveredRunsRef.current.has(runId)) return;
      const type = String(event.type || "").toLowerCase();
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      updateRecovered(
        runId,
        (message) => {
          const structured: StructuredRunEvent = {
            type,
            payload,
            sequence: Number(event.sequence) || undefined,
            toolCallId: event.tool_call_id
              ? String(event.tool_call_id)
              : undefined,
            eventId: event.event_id ? String(event.event_id) : undefined,
          };
          const process = appendProcessEvent(message.process, structured);
          const runStatus = reduceRunPresentation(message.runStatus, structured);
          const delta =
            type === "agent.message.delta" ? textFrom(payload.delta) : "";
          const completed =
            type === "agent.message.completed" ? textFrom(payload.content) : "";
          const terminal = [
            "session.completed",
            "session.complete",
            "session.failed",
            "session.interrupted",
          ].includes(type);
          return {
            ...message,
            process,
            runStatus,
            runSummary: terminal ? summarizeRunPresentation(runStatus) : message.runSummary,
            content:
              completed ||
              (delta ? `${message.content}${delta}` : message.content),
            pending: terminal ? false : true,
          };
        },
        [
          "session.completed",
          "session.complete",
          "session.failed",
          "session.interrupted",
        ].includes(type),
      );
    });
    const removeEnd = runtime.onStreamEnd(({ runId }) => {
      const target = recoveredRunsRef.current.get(runId);
      if (!target) return;
      // Events are durable. Re-read once at the real end so a final message
      // that arrived while the renderer was loading is never lost.
      void api
        .runtimeEvents(target.threadId, runId)
        .then((result) =>
          updateRecovered(
            runId,
            (message) => restoreAssistantMessage(message, result.items),
            true,
          ),
        )
        .catch(() =>
          updateRecovered(
            runId,
            (message) => ({
              ...message,
              pending: false,
              content: message.content || "画板已更新。",
            }),
            true,
          ),
        );
    });
    return () => {
      removeEvent();
      removeEnd();
    };
  }, [api, persistConversation]);

  const load = useCallback(async () => {
    // Keep a previous failure/missing state from flashing while the embedded
    // Runtime opens SQLite and restores conversations.  A configured model is
    // authoritative once inspectBootstrap completes; until then this is a
    // normal startup phase, not a prompt to configure it again.
    setStatus(initialStatus);
    const bridge = window.tugo;
    const loadedConfig = bridge ? await bridge.config.read() : defaultConfig;
    const loadedFolders = bridge
      ? await bridge.folders.list()
      : browserStore.folders;
    const loadedProjects = bridge
      ? await bridge.projects.list()
      : browserStore.projects;
    const conversationIndex: ConversationIndex = bridge
      ? await bridge.conversations.list()
      : { conversations: [], activeConversationIds: {} };
    const client = new TuGoApi(loadedConfig);
    setConfig(loadedConfig);
    setApi(client);
    setFolders(loadedFolders);
    setProjects(loadedProjects);
    // Structured events are the process source of truth. Rebuild completed
    // tool/plan cards after a renderer restart; only a run without a terminal
    // event is treated as interrupted.
    // Do not restore every stored Run in parallel.  Each recovery reads its
    // structured event stream; unbounded Promise.all here can issue dozens of
    // large SQLite reads at startup and previously killed the embedded Worker.
    const restoredConversations: ProjectConversation[] = [];
    const liveRecoveries: Array<{
      projectId: string;
      conversationId: string;
      messageId: string;
      threadId: string;
      runId: string;
    }> = [];
    for (const conversation of conversationIndex.conversations) {
      const messages: ChatMessage[] = [];
      for (const message of conversation.messages) {
        // Completed messages already contain their final text and process
        // projection in the L5 conversation store. Re-reading every historic
        // Run's events here made startup scan the entire Runtime database.
        if (
          !bridge ||
          message.role !== "assistant" ||
          !message.pending ||
          !message.threadId ||
          !message.runId
        ) {
          messages.push(
            message.pending
              ? {
                  ...message,
                  pending: false,
                  content:
                    message.content || "上一次 AI 操作在应用关闭前中断。",
                }
              : message,
          );
          continue;
        }
        try {
          const [events, thread] = await Promise.all([
            client.runtimeEvents(message.threadId, message.runId),
            client.threadStatus(message.threadId),
          ]);
          const restored = restoreAssistantMessage(message, events.items);
          if (thread.active_run_id === message.runId) {
            // The Runtime worker survived the renderer reload. It will keep
            // sending its original subscription's events to this window, so
            // resume the visible message rather than inventing an interruption.
            messages.push({ ...restored, pending: true });
            liveRecoveries.push({
              projectId: conversation.projectId,
              conversationId: conversation.id,
              messageId: message.id,
              threadId: message.threadId,
              runId: message.runId,
            });
          } else messages.push(restored);
        } catch {
          messages.push(
            message.pending
              ? {
                  ...message,
                  pending: false,
                  content:
                    message.content || "上一次 AI 操作在应用关闭前中断。",
                }
              : message,
          );
        }
      }
      restoredConversations.push({ ...conversation, messages });
    }
    for (const conversation of restoredConversations)
      if (bridge) void bridge.conversations.save(conversation);
    setConversations(
      restoredConversations.reduce<Record<string, ProjectConversation[]>>(
        (grouped, conversation) => {
          (grouped[conversation.projectId] ||= []).push(conversation);
          return grouped;
        },
        {},
      ),
    );
    for (const recovered of liveRecoveries) {
      recoveredRunsRef.current.set(recovered.runId, recovered);
      if (!runCoordinatorRef.current.has(recovered.conversationId))
        runCoordinatorRef.current.begin(recovered.conversationId);
      runCoordinatorRef.current.bindRuntimeRun(recovered.conversationId, {
        threadId: recovered.threadId,
        runId: recovered.runId,
      });
    }
    if (liveRecoveries.length)
      setRunningConversationIds((ids) => [
        ...new Set([
          ...ids,
          ...liveRecoveries.map((item) => item.conversationId),
        ]),
      ]);
    setActiveConversationIds(conversationIndex.activeConversationIds);
    if (loadedProjects[0]) {
      setActiveId(loadedProjects[0].id);
      setHistory({
        current: normalizeDocument(loadedProjects[0].document),
        past: [],
        future: [],
      });
    }
    if (!bridge) {
      setStatus(webPreviewStatus);
      return;
    }
    let effectiveConfig = loadedConfig;
    let inspected = await client.inspectBootstrap();
    if (inspected.l4 === "ready") {
      try {
        const availableModels = await client.listModels();
        setModels(availableModels);
        const selectableSkills = (await client.listSkills()).filter(
          (skill) => skill.enabled !== false,
        );
        setEnabledSkills(selectableSkills);
        if (loadedProjects[0]) {
          const scope = await bridge.projects.skillScope(loadedProjects[0].id);
          setProjectSkillIds(scope.skillIds);
          setProjectSkillScopeConfigured(scope.configured);
        }
        const configuredModelStillExists = Boolean(
          effectiveConfig.model?.modelId &&
            availableModels.some(
              (item) =>
                item.model_id === effectiveConfig.model?.modelId &&
                item.enabled !== false,
            ),
        );
        // The model id is scoped to the TuGo tenant/user. If an older
        // config points at a model from another identity, adopt the current
        // user's default instead of leaving the UI stuck at "需要连接模型".
        const existingModel = configuredModelStillExists
          ? undefined
          : availableModels.find(
              (item) => item.is_default && item.enabled !== false,
            ) || availableModels.find((item) => item.enabled !== false);
        if (existingModel && !configuredModelStillExists) {
          effectiveConfig = {
            ...effectiveConfig,
            model: {
              modelId: existingModel.model_id,
              providerId: existingModel.provider_id,
              model: existingModel.model,
              displayName: existingModel.display_name || existingModel.model,
              baseUrl: existingModel.extra_config?.base_url,
              apiPath:
                typeof existingModel.extra_config?.api_path === "string"
                  ? existingModel.extra_config.api_path
                  : undefined,
              contextWindow: Number(
                existingModel.extra_config?.context_window || 128000,
              ),
              maxOutputTokens: Number(
                existingModel.extra_config?.max_output_tokens || 32768,
              ),
              visionCapable:
                existingModel.extra_config?.vision_capable !== false,
            },
            // The Lead Agent must be rebound to the adopted model. Keeping a
            // previous bootstrap marker here would skip that rebinding.
            bootstrap: undefined,
          };
          const persisted = await bridge.config.write(effectiveConfig);
          effectiveConfig = persisted;
          setConfig(persisted);
          client.updateConfig(persisted);
        }
      } catch {
        /* leave the user on the normal AI connection screen */
      }
    }
    // Runtime template version 9 adds durable board snapshots alongside the
    // built-in board tools and binds the selected model to the template Agent.
    if (
      effectiveConfig.model?.modelId &&
      inspected.l4 === "ready" &&
      (!effectiveConfig.bootstrap?.agentId ||
        effectiveConfig.bootstrap?.toolPolicyVersion !== 9 ||
        inspected.skill !== "ready" ||
        inspected.agent !== "ready")
    ) {
      try {
        const resources = await client.bootstrapResources(
          effectiveConfig.model.modelId,
        );
        const next = {
          ...effectiveConfig,
          bootstrap: {
            ready: true,
            agentId: resources.agent.agent_id,
            skillId: resources.skill.skill_id,
            toolPolicyVersion: 9,
          },
        };
        const persisted = bridge ? await bridge.config.write(next) : next;
        setConfig(persisted);
        client.updateConfig(persisted);
        inspected = await client.inspectBootstrap();
      } catch (error) {
        inspected = {
          ...inspected,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    setStatus(inspected);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeId) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const existing = projects.find((project) => project.id === activeId);
      if (!existing) return;
      if (window.tugo) {
        const updated = await window.tugo.projects.update({
          id: activeId,
          document: history.current,
        });
        setProjects((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
      } else {
        setProjects((items) =>
          items.map((item) =>
            item.id === activeId
              ? {
                  ...item,
                  document: history.current,
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
        );
      }
    }, 450);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [activeId, history.current]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncDocumentDsl = (document: ReturnType<typeof normalizeDocument>) => {
    if (document.dsl?.kind !== "mermaid") return document;
    return {
      ...document,
      dsl: {
        ...document.dsl,
        source: toMermaid(document),
        updatedAt: new Date().toISOString(),
      },
    };
  };
  const commitOperations = useCallback(
    (operations: BoardOperation[]) =>
      setHistory((current) => {
        const next = commit(current, operations);
        return { ...next, current: syncDocumentDsl(next.current) };
      }),
    [],
  );
  const completeAiPlayback = useCallback(
    (id: string) =>
      setAiPlaybackQueue((current) =>
        current[0]?.id === id
          ? current.slice(1)
          : current.filter((item) => item.id !== id),
      ),
    [],
  );
  const performUndo = useCallback(
    () => setHistory((current) => undo(current)),
    [],
  );
  const performRedo = useCallback(
    () => setHistory((current) => redo(current)),
    [],
  );
  const addImagesToBoard = useCallback(
    async (paths: string[], point: { x: number; y: number }) => {
      if (!window.tugo) {
        window.alert("添加图片需要在 TuGo 桌面应用中进行。");
        return;
      }
      const imagePaths = paths.filter((path) =>
        /\.(png|jpe?g|webp|gif)$/i.test(path),
      );
      if (!imagePaths.length) return;
      try {
        const operations: BoardOperation[] = [];
        const sources: Record<string, string> = {};
        for (const [index, path] of imagePaths.entries()) {
          const imported = await api.importAttachment(path);
          const source = await api.attachmentImage(imported.attachment_id);
          sources[imported.attachment_id] = source.data_url;
          const width = 320,
            height = 220;
          operations.push({
            op: "add_element",
            element: {
              id: newId("image"),
              kind: "image",
              x: point.x - width / 2 + index * 28,
              y: point.y - height / 2 + index * 28,
              width,
              height,
              text: "",
              fill: "#F1F5F9",
              stroke: "#64748B",
              strokeWidth: 1,
              fontSize: 14,
              zIndex: historyRef.current.current.elements.length + index,
              metadata: {
                attachmentId: imported.attachment_id,
                attachmentName: imported.name,
                projectId: activeIdRef.current,
              },
            },
          });
        }
        setImageSources((current) => ({ ...current, ...sources }));
        if (operations.length) commitOperations(operations);
      } catch (error) {
        window.alert(
          `添加图片失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [api, commitOperations],
  );
  const addImageToBoard = useCallback(
    async (point: { x: number; y: number }) => {
      if (!window.tugo) {
        window.alert("添加图片需要在 TuGo 桌面应用中进行。");
        return;
      }
      await addImagesToBoard(
        await window.tugo.system.chooseAttachments(),
        point,
      );
    },
    [addImagesToBoard],
  );
  const addCanvasReferencesToChat = useCallback((references: CanvasReference[]) => {
    setChatReferences((current) => [
      ...current,
      ...references.filter(
        (reference) =>
          !current.some(
            (item) =>
              item.kind === reference.kind && item.id === reference.id,
          ),
      ),
    ]);
    setChatOpen(true);
  }, []);
  const selectedCanvasReferences = useMemo(
    () => canvasReferencesForSelection(history.current, selectedIds),
    [history.current, selectedIds],
  );

  const persistProjectDocument = useCallback(
    async (
      projectId: string,
      document: ReturnType<typeof normalizeDocument>,
    ) => {
      const project = projectsRef.current.find((item) => item.id === projectId);
      if (!project) throw new Error("找不到目标项目，已停止本次画布操作。");
      const updated = {
        ...project,
        document,
        updatedAt: new Date().toISOString(),
      };
      const nextProjects = projectsRef.current.map((item) =>
        item.id === projectId ? updated : item,
      );
      projectsRef.current = nextProjects;
      setProjects(nextProjects);
      if (window.tugo)
        await window.tugo.projects.update({ id: projectId, document });
    },
    [],
  );

  const saveManualSnapshot = async (value: { name: string; notes: string }) => {
    if (!activeProject || !window.tugo)
      throw new Error("快照仅在桌面应用中可用");
    const snapshot = await window.tugo.projects.snapshots.create({
      projectId: activeProject.id,
      source: "user",
      document: historyRef.current.current,
      ...value,
    });
    return snapshot;
  };
  const importSnapshot = async (file?: File) => {
    if (!activeProject || !window.tugo)
      throw new Error("快照导入仅在桌面应用中可用");
    return window.tugo.projects.snapshots.import(activeProject.id, file);
  };
  const applySnapshotDocument = (document: BoardDocument, importedImageSources: Record<string, string>) => {
    const imported = normalizeDocument(document);
    setHistory((current) => {
      const next = insertDslDocument(current.current, imported);
      return commit(current, [{ op: "replace_document", document: next }]);
    });
    setImageSources((current) => ({ ...current, ...importedImageSources }));
    setDslOpen(false);
  };
  const restoreSnapshot = async (document: BoardDocument) => {
    if (!activeProject) return;
    if (
      !window.confirm(
        "将此快照恢复为当前画板？当前内容不会自动删除，但会被保留在本地撤销历史中。",
      )
    )
      return;
    const restored = normalizeDocument(document);
    setHistory((current) =>
      commit(current, [{ op: "replace_document", document: restored }]),
    );
    await persistProjectDocument(activeProject.id, restored);
  };
  const createProjectFromSnapshot = async (
    name: string,
    document: BoardDocument,
  ) => {
    if (!activeProject || !window.tugo) return;
    const existing = new Set(projectsRef.current.map((item) => item.name));
    const base = `${name} · 版本`;
    let nextName = base;
    let suffix = 2;
    while (existing.has(nextName)) nextName = `${base} (${suffix++})`;
    const created = await window.tugo.projects.create({
      name: nextName,
      folderId: activeProject.folderId,
      document: normalizeDocument(document),
    });
    if (projectSkillScopeConfigured)
      await window.tugo.projects.setSkillIds(created.id, projectSkillIds);
    setProjects((current) => [created, ...current]);
    openProject(created);
    setSnapshotsOpen(false);
  };
  const startBoardVersionDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stage = canvasStageRef.current;
    if (!stage) return;
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      position: boardVersionPosition,
      dragged: false,
    };
    const move = (pointer: PointerEvent) => {
      if (
        !start.dragged &&
        Math.hypot(
          pointer.clientX - start.clientX,
          pointer.clientY - start.clientY,
        ) < 5
      )
        return;
      start.dragged = true;
      pointer.preventDefault();
      const rect = stage.getBoundingClientRect();
      const next = {
        x: Math.max(
          8,
          Math.min(
            rect.width - 92,
            start.position.x + pointer.clientX - start.clientX,
          ),
        ),
        y: Math.max(
          8,
          Math.min(
            rect.height - 50,
            start.position.y + pointer.clientY - start.clientY,
          ),
        ),
      };
      setBoardVersionPosition(next);
    };
    const end = (pointer: PointerEvent) => {
      move(pointer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      if (!start.dragged) return;
      suppressVersionClickRef.current = Date.now() + 300;
      const rect = stage.getBoundingClientRect();
      const next = {
        x: Math.max(
          8,
          Math.min(
            rect.width - 92,
            start.position.x + pointer.clientX - start.clientX,
          ),
        ),
        y: Math.max(
          8,
          Math.min(
            rect.height - 50,
            start.position.y + pointer.clientY - start.clientY,
          ),
        ),
      };
      if (window.tugo)
        void window.tugo.config
          .write({ boardVersionPosition: next })
          .then((value) => setConfig(value))
          .catch(() => undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  const startPlanDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const stage = canvasStageRef.current;
    if (!stage) return;
    const start = { clientX: event.clientX, clientY: event.clientY, position: planPosition, dragged: false };
    const positionFor = (pointer: PointerEvent) => {
      const rect = stage.getBoundingClientRect();
      return {
        x: Math.max(8, Math.min(rect.width - 340, start.position.x + pointer.clientX - start.clientX)),
        y: Math.max(72, Math.min(rect.height - 120, start.position.y + pointer.clientY - start.clientY)),
      };
    };
    const move = (pointer: PointerEvent) => {
      if (!start.dragged && Math.hypot(pointer.clientX - start.clientX, pointer.clientY - start.clientY) < 5) return;
      start.dragged = true;
      pointer.preventDefault();
      setPlanPosition(positionFor(pointer));
    };
    const end = (pointer: PointerEvent) => {
      move(pointer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      if (!start.dragged) return;
      const next = positionFor(pointer);
      if (window.tugo)
        void window.tugo.config.write({ planPosition: next }).then((value) => setConfig(value)).catch(() => undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };

  // MCP results become part of the next model turn. Returning the complete
  // persisted document also returns a potentially enormous Mermaid source and
  // every visual-style field, which made a large board cost 10k+ tokens per
  // read. GLM then sometimes emitted a second, truncated tool JSON beside the
  // correct call. Give the Agent the editable facts it needs, not the storage
  // representation. It can query a specific item when a compact list is not
  // enough.
  const compactBoardSnapshot = (
    document: ReturnType<typeof normalizeDocument>,
  ) => {
    const maxItems = 80;
    const elements = document.elements.slice(0, maxItems).map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      groupId: item.groupId,
      ...(item.kind === "image" &&
      typeof item.metadata?.attachmentId === "string"
        ? {
            image_attachment_id: item.metadata.attachmentId,
            image_name: item.metadata.attachmentName,
          }
        : {}),
    }));
    const knownIds = new Set(elements.map((item) => item.id));
    const edges = document.edges
      .filter((edge) => knownIds.has(edge.from) || knownIds.has(edge.to))
      .slice(0, maxItems)
      .map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        label: edge.label,
      }));
    return {
      version: document.version,
      paletteId: document.paletteId,
      viewport: document.viewport,
      element_count: document.elements.length,
      edge_count: document.edges.length,
      truncated:
        document.elements.length > maxItems || document.edges.length > maxItems,
      elements,
      edges,
      dsl: document.dsl
        ? { kind: document.dsl.kind, updatedAt: document.dsl.updatedAt }
        : undefined,
    };
  };

  const boardCaptureRegion = (
    document: ReturnType<typeof normalizeDocument>,
    args: Record<string, unknown>,
  ): ExportRegion => {
    const numeric = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const requested = {
      x: numeric(args.x),
      y: numeric(args.y),
      width: numeric(args.width),
      height: numeric(args.height),
    };
    if (
      requested.x !== undefined &&
      requested.y !== undefined &&
      requested.width !== undefined &&
      requested.height !== undefined
    ) {
      if (
        requested.width <= 0 ||
        requested.height <= 0 ||
        requested.width > 12_000 ||
        requested.height > 12_000
      )
        throw new Error("截图区域宽高必须在 1–12000 之间");
      return {
        x: requested.x,
        y: requested.y,
        width: requested.width,
        height: requested.height,
      };
    }
    const items = document.elements;
    if (!items.length) return { x: -80, y: -80, width: 640, height: 420 };
    const padding = 72;
    const left = Math.min(...items.map((item) => item.x)) - padding;
    const top = Math.min(...items.map((item) => item.y)) - padding;
    const right =
      Math.max(...items.map((item) => item.x + item.width)) + padding;
    const bottom =
      Math.max(...items.map((item) => item.y + item.height)) + padding;
    return {
      x: left,
      y: top,
      width: Math.min(12_000, right - left),
      height: Math.min(12_000, bottom - top),
    };
  };

  useEffect(
    () =>
      window.tugo?.board.onToolCall(
        async ({ id, name, args, context }) => {
          try {
            const projectId = String(args.project_id || "").trim();
            if (!projectId)
              throw new Error("每次画布工具调用都必须提供 project_id。");
            if (String(context.project_id || "") !== projectId)
              throw new Error("画板工具的 Run 上下文与 project_id 不一致。");
            const conversationId = String(context.conversation_id || "");
            const threadId = String(context.thread_id || "");
            const boundConversation = Object.values(conversationsRef.current)
              .flat()
              .find((item) => item.id === conversationId);
            if (
              !boundConversation ||
              boundConversation.projectId !== projectId ||
              boundConversation.threadId !== threadId
            )
              throw new Error("画板工具与当前会话绑定不一致，已拒绝操作。");
            const project = projectsRef.current.find(
              (item) => item.id === projectId,
            );
            if (!project)
              throw new Error("project_id 不属于当前 TuGo 项目。");
            const document =
              projectId === activeIdRef.current
                ? historyRef.current.current
                : normalizeDocument(project.document);
            if (name === "board_create_snapshot") {
              const snapshot =
                await window.tugo?.projects.snapshots.create({
                  projectId,
                  source: "agent",
                  name: String(args.name || ""),
                  reason: String(args.reason || ""),
                  summary: String(args.summary || ""),
                  notes: String(args.notes || ""),
                  document,
                });
              if (!snapshot) throw new Error("快照服务不可用");
              window.tugo?.board.respondToolCall(id, {
                ok: true,
                snapshot_id: snapshot.id,
                snapshot_name: snapshot.name,
                created_at: snapshot.createdAt,
                message: `已保存画布快照“${snapshot.name}”，时间为 ${snapshot.createdAt}。`,
              });
              return;
            }
            if (name === "board_list_snapshots") {
              const source =
                args.source === "user"
                  ? "user"
                  : args.source === "agent"
                    ? "agent"
                    : null;
              if (!source)
                throw new Error("查询快照时必须指定 source 为 user 或 agent");
              const snapshots =
                await window.tugo?.projects.snapshots.list(
                  projectId,
                  Number(args.page || 1),
                  Number(args.page_size || 10),
                  source,
                );
              if (!snapshots) throw new Error("快照服务不可用");
              window.tugo?.board.respondToolCall(id, {
                ok: true,
                ...snapshots,
              });
              return;
            }
            if (name === "board_get_snapshot") {
              const snapshot = await window.tugo?.projects.snapshots.get(
                projectId,
                String(args.snapshot_id || ""),
              );
              if (!snapshot) throw new Error("快照服务不可用");
              window.tugo?.board.respondToolCall(id, {
                ok: true,
                snapshot,
              });
              return;
            }
            if (name === "board_get_state") {
              window.tugo?.board.respondToolCall(id, {
                ok: true,
                projectId,
                board: compactBoardSnapshot(document),
              });
              return;
            }
            if (name === "board_query_elements") {
              const query = String(args.text || "").toLowerCase();
              const region =
                args.region && typeof args.region === "object"
                  ? (args.region as Record<string, unknown>)
                  : undefined;
              const connectedTo = String(args.connected_to || "");
              const connectedIds = connectedTo
                ? new Set(
                    document.edges
                      .filter(
                        (edge) =>
                          edge.from === connectedTo || edge.to === connectedTo,
                      )
                      .flatMap((edge) => [edge.from, edge.to]),
                  )
                : undefined;
              const container = args.container_id
                ? document.elements.find(
                    (item) => item.id === String(args.container_id),
                  )
                : undefined;
              const inRegion = (item: BoardElement) =>
                !region ||
                (item.x < Number(region.x) + Number(region.width) &&
                  item.x + item.width > Number(region.x) &&
                  item.y < Number(region.y) + Number(region.height) &&
                  item.y + item.height > Number(region.y));
              const inContainer = (item: BoardElement) =>
                !container ||
                item.groupId === container.id ||
                (item.id !== container.id &&
                  item.x >= container.x &&
                  item.y >= container.y &&
                  item.x + item.width <= container.x + container.width &&
                  item.y + item.height <= container.y + container.height);
              const allElements = document.elements.filter(
                (item) =>
                  (!args.id || item.id === args.id) &&
                  (!args.kind || item.kind === args.kind) &&
                  (!query ||
                    String(item.text || "")
                      .toLowerCase()
                      .includes(query)) &&
                  (!connectedIds || connectedIds.has(item.id)) &&
                  inRegion(item) &&
                  inContainer(item),
              );
              const allEdges = document.edges.filter(
                (item) =>
                  (!args.id || item.id === args.id) &&
                  (!connectedTo ||
                    item.from === connectedTo ||
                    item.to === connectedTo),
              );
              const pageSize = Math.max(
                1,
                Math.min(100, Number(args.page_size || 40)),
              );
              const offset = Math.max(
                0,
                Number.parseInt(String(args.cursor || "0"), 10) || 0,
              );
              const combined = [
                ...allElements.map((value) => ({
                  type: "element" as const,
                  value,
                })),
                ...allEdges.map((value) => ({ type: "edge" as const, value })),
              ];
              const page = combined.slice(offset, offset + pageSize);
              const elements = page
                .filter((item) => item.type === "element")
                .map((item) => item.value as BoardElement);
              const edges = page
                .filter((item) => item.type === "edge")
                .map((item) => item.value as BoardDocument["edges"][number]);
              const nextOffset = offset + page.length;
              window.tugo?.board.respondToolCall(id, {
                ok: true,
                projectId,
                elements,
                edges,
                total: combined.length,
                element_total: allElements.length,
                edge_total: allEdges.length,
                truncated: nextOffset < combined.length,
                next_cursor:
                  nextOffset < combined.length ? String(nextOffset) : null,
              });
              return;
            }
            if (name === "board_review_quality") {
              window.tugo?.board.respondToolCall(id, {
                ok: true,
                projectId,
                board: compactBoardSnapshot(document),
                layout_reflection: reflectDiagram(document),
              });
              return;
            }
            if (name === "board_capture_image") {
              const region = boardCaptureRegion(document, args);
              const image = await renderRegionPngDataUrl(document, region);
              window.tugo?.board.respondToolCall(id, {
                ok: true,
                projectId,
                mime_type: "image/png",
                image_base64: image.base64,
                region,
                width: image.width,
                height: image.height,
                scale: image.scale,
              });
              return;
            }
            if (name === "board_export_pptx") {
              const rawRegions = Array.isArray(args.regions) ? args.regions : [];
              const regions = rawRegions.map((value) => {
                const region = value as Record<string, unknown>;
                return {
                  x: Number(region.x), y: Number(region.y),
                  width: Number(region.width), height: Number(region.height),
                };
              });
              if (!regions.length || regions.some((region) => !Number.isFinite(region.x) || !Number.isFinite(region.y) || region.width <= 0 || region.height <= 0)) throw new Error("PPT 页面区域无效");
              const name = String(args.name || "TuGo 演示稿").trim().replace(/\.pptx$/i, "") || "TuGo 演示稿";
              const pptxBase64 = await buildRegionsPptxBase64(document, regions, name);
              window.tugo?.board.respondToolCall(id, {
                ok: true,
                projectId,
                name: `${name}.pptx`,
                mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                pptx_base64: pptxBase64,
                page_count: regions.length,
              });
              return;
            }
            let nextDocument = document;
            let historyAlreadyUpdated = false;
            let playbackOperations: BoardOperation[] | undefined;
            if (name === "board_undo" || name === "board_redo") {
              if (projectId !== activeIdRef.current)
                throw new Error(
                  "该项目当前未打开，不能撤销或重做；请先打开该项目后重试。",
                );
              const nextHistory =
                name === "board_undo"
                  ? undo(historyRef.current)
                  : redo(historyRef.current);
              nextDocument = nextHistory.current;
              historyAlreadyUpdated = true;
              setHistory(nextHistory);
            } else if (name === "board_optimize_layout") {
              playbackOperations = optimizeDiagramLayout(
                document,
                args.scope === "full" ? "full" : "local",
              );
              nextDocument = commit(
                { current: document, past: [], future: [] },
                playbackOperations,
              ).current;
            } else if (name === "board_patch_dsl") {
              nextDocument = insertDslDocument(
                document,
                parseDsl(args.kind as DslKind, String(args.source || "")),
              );
              playbackOperations = [
                { op: "replace_document", document: nextDocument },
              ];
            } else {
              const raw =
                name === "board_batch" ? args.operations : [args.operation];
              if (!Array.isArray(raw)) throw new Error("operations 必须是数组");
              if (name === "board_batch" && raw.length > 12)
                throw new Error(
                  "一次 board_batch 最多 12 项操作；请分批继续。",
                );
              playbackOperations = raw as BoardOperation[];
              nextDocument = commit(
                { current: document, past: [], future: [] },
                playbackOperations,
              ).current;
            }
            nextDocument = syncDocumentDsl(nextDocument);
            if (projectId === activeIdRef.current && !historyAlreadyUpdated)
              setHistory((current) =>
                commit(current, [
                  { op: "replace_document", document: nextDocument },
                ]),
              );
            if (
              projectId === activeIdRef.current &&
              playbackOperations?.length
            ) {
              const intent = String(args.description || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 42);
              setAiPlaybackQueue((current) =>
                [
                  ...current,
                  {
                    id: `ai_${id}`,
                    base: current.length
                      ? applyBoardOperations(
                          current.at(-1)!.base,
                          current.at(-1)!.operations,
                        )
                      : document,
                    operations: playbackOperations,
                    label: intent || "AI 正在绘制",
                  },
                ].slice(-8),
              );
            }
            await persistProjectDocument(projectId, nextDocument);
            // Keep every mutation informed by a short local geometry signal, without
            // turning it into a full review round. The Agent chooses when the draft
            // is complete enough to call board_review_quality for the full audit.
            const localAudit = reflectDiagram(nextDocument);
            const layoutFeedback = localAudit.checked
              ? {
                  score: localAudit.score,
                  summary: localAudit.summary,
                  issues: localAudit.issues.slice(0, 3),
                  suggestions: localAudit.suggestions.slice(0, 2),
                }
              : undefined;
            window.tugo?.board.respondToolCall(id, {
              ok: true,
              projectId,
              operation: name,
              element_count: nextDocument.elements.length,
              edge_count: nextDocument.edges.length,
              message:
                "画板已更新。若要核对结果，请调用 board_get_state 或 board_query_elements。",
              ...(layoutFeedback ? { layout_feedback: layoutFeedback } : {}),
            });
          } catch (error) {
            window.tugo?.board.respondToolCall(
              id,
              undefined,
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      ),
    [persistProjectDocument],
  );

  const openProject = (project: BoardProject) => {
    setActiveId(project.id);
    setHistory({
      current: normalizeDocument(project.document),
      past: [],
      future: [],
    });
    setSelectedIds([]);
    setChatReferences([]);
    if (window.tugo)
      void window.tugo.projects
        .skillScope(project.id)
        .then((scope) => {
          setProjectSkillIds(scope.skillIds);
          setProjectSkillScopeConfigured(scope.configured);
        })
        .catch(() => {
          setProjectSkillIds([]);
          setProjectSkillScopeConfigured(false);
        });
    else {
      setProjectSkillIds([]);
      setProjectSkillScopeConfigured(false);
    }
  };
  const createProject = async (folderId: string | null = null) => {
    const baseName = "未命名画板";
    const existingNames = new Set(
      projects.map((project) => project.name.trim()),
    );
    const relatedCount = projects.filter(
      (project) =>
        project.name === baseName || /^未命名画板\(\d+\)$/.test(project.name),
    ).length;
    let suggestedName = existingNames.has(baseName)
      ? `${baseName}(${relatedCount})`
      : baseName;
    let suffix = Math.max(1, relatedCount);
    while (existingNames.has(suggestedName))
      suggestedName = `${baseName}(${++suffix})`;
    setTextDialog({
      title: "新建画板",
      label: "画板名称",
      initialValue: suggestedName,
      confirmLabel: "创建",
      onConfirm: async (name) => {
        const payload = {
          name: name.trim() || suggestedName,
          folderId,
          document: emptyDocument(),
        };
        const project = window.tugo
          ? await window.tugo.projects.create(payload)
          : {
              ...payload,
              id: newId("project"),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
        setProjects((items) => [project, ...items]);
        openProject(project);
      },
    });
  };
  const renameProject = async (project: BoardProject) => {
    setTextDialog({
      title: "重命名画板",
      label: "画板名称",
      initialValue: project.name,
      confirmLabel: "保存",
      onConfirm: async (name) => {
        const updated = window.tugo
          ? await window.tugo.projects.update({ id: project.id, name })
          : { ...project, name };
        setProjects((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
      },
    });
  };
  const removeProject = async (project: BoardProject) => {
    if (!window.confirm(`删除“${project.name}”？此操作不能撤销。`)) return;
    if (window.tugo) await window.tugo.projects.remove(project.id);
    const next = projects.filter((item) => item.id !== project.id);
    setProjects(next);
    if (activeId === project.id && next[0]) openProject(next[0]);
  };
  const createFolder = async () => {
    setTextDialog({
      title: "新建文件夹",
      label: "文件夹名称",
      initialValue: "新文件夹",
      confirmLabel: "创建",
      onConfirm: async (name) => {
        const folder = window.tugo
          ? await window.tugo.folders.create(name)
          : {
              id: newId("folder"),
              name,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
        setFolders((items) => [...items, folder]);
      },
    });
  };
  const renameFolder = async (folder: ProjectFolder) => {
    setTextDialog({
      title: "重命名文件夹",
      label: "文件夹名称",
      initialValue: folder.name,
      confirmLabel: "保存",
      onConfirm: async (name) => {
        const updated = window.tugo
          ? await window.tugo.folders.rename(folder.id, name)
          : { ...folder, name };
        setFolders((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
      },
    });
  };
  const removeFolder = async (folder: ProjectFolder) => {
    if (!window.confirm(`删除文件夹“${folder.name}”？其中项目会移到未分类。`))
      return;
    if (window.tugo) await window.tugo.folders.remove(folder.id);
    setFolders((items) => items.filter((item) => item.id !== folder.id));
    setProjects((items) =>
      items.map((item) =>
        item.folderId === folder.id ? { ...item, folderId: null } : item,
      ),
    );
  };
  const moveProject = async (
    project: BoardProject,
    folderId: string | null,
  ) => {
    const updated = window.tugo
      ? await window.tugo.projects.update({ id: project.id, folderId })
      : { ...project, folderId };
    setProjects((items) =>
      items.map((item) => (item.id === updated.id ? updated : item)),
    );
  };
  const activeProject = projects.find((project) => project.id === activeId);
  const effectiveProjectSkillIds = projectSkillScopeConfigured
    ? projectSkillIds
    : enabledSkills.map((skill) => skill.skill_id);
  const activeConversation = (conversations[activeId] || []).find(
    (conversation) => conversation.id === activeConversationIds[activeId],
  );
  const activeCanvasRun = useMemo(() => {
    if (
      !activeConversation ||
      !runningConversationIds.includes(activeConversation.id)
    )
      return undefined;
    const activeAssistantMessage = [...activeConversation.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.pending);
    return activeAssistantMessage?.runStatus;
  }, [activeConversation, runningConversationIds]);
  const activeCanvasPlan = activeCanvasRun?.plan;
  const selectedConversationModelId = resolveModelId(
    activeConversation?.modelId || draftModelIds[activeId],
  );
  const saveProjectSkillScope = async (skillIds: string[]) => {
    if (!activeProject || !window.tugo) return;
    const enabledIds = new Set(enabledSkills.map((skill) => skill.skill_id));
    const nextIds = [...new Set(skillIds.filter((id) => enabledIds.has(id)))];
    await window.tugo.projects.setSkillIds(activeProject.id, nextIds);
    setProjectSkillIds(nextIds);
    setProjectSkillScopeConfigured(true);
    await Promise.all(
      (conversationsRef.current[activeProject.id] || []).flatMap(
        (conversation) =>
          conversation.threadId
            ? [api.updateThreadSkillScope(conversation.threadId, nextIds)]
            : [],
      ),
    );
  };
  const configureProjectSkills = async (project: BoardProject) => {
    openProject(project);
    const [skills, scope] = await Promise.all([
      api.listSkills(),
      window.tugo?.projects.skillScope(project.id),
    ]);
    setEnabledSkills(skills.filter((skill) => skill.enabled !== false));
    setProjectSkillIds(scope?.skillIds || []);
    setProjectSkillScopeConfigured(Boolean(scope?.configured));
    setProjectSkillsOpen(true);
  };
  const selectConversationModel = async (modelId: string) => {
    const conversationId = activeConversationIds[activeId];
    const selected = resolveModelId(modelId);
    if (!selected) return;
    const current = (conversationsRef.current[activeId] || []).find(
      (item) => item.id === conversationId,
    );
    if (!current) {
      setDraftModelIds((current) => ({ ...current, [activeId]: selected }));
      return;
    }
    if (current.modelId === selected) return;
    const updated = {
      ...current,
      modelId: selected,
      updatedAt: new Date().toISOString(),
    };
    const next = {
      ...conversationsRef.current,
      [activeId]: (conversationsRef.current[activeId] || []).map((item) =>
        item.id === updated.id ? updated : item,
      ),
    };
    conversationsRef.current = next;
    setConversations(next);
    await persistConversation(updated);
  };

  const applyDsl = (kind: DslKind, source: string) => {
    // Parse before scheduling a React state update. A malformed DSL must be
    // reported by the import dialog, never surface later from a state updater
    // and blank the entire workspace.
    const imported = parseDsl(kind, source);
    setHistory((current) => {
      const document = insertDslDocument(current.current, imported);
      return commit(current, [{ op: "replace_document", document }]);
    });
    setDslOpen(false);
  };
  const saveModel = async (input: {
    modelId?: string;
    providerId: string;
    model: string;
    displayName: string;
    apiKey: string;
    baseUrl?: string;
    apiPath?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    visionCapable?: boolean;
    isDefault?: boolean;
  }) => {
    if (!window.tugo)
      throw new Error(
        "浏览器模式仅用于预览画布。请执行 npm run dev，在 TuGo 桌面窗口中配置模型。",
      );
    let saved;
    try {
      saved = await api.saveModel(input);
    } catch (error) {
      throw new Error(
        `模型保存失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const shouldAdopt = saved.is_default || !config.model?.modelId;
    const savedModel: TuGoConfig = {
      ...config,
      ...(shouldAdopt
        ? {
            model: {
              providerId: input.providerId,
              model: input.model,
              displayName: input.displayName,
              baseUrl: input.baseUrl,
              apiPath: input.apiPath,
              contextWindow: input.contextWindow,
              maxOutputTokens: input.maxOutputTokens,
              visionCapable: input.visionCapable,
              modelId: saved.model_id,
            },
          }
        : {}),
      selectedModelId: config.selectedModelId || saved.model_id,
    };
    let persistedModel: TuGoConfig;
    try {
      persistedModel = await window.tugo.config.write(savedModel);
    } catch (error) {
      throw new Error(
        `模型已保存，但本地配置写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    setConfig(persistedModel);
    api.updateConfig(persistedModel);
    let resources;
    try {
      resources = await api.bootstrapResources(
        saved.is_default || !config.bootstrap?.agentId
          ? saved.model_id
          : config.model?.modelId || saved.model_id,
      );
    } catch (error) {
      const inspected = await api.inspectBootstrap();
      setStatus({
        ...inspected,
        message: `模型已保存，但 Agent 初始化失败：${error instanceof Error ? error.message : String(error)}`,
      });
      throw new Error(
        `模型已保存，但 Agent 初始化失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const next = {
      ...persistedModel,
      bootstrap: {
        ready: true,
        agentId: resources.agent.agent_id,
        skillId: resources.skill.skill_id,
        toolPolicyVersion: 9,
      },
    };
    const persisted = await window.tugo.config.write(next);
    setConfig(persisted);
    api.updateConfig(persisted);
    setModels(await api.listModels());
    setStatus(await api.inspectBootstrap());
    return saved;
  };

  const setDefaultModel = async (model: ModelRecord) => {
    const saved = await api.setDefaultModel(model);
    const savedModel: TuGoConfig = {
      ...config,
      model: {
        providerId: saved.provider_id,
        model: saved.model,
        displayName: saved.display_name,
        baseUrl: String(saved.extra_config?.base_url || ""),
        apiPath: String(saved.extra_config?.api_path || ""),
        contextWindow: Number(saved.extra_config?.context_window || 128000),
        maxOutputTokens: Number(saved.extra_config?.max_output_tokens || 32768),
        visionCapable: saved.extra_config?.vision_capable === true,
        modelId: saved.model_id,
      },
      selectedModelId: saved.model_id,
    };
    const persisted = await window.tugo!.config.write(savedModel);
    setConfig(persisted);
    api.updateConfig(persisted);
    const resources = await api.bootstrapResources(saved.model_id);
    const withBootstrap = await window.tugo!.config.write({
      ...persisted,
      bootstrap: {
        ready: true,
        agentId: resources.agent.agent_id,
        skillId: resources.skill.skill_id,
        toolPolicyVersion: 9,
      },
    });
    setConfig(withBootstrap);
    api.updateConfig(withBootstrap);
    setModels(await api.listModels());
    setStatus(await api.inspectBootstrap());
  };

  const sendMessage = async (
    content: string,
    attachments: ChatAttachment[] = [],
    references: CanvasReference[] = [],
    target?: {
      project: BoardProject;
      conversation: ProjectConversation;
      replaceStoppedRun?: boolean;
    },
    skillMentions: ChatSkillMention[] = [],
  ) => {
    // A canvas reference is a valid user request on its own.  Keep this guard
    // in sync with the composer, which intentionally enables Send when the
    // user has selected an object but has not typed additional instructions.
    const targetProject = target?.project || activeProject;
    if (
      !targetProject ||
      (!content.trim() && !attachments.length && !references.length)
    )
      return;
    if (!config.model?.modelId || !config.bootstrap?.agentId) {
      setSettingsOpen(true);
      return;
    }
    const projectId = targetProject.id;
    if (
      (conversations[projectId] || []).some((conversation) =>
        runningConversationIds.includes(conversation.id) &&
        (!target?.replaceStoppedRun || conversation.id !== target.conversation.id),
      )
    )
      return;
    // During replay React has not necessarily rendered the rewritten history.
    // Use it directly so the outgoing request cannot read stale conversation state.
    let conversation =
      target?.conversation ||
      (conversationsRef.current[projectId] || []).find(
        (item) => item.id === activeConversationIds[projectId],
      );
    if (!conversation) {
      if (!window.tugo) return;
      conversation = await window.tugo.conversations.create(projectId);
      conversation = {
        ...conversation,
        modelId: resolveModelId(draftModelIds[projectId]),
      };
      await persistConversation(conversation);
      const nextConversations = {
        ...conversationsRef.current,
        [projectId]: [
          ...(conversationsRef.current[projectId] || []),
          conversation as ProjectConversation,
        ],
      };
      conversationsRef.current = nextConversations;
      setConversations(nextConversations);
      setActiveConversationIds((current) => ({
        ...current,
        [projectId]: conversation!.id,
      }));
    }
    const conversationId = conversation.id;
    setRunningConversationIds((current) => [
      ...new Set([...current, conversationId]),
    ]);
    const controller = runCoordinatorRef.current.begin(conversationId);
    let inactivityTimer: number | undefined;
    const armInactivityTimer = () => {
      if (inactivityTimer) window.clearTimeout(inactivityTimer);
      inactivityTimer = window.setTimeout(() => {
        const activeRun = runCoordinatorRef.current.active(conversationId);
        if (activeRun)
          void api
            .cancelRun(activeRun.threadId, activeRun.runId)
            .catch(() => undefined);
        else if (workingConversation.threadId)
          void api
            .cancelActiveRun(workingConversation.threadId)
            .catch(() => undefined);
        controller.abort("timeout");
      }, 90000);
    };
    armInactivityTimer();
    const { userContent, agentContent } = buildAgentRunRequest(
      content,
      attachments,
      references,
      skillMentions,
    );
    const userMessage: ChatMessage = {
      id: newId("message"),
      role: "user",
      content: userContent,
      attachments,
      references: references.length ? references : undefined,
      skills: skillMentions.length ? skillMentions : undefined,
      createdAt: new Date().toISOString(),
    };
    const assistantId = newId("message");
    const initialMessages = [
      ...conversation.messages,
      userMessage,
      {
        id: assistantId,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
        pending: true,
        runStatus: createRunPresentation(),
      },
    ];
    let workingConversation: ProjectConversation = {
      ...conversation,
      messages: initialMessages,
      updatedAt: new Date().toISOString(),
    };
    let titlePersist: Promise<ProjectConversation> = Promise.resolve(
      workingConversation,
    );
    const publishConversation = (nextConversation: ProjectConversation) => {
      const current = conversationsRef.current;
      const next = {
        ...current,
        [projectId]: (current[projectId] || []).map((item) =>
          item.id === conversationId ? nextConversation : item,
        ),
      };
      conversationsRef.current = next;
      setConversations(next);
    };
    publishConversation(workingConversation);
    await persistConversation(workingConversation);
    // References belong to this outgoing message. Clear the composer state
    // immediately so a failed/cancelled run cannot accidentally reuse them.
    setChatReferences([]);
    // Model providers may emit dozens of text deltas per second. Rendering every delta also
    // rerenders the surrounding workspace and can starve pointer/input events.
    // Keep the complete latest text, but publish it to React at a human-visible
    // cadence. The final value is always flushed before the run is completed.
    let pendingStreamText = "";
    let streamRenderTimer: number | undefined;
    let lastPresentationPublishAt = 0;
    let presentationRenderTimer: number | undefined;
    const flushStreamText = () => {
      if (streamRenderTimer) window.clearTimeout(streamRenderTimer);
      streamRenderTimer = undefined;
      if (!pendingStreamText) return;
      workingConversation = {
        ...workingConversation,
        messages: workingConversation.messages.map((item) =>
          item.id === assistantId
            ? { ...item, content: pendingStreamText, pending: true }
            : item,
        ),
        updatedAt: new Date().toISOString(),
      };
      publishConversation(workingConversation);
    };
    const userRequest = agentContent;
    try {
      let threadId = workingConversation.threadId;
      if (threadId) {
        try {
          await api.threadStatus(threadId);
        } catch (error) {
          // A Runtime restore/reset may retain the App conversation while its
          // matching Runtime thread no longer exists. Preserve visible chat
          // history, discard only the stale pointer, then make a fresh thread.
          if (
            !/thread not found/i.test(
              error instanceof Error ? error.message : String(error),
            )
          )
            throw error;
          threadId = undefined;
          workingConversation = { ...workingConversation, threadId: undefined };
        }
      }
      // One visible conversation maps to one Runtime thread. Context pressure is
      // handled by Runtime summarization instead of silently breaking history.
      if (!threadId) {
        const thread = await api.createThread(
          config.bootstrap.agentId,
          conversation.title || "新会话",
          projectId,
          conversationId,
          projectSkillScopeConfigured ? projectSkillIds : undefined,
        );
        threadId = thread.thread_id;
        const history = conversation.messages
          .filter(
            (message) =>
              !message.pending &&
              (message.role === "user" || message.role === "assistant") &&
              message.content.trim(),
          )
          .map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.content,
          }));
        if (history.length) await api.seedThreadContext(threadId, history);
        workingConversation = { ...workingConversation, threadId };
        const nextConversations = {
          ...conversationsRef.current,
          [projectId]: (conversationsRef.current[projectId] || []).map(
            (item) => (item.id === conversationId ? workingConversation : item),
          ),
        };
        conversationsRef.current = nextConversations;
        setConversations(nextConversations);
        await persistConversation(workingConversation);
      }
      let latestText = "";
      await api.streamChat(
        threadId,
        config.bootstrap.agentId,
        userRequest,
        (text) => {
          latestText = text;
          pendingStreamText = text;
          if (!streamRenderTimer)
            streamRenderTimer = window.setTimeout(flushStreamText, 80);
        },
        controller.signal,
        (title) => {
          const cleanTitle = title.trim();
          if (!cleanTitle) return;
          if (!["新会话", "会话"].includes(workingConversation.title)) return;
          workingConversation = {
            ...workingConversation,
            title: cleanTitle,
            updatedAt: new Date().toISOString(),
          };
          publishConversation(workingConversation);
          titlePersist = persistConversation(workingConversation).catch(
            () => workingConversation,
          );
        },
        (runId) => {
          runCoordinatorRef.current.bindRuntimeRun(conversationId, {
            threadId,
            runId,
          });
          workingConversation = {
            ...workingConversation,
            messages: workingConversation.messages.map((item) =>
              item.id === assistantId ? { ...item, runId, threadId } : item,
            ),
          };
        },
        armInactivityTimer,
        (event) => {
          if (event.type === "run.steered") {
            const instructions = Array.isArray(event.payload.instructions)
              ? (event.payload.instructions as Array<Record<string, unknown>>)
              : [];
            const consumedIds = instructions
              .map((item) => String(item.client_request_id || "").trim())
              .filter(Boolean);
            if (consumedIds.length)
              setConsumedSteerRequestIds((current) =>
                [...new Set([...current, ...consumedIds])].slice(-100),
              );
            const { additions, messages } = mergeSteeredUserMessages(
              workingConversation.messages,
              assistantId,
              instructions,
              () => newId("message"),
            );
            if (additions.length) {
              // The assistant reply is still pending, so an accepted instruction
              // belongs immediately before it in the normal message chronology.
              workingConversation = {
                ...workingConversation,
                messages,
                updatedAt: new Date().toISOString(),
              };
              publishConversation(workingConversation);
              void persistConversation(workingConversation);
            }
            return;
          }
          const process = appendProcessEvent(
            workingConversation.messages.find((item) => item.id === assistantId)
              ?.process,
            event,
          );
          const previous = workingConversation.messages.find(
            (item) => item.id === assistantId,
          );
          const runStatus = reduceRunPresentation(previous?.runStatus, event);
          const rawAttachment = event.payload.attachment;
          const generatedAttachment = rawAttachment && typeof rawAttachment === "object"
            ? rawAttachment as Record<string, unknown>
            : undefined;
          const attachment = generatedAttachment?.attachment_id
            ? {
                attachmentId: String(generatedAttachment.attachment_id),
                name: String(generatedAttachment.name || "生成文件"),
                size: Number(generatedAttachment.size || 0),
                mimeType: String(generatedAttachment.mime_type || "application/octet-stream"),
              }
            : undefined;
          workingConversation = {
            ...workingConversation,
            messages: workingConversation.messages.map((item) =>
              item.id === assistantId
                ? {
                    ...item,
                    process,
                    runStatus,
                    pending: true,
                    attachments: attachment && !(item.attachments || []).some((value) => value.attachmentId === attachment.attachmentId)
                      ? [...(item.attachments || []), attachment]
                      : item.attachments,
                  }
                : item,
            ),
            updatedAt: new Date().toISOString(),
          };
          const now = Date.now();
          const isDelta = event.type === "agent.message.delta";
          const publishPresentation = () => {
            if (presentationRenderTimer)
              window.clearTimeout(presentationRenderTimer);
            presentationRenderTimer = undefined;
            lastPresentationPublishAt = Date.now();
            publishConversation(workingConversation);
          };
          if (!isDelta || now - lastPresentationPublishAt >= 120) {
            publishPresentation();
          } else if (!presentationRenderTimer) {
            presentationRenderTimer = window.setTimeout(
              publishPresentation,
              120 - (now - lastPresentationPublishAt),
            );
          }
        },
        attachments,
        resolveModelId(workingConversation.modelId),
      );
      flushStreamText();
      if (presentationRenderTimer)
        window.clearTimeout(presentationRenderTimer);
      // Wait for the title persist (if any) before saving the completed
      // conversation.  Without this, the fire-and-forget title save can race
      // with the completion save and the last writer wins, potentially
      // dropping the generated title.
      await titlePersist;
      const completedMessages = workingConversation.messages.map((item) =>
        item.id === assistantId
          ? {
              ...item,
              pending: false,
              runSummary: summarizeRunPresentation(item.runStatus),
              content: latestText || item.content || "画板已更新。",
            }
          : item,
      );
      workingConversation = {
        ...workingConversation,
        messages: completedMessages,
        updatedAt: new Date().toISOString(),
      };
      publishConversation(workingConversation);
      await persistConversation(workingConversation);
    } catch (error) {
      flushStreamText();
      if (presentationRenderTimer)
        window.clearTimeout(presentationRenderTimer);
      await titlePersist.catch(() => workingConversation);
      const finalMessages = workingConversation.messages.map((item) =>
        item.id === assistantId
          ? finalizeAssistantRunError(item, error, controller.signal)
          : item,
      );
      workingConversation = {
        ...workingConversation,
        messages: finalMessages,
        updatedAt: new Date().toISOString(),
      };
      publishConversation(workingConversation);
      await persistConversation(workingConversation);
    } finally {
      if (streamRenderTimer) window.clearTimeout(streamRenderTimer);
      if (presentationRenderTimer)
        window.clearTimeout(presentationRenderTimer);
      if (inactivityTimer) window.clearTimeout(inactivityTimer);
      runCoordinatorRef.current.finish(conversationId);
      setRunningConversationIds((current) =>
        current.filter((id) => id !== conversationId),
      );
      const queued = queuedMessagesRef.current.get(conversationId) || [];
      queuedMessagesRef.current.delete(conversationId);
      if (queued.length)
        window.setTimeout(() => void sendMessage(queued[0]), 0);
    }
  };

  const steerConversation = async (content: string, requestId: string) => {
    const conversationId = activeConversationIds[activeId];
    const active = conversationId
      ? runCoordinatorRef.current.active(conversationId)
      : undefined;
    if (!active || !content.trim()) return;
    const accepted = await api.steerRun(active.runId, content, requestId);
    if (!accepted.accepted) throw new Error("当前任务已结束，不能再引导");
  };
  const queueConversation = (content: string) => {
    const conversationId = activeConversationIds[activeId];
    if (!conversationId || !content.trim()) return;
    queuedMessagesRef.current.set(conversationId, [
      ...(queuedMessagesRef.current.get(conversationId) || []),
      content.trim(),
    ]);
  };

  const createConversation = async () => {
    if (
      !activeProject ||
      (conversations[activeProject.id] || []).some((conversation) =>
        runningConversationIds.includes(conversation.id),
      )
    )
      return;
    // A new conversation is only a blank composer until its first message.
    // Do not create a local record or Runtime thread merely because the user clicked +.
    setActiveConversationIds((current) => ({
      ...current,
      [activeProject.id]: `draft_${activeProject.id}`,
    }));
  };
  const switchConversation = async (conversationId: string) => {
    if (
      !activeProject ||
      (conversations[activeProject.id] || []).some((conversation) =>
        runningConversationIds.includes(conversation.id),
      )
    )
      return;
    setActiveConversationIds((current) => ({
      ...current,
      [activeProject.id]: conversationId,
    }));
    await window.tugo?.conversations.activate(
      activeProject.id,
      conversationId,
    );
  };
  const branchConversation = async (messageIndex: number) => {
    if (!activeProject || !window.tugo) return;
    const agentId = config.bootstrap?.agentId;
    if (!agentId) {
      setSettingsOpen(true);
      return;
    }
    const sourceConversation = (conversations[activeProject.id] || []).find(
      (item) => item.id === activeConversationIds[activeProject.id],
    );
    if (
      !sourceConversation ||
      runningConversationIds.includes(sourceConversation.id)
    )
      return;
    const sourceMessages = sourceConversation.messages
      .slice(0, messageIndex + 1)
      .filter(
        (message) =>
          !message.pending &&
          (message.role === "user" || message.role === "assistant"),
      );
    if (!sourceMessages.length) return;
    const projectBase = `${activeProject.name} · 分支`;
    const projectNames = new Set(
      projectsRef.current.map((project) => project.name),
    );
    let projectName = projectBase;
    let suffix = 2;
    while (projectNames.has(projectName))
      projectName = `${projectBase} (${suffix++})`;
    const conversationBase = `${sourceConversation.title || "新会话"} · 分支`;
    const branchProject = await window.tugo.projects.create({
      name: projectName,
      folderId: activeProject.folderId,
      document: structuredClone(historyRef.current.current),
    });
    try {
      if (projectSkillScopeConfigured)
        await window.tugo.projects.setSkillIds(
          branchProject.id,
          projectSkillIds,
        );
      const created = await window.tugo.conversations.create(
        branchProject.id,
      );
      const copiedMessages: ChatMessage[] = sourceMessages.map((message) => ({
        ...structuredClone(message),
        pending: false,
        process: undefined,
        runId: undefined,
        threadId: undefined,
      }));
      const branchConversation: ProjectConversation = {
        ...created,
        title: conversationBase,
        modelId: sourceConversation.modelId,
        messages: copiedMessages,
        updatedAt: new Date().toISOString(),
      };
      const thread = await api.createThread(
        agentId,
        conversationBase,
        branchProject.id,
        branchConversation.id,
        projectSkillScopeConfigured ? projectSkillIds : undefined,
      );
      await api.seedThreadContext(
        thread.thread_id,
        sourceMessages.map((message) => ({
          role: message.role as "user" | "assistant",
          content: message.content,
        })),
      );
      branchConversation.threadId = thread.thread_id;
      await window.tugo.conversations.save(branchConversation);
      setProjects((current) => [branchProject, ...current]);
      setConversations((current) => ({
        ...current,
        [branchProject.id]: [branchConversation],
      }));
      setActiveConversationIds((current) => ({
        ...current,
        [branchProject.id]: branchConversation.id,
      }));
      openProject(branchProject);
    } catch (error) {
      await window.tugo.projects
        .remove(branchProject.id)
        .catch(() => undefined);
      window.alert(
        `创建分支失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const replayUserMessage = async (
    messageIndex: number,
    replacement?: string,
  ) => {
    if (!activeProject || !window.tugo) return;
    const projectId = activeProject.id;
    const conversation = (conversationsRef.current[projectId] || []).find(
      (item) => item.id === activeConversationIds[projectId],
    );
    if (!conversation) return;
    const original = conversation.messages[messageIndex];
    if (!original || original.role !== "user" || original.pending) return;
    const content = (replacement ?? original.content).trim();
    if (
      !content &&
      !original.attachments?.length &&
      !original.references?.length
    )
      return;
    const prefix = messagesBeforeReplay(conversation.messages, messageIndex);
    const rewritten: ProjectConversation = {
      ...conversation,
      messages: prefix,
      updatedAt: new Date().toISOString(),
    };
    try {
      // Replaying an earlier instruction intentionally replaces the current
      // run. Abort the renderer stream and wait for its persistence/finally
      // path before rewriting history, otherwise the cancelled run can race
      // and restore messages that the user just discarded.
      if (runCoordinatorRef.current.has(conversation.id)) {
        const activeRun = runCoordinatorRef.current.cancel(
          conversation.id,
          "replaced_by_replay",
        );
        if (activeRun)
          await api
            .cancelRun(activeRun.threadId, activeRun.runId)
            .catch(() => undefined);
        const deadline = Date.now() + 10_000;
        while (
          runCoordinatorRef.current.has(conversation.id) &&
          Date.now() < deadline
        )
          await new Promise((resolve) => window.setTimeout(resolve, 25));
        if (runCoordinatorRef.current.has(conversation.id))
          throw new Error("当前任务仍在停止，请稍后再试");
      }
      if (rewritten.threadId)
        await api.seedThreadContext(
          rewritten.threadId,
          prefix.map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.content,
          })),
          true,
        );
      const next = {
        ...conversationsRef.current,
        [projectId]: (conversationsRef.current[projectId] || []).map((item) =>
          item.id === rewritten.id ? rewritten : item,
        ),
      };
      conversationsRef.current = next;
      setConversations(next);
      await persistConversation(rewritten);
      // Do not re-read the old render state here: the edited instruction must
      // be appended to this exact, freshly persisted conversation history.
      await sendMessage(
        content,
        original.attachments || [],
        original.references || [],
        {
          project: activeProject,
          conversation: rewritten,
          replaceStoppedRun: true,
        },
        original.skills || [],
      );
    } catch (error) {
      window.alert(
        `无法重新发送这条消息：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const cancelConversation = () => {
    const conversationId = activeConversationIds[activeId];
    if (!conversationId) return;
    const activeRun = runCoordinatorRef.current.cancel(conversationId, "user");
    // Stop the local stream first.  Waiting for the remote cancel response can
    // itself stall, which would otherwise leave the composer permanently locked.
    if (activeRun)
      void api
        .cancelRun(activeRun.threadId, activeRun.runId)
        .catch(() => undefined);
    else {
      const conversation = (conversations[activeId] || []).find(
        (item) => item.id === conversationId,
      );
      if (conversation?.threadId)
        void api.cancelActiveRun(conversation.threadId).catch(() => undefined);
    }
  };

  return (
    <I18nProvider language={language}>
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><img src={tugoLogo} alt="" /></div>
          <strong>TuGo</strong>
        </div>
        <button
          className="icon-btn"
          title={t("projectList")}
          onClick={() => setProjectPanelOpen((value) => !value)}
        >
          <Menu size={18} />
        </button>
        <div className="project-title">
          <span className="save-dot" />
          <button onClick={() => activeProject && renameProject(activeProject)}>
            {activeProject?.name || t("loading")}
          </button>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-btn"
            data-e2e="model-settings"
            title={t("modelSettings")}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={18} />
          </button>
          <button
            className={`assistant-toggle ${chatOpen ? "active" : ""}`}
            onClick={() => setChatOpen((value) => !value)}
            aria-label={t("openCreatePanel")}
          >
            <Sparkles size={16} /> {t("createPanel")}
          </button>
        </div>
      </header>
      <main className="workspace">
        <section className="canvas-stage" ref={canvasStageRef}>
          {activeCanvasPlan && <CanvasPlanFloat plan={activeCanvasPlan} activity={activeCanvasRun?.activity} position={planPosition} onPointerDown={startPlanDrag} />}
          <div
            className={`board-canvas-actions${activeCanvasPlan ? " is-plan-visible" : ""}`}
            aria-label={t("currentBoardActions")}
            title={t("dragToMove")}
            style={{
              left: boardVersionPosition.x,
              top: boardVersionPosition.y,
            }}
            onPointerDown={startBoardVersionDrag}
          >
            <button
              className="canvas-fab canvas-import-fab"
              data-e2e="import-board"
              title={t("importCurrentBoard")}
              aria-label={t("importCurrentBoard")}
              onClick={() => {
                if (Date.now() > suppressVersionClickRef.current)
                  setDslOpen(true);
              }}
              disabled={!activeProject}
            >
              <FileInput size={18} />
            </button>
            <button
              className="canvas-fab canvas-snapshot-fab"
              data-e2e="version-snapshots"
              title={t("versionSnapshots")}
              aria-label={t("versionSnapshots")}
              onClick={() => {
                if (Date.now() > suppressVersionClickRef.current)
                  setSnapshotsOpen(true);
              }}
              disabled={!activeProject}
            >
              <Layers3 size={17} />
            </button>
          </div>
          <button
            type="button"
            className="board-skill-config-fab"
            title={t("boardSkills")}
            aria-label={t("boardSkills")}
            disabled={!activeProject}
            onClick={() => activeProject && void configureProjectSkills(activeProject)}
          >
            <Sparkles size={16} />
            <span>Skill</span>
          </button>
          <InfiniteCanvas
            document={history.current}
            onCommit={commitOperations}
            onUndo={performUndo}
            onRedo={performRedo}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onExportRegion={setExportRegion}
            onBatchExportRegions={setBatchExportRegions}
            onAddImage={addImageToBoard}
            onDropImages={addImagesToBoard}
            imageSources={imageSources}
            exportModeRequest={exportModeRequest}
            aiPlayback={aiPlayback}
            aiWork={aiCanvasWork}
            cursorStyle={config.drawingCursor?.style}
            cursorColor={config.drawingCursor?.color}
            onAiPlaybackComplete={completeAiPlayback}
            onAddToChat={addCanvasReferencesToChat}
          />
          {selectedIds.length === 1 && (
            <CanvasInspector
              document={history.current}
              selectedId={selectedIds[0]}
              onCommit={commitOperations}
            />
          )}
        </section>
        <ProjectPanel
          open={projectPanelOpen}
          folders={folders}
          projects={projects}
          activeId={activeId}
          onToggle={() => setProjectPanelOpen((value) => !value)}
          onOpen={openProject}
          onCreate={createProject}
          onCreateFolder={createFolder}
          onRename={renameProject}
          onRemove={removeProject}
          onMove={moveProject}
          onRenameFolder={renameFolder}
          onRemoveFolder={removeFolder}
        />
        <ChatPanel
          api={api}
          open={chatOpen}
          desktop={Boolean(window.tugo)}
          status={status}
          models={models}
          allowedSkillIds={effectiveProjectSkillIds}
          selectedModelId={selectedConversationModelId}
          onSelectModel={selectConversationModel}
          conversations={conversations[activeId] || []}
          activeConversationId={activeConversationIds[activeId]}
          running={(conversations[activeId] || []).some((conversation) =>
            runningConversationIds.includes(conversation.id),
          )}
          references={chatReferences}
          canvasDocument={history.current}
          selectionCount={selectedIds.length}
          selectionReferences={selectedCanvasReferences}
          onUseSelection={addCanvasReferencesToChat}
          onRemoveReference={(reference) =>
            setChatReferences((current) =>
              current.filter(
                (item) =>
                  !(item.kind === reference.kind && item.id === reference.id),
              ),
            )
          }
          onToggle={() => setChatOpen((value) => !value)}
          onSend={(value, attachments, references, skills) =>
            void sendMessage(value, attachments, references, undefined, skills)
          }
          onSteer={steerConversation}
          consumedSteerRequestIds={consumedSteerRequestIds}
          onConfigure={() => setSettingsOpen(true)}
          onConfigureSkills={() => {
            if (activeProject) void configureProjectSkills(activeProject);
          }}
          onCreateConversation={createConversation}
          onSwitchConversation={switchConversation}
          onBranchConversation={branchConversation}
          onReplayUserMessage={replayUserMessage}
          onCancel={cancelConversation}
          onDebug={(threadId, runId) => setDebugTarget({ threadId, runId })}
          onOpenSnapshots={async (snapshotIds, threadId, runId) => {
            let resolvedIds = snapshotIds;
            // Earlier runs kept the snapshot count but serialized tool output
            // as a JSON string, so their visible summary has no IDs. Recover
            // those IDs from the durable run journal instead of falling back
            // to the latest snapshot.
            if (!resolvedIds.length && threadId && runId) {
              try {
                const journal = await api.runtimeJournal(threadId, runId);
                resolvedIds = journal.items.flatMap((item) => {
                  if (String(item.actor || "") !== "board_create_snapshot") return [];
                  const payload = item.payload && typeof item.payload === "object" ? item.payload as Record<string, unknown> : {};
                  const raw = payload.output;
                  try {
                    const output = typeof raw === "string" ? JSON.parse(raw) : raw;
                    const id = output && typeof output === "object" ? String((output as Record<string, unknown>).snapshot_id || "") : "";
                    return id ? [id] : [];
                  } catch { return []; }
                });
              } catch { /* the normal empty history view remains available */ }
            }
            setSnapshotFocusIds([...new Set(resolvedIds)]);
            setSnapshotsOpen(true);
          }}
        />
      </main>
      {dslOpen && (
        <DslDialog
          initialKind={history.current.dsl?.kind || "mermaid"}
          initialSource={
            history.current.dsl?.source || toMermaid(history.current)
          }
          onClose={() => setDslOpen(false)}
          onApply={applyDsl}
          onImportSnapshot={importSnapshot}
          onApplySnapshot={applySnapshotDocument}
        />
      )}
      {snapshotsOpen && activeProject && (
        <SnapshotBrowserDialog
          projectId={activeProject.id}
          focusSnapshotIds={snapshotFocusIds}
          onClose={() => {
            setSnapshotsOpen(false);
            setSnapshotFocusIds([]);
          }}
          onRestore={restoreSnapshot}
          onCreateProject={createProjectFromSnapshot}
          onCreateManualSnapshot={saveManualSnapshot}
          initialManualSnapshotName={`${activeProject.name} · 当前版本`}
        />
      )}
      {textDialog && (
        <TextInputDialog {...textDialog} onClose={() => setTextDialog(null)} />
      )}
      {exportRegion && (
        <ExportDialog
          document={history.current}
          region={exportRegion}
          fileName={activeProject?.name || "TuGo"}
          onClose={() => setExportRegion(null)}
          onAddToChat={(reference) => {
            setChatReferences((current) => [...current, reference]);
            setChatOpen(true);
          }}
        />
      )}
      {batchExportRegions && (
        <BatchExportDialog
          document={history.current}
          regions={batchExportRegions}
          fileName={activeProject?.name || "TuGo"}
          onClose={() => setBatchExportRegions(null)}
          onAddToChat={(references) => {
            setChatReferences((current) => [
              ...current,
              ...references.filter(
                (reference) =>
                  !current.some((item) => item.id === reference.id),
              ),
            ]);
            setChatOpen(true);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          config={config}
          api={api}
          onClose={() => setSettingsOpen(false)}
          onSave={saveModel}
          onSetDefault={setDefaultModel}
          onTheme={async (theme) => {
            const next = window.tugo
              ? await window.tugo.config.write({ theme })
              : { ...config, theme };
            setConfig(next);
            api.updateConfig(next);
          }}
          onLanguage={async (languagePreference) => {
            const next = window.tugo
              ? await window.tugo.config.write({ language: languagePreference })
              : { ...config, language: languagePreference };
            setConfig(next);
            api.updateConfig(next);
          }}
          onCursorAppearance={async (drawingCursor) => {
            const next = window.tugo
              ? await window.tugo.config.write({ drawingCursor })
              : { ...config, drawingCursor };
            setConfig(next);
            api.updateConfig(next);
          }}
        />
      )}
      {aiConfigurationOpen && (
        <AiConfigurationDialog
          api={api}
          onClose={() => setAiConfigurationOpen(false)}
        />
      )}
      {projectSkillsOpen && (
        <ProjectSkillsDialog
          skills={enabledSkills}
          selectedIds={
            projectSkillScopeConfigured
              ? projectSkillIds
              : enabledSkills.map((skill) => skill.skill_id)
          }
          onClose={() => setProjectSkillsOpen(false)}
          onSave={async (ids) => {
            await saveProjectSkillScope(ids);
            setProjectSkillsOpen(false);
          }}
        />
      )}
      {debugTarget && (
        <RunDebugDialog
          api={api}
          target={debugTarget}
          onClose={() => setDebugTarget(null)}
        />
      )}
      {downloads.length > 0 && (
        <div className="download-tray">
          {downloads.map((item) => {
            const progress =
              item.total > 0
                ? Math.min(100, Math.round((item.received / item.total) * 100))
                : 0;
            return (
              <div className={`download-item is-${item.status}`} key={item.id}>
                <span className="download-icon">
                  {item.status === "completed" ? (
                    <Check size={15} />
                  ) : (
                    <Download size={15} />
                  )}
                </span>
                <span>
                  <strong>{item.fileName}</strong>
                  <small>
                    {item.status === "completed"
                      ? "下载完成"
                      : item.status === "downloading"
                        ? item.total > 0
                          ? `正在下载 ${progress}%`
                          : "正在下载…"
                        : "下载未完成"}
                  </small>
                  {item.status === "downloading" && (
                    <i>
                      <b style={{ width: `${progress}%` }} />
                    </i>
                  )}
                </span>
                {item.status === "completed" && (
                  <button
                    onClick={() =>
                      void window.tugo?.system.openDownloadedFile(
                        item.path,
                      )
                    }
                  >
                    打开
                  </button>
                )}
                <button
                  className="download-dismiss"
                  title="关闭"
                  onClick={() =>
                    setDownloads((current) =>
                      current.filter((value) => value.id !== item.id),
                    )
                  }
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
    </I18nProvider>
  );
}

function CanvasPlanFloat({
  plan,
  activity,
  position,
  onPointerDown,
}: {
  plan: ChatPlan;
  activity?: ChatRunStatus["activity"];
  position: { x: number; y: number };
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
}) {
  const steps = plan.steps;
  const completed = steps.filter((step) =>
    ["completed", "skipped", "cancelled", "abandoned"].includes(step.status),
  );
  const running = steps.some((step) => step.status === "in_progress");
  const blocked = steps.some((step) =>
    ["blocked", "failed", "waiting_input"].includes(step.status),
  );
  const statusText = (status: string) =>
    status === "completed" ? "已完成" : status === "in_progress" ? "进行中" : status === "blocked" || status === "failed" ? "受阻" : status === "waiting_input" ? "等待输入" : status === "skipped" ? "已跳过" : "待执行";
  return (
    <aside
      className={`canvas-plan-float${blocked ? " is-blocked" : ""}`}
      aria-label="执行计划"
      aria-live="polite"
      style={{ left: position.x, top: position.y }}
      onPointerDown={onPointerDown}
    >
      <header>
        <span className="canvas-plan-float-icon">
          {blocked ? "!" : running ? <span className="canvas-plan-running-dot" /> : <Check size={14} />}
        </span>
        <span className="canvas-plan-float-heading">
          <strong>执行计划</strong>
          <small>{plan.title}</small>
        </span>
        <b>{completed.length}/{steps.length}</b>
      </header>
      <div className="canvas-plan-float-body">
        {steps.map((step, index) => {
          const stepBlocked = ["blocked", "failed", "waiting_input"].includes(step.status);
          const stepComplete = ["completed", "skipped", "cancelled", "abandoned"].includes(step.status);
          const isCurrent = step.id === plan.currentStepId || step.status === "in_progress";
          const process = isCurrent && step.status === "in_progress" ? activity?.label : undefined;
          const outcome = step.blocker || step.resultSummary;
          return <div className={`canvas-plan-step is-${step.status}`} key={step.id || `${index}:${step.title}`}>
            <span>{stepComplete ? <Check size={11} /> : stepBlocked ? "!" : step.status === "in_progress" ? <span className="canvas-plan-running-dot" /> : String(index + 1).padStart(2, "0")}</span>
            <div>
              <div className="canvas-plan-step-head"><strong>{step.title}</strong><em>{statusText(step.status)}</em></div>
              {(process || outcome) && <small className={step.blocker ? "is-error" : ""}>{process || outcome}</small>}
            </div>
          </div>;
        })}
      </div>
    </aside>
  );
}

function ProjectPanel(props: {
  open: boolean;
  folders: ProjectFolder[];
  projects: BoardProject[];
  activeId: string;
  onToggle(): void;
  onOpen(project: BoardProject): void;
  onCreate(folderId?: string | null): void;
  onCreateFolder(): void;
  onRename(project: BoardProject): void;
  onRemove(project: BoardProject): void;
  onMove(project: BoardProject, folderId: string | null): void;
  onRenameFolder(folder: ProjectFolder): void;
  onRemoveFolder(folder: ProjectFolder): void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [menuFolderId, setMenuFolderId] = useState<string | null>(null);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<string[]>([]);
  if (!props.open)
    return (
      <button
        className="collapsed-rail project-collapsed"
        onClick={props.onToggle}
        title={t("expandProjects")}
      >
        <LayoutDashboard size={18} />
        <ChevronLeft size={14} />
      </button>
    );
  const matches = (project: BoardProject) =>
    project.name.toLowerCase().includes(query.toLowerCase());
  const renderProject = (project: BoardProject, nested = false) => (
    <div
      key={project.id}
      draggable
      className={`project-row ${nested ? "nested" : "root-project"} ${project.id === props.activeId ? "active" : ""}`}
      onDragStart={(event) =>
        event.dataTransfer.setData("text/tugo-project", project.id)
      }
      onClick={() => props.onOpen(project)}
    >
      <div className="project-thumb">
        <FileText size={15} />
      </div>
      <span>{project.name}</span>
      <div className="project-actions-menu">
        <button
          onClick={(event) => {
            event.stopPropagation();
            setMenuProjectId((current) =>
              current === project.id ? null : project.id,
            );
          }}
          title={t("moreActions")}
        >
          <MoreHorizontal size={15} />
        </button>
        {menuProjectId === project.id && (
          <div className="project-action-popover">
            <button
              onClick={(event) => {
                event.stopPropagation();
                setMenuProjectId(null);
                props.onRename(project);
              }}
            >
              {t("rename")}
            </button>
          </div>
        )}
      </div>
      <button
        className="danger-hover"
        onClick={(event) => {
          event.stopPropagation();
          props.onRemove(project);
        }}
        title={t("delete")}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
  return (
    <aside className="project-panel side-panel">
      <div className="panel-header">
        <div>
          <small>WORKSPACE</small>
          <strong>{t("projects")}</strong>
        </div>
        <button className="icon-btn" onClick={props.onToggle}>
          <ChevronRight size={17} />
        </button>
      </div>
      <div className="panel-actions">
        <button onClick={() => props.onCreate(null)}>
          <Plus size={16} /> {t("createBoard")}
        </button>
        <button data-e2e="create-folder" title={t("createFolder")} onClick={props.onCreateFolder}>
          <FolderPlus size={16} />
        </button>
      </div>
      <label className="search-box">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchProjects")}
        />
      </label>
      <div className="project-tree">
        {props.folders.map((folder) => (
          <section className="folder-group" key={folder.id}>
            <div
              className="folder-title"
              onClick={() =>
                setCollapsedFolderIds((current) =>
                  current.includes(folder.id)
                    ? current.filter((id) => id !== folder.id)
                    : [...current, folder.id],
                )
              }
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const project = props.projects.find(
                  (item) =>
                    item.id ===
                    event.dataTransfer.getData("text/tugo-project"),
                );
                if (project) props.onMove(project, folder.id);
              }}
            >
              <ChevronRight
                className={
                  collapsedFolderIds.includes(folder.id)
                    ? "folder-chevron"
                    : "folder-chevron open"
                }
                size={14}
              />
              <span className="folder-icon">
                <Folder size={14} />
              </span>
              <span className="folder-name">{folder.name}</span>
              <small>
                {
                  props.projects.filter(
                    (project) => project.folderId === folder.id,
                  ).length
                }
              </small>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCreate(folder.id);
                }}
              >
                <Plus size={14} />
              </button>
              <div className="project-actions-menu">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuFolderId((current) =>
                      current === folder.id ? null : folder.id,
                    );
                  }}
                  title="更多操作"
                >
                  <MoreHorizontal size={14} />
                </button>
                {menuFolderId === folder.id && (
                  <div className="project-action-popover">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuFolderId(null);
                        props.onRenameFolder(folder);
                      }}
                    >
                      重命名
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  props.onRemoveFolder(folder);
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
            {!collapsedFolderIds.includes(folder.id) && (
              <div className="folder-children">
                {props.projects
                  .filter(
                    (project) =>
                      project.folderId === folder.id && matches(project),
                  )
                  .map((project) => renderProject(project, true))}
              </div>
            )}
          </section>
        ))}
        <section className="folder-group unfiled-group">
          <div
            className="folder-title"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const project = props.projects.find(
                (item) =>
                  item.id ===
                  event.dataTransfer.getData("text/tugo-project"),
              );
              if (project) props.onMove(project, null);
            }}
          >
            <LayoutDashboard size={14} />
            <span className="folder-name">未分类</span>
            <small>
              {props.projects.filter((project) => !project.folderId).length}
            </small>
          </div>
          {props.projects
            .filter((project) => !project.folderId && matches(project))
            .map((project) => renderProject(project, false))}
        </section>
      </div>
    </aside>
  );
}

function ChatPanel({
  api,
  open,
  desktop,
  status,
  models,
  allowedSkillIds,
  selectedModelId,
  onSelectModel,
  conversations,
  activeConversationId,
  running,
  references,
  canvasDocument,
  selectionCount,
  selectionReferences,
  onUseSelection,
  onRemoveReference,
  onToggle,
  onSend,
  onSteer,
  consumedSteerRequestIds,
  onConfigure,
  onConfigureSkills,
  onCreateConversation,
  onSwitchConversation,
  onBranchConversation,
  onReplayUserMessage,
  onCancel,
  onDebug,
  onOpenSnapshots,
}: {
  api: TuGoApi;
  open: boolean;
  desktop: boolean;
  status: BootstrapStatus;
  models: ModelRecord[];
  allowedSkillIds: string[];
  selectedModelId?: string;
  onSelectModel(modelId: string): void | Promise<void>;
  conversations: ProjectConversation[];
  activeConversationId?: string;
  running: boolean;
  references: CanvasReference[];
  canvasDocument: BoardDocument;
  selectionCount: number;
  selectionReferences: CanvasReference[];
  onUseSelection(references: CanvasReference[]): void;
  onRemoveReference(reference: CanvasReference): void;
  onToggle(): void;
  onSend(
    value: string,
    attachments?: ChatAttachment[],
    references?: CanvasReference[],
    skills?: ChatSkillMention[],
  ): void;
  onSteer(value: string, requestId: string): Promise<void>;
  consumedSteerRequestIds: string[];
  onConfigure(): void;
  onConfigureSkills(): void;
  onCreateConversation(): void;
  onSwitchConversation(id: string): void;
  onBranchConversation(messageIndex: number): void | Promise<void>;
  onReplayUserMessage(
    messageIndex: number,
    replacement?: string,
  ): Promise<void>;
  onCancel(): void;
  onDebug(threadId: string, runId: string): void;
  onOpenSnapshots(snapshotIds: string[], threadId?: string, runId?: string): void | Promise<void>;
}) {
  const { language, t } = useI18n();
  const [value, setValue] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [referencesExpanded, setReferencesExpanded] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<SkillRecord[]>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [queued, setQueued] = useState<
    Array<{
      id: string;
      content: string;
      skills?: ChatSkillMention[];
      status?: "queued" | "awaiting";
    }>
  >([]);
  const [draggedQueueId, setDraggedQueueId] = useState<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const followChatRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  useEffect(() => {
    if (!consumedSteerRequestIds.length) return;
    setQueued((current) =>
      current.filter((item) => !consumedSteerRequestIds.includes(item.id)),
    );
  }, [consumedSteerRequestIds]);
  const addAttachments = async (paths: string[]) => {
    if (!paths.length) return;
    setAttachmentError("");
    try {
      const imported = await Promise.all(
        paths.slice(0, 8).map((path) => api.importAttachment(path)),
      );
      setAttachments((current) =>
        [
          ...current,
          ...imported.map((item) => ({
            attachmentId: item.attachment_id,
            name: item.name,
            size: item.size,
            mimeType: item.mime_type || "",
          })),
        ].slice(0, 8),
      );
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const refreshMentionSkills = useCallback(() => {
    if (!desktop) return Promise.resolve();
    setSkillsLoading(true);
    return api
      .listSkills()
      .then((items) =>
        setSkills(items.filter((skill) => skill.enabled !== false)),
      )
      .catch(() => setSkills([]))
      .finally(() => setSkillsLoading(false));
  }, [api, desktop]);
  useEffect(() => {
    void refreshMentionSkills();
  }, [refreshMentionSkills]);
  useEffect(
    () =>
      setSelectedSkills((current) =>
        current.filter((skill) => allowedSkillIds.includes(skill.skill_id)),
      ),
    [allowedSkillIds],
  );
  const skillMention = value.match(/@([^\s@]*)$/);
  const skillQuery = skillMention?.[1].toLocaleLowerCase() || "";
  const mentionCandidates = skills.filter(
    (skill) =>
      allowedSkillIds.includes(skill.skill_id) &&
      !selectedSkills.some((item) => item.skill_id === skill.skill_id) &&
      [skill.name, skill.slug, skill.description]
        .join(" ")
        .toLocaleLowerCase()
        .includes(skillQuery),
  );
  // Skills can be created from Settings while this panel remains mounted.
  // Refresh only as the @ picker opens, instead of polling the Runtime.
  useEffect(() => {
    if (skillMenuOpen) void refreshMentionSkills();
  }, [skillMenuOpen, refreshMentionSkills]);
  const selectedSkillMentions = (): ChatSkillMention[] =>
    selectedSkills.map((skill) => ({
      skillId: skill.skill_id,
      name: skill.name,
      description: skill.description || skill.slug,
    }));
  // Model connectivity gates the user-facing composer. Agent/Skill template
  // reconciliation happens in the background and must never send a verified
  // model back to the intrusive "连接模型" screen during an app upgrade.
  const booting = status.l4 === "starting";
  const ready = status.l4 === "ready" && status.model === "ready";
  const activeConversation = activeConversationId
    ? conversations.find(
        (conversation) => conversation.id === activeConversationId,
      )
    : conversations[conversations.length - 1];
  const messages = activeConversation?.messages || [];
  const lastMessage = messages[messages.length - 1];
  const lastRunMarker = lastMessage?.runStatus
    ? `${lastMessage.runStatus.headline}:${lastMessage.runStatus.activity?.label || ""}:${lastMessage.runStatus.activity?.status || ""}:${lastMessage.runStatus.lastActivityAt}:${lastMessage.runStatus.changes.addedElements}:${lastMessage.runStatus.changes.updatedElements}:${lastMessage.runStatus.changes.addedEdges}:${lastMessage.runStatus.changes.updatedEdges}`
    : "";
  useEffect(() => {
    followChatRef.current = true;
    setShowJumpToLatest(false);
    const frame = window.requestAnimationFrame(() => {
      const node = chatScrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId]);
  useEffect(() => {
    const node = chatScrollRef.current;
    if (!node || !followChatRef.current) {
      if (node) setShowJumpToLatest(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      setShowJumpToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, lastMessage?.content, lastRunMarker, running]);
  const onChatScroll = () => {
    const node = chatScrollRef.current;
    if (!node) return;
    const atBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
    followChatRef.current = atBottom;
    setShowJumpToLatest(!atBottom);
  };
  const jumpToLatest = () => {
    const node = chatScrollRef.current;
    if (!node) return;
    followChatRef.current = true;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    setShowJumpToLatest(false);
  };
  const prepareSelectionAction = (prompt: string) => {
    onUseSelection(selectionReferences);
    setValue(prompt);
  };
  useEffect(() => {
    if (running || !ready || !queued.length) return;
    const nextIndex = queued.findIndex((item) => item.status !== "awaiting");
    if (nextIndex < 0) return;
    const next = queued[nextIndex];
    setQueued((current) => current.filter((item) => item.id !== next.id));
    onSend(next.content, [], [], next.skills);
  }, [running, ready, queued, onSend]);
  if (!open)
    return (
      <button
        className="collapsed-rail chat-collapsed"
        onClick={onToggle}
        title={t("openCreatePanel")}
      >
        <MessageSquare size={18} />
        <ChevronRight size={14} />
      </button>
    );
  const visibleModels = models.filter((model) => model.enabled !== false);
  return (
    <>
      {historyOpen && (
        <>
          <button className="conversation-drawer-backdrop" aria-label="关闭会话抽屉" onClick={() => setHistoryOpen(false)} />
          <aside className="conversation-drawer" aria-label="会话列表">
            <header>
              <strong>会话</strong>
              <button type="button" title="关闭" onClick={() => setHistoryOpen(false)}><X size={16} /></button>
            </header>
            <nav>
              {conversations.length ? conversations.slice().reverse().map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  className={conversation.id === activeConversation?.id ? "active" : ""}
                  onClick={() => { onSwitchConversation(conversation.id); setHistoryOpen(false); }}
                >
                  <strong>{conversation.title || t("newChat")}</strong>
                  <span>{conversation.messages.at(-1)?.content || t("noMessages")}</span>
                </button>
              )) : <p>{t("noConversations")}</p>}
            </nav>
          </aside>
        </>
      )}
      <aside className="chat-panel side-panel">
        <div className="panel-header chat-panel-header">
          <button className="icon-btn" data-e2e="new-conversation" disabled={running || booting} title={t("newConversation")} onClick={onCreateConversation}>
            <Plus size={16} />
          </button>
          {visibleModels.length > 0 && (
            <select
              className="chat-model-select chat-model-select-compact"
              disabled={running || booting}
              value={selectedModelId || ""}
              onChange={(event) => void onSelectModel(event.target.value)}
              title={t("chooseRunModel")}
            >
              {visibleModels.map((model) => <option key={model.model_id} value={model.model_id}>{model.display_name || model.model}</option>)}
            </select>
          )}
          <button
            type="button"
            className="conversation-drawer-trigger"
            title={t("conversationHistory")}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <MessageSquare size={15} />
            <span>{activeConversation?.title || t("newChat")}</span>
            <ChevronLeft size={13} />
          </button>
          <button className="icon-btn" title="收起" onClick={onToggle}><ChevronRight size={17} /></button>
        </div>
      {selectionCount > 0 && (
        <section className="chat-selection-context" aria-label={`当前已选择 ${selectionCount} 个画布对象`}>
          <div className="selection-context-heading">
            <span><Crosshair size={14} /></span>
            <div><strong>已选择 {selectionCount} 个对象</strong><small>发送时会带上准确的画布位置与内容</small></div>
            <button type="button" disabled={!ready} onClick={() => onUseSelection(selectionReferences)}>加入对话</button>
          </div>
          <div className="selection-context-items">
            {selectionReferences.slice(0, 3).map((reference) => (
              <span key={`${reference.kind}:${reference.id}`} title={referenceMeta(reference)}>{reference.label}</span>
            ))}
            {selectionReferences.length > 3 && <small>+{selectionReferences.length - 3}</small>}
          </div>
          <div className="selection-context-actions">
            <button type="button" disabled={!ready} onClick={() => prepareSelectionAction("整理所选内容的布局，保持语义和连接关系不变")}><LayoutDashboard size={13} />整理布局</button>
            <button type="button" disabled={!ready} onClick={() => prepareSelectionAction("统一所选内容的视觉样式，并保持清晰的层级")}><Pencil size={13} />修改样式</button>
            <button type="button" disabled={!ready} onClick={() => prepareSelectionAction("解释所选内容表达的结构和关系")}><Eye size={13} />解释所选</button>
            <button type="button" disabled={!ready} onClick={() => prepareSelectionAction("基于所选内容继续扩展画板")}><Plus size={13} />继续扩展</button>
          </div>
        </section>
      )}
      <div className="chat-scroll-wrap">
        <div
          ref={chatScrollRef}
          className="chat-scroll"
          onScroll={onChatScroll}
        >
          {!messages.length && ready && (
            <div className="chat-empty">
              <div className="empty-orb">
                <Sparkles size={25} />
              </div>
              <h3>{t("thinkWithBoard")}</h3>
              <p>{t("chatEmptyDescription")}</p>
              <div className="prompt-chips">
                <button
                  onClick={() => onSend(language === "zh-CN" || language === "zh-TW" ? "把当前需求整理成一张清晰的业务流程图" : "Turn the current requirements into a clear business flowchart")}
                >
                  {t("organizeFlow")}
                </button>
                <button
                  onClick={() =>
                    onSend(
                      language === "zh-CN" || language === "zh-TW" ? "设计一个现代 SaaS 系统架构图，包含客户端、网关、服务和数据层" : "Design a modern SaaS architecture diagram with client, gateway, service, and data layers",
                    )
                  }
                >
                  {t("generateArchitecture")}
                </button>
                <button
                  onClick={() => onSend(language === "zh-CN" || language === "zh-TW" ? "检查当前画板的布局和连线，并直接优化" : "Review the current board layout and connections, then optimize them")}
                >
                  {t("optimizeBoard")}
                </button>
              </div>
            </div>
          )}
          {messages.map((message, index) => (
            <ChatMessageBubble
              key={message.id}
              message={message}
              autoCollapse={
                message.role === "user" && Boolean(messages[index + 1]?.pending)
              }
              onBranch={() => void onBranchConversation(index)}
              onReplay={(replacement) =>
                onReplayUserMessage(index, replacement)
              }
              onDebug={onDebug}
              onOpenSnapshots={onOpenSnapshots}
              previewDocument={index === messages.length - 1 ? canvasDocument : undefined}
            />
          ))}
        </div>
        {showJumpToLatest && (
          <button
            type="button"
            className="chat-jump-latest"
            title={t("jumpLatest")}
            aria-label={t("jumpLatest")}
            onClick={jumpToLatest}
          >
            <ChevronDown size={18} />
          </button>
        )}
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const content = value.trim();
          const skillMentions = selectedSkillMentions();
          if (running && value.trim()) {
            setQueued((current) => [
              ...current,
              { id: newId("queued"), content, skills: skillMentions },
            ]);
            setValue("");
            setSelectedSkills([]);
            return;
          }
          if (
            (value.trim() || attachments.length || references.length) &&
            !running
          ) {
            onSend(content, attachments, references, skillMentions);
            setValue("");
            setAttachments([]);
            setSelectedSkills([]);
          }
        }}
        onDragOver={(event) => {
          if (!running && ready && event.dataTransfer.files.length)
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (running || !ready) return;
          event.preventDefault();
          const paths = [...event.dataTransfer.files]
            .map((file) => {
              // File.path was removed by Electron. The preload bridge uses Electron's
              // supported webUtils API and retains the legacy fallback for old builds.
              const legacyPath = (file as File & { path?: string }).path;
              return String(
                window.tugo?.system.getPathForFile(file) ||
                  legacyPath ||
                  "",
              );
            })
            .filter(Boolean);
          if (paths.length) void addAttachments(paths);
          else
            setAttachmentError(
              desktop
                ? "无法读取拖入文件的位置，请重启 TuGo 后再试。"
                : "浏览器预览不支持读取本机文件，请使用 TuGo 桌面应用。",
            );
        }}
      >
        {!ready && (
          <div className="composer-model-notice" role="status">
            <span className="status-dot" />
            <span>{booting ? "正在加载模型配置…" : "尚未连接 AI 模型"}</span>
            {!booting && (
              <button type="button" onClick={onConfigure}>
                去设置
              </button>
            )}
          </div>
        )}
        {references.length > 0 && (
          <div className="chat-reference-chips">
            {references.length > 3 && !referencesExpanded ? (
              <button
                type="button"
                className="reference-summary"
                onClick={() => setReferencesExpanded(true)}
              >
                <Crosshair size={13} />
                <b>已引用 {references.length} 个画布对象</b>
                <small>点击展开</small>
              </button>
            ) : (
              <>
                {references.map((reference) => (
                  <span
                    key={`${reference.kind}:${reference.id}`}
                    title={referenceMeta(reference)}
                  >
                    <Crosshair size={13} />
                    <b>{reference.label}</b>
                    <small>
                      {reference.kind === "edge"
                        ? "连线"
                        : reference.kind === "region"
                          ? "区域"
                          : "图形"}{" "}
                      · {referenceMeta(reference)}
                    </small>
                    <button
                      type="button"
                      title="移除引用"
                      onClick={() => onRemoveReference(reference)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                {references.length > 3 && (
                  <button
                    type="button"
                    className="reference-collapse"
                    onClick={() => setReferencesExpanded(false)}
                  >
                    收起
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachment-chips">
            {attachments.map((item) => (
              <span key={item.attachmentId}>
                <FileText size={13} />
                <b>{item.name}</b>
                <button
                  type="button"
                  onClick={() => {
                    setAttachments((current) =>
                      current.filter(
                        (value) => value.attachmentId !== item.attachmentId,
                      ),
                    );
                    void api
                      .deleteAttachment(item.attachmentId)
                      .catch(() => undefined);
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {selectedSkills.length > 0 && (
          <div className="skill-chips">
            {selectedSkills.map((skill) => (
              <span key={skill.skill_id}>
                <Sparkles size={13} />
                <b>@{skill.name}</b>
                <button
                  type="button"
                  title="移除 Skill"
                  onClick={() =>
                    setSelectedSkills((current) =>
                      current.filter(
                        (item) => item.skill_id !== skill.skill_id,
                      ),
                    )
                  }
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && (
          <div className="attachment-error">{attachmentError}</div>
        )}
        {queued.length > 0 && (
          <div className="chat-queue">
            {queued.map((item, index) => (
              <QueueItem
                key={item.id}
                item={item}
                index={index}
                dragged={draggedQueueId === item.id}
                onDragStart={() => setDraggedQueueId(item.id)}
                onDrop={() => {
                  if (item.status === "awaiting") return;
                  setQueued((current) => {
                    const from = current.findIndex(
                      (value) => value.id === draggedQueueId,
                    );
                    const to = current.findIndex(
                      (value) => value.id === item.id,
                    );
                    if (from < 0 || to < 0) return current;
                    const next = [...current];
                    next.splice(to, 0, next.splice(from, 1)[0]);
                    return next;
                  });
                }}
                onChange={(content) =>
                  setQueued((current) =>
                    current.map((value) =>
                      value.id === item.id ? { ...value, content } : value,
                    ),
                  )
                }
                onSteer={() => {
                  void onSteer(item.content, item.id)
                    .then(() =>
                      setQueued((current) =>
                        current.map((value) =>
                          value.id === item.id
                            ? { ...value, status: "awaiting" }
                            : value,
                        ),
                      ),
                    )
                    .catch((error) => {
                      const detail = String(error);
                      setAttachmentError(
                        /Unknown runtime method: run\.steer/.test(detail)
                          ? "请重启 TuGo 以加载“引导当前任务”功能。"
                          : detail,
                      );
                    });
                }}
                onCancel={() =>
                  setQueued((current) =>
                    current.filter((value) => value.id !== item.id),
                  )
                }
              />
            ))}
          </div>
        )}
        <textarea
          value={value}
          disabled={!ready}
          onChange={(event) => {
            const next = event.target.value.replaceAll("＠", "@");
            setValue(next);
            setSkillMenuOpen(/@[^\s@]*$/.test(next));
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setSkillMenuOpen(false);
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={
            running
              ? "当前任务执行中；发送后会排队…"
              : ready
                ? "描述你想画什么，输入 @ 选择 Skill…"
                : "描述你想修改的内容…"
          }
          rows={3}
        />
        {skillMenuOpen && skillMention && (
          <div className="skill-mention-menu">
            {skillsLoading ? (
              <span className="skill-mention-empty">正在加载 Skills…</span>
            ) : mentionCandidates.length ? (
              mentionCandidates.map((skill) => (
                <button
                  type="button"
                  key={skill.skill_id}
                  onClick={() => {
                    setSelectedSkills((current) => [...current, skill]);
                    setValue((current) => current.replace(/@[^\s@]*$/, ""));
                    setSkillMenuOpen(false);
                  }}
                >
                  <Sparkles size={14} />
                  <span>
                    <strong>{skill.name}</strong>
                    <small>{skill.description || skill.slug}</small>
                  </span>
                </button>
              ))
            ) : (
              <button
                type="button"
                className="skill-mention-empty"
                onClick={() => {
                  setSkillMenuOpen(false);
                  onConfigureSkills();
                }}
              >
                当前画板没有可用 Skill · 去配置
              </button>
            )}
          </div>
        )}
        <div className="composer-footer">
          <div className="composer-tools">
            <button
              type="button"
              className="attach-button"
              disabled={!ready || running}
              title="选择 Skill"
              onClick={() => {
                setValue(
                  (current) =>
                    `${current}${current && !/\s$/.test(current) ? " " : ""}@`,
                );
                setSkillMenuOpen(true);
              }}
            >
              <Sparkles size={15} />
            </button>
            <button
              type="button"
              className="attach-button"
              disabled={!ready || running || !desktop}
              title="添加图片或文档"
              onClick={async () =>
                void addAttachments(
                  (await window.tugo?.system.chooseAttachments()) || [],
                )
              }
            >
              <Paperclip size={15} />
            </button>
            <span>
              {running
                ? "发送后已排队；可在上方将其引导给当前任务"
                : references.length
                  ? `已引用 ${references.length} 个画布对象`
                  : "拖入文件，或让 AI 直接编辑当前画板"}
            </span>
          </div>
          {running ? (
            <>
              <button
                type="button"
                className="cancel-run"
                title="取消本次操作"
                onClick={onCancel}
              >
                <X size={16} />
              </button>
              <button disabled={!value.trim()} title="当前任务结束后自动发送">
                <Send size={16} />
              </button>
            </>
          ) : (
            <button
              disabled={
                (!value.trim() && !attachments.length && !references.length) ||
                !ready
              }
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </form>
      </aside>
    </>
  );
}

function QueueItem({
  item,
  index,
  dragged,
  onDragStart,
  onDrop,
  onChange,
  onSteer,
  onCancel,
}: {
  item: {
    id: string;
    content: string;
    skills?: ChatSkillMention[];
    status?: "queued" | "awaiting";
  };
  index: number;
  dragged: boolean;
  onDragStart(): void;
  onDrop(): void;
  onChange(content: string): void;
  onSteer(): void;
  onCancel(): void;
}) {
  const [editing, setEditing] = useState(false);
  const awaiting = item.status === "awaiting";
  const presentation = queueRunPresentation(item.status);
  return (
    <div
      className={`chat-queue-item ${dragged ? "is-dragging" : ""} ${awaiting ? "is-steered" : ""}`}
      draggable={!editing && !awaiting}
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <span className="queue-order" title={awaiting ? undefined : "拖动调整顺序"}>
        {index + 1}
      </span>
      {editing ? (
        <input
          autoFocus
          value={item.content}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setEditing(false);
            if (event.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <strong title={item.content}>{item.content}</strong>
      )}
      {awaiting ? (
        <span className="queue-awaiting" title={presentation.detail}>
          <i />正在引导…
        </span>
      ) : (
        <div className="queue-actions">
          <span className="queue-pending" title={presentation.detail}>待发送</span>
          <button type="button" className="queue-action queue-guide" title="立即引导当前任务" onClick={onSteer}>
            <Send size={13} />
          </button>
          <button type="button" className="queue-action" title="编辑" onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </button>
          <button type="button" className="queue-action queue-cancel" title="取消" onClick={onCancel}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  autoCollapse,
  onBranch,
  onReplay,
  onDebug,
  onOpenSnapshots,
  previewDocument,
}: {
  message: ChatMessage;
  autoCollapse?: boolean;
  onBranch(): void;
  onReplay(replacement?: string): Promise<void>;
  onDebug(threadId: string, runId: string): void;
  onOpenSnapshots(snapshotIds: string[], threadId?: string, runId?: string): void | Promise<void>;
  previewDocument?: BoardDocument;
}) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [textCollapsed, setTextCollapsed] = useState(false);
  const [statsExpanded, setStatsExpanded] = useState(false);
  const [referencesExpanded, setReferencesExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!message.pending || message.role !== "assistant") return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [message.pending, message.role]);
  const text =
    message.content || (message.pending ? "正在思考并操作画板…" : "");
  const collapsible = message.role === "user" && text.length > 420;
  useEffect(() => {
    if (autoCollapse && collapsible) setCollapsed(true);
  }, [autoCollapse, collapsible]);
  const copy = async () => {
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* copy button remains unchanged on failure */
    }
  };
  const replay = async (replacement?: string) => {
    if (replaying) return;
    setReplaying(true);
    try {
      await onReplay(replacement);
      setEditing(false);
    } finally {
      setReplaying(false);
    }
  };
  const runPresentation =
    message.role === "assistant" ? assistantRunPresentation(message) : null;
  const failed =
    runPresentation?.state === "failed" ||
    runPresentation?.state === "timed_out";
  const assistantText = message.pending ? "" : text;
  const assistantTextLong = assistantText.length > 180;
  const showAssistantTextFaded = assistantTextLong && textCollapsed;
  const liveStatus = message.runStatus || createRunPresentation(message.createdAt);
  const quiet = message.pending && runIsQuiet(liveStatus, clock);
  const liveHeadline = quiet ? "仍在等待模型响应" : liveStatus.headline;
  const concreteActivity =
    liveStatus.activity?.toolName &&
    liveStatus.activity.status !== "completed";
  const liveActivityText =
    liveStatus.toolPreview ||
    (concreteActivity ? liveStatus.activity?.label : "") ||
    liveStatus.liveNarration ||
    liveStatus.reasoningPreview ||
    liveStatus.activity?.label ||
    liveStatus.narration ||
    liveStatus.detail ||
    (quiet ? "当前操作仍在运行，可以随时停止。" : "正在准备下一项操作…");
  const liveActivityState = liveStatus.activity?.status || "running";
  const recentProgress = (message.process || [])
    .filter(
      (item) =>
        item.status === "success" &&
        item.id !== liveStatus.activity?.id &&
        ["tool", "plan", "status"].includes(item.kind),
    )
    .slice(-2)
    .reverse();
  const completedSummary =
    message.role === "assistant" && !message.pending
      ? message.runSummary
      : undefined;
  // Persisted conversations can contain summaries written by older releases.
  // Treat newly introduced counters as zero instead of letting one legacy
  // message crash the entire renderer when its project is opened.
  const completedChanges = completedSummary?.changes ?? {
    addedElements: 0,
    updatedElements: 0,
    removedElements: 0,
    addedEdges: 0,
    updatedEdges: 0,
    removedEdges: 0,
  };
  const completedArtifacts = completedSummary?.artifacts ?? {
    snapshotsCreated: 0,
    snapshotIds: [],
    imagesCaptured: 0,
  };
  const completedMilestones = completedSummary?.milestones ?? [];
  const hasElementDiff = Boolean(
    completedChanges.addedElements ||
      completedChanges.updatedElements ||
      completedChanges.removedElements,
  );
  const hasEdgeDiff = Boolean(
    completedChanges.addedEdges ||
      completedChanges.updatedEdges ||
      completedChanges.removedEdges,
  );
  const hasSnapshots = Boolean(completedArtifacts.snapshotsCreated);
  const totalAdded = completedChanges.addedElements + completedChanges.addedEdges;
  const totalUpdated =
    completedChanges.updatedElements + completedChanges.updatedEdges;
  const totalRemoved =
    completedChanges.removedElements + completedChanges.removedEdges;
  const hasChanges = Boolean(totalAdded || totalUpdated || totalRemoved);
  const displayText =
    message.role === "assistant"
      ? assistantText
      : collapsed
        ? `${text.slice(0, 260).trimEnd()}…`
        : text;
  const sentAt = new Date(message.createdAt);
  const sentAtLabel = Number.isNaN(sentAt.getTime())
    ? ""
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(sentAt);
  return (
    <div className={`chat-message ${message.role}`}>
      <div className="message-bubble-wrap">
        {message.role === "user" &&
        (message.skills?.length ||
          message.references?.length ||
          message.attachments?.length) ? (
          <div className="message-input-context">
            {message.skills?.map((skill) => (
              <span
                className="message-context-skill"
                key={skill.skillId}
                title={skill.description || skill.name}
              >
                <Sparkles size={12} />@{skill.name}
              </span>
            ))}
            {message.attachments?.map((item) => (
              <span
                className="message-context-attachment"
                key={item.attachmentId}
                title={item.name}
              >
                <Paperclip size={12} />
                {item.name}
              </span>
            ))}
            {message.references?.length ? (
              message.references.length > 3 && !referencesExpanded ? (
                <button
                  type="button"
                  className="reference-summary"
                  onClick={() => setReferencesExpanded(true)}
                >
                  <Crosshair size={11} />
                  <b>已引用 {message.references.length} 个画布对象</b>
                  <small>点击展开</small>
                </button>
              ) : (
                <>
                  {message.references.map((reference) => (
                    <span
                      className="message-context-reference"
                      key={`${reference.kind}:${reference.id}`}
                      title={referenceMeta(reference)}
                    >
                      <Crosshair size={11} />
                      {reference.label}
                    </span>
                  ))}
                  {message.references.length > 3 && (
                    <button
                      type="button"
                      className="reference-collapse"
                      onClick={() => setReferencesExpanded(false)}
                    >
                      收起
                    </button>
                  )}
                </>
              )
            ) : null}
          </div>
        ) : null}
        {message.role !== "user" && message.references?.length ? (
          <div className="message-reference-list">
            {message.references.length > 3 && !referencesExpanded ? (
              <button
                type="button"
                className="reference-summary"
                onClick={() => setReferencesExpanded(true)}
              >
                <Crosshair size={11} />
                <b>已引用 {message.references.length} 个画布对象</b>
                <small>点击展开</small>
              </button>
            ) : (
              <>
                {message.references.map((reference) => (
                  <span
                    key={`${reference.kind}:${reference.id}`}
                    title={referenceMeta(reference)}
                  >
                    <Crosshair size={11} />
                    {reference.label}
                    <small>
                      {reference.kind === "edge"
                        ? "连线"
                        : reference.kind === "region"
                          ? "区域"
                          : "图形"}
                    </small>
                  </span>
                ))}
                {message.references.length > 3 && (
                  <button
                    type="button"
                    className="reference-collapse"
                    onClick={() => setReferencesExpanded(false)}
                  >
                    收起
                  </button>
                )}
              </>
            )}
          </div>
        ) : null}
        {message.role === "assistant" && message.pending ? (
          <div className="run-activity" role="status" aria-live="polite">
            <div className="run-activity-header">
              <span className="process-spinner" />
              <strong>{liveHeadline}</strong>
              <small>· {runElapsedLabel(liveStatus, clock)}</small>
            </div>
            <p className={`run-current-action ${liveActivityState}`}>
              <span aria-hidden="true" />
              <span>{liveActivityText}</span>
            </p>
            {recentProgress.length > 0 && (
              <div className="run-recent-progress" aria-label="最近完成">
                {recentProgress.map((item) => (
                  <span key={item.id}>
                    <Check size={11} />
                    <b>{item.detail || item.label}</b>
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className={`message-content ${message.role === "assistant" ? `assistant-state ${failed ? "is-error" : "is-complete"}` : ""}`}
            role={message.role === "assistant" ? "status" : undefined}
            aria-live={message.role === "assistant" ? "polite" : undefined}
          >
            {message.role === "assistant" && failed && (
              <div className="assistant-bubble-state"><span>!</span><small>{runPresentation?.label}</small></div>
            )}
            {editing ? (
              <div className="message-edit">
                <textarea
                  autoFocus
                  disabled={replaying}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { setDraft(message.content); setEditing(false); }
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void replay(draft);
                  }}
                />
                <div>
                  <button type="button" disabled={replaying} onClick={() => { setDraft(message.content); setEditing(false); }}>取消</button>
                  <button type="button" disabled={!draft.trim() || replaying} onClick={() => void replay(draft)}>{replaying ? "正在重新发送…" : "保存并重新发送"}</button>
                </div>
              </div>
            ) : message.role === "assistant" && showAssistantTextFaded ? (
              <div className="assistant-text-fade">
                <div className="assistant-text-fade-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
                  >
                    {displayText}
                  </ReactMarkdown>
                </div>
                <button
                  type="button"
                  className="assistant-text-expand"
                  onClick={() => setTextCollapsed(false)}
                >
                  展开全部
                </button>
              </div>
            ) : (
              <>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
                >
                  {displayText}
                </ReactMarkdown>
                {message.role === "assistant" && assistantTextLong && !textCollapsed && (
                  <button
                    type="button"
                    className="assistant-text-collapse"
                    onClick={() => setTextCollapsed(true)}
                  >
                    收起
                  </button>
                )}
              </>
            )}
            {message.role === "assistant" && failed && message.threadId && message.runId && (
              <button
                type="button"
                className="message-error-debug"
                onClick={() => onDebug(message.threadId!, message.runId!)}
              >
                <Bug size={13} /> 查看失败详情
              </button>
            )}
            {message.role === "assistant" && !failed && completedSummary && hasChanges && previewDocument ? (
              <BoardResultPreview document={previewDocument} />
            ) : null}
            {message.role === "assistant" &&
              !failed &&
              completedMilestones.length ? (
              <div className="run-completion-summary"><Check size={12} /><span>{completedMilestones.join(" · ")}</span></div>
            ) : null}
            {message.role === "assistant" &&
              !failed &&
              completedSummary &&
              (hasChanges || hasSnapshots) && (
                <div className="run-completion-stats" aria-label="本次修改数量">
                  {hasChanges && (
                    <button
                      type="button"
                      className={`run-change-summary ${statsExpanded ? "expanded" : ""}`}
                      title="展开本次图形与连线的变更明细"
                      aria-expanded={statsExpanded}
                      onClick={() => setStatsExpanded((value) => !value)}
                    >
                      <span className="added">新增 {totalAdded}</span>
                      <span className="updated">调整 {totalUpdated}</span>
                      <span className="removed">删除 {totalRemoved}</span>
                      <ChevronDown size={12} />
                    </button>
                  )}
                  {hasSnapshots && (
                    <button
                      type="button"
                      className="run-snapshot-count"
                      aria-label={`查看本次 AI 保存的 ${completedArtifacts.snapshotsCreated} 个版本快照`}
                      onClick={() => void onOpenSnapshots(completedArtifacts.snapshotIds ?? [], message.threadId, message.runId)}
                    >
                      <History size={13} />
                      <b>{completedArtifacts.snapshotsCreated}</b>
                    </button>
                  )}
                  {statsExpanded && hasChanges && (
                    <div className="run-change-details">
                      {hasElementDiff && (
                        <div className="run-stat-row">
                          <b>图形</b>
                          <span className="added">新增 {completedChanges.addedElements}</span>
                          <span className="updated">调整 {completedChanges.updatedElements}</span>
                          <span className="removed">删除 {completedChanges.removedElements}</span>
                        </div>
                      )}
                      {hasEdgeDiff && (
                        <div className="run-stat-row">
                          <b>连线</b>
                          <span className="added">新增 {completedChanges.addedEdges}</span>
                          <span className="updated">调整 {completedChanges.updatedEdges}</span>
                          <span className="removed">删除 {completedChanges.removedEdges}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            {message.role === "assistant" && !failed && completedSummary && (
              <div className="run-completion-meta">
                {completedSummary.durationMs !== undefined && (
                  <span title="本次运行耗时">{runDurationLabel(completedSummary.durationMs)}</span>
                )}
                {completedSummary.usage && (
                  <span title={`输入 ${completedSummary.usage.inputTokens} · 输出 ${completedSummary.usage.outputTokens}${completedSummary.usage.cachedInputTokens ? ` · 缓存 ${completedSummary.usage.cachedInputTokens}` : ""}`}>
                    {runTokenLabel(completedSummary.usage.totalTokens)}
                  </span>
                )}
                {message.threadId && message.runId && (
                  <button
                    type="button"
                    className="run-debug-trigger"
                    title="查看本次运行调试信息"
                    aria-label="查看本次运行调试信息"
                    onClick={() => onDebug(message.threadId!, message.runId!)}
                  >
                    <Bug size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {message.role === "assistant" && message.attachments?.length ? (
          <div className="message-artifact-row">
            {message.attachments.map((item) => (
              <button
                type="button"
                className="message-file-link"
                key={item.attachmentId}
                title={`下载 ${item.name}`}
                onClick={() => void window.tugo!.runtime.request<{ name: string; data_url: string }>("runtime.http", { method: "GET", path: `/api/attachments/${encodeURIComponent(item.attachmentId)}/download` }).then((file) => {
                  const link = window.document.createElement("a");
                  link.href = file.data_url;
                  link.download = file.name;
                  link.click();
                }).catch((error) => window.alert(`无法下载文件：${error instanceof Error ? error.message : String(error)}`))}
              >
                <FileText size={14} /><span>{item.name}</span><Download size={13} />
              </button>
            ))}
          </div>
        ) : null}
        <div className="message-footer">
          {sentAtLabel ? <time className="message-time" dateTime={message.createdAt}>{sentAtLabel}</time> : null}
          <div className="message-actions">
          {collapsible && (
            <button
              className="message-copy"
              title={collapsed ? "展开消息" : "折叠消息"}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
            </button>
          )}
          {message.role === "user" && !message.pending && (
            <>
              <button
                className="message-copy"
                title="重新发送，并移除这条消息后的对话"
                aria-label="重新发送"
                disabled={replaying}
                onClick={() => void replay()}
              >
                <RotateCcw size={13} />
              </button>
              <button
                className="message-copy"
                title="编辑后重新发送"
                aria-label="编辑后重新发送"
                disabled={replaying}
                onClick={() => {
                  setDraft(message.content);
                  setEditing(true);
                }}
              >
                <Pencil size={13} />
              </button>
            </>
          )}
          <button
            className="message-copy"
            title="从此处创建独立分支"
            aria-label="从此处创建独立分支"
            onClick={onBranch}
            disabled={message.pending}
          >
            <GitBranch size={13} />
          </button>
          <button
            className={`message-copy ${copied ? "copied" : ""}`}
            title={copied ? "已复制" : "复制消息"}
            aria-label={copied ? "已复制" : "复制消息"}
            onClick={() => void copy()}
            disabled={!text}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
});

function BoardResultPreview({ document }: { document: BoardDocument }) {
  const [image, setImage] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const bounds = contentBounds(document.elements, 32);
    if (!bounds) return;
    let cancelled = false;
    void renderRegionPngDataUrl(document, bounds, 960)
      .then((value) => { if (!cancelled) setImage(`data:image/png;base64,${value.base64}`); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // This preview intentionally freezes the board at the moment the completed
    // response becomes visible instead of drifting with later manual edits.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return null;
  return (
    <figure className={`board-result-preview ${image ? "is-ready" : "is-loading"}`}>
      <figcaption><span><Check size={12} />本次操作后的当前画板</span><small>真实画布渲染</small></figcaption>
      {image ? <img src={image} alt="本次 AI 操作后的画板预览" /> : <div><span className="process-spinner" />正在生成预览…</div>}
    </figure>
  );
}

type DebugJournalItem = Record<string, unknown>;
type DebugCallGroup = {
  id: string;
  phase: string;
  actor: string;
  firstId: number;
  duration?: unknown;
  failed: boolean;
  entries: DebugJournalItem[];
};

function DebugCallCard({
  group,
  payloadText,
  copiedPayload,
  onCopy,
}: {
  group: DebugCallGroup;
  payloadText(item: DebugJournalItem): string;
  copiedPayload: string;
  onCopy(value: string, id: string): void;
}) {
  const [tab, setTab] = useState(0);
  const phase =
    group.phase === "model"
      ? "LLM"
      : group.phase === "tool"
        ? "Tool"
        : group.phase === "middleware"
          ? "Middleware"
          : "Runtime";
  const title =
    group.phase === "model"
      ? "LLM Call"
      : group.phase === "tool"
        ? group.actor || "Tool Call"
        : group.phase === "middleware"
          ? group.actor || "Middleware"
          : group.actor || "Runtime";
  const tabLabel = (item: DebugJournalItem) => {
    const event = String(item.event_type || "");
    if (event === "model.http.request") return "Request";
    if (
      event === "model.http.response.complete" ||
      event === "model.http.response"
    )
      return "Response";
    if (event.endsWith(".request")) return "Request";
    if (event.endsWith(".response")) return "Result";
    if (event.endsWith(".started")) return "Started";
    if (event.endsWith(".completed")) return "Completed";
    if (event.endsWith(".error")) return "Error";
    if (event.endsWith(".interrupted")) return "Interrupted";
    return event.replace(/^[^.]+\./, "") || "Event";
  };
  // Middleware lifecycle records often only bracket a synchronous hook. When
  // neither its context nor outcome changed, Started and Completed are the
  // same diagnostic fact, so show its final state once instead of pretending
  // two identical JSON blobs convey two different things.
  const entries = (() => {
    if (group.phase !== "middleware" || group.entries.length !== 2)
      return group.entries;
    const [started, completed] = group.entries;
    if (
      !String(started.event_type || "").endsWith(".started") ||
      !String(completed.event_type || "").endsWith(".completed")
    )
      return group.entries;
    const startedPayload = JSON.stringify(started.payload || {});
    const completedPayload = JSON.stringify(completed.payload || {});
    return startedPayload === completedPayload
      ? [{ ...completed, event_type: "middleware.result" }]
      : group.entries;
  })();
  const effectiveDuration =
    group.duration ??
    (() => {
      const first = Date.parse(String(entries[0]?.created_at || ""));
      const last = Date.parse(String(entries.at(-1)?.created_at || ""));
      return Number.isFinite(first) && Number.isFinite(last) && last >= first
        ? last - first
        : undefined;
    })();
  const active = entries[Math.min(tab, entries.length - 1)];
  const activeId = `${group.id}:${tab}`;
  return (
    <details
      className={`debug-timeline-item debug-call-card phase-${group.phase || "run"}`}
      open={group.failed}
    >
      <summary>
        <b>{phase}</b>
        <span>{title}</span>
        <small>
          {effectiveDuration != null
            ? `${String(effectiveDuration)} ms`
            : entries.length > 1
              ? `${entries.length} events`
              : ""}
        </small>
      </summary>
      {entries.length > 1 && (
        <div
          className="debug-call-tabs"
          role="tablist"
          aria-label={`${title} details`}
        >
          {entries.map((item, index) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === index}
              className={tab === index ? "active" : ""}
              key={`${String(item.id || index)}-${tabLabel(item)}`}
              onClick={() => setTab(index)}
            >
              {tabLabel(item)}
            </button>
          ))}
        </div>
      )}
      {active && (
        <>
          <div className="debug-payload-actions">
            <button
              type="button"
              onClick={() => onCopy(payloadText(active), activeId)}
              title="复制原始 JSON"
            >
              {copiedPayload === activeId ? (
                <Check size={13} />
              ) : (
                <Copy size={13} />
              )}{" "}
              {copiedPayload === activeId ? "已复制" : "复制"}
            </button>
          </div>
          <pre>{payloadText(active)}</pre>
        </>
      )}
    </details>
  );
}

function RunDebugDialog({
  api,
  target,
  onClose,
}: {
  api: TuGoApi;
  target: { threadId: string; runId: string };
  onClose(): void;
}) {
  const [trace, setTrace] = useState<{
    failure: Record<string, unknown> | null;
    loops: Array<{
      loop_index: number;
      model: Array<Record<string, unknown>>;
      middleware: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
      run: Array<Record<string, unknown>>;
    }>;
  } | null>(null);
  const [debug, setDebug] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState("");
  const [copiedPayload, setCopiedPayload] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([
      api.runtimeTrace(target.threadId, target.runId),
      api.runtimeDebug(target.threadId, target.runId),
    ])
      .then(([traceResult, debugResult]) => {
        if (active) {
          setTrace(traceResult);
          setDebug(debugResult.items);
        }
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [api, target]);
  const payloadText = (item: Record<string, unknown>) =>
    JSON.stringify(item.payload || {}, null, 2);
  const copyPayload = async (value: string, id: string) => {
    try {
      await copyTextToClipboard(value);
      setError("");
      setCopiedPayload(id);
      window.setTimeout(
        () => setCopiedPayload((current) => (current === id ? "" : current)),
        1400,
      );
    } catch (reason) {
      setError(
        `复制失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  };
  const renderTimeline = (loop: {
    model: Array<Record<string, unknown>>;
    middleware: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>>;
    run: Array<Record<string, unknown>>;
  }) => {
    const raw = [
      ...loop.model,
      ...loop.middleware,
      ...loop.tools,
      ...loop.run,
    ].sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
    const completeResponses = raw.filter(
      (item) =>
        String(item.event_type || "") === "model.http.response.complete",
    );
    const completedCorrelations = new Set(
      completeResponses.map((item) => String(item.correlation_id || "")),
    );
    const responseHeaders = new Map(
      raw
        .filter(
          (item) => String(item.event_type || "") === "model.http.response",
        )
        .map((item) => [String(item.correlation_id || ""), item]),
    );
    const framesByCorrelation = new Map<
      string,
      Array<Record<string, unknown>>
    >();
    for (const item of raw.filter(
      (value) => String(value.event_type || "") === "model.http.response.frame",
    )) {
      const correlation = String(item.correlation_id || "");
      framesByCorrelation.set(correlation, [
        ...(framesByCorrelation.get(correlation) || []),
        item,
      ]);
    }
    const assembleFrames = (frames: Array<Record<string, unknown>>) => {
      let content = "";
      let reasoning = "";
      let finishReason = "";
      let usage: unknown;
      const toolCalls: unknown[] = [];
      for (const frame of frames) {
        const envelope =
          frame.payload && typeof frame.payload === "object"
            ? (frame.payload as Record<string, unknown>)
            : {};
        if (String(envelope.data || "") === "[DONE]") continue;
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(envelope.data || "{}")) as Record<
            string,
            unknown
          >;
        } catch {
          continue;
        }
        for (const choice of Array.isArray(payload.choices)
          ? (payload.choices as Array<Record<string, unknown>>)
          : []) {
          const delta =
            choice.delta && typeof choice.delta === "object"
              ? (choice.delta as Record<string, unknown>)
              : {};
          if (typeof delta.content === "string") content += delta.content;
          if (typeof (delta.reasoning_content ?? delta.reasoning) === "string")
            reasoning += String(delta.reasoning_content ?? delta.reasoning);
          if (Array.isArray(delta.tool_calls))
            toolCalls.push(...delta.tool_calls);
          if (choice.finish_reason) finishReason = String(choice.finish_reason);
        }
        const type = String(payload.type || "");
        if (
          type === "response.output_text.delta" &&
          typeof payload.delta === "string"
        )
          content += payload.delta;
        if (
          type === "response.reasoning_summary_text.delta" &&
          typeof payload.delta === "string"
        )
          reasoning += payload.delta;
        if (type.includes("function_call")) toolCalls.push(payload);
        const delta =
          payload.delta && typeof payload.delta === "object"
            ? (payload.delta as Record<string, unknown>)
            : {};
        if (delta.type === "text_delta" && typeof delta.text === "string")
          content += delta.text;
        if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        )
          reasoning += delta.thinking;
        if (delta.type === "input_json_delta") toolCalls.push(payload);
        for (const candidate of Array.isArray(payload.candidates)
          ? (payload.candidates as Array<Record<string, unknown>>)
          : []) {
          const candidateContent =
            candidate.content && typeof candidate.content === "object"
              ? (candidate.content as Record<string, unknown>)
              : {};
          for (const part of Array.isArray(candidateContent.parts)
            ? (candidateContent.parts as Array<Record<string, unknown>>)
            : []) {
            if (typeof part.text === "string") content += part.text;
            if (part.functionCall) toolCalls.push(part.functionCall);
          }
          if (candidate.finishReason)
            finishReason = String(candidate.finishReason);
        }
        if (payload.usage || payload.usageMetadata)
          usage = payload.usage || payload.usageMetadata;
      }
      return {
        streaming: true,
        frame_count: frames.length,
        content,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finish_reason: finishReason } : {}),
      };
    };
    const visible = raw.flatMap((item) => {
      const event = String(item.event_type || "");
      const correlation = String(item.correlation_id || "");
      if (event === "model.request" || event === "model.response") return [];
      if (event === "model.http.response.frame") {
        if (completedCorrelations.has(correlation)) return [];
        const frames = framesByCorrelation.get(correlation) || [];
        if (item !== frames.at(-1)) return [];
        const header = responseHeaders.get(correlation);
        const headerPayload =
          header?.payload && typeof header.payload === "object"
            ? (header.payload as Record<string, unknown>)
            : {};
        return [
          {
            ...item,
            event_type: "model.http.response.complete",
            payload: { ...headerPayload, ...assembleFrames(frames) },
          },
        ];
      }
      if (
        event === "model.http.response" &&
        (completedCorrelations.has(correlation) ||
          framesByCorrelation.has(correlation))
      )
        return [];
      if (event === "model.http.response.complete") {
        const header = responseHeaders.get(correlation);
        const headerPayload =
          header?.payload && typeof header.payload === "object"
            ? (header.payload as Record<string, unknown>)
            : {};
        const bodyPayload =
          item.payload && typeof item.payload === "object"
            ? (item.payload as Record<string, unknown>)
            : {};
        return [{ ...item, payload: { ...headerPayload, ...bodyPayload } }];
      }
      return [item];
    });
    // A journal emits lifecycle events in pairs.  Group those events by their
    // actual correlation id before rendering so the visual timeline represents
    // calls (LLM / tool / middleware), not individual implementation hooks.
    const groups = new Map<string, DebugCallGroup>();
    for (const item of visible) {
      const phase = String(item.phase || "run");
      const event = String(item.event_type || "");
      // Model summaries duplicate the HTTP request/response shown below.
      if (
        phase === "model" &&
        (event === "model.request" || event === "model.response")
      )
        continue;
      const correlation = String(item.correlation_id || item.id || "");
      const id = `${phase}:${correlation || `${item.actor || "runtime"}:${item.id || groups.size}`}`;
      const current = groups.get(id) || {
        id,
        phase,
        actor: String(item.actor || ""),
        firstId: Number(item.id || Number.MAX_SAFE_INTEGER),
        duration: undefined,
        failed: false,
        entries: [],
      };
      current.entries.push(item);
      current.firstId = Math.min(
        current.firstId,
        Number(item.id || Number.MAX_SAFE_INTEGER),
      );
      current.duration = item.duration_ms ?? current.duration;
      current.failed ||=
        item.status === "failed" ||
        event.endsWith(".error") ||
        event.endsWith(".interrupted");
      groups.set(id, current);
    }
    const orderedGroups = [...groups.values()].sort(
      (left, right) => left.firstId - right.firstId,
    );
    return (
      <div className="debug-timeline">
        {orderedGroups.map((group) => (
          <DebugCallCard
            key={group.id}
            group={group}
            payloadText={payloadText}
            copiedPayload={copiedPayload}
            onCopy={(value, id) => void copyPayload(value, id)}
          />
        ))}
      </div>
    );
  };
  return (
    <div
      className="modal-backdrop run-debug-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="run-debug-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-debug-title"
      >
        <div className="modal-header">
          <div>
            <small>RUN JOURNAL</small>
            <h2 id="run-debug-title">运行调试</h2>
            <p>{target.runId}</p>
          </div>
          <button
            className="icon-btn"
            aria-label="关闭运行调试"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="run-debug-content">
          {error && <div className="form-error">{error}</div>}
          {!error && !trace && (
            <div className="configuration-loading">正在读取运行记录…</div>
          )}
          {trace?.failure && (
            <section className="debug-failure-summary">
              <strong>
                失败位置：{String(trace.failure.phase || "runtime")} /{" "}
                {String(trace.failure.actor || "runtime")}
                {trace.failure.contract_phase ? (
                  <span className="failure-contract-phase">（错误类型：{String(trace.failure.contract_phase)}）</span>
                ) : null}
              </strong>
              {trace.failure.user_message ? (
                <p className="failure-user-message">
                  {String(trace.failure.user_message)}
                </p>
              ) : null}
              {trace.failure.user_action ? (
                <p className="failure-user-action">
                  <strong>建议操作：</strong>{String(trace.failure.user_action)}
                </p>
              ) : null}
              {trace.failure.message ? (
                <p className="failure-technical-message">
                  <strong>错误详情：</strong>{String(trace.failure.message)}
                </p>
              ) : null}
              <div className="failure-metadata">
                {trace.failure.error_code ? (
                  <small>错误码：{String(trace.failure.error_code)}</small>
                ) : null}
                {trace.failure.category ? (
                  <small>分类：{String(trace.failure.category)}</small>
                ) : null}
                {trace.failure.error_category ? (
                  <small>错误分类：{String(trace.failure.error_category)}</small>
                ) : null}
                {typeof trace.failure.retryable === "boolean" ? (
                  <small>{trace.failure.retryable ? "可重试" : "不可重试"}</small>
                ) : null}
                {trace.failure.status ? (
                  <small>HTTP {String(trace.failure.status)}</small>
                ) : null}
              </div>
              {trace.failure.technical_detail ? (
                <details className="failure-technical-detail">
                  <summary>技术详情</summary>
                  <pre>{String(trace.failure.technical_detail)}</pre>
                </details>
              ) : null}
              {trace.failure.provider_error ? (
                <details className="failure-provider-error">
                  <summary>Provider 错误</summary>
                  <pre>{JSON.stringify(trace.failure.provider_error, null, 2)}</pre>
                </details>
              ) : null}
            </section>
          )}
          {trace?.loops.map((loop) => (
            <details
              className="debug-phase debug-loop debug-loop-disclosure"
              key={loop.loop_index}
            >
              <summary>
                <h3>Loop {loop.loop_index}</h3>
                <small>
                  {
                    loop.model.filter((item) =>
                      [
                        "model.http.request",
                        "model.http.response",
                        "model.http.response.complete",
                      ].includes(String(item.event_type || "")),
                    ).length
                  }{" "}
                  HTTP · {loop.tools.length} Tool · {loop.middleware.length}{" "}
                  Middleware
                </small>
              </summary>
              <div className="debug-loop-content">{renderTimeline(loop)}</div>
            </details>
          ))}
          {debug.length > 0 && (
            <section className="debug-phase">
              <h3>异常诊断</h3>
              {debug.map((item, index) => {
                const text = payloadText(item);
                const id = `diagnostic-${String(item.id || index)}`;
                return (
                  <details key={String(item.id || index)}>
                    <summary>
                      <span>{String(item.category || "debug")}</span>
                      <small>{String(item.created_at || "")}</small>
                    </summary>
                    <div className="debug-payload-actions">
                      <button
                        type="button"
                        onClick={() => void copyPayload(text, id)}
                        title="复制原始 JSON"
                      >
                        {copiedPayload === id ? (
                          <Check size={13} />
                        ) : (
                          <Copy size={13} />
                        )}{" "}
                        {copiedPayload === id ? "已复制" : "复制"}
                      </button>
                    </div>
                    <pre>{text}</pre>
                  </details>
                );
              })}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

function ProjectSkillsDialog({
  skills,
  selectedIds,
  onClose,
  onSave,
}: {
  skills: SkillRecord[];
  selectedIds: string[];
  onClose(): void;
  onSave(ids: string[]): Promise<void>;
}) {
  const [selected, setSelected] = useState(() => new Set(selectedIds));
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      await onSave([...selected]);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal project-skills-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-skills-title"
      >
        <div className="modal-header">
          <div>
            <small>PROJECT SKILLS</small>
            <h2 id="project-skills-title">本项目 Skills</h2>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="project-skills-list">
          {skills.length ? (
            skills.map((skill) => (
              <label key={skill.skill_id}>
                <input
                  type="checkbox"
                  checked={selected.has(skill.skill_id)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      next.has(skill.skill_id)
                        ? next.delete(skill.skill_id)
                        : next.add(skill.skill_id);
                      return next;
                    })
                  }
                />
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.description || skill.slug}</small>
                </span>
              </label>
            ))
          ) : (
            <div className="project-skills-empty">没有已启用的 Skill</div>
          )}
        </div>
        <div className="modal-footer">
          <span>已选择 {selected.size} 个</span>
          <button className="soft-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-btn"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? "正在保存…" : "完成"}
          </button>
        </div>
      </div>
    </div>
  );
}

type SnapshotSource = "user" | "agent";
type BoardSnapshotMeta = {
  id: string;
  name: string;
  source: SnapshotSource;
  reason: string;
  summary: string;
  notes: string;
  createdAt: string;
};
type BoardSnapshot = BoardSnapshotMeta & {
  projectId: string;
  document: BoardDocument;
};

function SnapshotSaveDialog({
  initialName,
  onClose,
  onSave,
}: {
  initialName: string;
  onClose(): void;
  onSave(value: { name: string; notes: string }): Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave({ name: name.trim(), notes: notes.trim() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal snapshot-save-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-save-title"
      >
        <div className="modal-header">
          <div>
            <small>BOARD SNAPSHOT</small>
            <h2 id="snapshot-save-title">保存快照</h2>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="snapshot-save-form">
          <label>
            快照名称
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：核心流程完成版"
            />
          </label>
          <label>
            备注（可选）
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="待验证事项、取舍或下一步"
              rows={3}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="soft-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-btn"
            disabled={saving || !name.trim()}
            onClick={() => void submit()}
          >
            {saving ? "正在保存…" : "保存快照"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SnapshotBrowserDialog({
  projectId,
  focusSnapshotIds = [],
  onClose,
  onRestore,
  onCreateProject,
  onCreateManualSnapshot,
  initialManualSnapshotName,
}: {
  projectId: string;
  focusSnapshotIds?: string[];
  onClose(): void;
  onRestore(document: BoardDocument): Promise<void>;
  onCreateProject(name: string, document: BoardDocument): Promise<void>;
  onCreateManualSnapshot(value: { name: string; notes: string }): Promise<BoardSnapshotMeta>;
  initialManualSnapshotName: string;
}) {
  const [items, setItems] = useState<BoardSnapshotMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [source, setSource] = useState<SnapshotSource>("user");
  const [initialPage, setInitialPage] = useState(1);
  const [preferredSnapshotId, setPreferredSnapshotId] = useState("");
  const [matchedSnapshotIds, setMatchedSnapshotIds] = useState<string[]>([]);
  const [focusNotice, setFocusNotice] = useState("");
  const [initialised, setInitialised] = useState(false);
  const [selected, setSelected] = useState<BoardSnapshot | null>(null);
  const [preview, setPreview] = useState("");
  const [previewZoomOpen, setPreviewZoomOpen] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creatingManualSnapshot, setCreatingManualSnapshot] = useState(false);
  const load = useCallback(
    async (targetPage = 1, targetSource = source, targetSnapshotId = preferredSnapshotId) => {
      if (!window.tugo) return;
      setLoading(true);
      setError("");
      try {
        const result = await window.tugo.projects.snapshots.list(
          projectId,
          targetPage,
          10,
          targetSource,
        );
        setItems(result.items);
        setTotal(result.total);
        setPage(result.page);
        setSelected(null);
        setPreview("");
        const preferred = targetSnapshotId
          ? result.items.find((item) => item.id === targetSnapshotId)
          : undefined;
        if (preferred || result.items[0]) void choose(preferred || result.items[0]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [preferredSnapshotId, projectId, source],
  );
  useEffect(() => {
    if (initialised) void load(initialPage);
  }, [initialPage, initialised, load]);
  useEffect(() => {
    let active = true;
    if (!window.tugo) {
      setInitialised(true);
      return () => {
        active = false;
      };
    }
    const snapshots = window.tugo.projects.snapshots;
    const initialise = async () => {
      try {
        const requested = [...new Set(focusSnapshotIds.filter(Boolean))];
        const matches: Array<{ item: BoardSnapshotMeta; source: SnapshotSource; index: number }> = [];
        if (requested.length) {
          for (const candidateSource of ["agent", "user"] as SnapshotSource[]) {
            let candidatePage = 1;
            let offset = 0;
            while (active) {
              const result = await snapshots.list(projectId, candidatePage, 100, candidateSource);
              result.items.forEach((item, index) => {
                if (requested.includes(item.id)) matches.push({ item, source: candidateSource, index: offset + index });
              });
              if (!result.hasMore || matches.length === requested.length) break;
              offset += result.items.length;
              candidatePage += 1;
            }
            if (matches.length === requested.length) break;
          }
        }
        if (!active) return;
        if (matches.length) {
          const latest = matches.sort((left, right) => new Date(right.item.createdAt).getTime() - new Date(left.item.createdAt).getTime())[0];
          setSource(latest.source);
          setInitialPage(Math.floor(latest.index / 10) + 1);
          setPreferredSnapshotId(latest.item.id);
          setMatchedSnapshotIds(matches.map((match) => match.item.id));
          setFocusNotice(`已定位本次运行保留的 ${matches.length} 个快照`);
        } else {
          const latest = await snapshots.latest(projectId);
          setSource(latest?.source === "agent" ? "agent" : "user");
          setFocusNotice(requested.length ? "本次运行的快照已删除，已显示最新版本" : "");
        }
        setInitialised(true);
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setInitialised(true);
        }
      }
    };
    void initialise();
    return () => {
      active = false;
    };
  }, [focusSnapshotIds, projectId]);
  async function choose(snapshot: BoardSnapshotMeta) {
    if (!window.tugo) return;
    setBusy(true);
    setError("");
    setPreview("");
    try {
      const full = await window.tugo.projects.snapshots.get(
        projectId,
        snapshot.id,
      );
      setSelected(full);
      const elements = full.document.elements;
      const region: ExportRegion = elements.length
        ? {
            x: Math.min(...elements.map((item) => item.x)) - 52,
            y: Math.min(...elements.map((item) => item.y)) - 52,
            width: Math.max(
              1,
              Math.max(...elements.map((item) => item.x + item.width)) -
                Math.min(...elements.map((item) => item.x)) +
                104,
            ),
            height: Math.max(
              1,
              Math.max(...elements.map((item) => item.y + item.height)) -
                Math.min(...elements.map((item) => item.y)) +
                104,
            ),
          }
        : { x: -80, y: -80, width: 640, height: 420 };
      const rendered = await renderRegionPngDataUrl(
        full.document,
        region,
        1200,
      );
      setPreview(`data:image/png;base64,${rendered.base64}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        /No handler registered for ['"]?tugo:projects:snapshots:(?:export|import)/i.test(message)
          ? "TuGo 桌面服务尚未更新，请完全退出应用后重新启动再试。"
          : message,
      );
    } finally {
      setBusy(false);
    }
  };
  const sourceLabel = source === "user" ? "我的快照" : "AI 快照";
  const switchSource = (next: SnapshotSource) => {
    if (next !== source) {
      setSource(next);
      setSelected(null);
      setPreview("");
    }
  };
  const remove = async (snapshot: BoardSnapshotMeta) => {
    if (
      !window.tugo ||
      !window.confirm(`删除快照“${snapshot.name}”？此操作不能撤销。`)
    )
      return;
    setBusy(true);
    setError("");
    try {
      await window.tugo.projects.snapshots.remove(projectId, snapshot.id);
      await load(page, source);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveManualSnapshot = async (value: { name: string; notes: string }) => {
    setBusy(true);
    try {
      const snapshot = await onCreateManualSnapshot(value);
      setCreatingManualSnapshot(false);
      setSource("user");
      setInitialPage(1);
      setPreferredSnapshotId(snapshot.id);
      setMatchedSnapshotIds([]);
      setFocusNotice("");
      await load(1, "user", snapshot.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal snapshot-browser-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-browser-title"
      >
        <div className="modal-header">
          <div>
            <small>BOARD HISTORY</small>
            <h2 id="snapshot-browser-title">版本快照</h2>
            <p>
              {sourceLabel} · 共 {total} 个
            </p>
            {focusNotice ? <p>{focusNotice}</p> : null}
          </div>
          <button
            className="icon-btn"
            data-e2e="close-version-snapshots"
            aria-label="关闭版本快照"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div
          className="snapshot-source-tabs"
          role="tablist"
          aria-label="快照来源"
        >
          <button
            type="button"
            role="tab"
            aria-selected={source === "user"}
            className={source === "user" ? "active" : ""}
            onClick={() => switchSource("user")}
          >
            我的快照
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === "agent"}
            className={source === "agent" ? "active" : ""}
            onClick={() => switchSource("agent")}
          >
            AI 快照
          </button>
        </div>
        {source === "user" ? (
          <div className="snapshot-create-action">
            <button
              type="button"
              className="primary-btn"
              disabled={busy || creatingManualSnapshot}
              onClick={() => setCreatingManualSnapshot(true)}
            >
              <Plus size={15} /> 创建快照
            </button>
          </div>
        ) : null}
        <div className="snapshot-browser-content">
          <aside className="snapshot-list">
            {loading ? (
              <div className="snapshot-empty">正在加载版本…</div>
            ) : items.length ? (
              items.map((item) => (
                <div
                  key={item.id}
                  className={`snapshot-list-item ${selected?.id === item.id ? "active" : ""} ${matchedSnapshotIds.includes(item.id) ? "run-focus" : ""}`}
                >
                  <button
                    className="snapshot-list-select"
                    onClick={() => void choose(item)}
                  >
                    <strong>{item.name}</strong>
                    <small>{new Date(item.createdAt).toLocaleString()}</small>
                    {matchedSnapshotIds.includes(item.id) ? <em className="snapshot-run-mark">本次生成</em> : null}
                    {source === "agent" && item.summary ? (
                      <span>{item.summary}</span>
                    ) : source === "user" && item.notes ? (
                      <span>{item.notes}</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="snapshot-delete"
                    title="删除快照"
                    aria-label={`删除快照 ${item.name}`}
                    disabled={busy}
                    onClick={() => void remove(item)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            ) : (
              <div className="snapshot-empty">
                {source === "user"
                  ? "还没有保存过快照。"
                  : "AI 还没有保存过快照。"}
              </div>
            )}
            {total > 10 && (
              <div className="snapshot-pagination">
                <button
                  disabled={page <= 1 || busy}
                  onClick={() => void load(page - 1)}
                >
                  上一页
                </button>
                <span>
                  {page} / {Math.ceil(total / 10)}
                </span>
                <button
                  disabled={page * 10 >= total || busy}
                  onClick={() => void load(page + 1)}
                >
                  下一页
                </button>
              </div>
            )}
          </aside>
          <section className="snapshot-preview">
            {selected ? (
              <>
                <div className="snapshot-preview-header">
                  <div>
                    <strong>{selected.name}</strong>
                    <small>
                      {new Date(selected.createdAt).toLocaleString()}
                    </small>
                  </div>
                  <span>
                    {selected.document.elements.length} 个图形 ·{" "}
                    {selected.document.edges.length} 条连线
                  </span>
                </div>
                <div className="snapshot-image-frame">
                  {preview ? (
                    <button type="button" className="snapshot-image-zoom" onClick={() => { setPreviewZoom(1); setPreviewZoomOpen(true); }} title="点击放大查看">
                      <img src={preview} alt={`${selected.name} 的画板快照预览`} />
                    </button>
                  ) : (
                    <span>
                      {busy ? "正在生成不可编辑预览…" : "选择一个快照查看预览"}
                    </span>
                  )}
                </div>
                {selected.source === "agent" && selected.summary ? (
                  <div className="snapshot-detail">
                    <label>
                      AI 版本摘要<p>{selected.summary}</p>
                    </label>
                  </div>
                ) : null}
                <div className="snapshot-actions">
                  <button
                    className="soft-btn"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await window.tugo!.projects.snapshots.export(projectId, selected.id);
                        if (result.path) setFocusNotice(`快照已导出到 ${result.path}`);
                      })
                    }
                  >
                    <Download size={15} /> 导出快照文件
                  </button>
                  <button
                    className="soft-btn"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        onCreateProject(selected.name, selected.document),
                      )
                    }
                  >
                    <GitBranch size={15} /> 从此版本创建新画板
                  </button>
                  <button
                    className="primary-btn"
                    disabled={busy}
                    onClick={() => void run(() => onRestore(selected.document))}
                  >
                    <RotateCcw size={15} /> 恢复为当前画板
                  </button>
                </div>
              </>
            ) : (
              <div className="snapshot-preview-empty">
                <GitBranch size={26} />
                <strong>选择一个版本</strong>
                <span>右侧会显示不可编辑的图片预览。</span>
              </div>
            )}
          </section>
        </div>
        {error && <div className="snapshot-error">{error}</div>}
      </div>
      {creatingManualSnapshot ? (
        <SnapshotSaveDialog
          initialName={initialManualSnapshotName}
          onClose={() => setCreatingManualSnapshot(false)}
          onSave={saveManualSnapshot}
        />
      ) : null}
      {previewZoomOpen && preview ? (
        <div className="snapshot-zoom-backdrop" role="dialog" aria-modal="true" aria-label="快照大图预览" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewZoomOpen(false); }}>
          <button type="button" className="icon-btn snapshot-zoom-close" aria-label="关闭大图预览" onClick={() => setPreviewZoomOpen(false)}><X size={18} /></button>
          <div className="snapshot-zoom-stage" onWheel={(event) => { event.preventDefault(); setPreviewZoom((value) => Math.max(.5, Math.min(5, Number((value + (event.deltaY < 0 ? .2 : -.2)).toFixed(2))))); }}>
            <img style={{ width: `${previewZoom * 100}%` }} src={preview} alt={`${selected?.name || "快照"} 的放大预览`} />
          </div>
          <span className="snapshot-zoom-level">{Math.round(previewZoom * 100)}%</span>
        </div>
      ) : null}
    </div>
  );
}

function DslPreview({ document, imageSources = {} }: { document: BoardDocument; imageSources?: Record<string, string> }) {
  const elements = document.elements;
  const elementById = new Map(elements.map((element) => [element.id, element]));
  const edgePoints = document.edges.flatMap((edge) =>
    [edge.freeStart, edge.freeEnd, ...(edge.controlPoints || [])].filter(
      (point): point is { x: number; y: number } =>
        Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y)),
    ),
  );
  const points = [
    ...elements.flatMap((element) => [
      { x: element.x, y: element.y },
      { x: element.x + element.width, y: element.y + element.height },
    ]),
    ...edgePoints,
  ];
  const minX = Math.min(0, ...points.map((point) => point.x)),
    minY = Math.min(0, ...points.map((point) => point.y)),
    maxX = Math.max(720, ...points.map((point) => point.x)),
    maxY = Math.max(420, ...points.map((point) => point.y));
  const padding = 46,
    width = Math.max(1, maxX - minX + padding * 2),
    height = Math.max(1, maxY - minY + padding * 2);
  const endpoint = (edge: BoardEdge, side: "from" | "to") => {
    const element = elementById.get(side === "from" ? edge.from : edge.to);
    const free = side === "from" ? edge.freeStart : edge.freeEnd;
    const anchor = side === "from" ? edge.fromAnchor : edge.toAnchor;
    return element
      ? {
          x: element.x + element.width * (anchor?.x ?? 0.5),
          y: element.y + element.height * (anchor?.y ?? 0.5),
        }
      : free || { x: 0, y: 0 };
  };
  const pathFor = (edge: BoardEdge) => {
    const start = endpoint(edge, "from"),
      end = endpoint(edge, "to"),
      control = edge.controlPoints?.[0];
    if (edge.routing === "straight")
      return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    if (edge.routing === "elbow") {
      const first = control || { x: (start.x + end.x) / 2, y: start.y };
      const second = edge.controlPoints?.[1] || { x: first.x, y: end.y };
      return `M ${start.x} ${start.y} L ${first.x} ${first.y} L ${second.x} ${second.y} L ${end.x} ${end.y}`;
    }
    const curve = control || {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };
    return `M ${start.x} ${start.y} Q ${curve.x} ${curve.y} ${end.x} ${end.y}`;
  };
  const shape = (element: BoardElement) => {
    const w = element.width,
      h = element.height,
      pie = element.metadata?.mermaidPieSlice as
        | { start?: number; end?: number }
        | undefined;
    const style = {
      fill: element.fill,
      fillOpacity: element.fillOpacity ?? 1,
      stroke: element.stroke,
      strokeWidth: element.strokeWidth,
    };
    if (pie && Number.isFinite(pie.start) && Number.isFinite(pie.end)) {
      const start = ((pie.start! - 90) * Math.PI) / 180,
        end = ((pie.end! - 90) * Math.PI) / 180,
        cx = w / 2,
        cy = h / 2;
      return (
        <path
          d={`M ${cx} ${cy} L ${cx + Math.cos(start) * cx} ${cy + Math.sin(start) * cy} A ${cx} ${cy} 0 ${pie.end! - pie.start! > 180 ? 1 : 0} 1 ${cx + Math.cos(end) * cx} ${cy + Math.sin(end) * cy} Z`}
          {...style}
        />
      );
    }
    if (element.kind === "ellipse")
      return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...style} />;
    if (element.kind === "diamond")
      return (
        <path
          d={`M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`}
          {...style}
        />
      );
    if (element.kind === "hexagon")
      return (
        <path
          d={`M ${w * 0.25} 0 H ${w * 0.75} L ${w} ${h / 2} L ${w * 0.75} ${h} H ${w * 0.25} L 0 ${h / 2} Z`}
          {...style}
        />
      );
    if (element.kind === "note")
      return <path d={`M 0 0 H ${w - 20} L ${w} 20 V ${h} H 0 Z`} {...style} />;
    if (element.kind === "database")
      return (
        <path
          d={`M 0 14 C 0 -4 ${w} -4 ${w} 14 V ${h - 14} C ${w} ${h + 4} 0 ${h + 4} 0 ${h - 14} Z`}
          {...style}
        />
      );
    if (element.kind === "actor")
      return (
        <g
          fill="none"
          stroke={element.stroke}
          strokeWidth={element.strokeWidth}
        >
          <circle cx={w / 2} cy={h * 0.17} r={Math.min(w, h) * 0.13} />
          <path
            d={`M ${w / 2} ${h * 0.3} V ${h * 0.65} M ${w * 0.2} ${h * 0.43} H ${w * 0.8} M ${w / 2} ${h * 0.65} L ${w * 0.22} ${h * 0.96} M ${w / 2} ${h * 0.65} L ${w * 0.78} ${h * 0.96}`}
          />
        </g>
      );
    return (
      <rect
        width={w}
        height={h}
        rx={
          element.kind === "rounded_rectangle"
            ? 22
            : element.kind === "frame"
              ? 5
              : 7
        }
        {...style}
      />
    );
  };
  return (
    <div className="dsl-preview-canvas" aria-label="导入预览">
      <svg
        viewBox={`${minX - padding} ${minY - padding} ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {document.edges.map((edge) => (
          <path
            key={edge.id}
            d={pathFor(edge)}
            fill="none"
            stroke={edge.stroke}
            strokeWidth={edge.strokeWidth}
            strokeDasharray={edge.strokeStyle === "dashed" ? "8 5" : undefined}
            opacity={edge.opacity ?? 1}
          />
        ))}
        {elements.map((element) => (
          <g
            key={element.id}
            transform={`translate(${element.x} ${element.y})`}
          >
            {element.kind === "image" && imageSources[String(element.metadata?.attachmentId || "")] ? (
              <image
                href={imageSources[String(element.metadata?.attachmentId || "")]}
                width={element.width}
                height={element.height}
                preserveAspectRatio="xMidYMid meet"
              />
            ) : shape(element)}
            {element.text && (
              <text
                x={element.width / 2}
                y={element.height / 2}
                textAnchor={element.textAlign === "left" ? "start" : "middle"}
                dominantBaseline="middle"
                fill={element.textColor || "#263145"}
                fontSize={Math.min(18, element.fontSize)}
                fontWeight={element.fontWeight}
              >
                {element.text.split("\n").map((line, index, all) => (
                  <tspan
                    key={index}
                    x={element.textAlign === "left" ? 10 : element.width / 2}
                    dy={
                      index === 0 ? `${-(all.length - 1) * 0.62}em` : "1.24em"
                    }
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

function DslDialog({
  initialKind,
  initialSource,
  onClose,
  onApply,
  onImportSnapshot,
  onApplySnapshot,
}: {
  initialKind: DslKind;
  initialSource: string;
  onClose(): void;
  onApply(kind: DslKind, source: string): void;
  onImportSnapshot(file?: File): Promise<{ cancelled?: boolean; name?: string; fileName?: string; document?: BoardDocument; imageSources?: Record<string, string> }>;
  onApplySnapshot(document: BoardDocument, imageSources: Record<string, string>): void;
}) {
  const examples: Record<DslKind, string> = {
    mermaid:
      "flowchart LR\n  A[开始] --> B{判断}\n  B -->|是| C[完成]\n  B -->|否| D[调整]",
    plantuml:
      '@startuml\nactor 用户\ncomponent "客户端" as client\ncomponent "服务" as service\n用户 --> client\nclient --> service\n@enduml',
    drawio:
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node_a" value="开始" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="80" y="80" width="140" height="60" as="geometry"/></mxCell><mxCell id="node_b" value="完成" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="320" y="80" width="140" height="60" as="geometry"/></mxCell><mxCell id="edge_a_b" edge="1" parent="1" source="node_a" target="node_b"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>',
  };
  const [kind, setKind] = useState<DslKind | "snapshot">(initialKind);
  const [source, setSource] = useState(initialSource);
  const [snapshotFile, setSnapshotFile] = useState<{ name: string; document: BoardDocument; imageSources: Record<string, string> } | null>(null);
  const [error, setError] = useState("");
  const [importingSnapshot, setImportingSnapshot] = useState(false);
  const snapshotInputRef = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => {
    if (kind === "snapshot")
      return { document: snapshotFile?.document || null, error: "" };
    try {
      return { document: parseDsl(kind, source), error: "" };
    } catch (cause) {
      return {
        document: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [kind, snapshotFile, source]);
  const changeKind = (nextKind: DslKind | "snapshot") => {
    setKind(nextKind);
    if (nextKind !== "snapshot")
      setSource(
        nextKind === initialKind && initialSource.trim()
          ? initialSource
          : examples[nextKind],
      );
    setError("");
  };
  const loadSnapshot = async (file?: File) => {
    setImportingSnapshot(true);
    setError("");
    try {
      const result = await onImportSnapshot(file);
      if (result.document)
        setSnapshotFile({
          name: result.fileName || result.name || file?.name || "TuGo 快照",
          document: normalizeDocument(result.document),
          imageSources: result.imageSources || {},
        });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        /No handler registered for ['"]?tugo:projects:snapshots:(?:export|import)/i.test(message)
          ? "TuGo 桌面服务尚未更新，请完全退出应用后重新启动再试。"
          : message,
      );
    } finally {
      setImportingSnapshot(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div
        className="modal dsl-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsl-dialog-title"
      >
        <div className="modal-header">
          <div>
            <small>IMPORT & SYNC</small>
            <h2 id="dsl-dialog-title">DSL 与画布</h2>
          </div>
          <button
            className="icon-btn"
            aria-label="关闭 DSL 导入"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="dsl-tabs">
          {(["mermaid", "plantuml", "drawio", "snapshot"] as const).map((item) => (
            <button
              className={kind === item ? "active" : ""}
              onClick={() => changeKind(item)}
              key={item}
            >
              {item === "plantuml"
                ? "PlantUML"
                : item === "drawio"
                  ? "draw.io XML"
                  : item === "snapshot"
                    ? "快照文件"
                    : "Mermaid"}
            </button>
          ))}
        </div>
        <div className="dsl-workspace">
          {kind === "snapshot" ? (
            <div
              className={`snapshot-file-drop ${snapshotFile ? "has-file" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) void loadSnapshot(file);
              }}
            >
              <input
                ref={snapshotInputRef}
                type="file"
                accept=".tugo-snapshot,.json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void loadSnapshot(file);
                  event.currentTarget.value = "";
                }}
              />
              <Download size={30} />
              <strong>{snapshotFile?.name || "选择 TuGo 快照文件"}</strong>
              <span>
                {snapshotFile
                  ? `${snapshotFile.document.elements.length} 个元素 · ${snapshotFile.document.edges.length} 条连线`
                  : "将 .tugo-snapshot 文件拖到这里，或从电脑中选择"}
              </span>
              <button
                type="button"
                className="soft-btn"
                disabled={importingSnapshot}
                onClick={() => snapshotInputRef.current?.click()}
              >
                {importingSnapshot ? "正在读取…" : snapshotFile ? "重新选择" : "选择文件"}
              </button>
            </div>
          ) : (
            <textarea
              className="code-editor"
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setError("");
              }}
              spellCheck={false}
            />
          )}
          <section className="dsl-preview">
            <div className="dsl-preview-header">
              <span>预览</span>
              <small>
                {preview.document
                  ? `${preview.document.elements.length} 个元素 · ${preview.document.edges.length} 条连线`
                  : "等待有效内容"}
              </small>
            </div>
            {preview.document ? (
              <DslPreview
                document={preview.document}
                imageSources={kind === "snapshot" ? snapshotFile?.imageSources : undefined}
              />
            ) : (
              <div className="dsl-preview-error">
                {preview.error || "无法生成预览"}
              </div>
            )}
          </section>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-footer">
          <span>{kind === "snapshot" ? "文件预览不会修改画布；确认后再插入到当前画布。" : "预览不会修改画布；PlantUML 覆盖常用图，draw.io 覆盖基础图形与连线。"}</span>
          <button className="soft-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-btn"
            disabled={!preview.document}
            onClick={() => {
              try {
                if (kind === "snapshot" && preview.document)
                  onApplySnapshot(preview.document, snapshotFile?.imageSources || {});
                else if (kind !== "snapshot") onApply(kind, source);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            插入到画布
          </button>
        </div>
      </div>
    </div>
  );
}

function TextInputDialog({
  title,
  label,
  initialValue,
  confirmLabel,
  onConfirm,
  onClose,
}: NonNullable<TextDialogState> & { onClose(): void }) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const cleanValue = value.trim();
    if (!cleanValue || saving) return;
    setSaving(true);
    try {
      await onConfirm(cleanValue);
      onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div
        className="modal text-input-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="text-input-title"
      >
        <div className="modal-header">
          <div>
            <small>TUGO</small>
            <h2 id="text-input-title">{title}</h2>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label className="text-input-label">
          {label}
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        <div className="modal-footer">
          <span></span>
          <button className="soft-btn" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-btn"
            disabled={!value.trim() || saving}
            onClick={() => void submit()}
          >
            {saving ? "正在保存…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function AiConfigurationDialog({
  api,
  onClose,
}: {
  api: TuGoApi;
  onClose(): void;
}) {
  const [configuration, setConfiguration] = useState<AiConfiguration | null>(
    null,
  );
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"overview" | "instructions">("overview");
  useEffect(() => {
    api
      .getAiConfiguration()
      .then(setConfiguration)
      .catch(() => setError("暂时无法读取 AI 配置。"));
  }, [api]);
  const lead = configuration?.lead;
  const json = (value: unknown) => JSON.stringify(value || {}, null, 2);
  return (
    <div className="modal-backdrop">
      <div
        className="modal ai-configuration-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-configuration-title"
      >
        <div className="modal-header">
          <div>
            <small>TUGO AI</small>
            <h2 id="ai-configuration-title">AI 工作方式</h2>
          </div>
          <button
            className="icon-btn"
            aria-label="关闭 AI 工作方式"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="configuration-tabs">
          <button
            className={tab === "overview" ? "active" : ""}
            onClick={() => setTab("overview")}
          >
            组成与能力
          </button>
          <button
            className={tab === "instructions" ? "active" : ""}
            onClick={() => setTab("instructions")}
          >
            AI 工作说明
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {!configuration && !error && (
          <div className="configuration-loading">正在读取配置…</div>
        )}
        {configuration && tab === "overview" && (
          <div className="configuration-content">
            <section className="configuration-section">
              <small>使用的模型</small>
              <strong>
                {configuration.model?.display_name ||
                  configuration.model?.model ||
                  "未连接"}
              </strong>
              <p>{configuration.model?.provider_id || "尚未连接模型"}</p>
            </section>
            <section className="configuration-section">
              <small>可用工具</small>
              <div className="configuration-row">
                <strong>内置画板工具</strong>
                <span>已启用，可直接创建、整理和调整画布内容</span>
              </div>
              {configuration.connections.length > 0 && (
                <div className="configuration-row">
                  <strong>外部工具连接</strong>
                  <span>
                    {configuration.connections
                      .map((connection) => connection.name)
                      .join("、")}
                  </span>
                </div>
              )}
            </section>
            <section className="configuration-section">
              <small>AI 的工作能力</small>
              <strong>
                {configuration.skill?.name || "TuGo Architect"}
              </strong>
              <p>
                {configuration.skill?.description ||
                  "读取当前画布，并创建、修改和整理图形。"}
              </p>
            </section>
            <section className="configuration-section">
              <small>工作方式</small>
              {lead ? (
                <>
                  <div className="configuration-lead">
                    <strong>{lead.display_name}</strong>
                    <span>一个 AI 统一理解、规划并直接编辑画布</span>
                  </div>
                  <p className="configuration-note">
                    复杂任务会先在内部形成计划，再一次性完成画布修改。
                  </p>
                </>
              ) : (
                <p>AI 配置尚未完成。</p>
              )}
            </section>
            {lead && (
              <details className="configuration-technical">
                <summary>高级运行信息</summary>
                <div className="configuration-technical-note">
                  用于排查连接或运行问题。模型、MCP 和 Skills 请在“设置”中管理。
                </div>
                <pre>
                  {json({
                    model_id: lead.model_id,
                    tools: lead.tool_names,
                    skills: lead.skills,
                    middleware: "plan · summarization · retry · loop detection",
                    plan_mode: "optional",
                  })}
                </pre>
              </details>
            )}
          </div>
        )}
        {configuration && tab === "instructions" && (
          <div className="configuration-content instructions-content">
            <p>这份说明帮助 AI 理解画布、规划修改并保持图形清晰易读。</p>
            <pre>
              {configuration.skillContent ||
                lead?.soul ||
                "暂时无法读取工作说明。"}
            </pre>
          </div>
        )}
        <div className="modal-footer">
          <span>此页面仅供查看，AI 配置由 TuGo 自动维护。</span>
          <button className="primary-btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsDialog({
  config,
  api,
  onClose,
  onSave,
  onSetDefault,
  onTheme,
  onLanguage,
  onCursorAppearance,
}: {
  config: TuGoConfig;
  api: TuGoApi;
  onClose(): void;
  onSave(value: {
    modelId?: string;
    providerId: string;
    model: string;
    displayName: string;
    apiKey: string;
    baseUrl?: string;
    apiPath?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    visionCapable?: boolean;
    isDefault?: boolean;
  }): Promise<ModelRecord>;
  onSetDefault(model: ModelRecord): Promise<void>;
  onTheme(theme: TuGoConfig["theme"]): Promise<void>;
  onLanguage(language: LanguagePreference): Promise<void>;
  onCursorAppearance(value: NonNullable<TuGoConfig["drawingCursor"]>): Promise<void>;
}) {
  const language = effectiveLanguage(config.language);
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  const drawingCursor = config.drawingCursor || { style: "tugo" as const, color: "#4F46E5" };
  const chineseUi = language === "zh-CN" || language === "zh-TW";
  const desktop = Boolean(window.tugo);
  const [tab, setTab] = useState<
    "model" | "mcp" | "skills" | "appearance" | "data"
  >("model");
  const [providers, setProviders] = useState<Record<string, unknown>[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const emptyModel = () => ({
    modelId: undefined as string | undefined,
    providerId: "openai",
    model: "",
    displayName: "",
    apiKey: "",
    baseUrl: "",
    apiPath: "",
    contextWindow: 128000,
    maxOutputTokens: 32768,
    visionCapable: false,
    isDefault: models.length === 0,
  });
  const [form, setForm] = useState({
    modelId: config.model?.modelId,
    providerId: config.model?.providerId || "openai",
    model: config.model?.model || "",
    displayName: config.model?.displayName || "",
    apiKey: "",
    baseUrl: config.model?.baseUrl || "",
    apiPath: config.model?.apiPath || "",
    contextWindow: config.model?.contextWindow || 128000,
    maxOutputTokens: config.model?.maxOutputTokens || 32768,
    visionCapable: config.model?.visionCapable === true,
    isDefault: true,
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    api
      .listProviders()
      .then(setProviders)
      .catch(() => setProviders([]));
    api
      .listModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, [api, desktop]);
  const editModel = async (model: ModelRecord) => {
    setError("");
    setNotice("");
    // TuGo is a local single-user application. Populate the field so it
    // remains editable on reopening; the password input keeps it obscured
    // until the user explicitly presses the eye button.
    let apiKey = "";
    try {
      apiKey = await api.revealModelKey(model.model_id);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? `无法读取已保存的 API Key：${reason.message}`
          : "无法读取已保存的 API Key",
      );
    }
    setForm({
      modelId: model.model_id,
      providerId: model.provider_id,
      model: model.model,
      displayName: model.display_name || model.model,
      apiKey,
      baseUrl: String(model.extra_config?.base_url || ""),
      apiPath: String(model.extra_config?.api_path || ""),
      contextWindow: Number(model.extra_config?.context_window || 128000),
      maxOutputTokens: Number(model.extra_config?.max_output_tokens || 32768),
      visionCapable: model.extra_config?.vision_capable !== false,
      isDefault: Boolean(model.is_default),
    });
  };
  const deleteModel = async (model: ModelRecord) => {
    if (
      !model.model_id ||
      !window.confirm("删除这个模型连接？已有会话会自动改用默认模型。")
    )
      return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await api.deleteModel(model.model_id);
      const next = await api.listModels();
      setModels(next);
      if (form.modelId === model.model_id) {
        const fallback = next.find((item) => item.is_default) || next[0];
        if (fallback) await editModel(fallback);
        else setForm(emptyModel());
      }
      setNotice("模型已删除");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  const makeDefault = async (model: ModelRecord) => {
    if (model.is_default) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await onSetDefault(model);
      const next = await api.listModels();
      setModels(next);
      setForm((current) => ({
        ...current,
        isDefault: current.modelId === model.model_id,
      }));
      setNotice(`已将「${model.display_name || model.model}」设为默认模型`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  const providerHint = (() => {
    if (form.providerId === "anthropic" || form.providerId === "claude")
      return {
        model: "例如 claude-sonnet-4-5",
        endpoint: "https://api.example.com/v1",
        path: "/messages",
      };
    if (form.providerId === "openai_responses")
      return {
        model: "例如 gpt-5 / gpt-5-mini",
        endpoint: "https://api.example.com/v1",
        path: "/responses",
      };
    if (form.providerId === "google")
      return {
        model: "例如 gemini-2.5-pro",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        path: "自动生成",
      };
    return {
      model: "例如 gpt-5 / qwen3-max",
      endpoint: "https://api.example.com/v1",
      path: "/chat/completions",
    };
  })();
  if (!desktop)
    return (
      <div className="modal-backdrop">
        <div
          className="modal settings-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-settings-title"
        >
          <div className="modal-header">
            <div>
              <small>TUGO SETTINGS</small>
              <h2 id="preview-settings-title">{t("settings")}</h2>
            </div>
            <button
              className="icon-btn"
              aria-label={t("closeSettings")}
              onClick={onClose}
            >
              <X size={18} />
            </button>
          </div>
          <div className="preview-notice">
            <div className="settings-icon">
              <Sparkles size={22} />
            </div>
            <strong>{t("canvasPreview")}</strong>
            <p>{t("browserPreviewDescription")}</p>
          </div>
          <div className="modal-footer">
            <span>{t("browserPreviewDescription")}</span>
            <button className="primary-btn" onClick={onClose}>
              {t("done")}
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="modal-backdrop">
      <div
        className="modal settings-modal product-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal-header">
          <div>
            <small>TUGO SETTINGS</small>
            <h2 id="settings-title">{t("settings")}</h2>
          </div>
          <button className="icon-btn" data-e2e="close-settings" aria-label={t("closeSettings")} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="settings-tabs">
          <button
            className={tab === "model" ? "active" : ""}
            onClick={() => setTab("model")}
          >
            {t("model")}
          </button>
          <button
            className={tab === "mcp" ? "active" : ""}
            onClick={() => setTab("mcp")}
          >
            MCP <span className="tab-badge beta">Beta</span>
          </button>
          <button
            className={tab === "skills" ? "active" : ""}
            onClick={() => setTab("skills")}
          >
            Skills
          </button>
          <button
            className={tab === "appearance" ? "active" : ""}
            onClick={() => setTab("appearance")}
          >
            {t("appearance")}
          </button>
          <button
            className={tab === "data" ? "active" : ""}
            onClick={() => setTab("data")}
          >
            {t("dataRecovery")}
          </button>
        </div>
        <div
          className={`settings-content ${tab === "skills" ? "skills-settings-content" : ""}`}
        >
          {tab === "model" && (
            <>
              <div className="settings-intro">
                <div className="settings-icon">
                  <Sparkles size={22} />
                </div>
                <div>
                  <strong>{t("manageModels")}</strong>
                  <p>{t("manageModelsDescription")}</p>
                </div>
              </div>
              <div className="model-connection-list">
                <button
                  type="button"
                  className="soft-btn"
                  onClick={() => {
                    setForm(emptyModel());
                    setError("");
                    setNotice("");
                  }}
                >
                  <Plus size={15} /> {t("addModel")}
                </button>
                {models.map((model) => (
                  <div
                    key={model.model_id}
                    className={`model-connection-row ${form.modelId === model.model_id ? "active" : ""}`}
                  >
                    <label className="model-default-choice" title={t("setDefaultModel")}>
                      <input
                        type="radio"
                        name="default-model"
                        checked={Boolean(model.is_default)}
                        disabled={saving || testing}
                        onChange={() => void makeDefault(model)}
                      />
                    </label>
                    <button
                      type="button"
                      className="model-connection-main"
                      onClick={() => void editModel(model)}
                    >
                      <span>
                        <strong>{model.display_name || model.model}</strong>
                        <small>
                          {model.provider_id} · {model.model}
                          {model.extra_config?.base_url
                            ? ` · ${String(model.extra_config.base_url)}`
                            : ""}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn model-delete-btn"
                      title={t("deleteModel")}
                      aria-label={`${t("deleteModel")} ${model.display_name || model.model}`}
                      disabled={saving || testing}
                      onClick={() => void deleteModel(model)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="form-grid settings-scroll">
                <label>
                  {t("displayName")}
                  <input
                    value={form.displayName}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        displayName: event.target.value,
                      }))
                    }
                    placeholder="例如 GLM 5.2（生产）"
                  />
                </label>
                <label>
                  {t("provider")}
                  <select
                    value={form.providerId}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        providerId: event.target.value,
                      }))
                    }
                  >
                    {providers.length ? (
                      providers.map((provider) => (
                        <option
                          key={String(provider.provider_id || provider.id)}
                          value={String(provider.provider_id || provider.id)}
                        >
                          {String(
                            provider.display_name ||
                              provider.name ||
                              provider.provider_id,
                          )}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="openai">OpenAI Compatible</option>
                        <option value="anthropic">Anthropic</option>
                      </>
                    )}
                  </select>
                </label>
                <label>
                  {t("modelName")}
                  <input
                    value={form.model}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                    placeholder={providerHint.model}
                  />
                </label>
                <label className="span-2">
                  {t("serviceUrl")}
                  <input
                    value={form.baseUrl}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        baseUrl: event.target.value,
                      }))
                    }
                    placeholder={providerHint.endpoint}
                  />
                  <small>
                    不同协议可共用同一服务根地址；例如都填写{" "}
                    {providerHint.endpoint}。
                  </small>
                </label>
                <details className="span-2 model-advanced">
                  <summary>{t("advancedSettings")}</summary>
                  <div className="form-grid">
                    {form.providerId !== "google" && (
                      <label className="span-2">
                        {t("requestPath")}
                        <input
                          value={form.apiPath}
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              apiPath: event.target.value,
                            }))
                          }
                          placeholder={`默认 ${providerHint.path}`}
                        />
                      </label>
                    )}
                    <label>
                      {t("contextLength")}
                      <input
                        type="number"
                        min="4096"
                        step="1024"
                        value={form.contextWindow}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            contextWindow: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <label>
                      {t("maxOutputLength")}
                      <input
                        type="number"
                        min="256"
                        step="256"
                        value={form.maxOutputTokens}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            maxOutputTokens: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                  </div>
                </details>
                <label className="span-2">
                  API Key
                  <div className="secret-input">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={form.apiKey}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          apiKey: event.target.value,
                        }))
                      }
                      placeholder={t("enterApiKey")}
                    />
                    <button
                      type="button"
                      title={showApiKey ? t("hideKey") : t("showKey")}
                      aria-label={showApiKey ? t("hideKey") : t("showKey")}
                      onClick={() => setShowApiKey((value) => !value)}
                    >
                      {showApiKey ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  <small>{t("apiKeyHelp")}</small>
                </label>
                <label className="span-2 checkbox-label">
                  <input
                    type="checkbox"
                    checked={form.visionCapable}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        visionCapable: event.target.checked,
                      }))
                    }
                  />{" "}
                  {t("visionSupport")}
                </label>
              </div>
              {error && <div className="form-error">{error}</div>}
              {notice && <div className="form-success">{notice}</div>}
              <div className="modal-footer">
                <span>{t("keyLocalOnly")}</span>
                <button
                  className="soft-btn"
                  disabled={
                    saving || testing || !form.model || (!form.apiKey && !form.modelId)
                  }
                  onClick={async () => {
                    setTesting(true);
                    setError("");
                    setNotice("");
                    try {
                      const saved = await onSave({
                        ...form,
                        displayName: form.displayName || form.model,
                      });
                      await api.testModel(saved.model_id);
                      await onSave({
                        ...form,
                        modelId: saved.model_id,
                        displayName: form.displayName || form.model,
                      });
                      setModels(await api.listModels());
                      setForm((current) => ({ ...current, modelId: saved.model_id }));
                      setNotice(t("modelTestSuccess"));
                    } catch (e) {
                      setError(`模型连接测试失败：${e instanceof Error ? e.message : String(e)}`);
                    } finally {
                      setTesting(false);
                    }
                  }}
                >
                  {testing ? t("testing") : t("test")}
                </button>
                <button
                  className="primary-btn"
                  disabled={
                    saving || testing || !form.model || (!form.apiKey && !form.modelId)
                  }
                  onClick={async () => {
                    setSaving(true);
                    setError("");
                    setNotice("");
                    try {
                      const saved = await onSave({
                        ...form,
                        displayName: form.displayName || form.model,
                      });
                      setModels(await api.listModels());
                      setForm((current) => ({ ...current, modelId: saved.model_id }));
                      setNotice(t("modelSaveSuccess"));
                    } catch (e) {
                      setError(modelSaveMessage(e));
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {saving ? t("saving") : t("save")}
                </button>
              </div>
            </>
          )}
          {tab === "mcp" && <McpSettings api={api} />}
          {tab === "skills" && <SkillSettings api={api} />}
          {tab === "appearance" && (
            <div className="settings-pane appearance-settings-pane">
              <div className="settings-list-header">
                <div>
                  <strong>{t("appearanceTitle")}</strong>
                  <p>{t("appearanceDescription")}</p>
                </div>
              </div>
              <div className="form-grid language-settings-grid">
                <label>
                  {t("language")}
                  <select
                    value={config.language || "system"}
                    onChange={(event) => void onLanguage(event.target.value as LanguagePreference)}
                  >
                    {languageOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value === "system" ? `${t("systemLanguage")} — ${option.nativeLabel}` : option.nativeLabel}
                      </option>
                    ))}
                  </select>
                  <small>{t("languageDescription")}</small>
                </label>
                <p className="settings-language-note">{t("promptLanguageNote")}</p>
              </div>
              <div className="settings-list-header settings-subsection-header">
                <div><strong>{t("theme")}</strong></div>
              </div>
              <div className="theme-choice-grid">
                {(
                  [
                    ["system", t("themeSystem"), t("themeSystemDescription")],
                    ["light", t("themeLight"), t("themeLightDescription")],
                    ["dark", t("themeDark"), t("themeDarkDescription")],
                  ] as const
                ).map(([value, title, description]) => (
                  <button
                    key={value}
                    className={config.theme === value ? "active" : ""}
                    onClick={() => void onTheme(value)}
                  >
                    <span className={`theme-preview theme-${value}`}>
                      <i />
                      <i />
                      <i />
                    </span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                    {config.theme === value && <Check size={16} />}
                  </button>
                ))}
              </div>
              <div className="settings-list-header settings-subsection-header cursor-settings-heading">
                <div><strong>{t("drawingCursor")}</strong><p>{t("drawingCursorDescription")}</p></div>
                <div className="cursor-live-preview" style={{ '--cursor-preview-color': drawingCursor.color } as CSSProperties}><AiCursorGlyph cursorStyle={drawingCursor.style} color={drawingCursor.color} size={34}/><span>{t("drawing")}</span></div>
              </div>
              <div className="cursor-theme-grid">
                {drawingCursorThemes.map(item => <button type="button" key={item.id} className={drawingCursor.style === item.id ? "active" : ""} aria-label={chineseUi ? item.name : item.nameEn} title={`${chineseUi ? item.name : item.nameEn} · ${chineseUi ? item.description : item.descriptionEn}`} aria-pressed={drawingCursor.style === item.id} onClick={() => void onCursorAppearance({ ...drawingCursor, style: item.id })}>
                  <span className="cursor-theme-icon"><AiCursorGlyph cursorStyle={item.id} color={drawingCursor.color} size={38}/></span>
                  {drawingCursor.style === item.id && <Check size={14}/>}
                </button>)}
              </div>
              <div className="cursor-color-settings">
                <div><strong>{t("cursorColor")}</strong><small>{t("rgbCursorNote")}</small></div>
                <div className="cursor-color-row">{drawingCursorColors.map(color => <button type="button" key={color} className={drawingCursor.color.toLowerCase() === color.toLowerCase() ? "active" : ""} style={{ background: color }} aria-label={`${t("cursorColor")} ${color}`} onClick={() => void onCursorAppearance({ ...drawingCursor, color })}/>)}</div>
                <label className="cursor-custom-color"><span>{t("customColor")}</span><input type="color" value={drawingCursor.color} onChange={event => void onCursorAppearance({ ...drawingCursor, color: event.target.value.toUpperCase() })}/><code>{drawingCursor.color.toUpperCase()}</code></label>
              </div>
            </div>
          )}
          {tab === "data" && <DataRecoverySettings />}
        </div>
      </div>
    </div>
  );
}

const parseKeyValueJson = (value: string, label: string) => {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((item) => typeof item !== "string")
  )
    throw new Error(`${label} 必须是字符串键值对 JSON`);
  return parsed as Record<string, string>;
};

function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  value: string;
  onChange(value: string): void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  let parsed: Record<string, string> = {};
  try {
    parsed = parseKeyValueJson(value, "");
  } catch {
    /* repaired by row edits */
  }
  const rows = Object.entries(parsed);
  const commit = (next: Array<[string, string]>) =>
    onChange(
      JSON.stringify(
        Object.fromEntries(next.filter(([key]) => key.trim())),
        null,
        2,
      ),
    );
  return (
    <div className="key-value-editor">
      {rows.map(([key, itemValue], index) => (
        <div key={`${key}:${index}`}>
          <input
            aria-label="键"
            value={key}
            placeholder={keyPlaceholder}
            onChange={(event) =>
              commit(
                rows.map((row, at) =>
                  at === index ? [event.target.value, row[1]] : row,
                ),
              )
            }
          />
          <input
            aria-label="值"
            type={
              /authorization|token|key|secret|password/i.test(key)
                ? "password"
                : "text"
            }
            value={itemValue}
            placeholder={valuePlaceholder}
            onChange={(event) =>
              commit(
                rows.map((row, at) =>
                  at === index ? [row[0], event.target.value] : row,
                ),
              )
            }
          />
          <button
            type="button"
            aria-label="删除此项"
            onClick={() => commit(rows.filter((_, at) => at !== index))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="soft-btn"
        onClick={() => commit([...rows, [`KEY_${rows.length + 1}`, ""]])}
      >
        <Plus size={13} /> 添加
      </button>
    </div>
  );
}

function McpSettings({ api }: { api: TuGoApi }) {
  const { t } = useI18n();
  const empty = {
    connectionId: "",
    name: "",
    transport: "http",
    target: "",
    description: "",
    enabled: true,
    bound: true,
    headers: "",
    env: "",
    args: "",
    allowlist: "",
  };
  const [records, setRecords] = useState<McpRecord[]>([]);
  const [lead, setLead] = useState<AiConfiguration["lead"]>();
  const [form, setForm] = useState(empty);
  const [tools, setTools] = useState<
    Array<{ name: string; description: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const reload = useCallback(async () => {
    const configuration = await api.getAiConfiguration();
    setRecords(configuration.connections);
    setLead(configuration.lead);
  }, [api]);
  useEffect(() => {
    void reload().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [reload]);
  const edit = (record?: McpRecord) => {
    if (!record) {
      setForm(empty);
      setTools([]);
      return;
    }
    const binding = lead?.mcp_bindings?.find(
      (item) => item.connection_id === record.connection_id,
    );
    setForm({
      connectionId: record.connection_id,
      name: record.name,
      transport: record.transport || "http",
      target: record.url,
      description: record.description || "",
      enabled: record.enabled !== false,
      bound: Boolean(binding),
      headers: JSON.stringify(
        Object.fromEntries(
          (record.header_names || []).map((name) => [name, ""]),
        ),
        null,
        2,
      ),
      env: JSON.stringify(
        Object.fromEntries((record.env_names || []).map((name) => [name, ""])),
        null,
        2,
      ),
      args: (record.args || []).join("\n"),
      allowlist: (binding?.allowlist || []).join(", "),
    });
    setTools([]);
    setError("");
    setNotice("");
  };
  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api.saveMcp({
        connectionId: form.connectionId || undefined,
        name: form.name.trim(),
        transport: form.transport,
        target: form.target.trim(),
        description: form.description,
        enabled: form.enabled,
        headers: parseKeyValueJson(form.headers, "Headers"),
        env: parseKeyValueJson(form.env, "环境变量"),
        args: form.args
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
      });
      if (!lead) throw new Error("找不到 TuGo Agent");
      const bindings = (lead.mcp_bindings || []).filter(
        (item) => item.connection_id !== saved.connection_id,
      );
      if (form.bound)
        bindings.push({
          connection_id: saved.connection_id,
          allowlist: form.allowlist
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        });
      await api.bindAgentMcp(lead.agent_id, bindings);
      await reload();
      setForm((current) => ({ ...current, connectionId: saved.connection_id }));
      setNotice("MCP 配置已生效");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const test = async (id = form.connectionId) => {
    if (!id) {
      setError("请先保存连接");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.testMcp(id);
      setTools(result.tools);
      setNotice(`连接成功，发现 ${result.tools.length} 个工具`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-pane mcp-settings-pane">
      <div className="settings-list-header">
        <div>
          <strong>{t("externalMcp")}</strong>
          <p>{t("mcpDescription")}</p>
        </div>
        <button className="soft-btn" onClick={() => edit()}>
          {t("newConnection")}
        </button>
      </div>
      <div className="mcp-settings-layout">
        <div className="mcp-record-list">
          {records.length ? (
            records.map((record) => (
              <button
                className={
                  form.connectionId === record.connection_id ? "active" : ""
                }
                key={record.connection_id}
                onClick={() => edit(record)}
              >
                <span>
                  <strong>{record.name}</strong>
                  <small>
                    {record.transport} ·{" "}
                    {record.enabled === false
                      ? t("disabled")
                      : record.binding_count
                        ? t("bound")
                        : t("unbound")}
                  </small>
                </span>
                <em>{record.url}</em>
              </button>
            ))
          ) : (
            <div className="settings-empty">{t("noMcp")}</div>
          )}
        </div>
        <div className="mcp-editor form-grid">
          <label>
            {t("name")}
            <input
              value={form.name}
              onChange={(event) =>
                setForm((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label>
            {t("transport")}
            <select
              value={form.transport}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  transport: event.target.value,
                }))
              }
            >
              <option value="http">Streamable HTTP</option>
              <option value="sse">SSE</option>
              <option value="stdio">stdio</option>
            </select>
          </label>
          <label className="span-2">
            {form.transport === "stdio" ? t("command") : t("serviceUrl")}
            <input
              value={form.target}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  target: event.target.value,
                }))
              }
            />
          </label>
          <label className="span-2">
            {t("description")}
            <input
              value={form.description}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
          </label>
          <label className="span-2">
            Headers
            <KeyValueEditor
              value={form.headers}
              onChange={(headers) =>
                setForm((current) => ({ ...current, headers }))
              }
              keyPlaceholder="Header 名称"
              valuePlaceholder="Header 值"
            />
          </label>
          <label className="span-2">
            {t("environmentVariables")}
            <KeyValueEditor
              value={form.env}
              onChange={(env) => setForm((current) => ({ ...current, env }))}
              keyPlaceholder="变量名"
              valuePlaceholder="变量值"
            />
          </label>
          {form.transport === "stdio" && (
            <label className="span-2">
              {t("launchArguments")}
              <textarea
                value={form.args}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    args: event.target.value,
                  }))
                }
              />
            </label>
          )}
          <fieldset className="span-2 mcp-tool-picker">
            <legend>{t("agentTools")}</legend>
            {tools.length ? (
              tools.map((tool) => {
                const selected =
                  !form.allowlist.trim() ||
                  form.allowlist
                    .split(",")
                    .map((item) => item.trim())
                    .includes(tool.name);
                return (
                  <label key={tool.name}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => {
                        const current = form.allowlist.trim()
                          ? form.allowlist
                              .split(",")
                              .map((item) => item.trim())
                              .filter(Boolean)
                          : tools.map((item) => item.name);
                        const next = event.target.checked
                          ? [...new Set([...current, tool.name])]
                          : current.filter((item) => item !== tool.name);
                        setForm((value) => ({
                          ...value,
                          allowlist: next.join(", "),
                        }));
                      }}
                    />
                    <span>
                      <strong>{tool.name}</strong>
                      <small>{tool.description}</small>
                    </span>
                  </label>
                );
              })
            ) : (
              <small>{t("toolsHint")}</small>
            )}
          </fieldset>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
            />{" "}
            {t("enableConnection")}
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.bound}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  bound: event.target.checked,
                }))
              }
            />{" "}
            {t("bindBoardAgent")}
          </label>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-success">{notice}</div>}
      <div className="modal-footer">
        <span>{t("secretsStorageNote")}</span>
        {form.connectionId && (
          <button
            className="danger-text-btn"
            disabled={busy}
            onClick={async () => {
              if (!confirm("删除这个 MCP 连接？")) return;
              setBusy(true);
              try {
                await api.deleteMcp(form.connectionId);
                edit();
                await reload();
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("delete")}
          </button>
        )}
        <button
          className="soft-btn"
          disabled={busy || !form.connectionId}
          onClick={() => void test()}
        >
          {t("testConnection")}
        </button>
        <button
          className="primary-btn"
          disabled={busy || !form.name.trim() || !form.target.trim()}
          onClick={() => void save()}
        >
          {busy ? t("processing") : t("save")}
        </button>
      </div>
    </div>
  );
}

function LegacySkillSettings({ api }: { api: TuGoApi }) {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [scope, setScope] = useState<"builtin" | "custom">("builtin");
  const [form, setForm] = useState({
    skillId: "",
    name: "",
    description: "",
    content: "",
    resources: [] as Array<{ path: string; content: string }>,
  });
  const [selectedResource, setSelectedResource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(
    () =>
      api
        .listSkills()
        .then(setSkills)
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        ),
    [api],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  const edit = async (skill?: SkillRecord) => {
    setError("");
    if (!skill) {
      setForm({
        skillId: "",
        name: "",
        description: "",
        content: "",
        resources: [],
      });
      setSelectedResource("");
      return;
    }
    try {
      const [source, resources] = await Promise.all([
        api.skillContent(skill.skill_id),
        api.skillResources(skill.skill_id),
      ]);
      setForm({
        skillId: skill.skill_id,
        name: skill.name,
        description: skill.description || "",
        content: source.content,
        resources: resources.items,
      });
      setSelectedResource("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const upload = async () => {
    try {
      const loaded = await window.tugo?.system.chooseSkill();
      if (loaded) {
        setForm({
          skillId: "",
          name: loaded.name || "未命名 Skill",
          description: "",
          content: loaded.content,
          resources: loaded.resources,
        });
        setSelectedResource("");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveSkill({
        skillId: form.skillId || undefined,
        name: form.name.trim(),
        description: form.description.trim(),
        content: form.content.trim(),
        resources: form.resources,
      });
      await reload();
      await edit(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const selected = skills.find((skill) => skill.skill_id === form.skillId);
  const visibleSkills = skills.filter((skill) =>
    scope === "builtin" ? skill.built_in : !skill.built_in,
  );
  const setEnabled = async (skill: SkillRecord, enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      const saved = await api.setSkillEnabled(skill.skill_id, enabled);
      setSkills((current) =>
        current.map((item) =>
          item.skill_id === saved.skill_id ? saved : item,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-pane skill-settings-pane">
      <div className="skill-settings-hero">
        <div>
          <strong>Skills</strong>
        </div>
        {scope === "custom" && (
          <div className="settings-header-actions">
            <button className="soft-btn" onClick={() => void upload()}>
              上传
            </button>
            <button
              className="primary-btn"
              onClick={() => {
                void edit();
                setScope("custom");
              }}
            >
              新建
            </button>
          </div>
        )}
      </div>
      <div className="skill-scope-tabs">
        <button
          className={scope === "builtin" ? "active" : ""}
          onClick={() => {
            setScope("builtin");
            void edit();
          }}
        >
          内置 Skills{" "}
          <small>{skills.filter((item) => item.built_in).length}</small>
        </button>
        <button
          className={scope === "custom" ? "active" : ""}
          onClick={() => {
            setScope("custom");
            void edit();
          }}
        >
          我的 Skills{" "}
          <small>{skills.filter((item) => !item.built_in).length}</small>
        </button>
      </div>
      <div className="skill-workspace">
        <nav className="skill-library">
          {visibleSkills.length ? (
            visibleSkills.map((skill) => (
              <button
                className={`${form.skillId === skill.skill_id ? "active" : ""} ${skill.enabled === false ? "disabled" : ""}`}
                key={skill.skill_id}
                onClick={() => void edit(skill)}
              >
                <span className="skill-record-heading">
                  <b>{skill.name}</b>
                  <i className={skill.enabled === false ? "off" : ""}>
                    {skill.enabled === false ? "关闭" : "启用"}
                  </i>
                </span>
                <small>{skill.description || "未填写简介"}</small>
                <em>
                  v{skill.version || "1.0.0"}
                  {skill.resource_count
                    ? ` · ${skill.resource_count} 个资源`
                    : ""}
                </em>
              </button>
            ))
          ) : (
            <div className="settings-empty">还没有 Skill</div>
          )}
        </nav>
        <section className="skill-editor-panel">
          {selected?.built_in ? (
            <>
              <div className="skill-editor-toolbar">
                <span>
                  <i
                    className={`skill-status-dot ${selected.enabled === false ? "off" : ""}`}
                  />
                  {selected.enabled === false ? "已关闭" : "已启用"}
                </span>
                <label className="skill-switch">
                  <input
                    type="checkbox"
                    checked={selected.enabled !== false}
                    disabled={busy}
                    onChange={(event) =>
                      void setEnabled(selected, event.target.checked)
                    }
                  />
                  <i />
                </label>
              </div>
              <div className="skill-readonly">
                <h3>{form.name}</h3>
                <p>{form.description}</p>
                <pre>{form.content}</pre>
                {form.resources.length > 0 && (
                  <div className="skill-resource-panel">
                    <div>
                      <strong>资源文件</strong>
                      <small>{form.resources.length} 个文件</small>
                    </div>
                    <nav>
                      {form.resources.map((resource) => (
                        <button
                          type="button"
                          key={resource.path}
                          className={
                            selectedResource === resource.path ? "active" : ""
                          }
                          onClick={() => setSelectedResource(resource.path)}
                        >
                          {resource.path}
                        </button>
                      ))}
                    </nav>
                    {selectedResource && (
                      <pre>
                        {
                          form.resources.find(
                            (resource) => resource.path === selectedResource,
                          )?.content
                        }
                      </pre>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="skill-editor-fields custom-skill-editor">
              <div className="skill-editor-intro">
                <strong>{form.skillId ? "编辑 Skill" : "创建 Skill"}</strong>
                <span>定义 AI 在此类任务中的工作方式与交付标准。</span>
              </div>
              <label>
                名称
                <input
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="例如 业务流程梳理"
                />
              </label>
              <label>
                简介
                <input
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  placeholder="一句话说明适用场景"
                />
              </label>
              <label className="span-2">
                工作说明
                <textarea
                  className="skill-content-editor"
                  value={form.content}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      content: event.target.value,
                    }))
                  }
                  placeholder="描述处理步骤、约束和交付标准…"
                />
              </label>
              <div className="skill-resource-panel span-2">
                <div>
                  <strong>资源文件</strong>
                  <small>{form.resources.length} 个文件</small>
                </div>
                {form.resources.length > 0 && (
                  <nav>
                    {form.resources.map((resource) => (
                      <button
                        type="button"
                        key={resource.path}
                        className={
                          selectedResource === resource.path ? "active" : ""
                        }
                        onClick={() => setSelectedResource(resource.path)}
                      >
                        {resource.path}
                      </button>
                    ))}
                  </nav>
                )}
                {selectedResource && (
                  <textarea
                    value={
                      form.resources.find(
                        (resource) => resource.path === selectedResource,
                      )?.content || ""
                    }
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        resources: current.resources.map((resource) =>
                          resource.path === selectedResource
                            ? { ...resource, content: event.target.value }
                            : resource,
                        ),
                      }))
                    }
                  />
                )}
              </div>
            </div>
          )}
        </section>
      </div>
      {error && <div className="form-error">{error}</div>}
      {!selected?.built_in && (
        <div className="modal-footer skill-footer">
          <span></span>
          {form.skillId && (
            <button
              className="danger-text-btn"
              disabled={busy}
              onClick={async () => {
                if (!confirm(`删除「${form.name}」？`)) return;
                setBusy(true);
                try {
                  await api.deleteSkill(form.skillId);
                  await reload();
                  await edit();
                } finally {
                  setBusy(false);
                }
              }}
            >
              删除
            </button>
          )}
          <button
            className="primary-btn"
            disabled={busy || !form.name.trim() || !form.content.trim()}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存修改"}
          </button>
        </div>
      )}
    </div>
  );
}

function SkillSettings({ api }: { api: TuGoApi }) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [scope, setScope] = useState<"builtin" | "custom">("builtin");
  const [builtin, setBuiltin] = useState<{
    skill?: SkillRecord;
    content: string;
    resources: Array<{ path: string; content: string }>;
  }>({ content: "", resources: [] });
  const [builtinResource, setBuiltinResource] = useState("");
  const [session, setSession] = useState<SkillEditorSession | null>(null);
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string; pending?: boolean }>
  >([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const skillChatFollowRef = useRef(true);
  const skillChatLastMarker = messages.length
    ? `${messages.length}:${messages[messages.length - 1]?.content || ""}:${messages[messages.length - 1]?.pending ? "pending" : "done"}`
    : "";
  useEffect(() => {
    const node = document.querySelector<HTMLElement>(".skill-agent-messages");
    if (!node || !skillChatFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [session?.thread_id, skillChatLastMarker]);
  useEffect(() => {
    const node = document.querySelector<HTMLElement>(".skill-agent-messages");
    const chat = node?.closest<HTMLElement>(".skill-agent-chat");
    if (!node || !chat) return;
    skillChatFollowRef.current = true;
    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "skill-chat-jump-latest";
    fab.title = "回到最新消息";
    fab.setAttribute("aria-label", "回到最新消息");
    fab.textContent = "↓";
    fab.hidden = true;
    const sync = () => {
      const atBottom =
        node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
      skillChatFollowRef.current = atBottom;
      fab.hidden = atBottom;
    };
    const jump = () => {
      skillChatFollowRef.current = true;
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
      fab.hidden = true;
    };
    node.addEventListener("scroll", sync, { passive: true });
    fab.addEventListener("click", jump);
    chat.append(fab);
    window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      sync();
    });
    return () => {
      node.removeEventListener("scroll", sync);
      fab.removeEventListener("click", jump);
      fab.remove();
    };
  }, [session?.thread_id]);
  const reload = useCallback(
    () =>
      api
        .listSkills()
        .then(setSkills)
        .catch((reason) => setError(String(reason))),
    [api],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  const openBuiltin = async (skill: SkillRecord) => {
    setBusy(true);
    setError("");
    try {
      const [content, resources] = await Promise.all([
        api.skillContent(skill.skill_id),
        api.skillResources(skill.skill_id),
      ]);
      setBuiltin({
        skill,
        content: content.content,
        resources: resources.items,
      });
      setBuiltinResource("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const openEditor = async (skillId?: string) => {
    setBusy(true);
    setError("");
    try {
      const created = await api.createSkillEditorSession(skillId);
      const restored = await api.skillEditorSession(created.thread_id);
      setSession({ ...created, ...restored });
      setMessages((restored.messages || []).map((item) => ({ ...item })));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    const content = draft.trim();
    if (!content || !session?.agent_id || busy) return;
    setDraft("");
    setBusy(true);
    setError("");
    setMessages((current) => [
      ...current,
      { role: "user", content },
      { role: "assistant", content: "", pending: true },
    ]);
    try {
      const result = await api.streamChat(
        session.thread_id,
        session.agent_id,
        content,
        (partial) =>
          setMessages((current) =>
            current.map((item, index) =>
              index === current.length - 1
                ? { ...item, content: partial, pending: true }
                : item,
            ),
          ),
        new AbortController().signal,
      );
      setMessages((current) =>
        current.map((item, index) =>
          index === current.length - 1
            ? { ...item, content: result, pending: false }
            : item,
        ),
      );
      const restored = await api.skillEditorSession(session.thread_id);
      setSession((current) =>
        current ? { ...current, ...restored } : current,
      );
      await reload();
    } catch (reason) {
      const text = String(reason);
      setError(text);
      setMessages((current) =>
        current.map((item, index) =>
          index === current.length - 1
            ? { ...item, content: `运行失败：${text}`, pending: false }
            : item,
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (skill: SkillRecord, enabled: boolean) => {
    setBusy(true);
    try {
      const changed = await api.setSkillEnabled(skill.skill_id, enabled);
      setSkills((current) =>
        current.map((item) =>
          item.skill_id === changed.skill_id ? changed : item,
        ),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (skill: SkillRecord) => {
    if (!confirm(`删除「${skill.name}」？`)) return;
    setBusy(true);
    try {
      await api.deleteSkill(skill.skill_id);
      if (session?.skill_id === skill.skill_id) {
        setSession(null);
        setMessages([]);
      }
      await reload();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const importSkill = async () => {
    setBusy(true);
    setError("");
    try {
      const loaded = await window.tugo?.system.chooseSkill();
      if (!loaded) return;
      const saved = await api.saveSkill({
        name: loaded.name || "未命名 Skill",
        description: "",
        content: loaded.content,
        resources: loaded.resources,
      });
      await reload();
      await openEditor(saved.skill_id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const visible = skills.filter((skill) =>
    scope === "builtin" ? skill.built_in : !skill.built_in,
  );
  return (
    <div className="settings-pane skill-settings-pane">
      <div className="skill-settings-hero">
        <strong>{t("skillsTitle")}</strong>
        {scope === "custom" && (
          <div className="settings-header-actions">
            <button className="soft-btn" disabled={busy} onClick={() => void importSkill()}>{t("import")}</button>
            <button className="primary-btn" disabled={busy} onClick={() => void openEditor()}>{t("newSkill")}</button>
          </div>
        )}
      </div>
      <div className="skill-scope-tabs">
        <button
          className={scope === "builtin" ? "active" : ""}
          onClick={() => {
            setScope("builtin");
            setSession(null);
          }}
        >
          {t("builtinSkills")}{" "}
          <small>{skills.filter((item) => item.built_in).length}</small>
        </button>
        <button
          className={scope === "custom" ? "active" : ""}
          onClick={() => {
            setScope("custom");
            setBuiltin({ content: "", resources: [] });
          }}
        >
          {t("mySkills")}{" "}
          <small>{skills.filter((item) => !item.built_in).length}</small>
        </button>
      </div>
      <div className="skill-workspace">
        <nav className="skill-library">
          {visible.length ? (
            visible.map((skill) => (
              <div
                key={skill.skill_id}
                className={`skill-library-row ${session?.skill_id === skill.skill_id || builtin.skill?.skill_id === skill.skill_id ? "active" : ""}`}
              >
                <button
                  onClick={() =>
                    scope === "builtin"
                      ? void openBuiltin(skill)
                      : void openEditor(skill.skill_id)
                  }
                >
                  <span className="skill-record-heading">
                    <b>{skill.name}</b>
                    <i className={skill.enabled === false ? "off" : ""}>
                      {skill.enabled === false ? t("disabled") : t("enabled")}
                    </i>
                  </span>
                  <small>{skill.description || t("noDescription")}</small>
                  <em>{1 + Number(skill.resource_count || 0)} {t("files")}</em>
                </button>
                {scope === "custom" && (
                  <div className="skill-row-actions">
                    <label className="skill-switch">
                      <input
                        type="checkbox"
                        checked={skill.enabled !== false}
                        disabled={busy}
                        onChange={(event) =>
                          void toggle(skill, event.target.checked)
                        }
                      />
                      <i />
                    </label>
                    <button
                      title={t("renameSkill")}
                      disabled={busy}
                      onClick={async () => {
                        const name = prompt("Skill 名称", skill.name);
                        if (!name?.trim()) return;
                        setBusy(true);
                        try {
                          await api.renameSkill(skill.skill_id, name);
                          await reload();
                        } catch (reason) {
                          setError(String(reason));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      ···
                    </button>
                    <button
                      title={t("deleteSkill")}
                      disabled={busy}
                      onClick={() => void remove(skill)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="settings-empty">
              {scope === "custom"
                ? t("newSkillHelp")
                : t("noBuiltinSkills")}
            </div>
          )}
        </nav>
        <section className="skill-editor-panel">
          {scope === "builtin" ? (
            builtin.skill ? (
              <div className="skill-readonly">
                <div className="skill-editor-toolbar">
                  <span>
                    {builtin.skill.enabled === false ? t("selectedSkillDisabled") : t("selectedSkillEnabled")}
                  </span>
                  <label className="skill-switch">
                    <input
                      type="checkbox"
                      checked={builtin.skill.enabled !== false}
                      disabled={busy}
                      onChange={(event) =>
                        void toggle(builtin.skill!, event.target.checked)
                      }
                    />
                    <i />
                  </label>
                </div>
                <h3>{builtin.skill.name}</h3>
                <p>{builtin.skill.description}</p>
                <pre>{builtin.content}</pre>
                {builtin.resources.length > 0 && (
                  <div className="skill-resource-panel">
                    <strong>{t("resourceFiles")}</strong>
                    <nav>
                      {builtin.resources.map((item) => (
                        <button
                          key={item.path}
                          className={builtinResource === item.path ? "active" : ""}
                          onClick={() => setBuiltinResource(item.path)}
                        >
                          {item.path}
                        </button>
                      ))}
                    </nav>
                    {builtinResource && <pre>{builtin.resources.find((item) => item.path === builtinResource)?.content}</pre>}
                  </div>
                )}
              </div>
            ) : (
              <div className="settings-empty">{t("chooseBuiltinSkill")}</div>
            )
          ) : !session ? (
            <div className="settings-empty">
              <strong>{t("skillChatTitle")}</strong>
              <span>{t("selectSkill")}</span>
            </div>
          ) : (
            <div className="skill-agent-chat">
              <header>
                <span>
                  <Sparkles size={15} />
                  <b>
                    {session.skill_id
                      ? session.name || t("skillSession")
                      : t("createNewSkill")}
                  </b>
                </span>
                <small>
                  {session.skill_id
                    ? t("skillEditorMaintainsFiles")
                    : t("describeSkillGoal")}
                </small>
              </header>
              <div className="skill-agent-messages">
                {messages.length ? (
                  messages.map((message, index) => (
                    <div
                      className={`skill-agent-message ${message.role}`}
                      key={`${index}-${message.content.slice(0, 12)}`}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {message.content ||
                          (message.pending ? "正在处理…" : "")}
                      </ReactMarkdown>
                      {message.pending && <span className="typing-caret" />}
                    </div>
                  ))
                ) : (
                  <div className="skill-agent-empty">
                    {t("skillPromptHelp")}
                  </div>
                )}
              </div>
              <form
                className="skill-agent-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <textarea
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={t("skillComposerPlaceholder")}
                  rows={3}
                />
                <button
                  className="primary-btn"
                  disabled={busy || !draft.trim()}
                >
                  {busy ? t("processing") : <Send size={15} />}
                </button>
              </form>
            </div>
          )}
        </section>
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

function DataRecoverySettings() {
  const { language, t } = useI18n();
  const [status, setStatus] = useState<Awaited<
    ReturnType<NonNullable<typeof window.tugo>["data"]["status"]>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(
    () =>
      window
        .tugo!.data.status()
        .then(setStatus)
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        ),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  const restore = async (scope: "app" | "runtime", name: string) => {
    if (!confirm(t("restoreConfirm")))
      return;
    setBusy(true);
    try {
      await window.tugo!.data.restore(scope, name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };
  const list = (
    scope: "app" | "runtime",
    items: Array<{
      name: string;
      size: number;
      createdAt?: string;
      created_at?: string;
    }>,
  ) => (
    <div className="backup-list">
      {items.length ? (
        items.map((item) => (
          <div key={item.name}>
            <span>
              <strong>
                {new Date(
                  item.createdAt || item.created_at || "",
                ).toLocaleString(language)}
              </strong>
              <small>{(item.size / 1024 / 1024).toFixed(1)} MB</small>
            </span>
            <button
              className="soft-btn"
              disabled={busy}
              onClick={() => void restore(scope, item.name)}
            >
              {t("restore")}
            </button>
          </div>
        ))
      ) : (
        <div className="settings-empty">{t("noBackups")}</div>
      )}
    </div>
  );
  return (
    <div className="settings-pane data-settings-pane">
      <div className="settings-list-header">
        <div>
          <strong>{t("dataTitle")}</strong>
          <p>{t("dataDescription")}</p>
        </div>
        <div className="settings-header-actions">
          <button className="soft-btn" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await window.tugo!.data.exportPackage("diagnostic"); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }}>{t("exportDiagnostics")}</button>
          <button className="primary-btn" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await window.tugo!.data.exportPackage("backup"); await reload(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }}>{t("exportBackup")}</button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {!status ? (
        <div className="configuration-loading">{t("checkingData")}</div>
      ) : (
        <>
          <div className="data-location">
            <span>
              <strong>{t("dataDirectory")}</strong>
              <small>{status.dataDir}</small>
            </span>
            <button
              className="soft-btn"
              onClick={() => void window.tugo!.system.openDataDirectory()}
            >
              {t("openDirectory")}
            </button>
            <button
              className="soft-btn"
              onClick={() => void window.tugo!.system.openBackendLog()}
            >
              {t("diagnosticLog")}
            </button>
          </div>
          <div className="data-columns">
            <section>
              <h3>
                {t("boardsAndChats")}{" "}
                <small>
                  {status.app.integrity === "ok"
                    ? t("healthy")
                    : status.app.integrity}
                </small>
              </h3>
              {list("app", status.app.backups)}
            </section>
            <section>
              <h3>
                Agent Runtime{" "}
                <small>
                  {status.runtime.integrity?.ok ? t("healthy") : t("needsCheck")}
                </small>
              </h3>
              {list("runtime", status.runtime.backups)}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
