import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type ProjectProfile = {
  id: string;
  name: string;
  folderPath: string;
  repoUrl: string;
  branch: string;
  deployCommand: string;
  gitUserName: string;
  gitUserEmail: string;
};

type PersistedState = {
  profiles: ProjectProfile[];
  selectedProfileId: string | null;
};

type ProjectInspection = {
  folderExists: boolean;
  gitInitialized: boolean;
  hasOriginRemote: boolean;
  remoteUrl: string | null;
  currentBranch: string | null;
  gitUserName: string | null;
  gitUserEmail: string | null;
  hasChanges: boolean;
  statusSummary: string;
};

type RepositoryConnectionReport = {
  repoUrlValid: boolean;
  remoteReachable: boolean;
  defaultBranch: string | null;
  remoteBranches: string[];
  gitUserName: string | null;
  gitUserEmail: string | null;
  authenticationHint: string | null;
  summary: string;
};

type StepResult = {
  title: string;
  command: string;
  success: boolean;
  output: string;
};

type SyncReport = {
  inspection: ProjectInspection;
  steps: StepResult[];
};

type LogLevel = "info" | "success" | "warn" | "error";

type LogEntry = {
  id: string;
  time: string;
  level: LogLevel;
  message: string;
};

type IconName =
  | "rocket"
  | "refresh"
  | "folder"
  | "repo"
  | "branch"
  | "user"
  | "mail"
  | "terminal"
  | "save"
  | "deploy"
  | "inspect"
  | "link"
  | "settings"
  | "theme"
  | "shield"
  | "spark"
  | "clock"
  | "check"
  | "chevronDown";

const emptyProfile: ProjectProfile = {
  id: "default",
  name: "默认项目",
  folderPath: "",
  repoUrl: "",
  branch: "main",
  deployCommand: "",
  gitUserName: "",
  gitUserEmail: ""
};

const workflowTips = [
  "如果目录未初始化 Git，会自动执行 git init。",
  "如果没有 origin，会自动绑定你填写的远程仓库。",
  "会自动补齐仓库级 Git 用户名与邮箱。",
  "远程分支已存在时，会优先 pull 再 push。"
];

const authTips = [
  "HTTPS 仓库通常需要凭据或 token。",
  "SSH 仓库需要本机已配置 SSH Key。",
  "如远程已有历史冲突，首次同步可能仍需手动处理。"
];

const branchPresets = ["main", "master", "develop", "release", "feature/*"];

const workflowPreviewSteps = [
  "git init",
  "remote add origin",
  "git pull",
  "git add .",
  "git commit",
  "git push",
  "deploy"
];

const WEB_STATE_KEY = "repo-deployer-web-state";

const previewProfiles: ProjectProfile[] = [
  {
    id: "preview-profile-1",
    name: "awesome-portfolio",
    folderPath: "D:\\Projects\\awesome-portfolio",
    repoUrl: "https://github.com/your-name/awesome-portfolio.git",
    branch: "main",
    deployCommand: "npm run build && npm run deploy",
    gitUserName: "Preview User",
    gitUserEmail: "preview@example.com"
  },
  {
    id: "preview-profile-2",
    name: "vite-admin",
    folderPath: "D:\\Projects\\vite-admin",
    repoUrl: "https://github.com/your-name/vite-admin.git",
    branch: "develop",
    deployCommand: "pnpm deploy",
    gitUserName: "Preview User",
    gitUserEmail: "preview@example.com"
  },
  {
    id: "preview-profile-3",
    name: "nextjs-starter",
    folderPath: "D:\\Projects\\nextjs-starter",
    repoUrl: "https://github.com/your-name/nextjs-starter.git",
    branch: "release",
    deployCommand: "",
    gitUserName: "Preview User",
    gitUserEmail: "preview@example.com"
  }
];

function createProfileId() {
  return `profile-${Date.now()}`;
}

function createLogId() {
  return `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getLogTimestamp() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
}

function getPanelTimestamp() {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function loadWebState(): PersistedState {
  if (typeof window === "undefined") {
    return { profiles: [], selectedProfileId: null };
  }

  const raw = window.localStorage.getItem(WEB_STATE_KEY);
  if (!raw) {
    return { profiles: [], selectedProfileId: null };
  }

  try {
    return JSON.parse(raw) as PersistedState;
  } catch {
    return { profiles: [], selectedProfileId: null };
  }
}

function saveWebState(state: PersistedState) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(WEB_STATE_KEY, JSON.stringify(state));
}

function shouldRefreshPreviewState(state: PersistedState) {
  return (
    state.profiles.length === 0 ||
    state.profiles.every((profile) => profile.id === "default") ||
    (state.profiles.length > 0 &&
      state.profiles.every((profile) => profile.id.startsWith("preview-profile")) &&
      state.profiles.length < previewProfiles.length)
  );
}

function getPreviewCommitMessage(profile: ProjectProfile) {
  if (profile.name === "vite-admin") {
    return "feat: polish admin dashboard release flow";
  }

  if (profile.name === "nextjs-starter") {
    return "fix: prepare starter release branch sync";
  }

  return "feat: update portfolio layout and fix responsive issues";
}

function createPreviewConnection(profile: ProjectProfile): RepositoryConnectionReport {
  const remoteBranches = Array.from(
    new Set([profile.branch, "main", "develop", "release", "master"].filter(Boolean))
  );

  return {
    repoUrlValid: true,
    remoteReachable: true,
    defaultBranch: profile.branch || "main",
    remoteBranches,
    gitUserName: profile.gitUserName,
    gitUserEmail: profile.gitUserEmail,
    authenticationHint: "当前为浏览器预览模式，展示的是模拟鉴权提示。",
    summary: `远程仓库可访问，默认分支为 ${profile.branch || "main"}，Git 身份已识别。`
  };
}

function createPreviewInspection(profile: ProjectProfile): ProjectInspection {
  return {
    folderExists: true,
    gitInitialized: true,
    hasOriginRemote: true,
    remoteUrl: profile.repoUrl,
    currentBranch: profile.branch,
    gitUserName: profile.gitUserName,
    gitUserEmail: profile.gitUserEmail,
    hasChanges: true,
    statusSummary: "工作区存在待提交改动，可直接执行提交与推送。"
  };
}

function createPreviewLogs(profile: ProjectProfile): LogEntry[] {
  const entries: Array<{ level: LogLevel; message: string }> = [
    {
      level: "success",
      message:
        `同步完成\n git push -u origin ${profile.branch}\n 已成功推送到远程仓库，预览模式未执行真实 Git 命令。`
    },
    {
      level: "success",
      message:
        `创建提交\n git commit -m "${getPreviewCommitMessage(profile)}"\n 5 files changed, 42 insertions(+), 12 deletions(-)`
    },
    {
      level: "info",
      message:
        `远程检查完成\n git ls-remote --symref origin HEAD\n 远程仓库可达，默认分支识别为 ${profile.branch}。`
    },
    {
      level: profile.deployCommand ? "success" : "warn",
      message: profile.deployCommand
        ? `部署步骤\n ${profile.deployCommand}\n 预览模式下展示部署命令已准备就绪。`
        : "部署步骤\n 当前项目未配置部署命令，执行同步时将只提交并推送。"
    }
  ];

  return entries.map((entry, index) => ({
    id: `preview-log-${index}`,
    time: getLogTimestamp(),
    level: entry.level,
    message: entry.message
  }));
}

function normalizeProfile(profile: ProjectProfile): ProjectProfile {
  return {
    ...emptyProfile,
    ...profile,
    gitUserName: profile.gitUserName ?? "",
    gitUserEmail: profile.gitUserEmail ?? ""
  };
}

function toRepoLabel(repoUrl: string) {
  if (!repoUrl.trim()) {
    return "未配置仓库地址";
  }

  return repoUrl
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(":", "/");
}

function toShortPath(folderPath: string) {
  if (!folderPath.trim()) {
    return "尚未选择本地目录";
  }

  const normalized = folderPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) {
    return folderPath;
  }

  return `.../${parts.slice(-3).join("/")}`;
}

function toRepoDomain(repoUrl: string) {
  const label = toRepoLabel(repoUrl);
  if (label === "未配置仓库地址") {
    return label;
  }

  return label.split("/").slice(0, 3).join("/");
}

function getProjectSyncLabel(profile: ProjectProfile) {
  if (profile.name === "awesome-portfolio") {
    return "2 min ago";
  }

  if (profile.name === "vite-admin") {
    return "12 min ago";
  }

  return profile.repoUrl.trim() ? "ready" : "not synced";
}

function getRepoAccessMode(repoUrl: string) {
  const trimmed = repoUrl.trim();

  if (trimmed.startsWith("git@")) {
    return "SSH";
  }

  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return "HTTPS";
  }

  return "待识别";
}

function getWorkflowSummary(profile: ProjectProfile) {
  if (profile.deployCommand.trim()) {
    return `完成推送后会继续执行部署命令：${profile.deployCommand.trim()}`;
  }

  return "当前流程会完成仓库初始化、提交与推送，不会额外执行部署命令。";
}

function getAuthCallout(repoUrl: string, authenticationHint: string | null) {
  if (authenticationHint) {
    return authenticationHint;
  }

  const mode = getRepoAccessMode(repoUrl);

  if (mode === "HTTPS") {
    return "检测到 HTTPS 仓库，首次同步前请确认 Git 凭据或 Personal Access Token 已可用。";
  }

  if (mode === "SSH") {
    return "检测到 SSH 仓库，请确认当前设备的 SSH Key 已配置并已添加到远程平台。";
  }

  return "填写仓库地址后，这里会根据连接方式给出更具体的认证建议。";
}

function resolveRepoUrl(formRepoUrl: string, inspection: ProjectInspection | null) {
  return formRepoUrl.trim() || inspection?.remoteUrl || "";
}

function getIdentityLabel(connection: RepositoryConnectionReport | null) {
  if (!connection) {
    return "待检查";
  }

  return connection.gitUserName && connection.gitUserEmail ? "已识别" : "待补充";
}

function getStatusTone(active: boolean): "good" | "neutral" | "warn" {
  return active ? "good" : "warn";
}

function getProfileStatus(profile: ProjectProfile) {
  if (profile.repoUrl.trim() && profile.folderPath.trim()) {
    return { label: "就绪", tone: "good" as const };
  }

  if (profile.repoUrl.trim() || profile.folderPath.trim()) {
    return { label: "待完善", tone: "warn" as const };
  }

  return { label: "空白", tone: "neutral" as const };
}

function Icon({ name }: { name: IconName }) {
  const icons: Record<IconName, string> = {
    rocket:
      "M11.5 3.5c3.6 0 6 1.4 7 2.4 1 1 2.4 3.4 2.4 7l-4.6 1.6-3.2 3.2-1.6 4.6c-3.6 0-6-1.4-7-2.4-1-1-2.4-3.4-2.4-7l4.6-1.6 3.2-3.2 1.6-4.6ZM14 10.5a1.5 1.5 0 1 0 0 3.001A1.5 1.5 0 0 0 14 10.5ZM6.5 18.5l-2 2M7.5 14.5l-4 1M10.5 17.5l1 4",
    refresh:
      "M18 8a6.5 6.5 0 0 0-11-2.5M6 6H3V3M6 16a6.5 6.5 0 0 0 11 2.5M18 18h3v3",
    folder:
      "M3.5 7.5h5l2 2h10v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z",
    repo:
      "M6.5 4.5h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2ZM8 8h7M8 12h8M8 16h5",
    branch:
      "M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm8 8a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM8 10.5v3a4 4 0 0 0 4 4h1.5M16 13.5V6.5a2 2 0 0 0-2-2H10.5",
    user:
      "M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6.5 7a6.5 6.5 0 1 1 13 0",
    mail:
      "M4 6.5h16a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a1 1 0 0 1 1-1Zm0 1 8 6 8-6",
    terminal:
      "M4 5.5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm3 4 3 3-3 3M12 16h5",
    save: "M5 4.5h12l2 2v13H5v-15Zm3 0v5h7v-5M8 19v-5h8v5",
    deploy:
      "M12 3.5 19 7v5c0 4.3-2.9 7.6-7 8.5-4.1-.9-7-4.2-7-8.5V7l7-3.5Zm-3 8 2 2 4-4",
    inspect:
      "M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm8 12 3 3",
    link: "M9 15 7 17a3 3 0 1 1-4-4l3-3a3 3 0 0 1 4 0M15 9l2-2a3 3 0 1 1 4 4l-3 3a3 3 0 0 1-4 0M9 15l6-6",
    settings:
      "M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0-5 1 2.2 2.4.7 2.1-1.2 1.8 1.8-1.2 2.1.7 2.4L21 12l-2.2 1  -.7 2.4 1.2 2.1-1.8 1.8-2.1-1.2-2.4.7L12 21l-1-2.2-2.4-.7-2.1 1.2-1.8-1.8 1.2-2.1-.7-2.4L3 12l2.2-1 .7-2.4-1.2-2.1 1.8-1.8 2.1 1.2 2.4-.7L12 3.5Z",
    theme:
      "M18.5 14.5A6.5 6.5 0 1 1 9.5 5.5a5.5 5.5 0 0 0 9 9Z",
    shield: "M12 3.5 19 6.5V12c0 4.2-2.7 7.5-7 8.5C7.7 19.5 5 16.2 5 12V6.5L12 3.5Zm0 4.5v6",
    spark: "M12 3.5 13.8 9l5.7 1.8-5.7 1.7L12 18l-1.8-5.5-5.7-1.7L10.2 9 12 3.5Z",
    clock: "M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm0 3v4l2.5 1.5",
    check: "M5 12.5 9.2 17 19 7.5",
    chevronDown: "m6 9 6 6 6-6"
  };

  return (
    <svg viewBox="0 0 24 24" className="icon" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={icons[name].replace("  -", "-")} />
    </svg>
  );
}

function SectionTitle({
  label,
  accent = "neutral",
  icon
}: {
  label: string;
  accent?: "neutral" | "brand" | "success";
  icon?: IconName;
}) {
  return (
    <div className="section-title">
      <span className={`section-title__dot section-title__dot--${accent}`} />
      {icon ? (
        <span className="section-title__icon">
          <Icon name={icon} />
        </span>
      ) : null}
      <h3>{label}</h3>
    </div>
  );
}

function App() {
  const [profiles, setProfiles] = useState<ProjectProfile[]>([emptyProfile]);
  const [selectedProfileId, setSelectedProfileId] = useState("default");
  const [form, setForm] = useState<ProjectProfile>(emptyProfile);
  const [commitMessage, setCommitMessage] = useState("chore: update project");
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [connection, setConnection] = useState<RepositoryConnectionReport | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [lastConnectionCheckAt, setLastConnectionCheckAt] = useState<string | null>(null);
  const [lastInspectionAt, setLastInspectionAt] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const savedProfiles = profiles.filter((profile) => profile.id !== "default");
  const visibleProfiles = savedProfiles.filter((profile) => {
    const keyword = projectSearch.trim().toLowerCase();
    if (!keyword) {
      return true;
    }

    return `${profile.name} ${profile.repoUrl} ${profile.folderPath}`.toLowerCase().includes(keyword);
  });
  const detectedBranches = Array.from(
    new Set(
      [
        inspection?.currentBranch,
        connection?.defaultBranch,
        ...(connection?.remoteBranches ?? []),
        form.branch.trim() || null
      ].filter((branch): branch is string => Boolean(branch && branch.trim()))
    )
  );
  const branchOptions = detectedBranches.length > 0 ? detectedBranches : branchPresets;
  const effectiveBranch = form.branch.trim() || connection?.defaultBranch || "main";
  const displayedRepoUrl = resolveRepoUrl(form.repoUrl, inspection);
  const busy = busyAction !== null;
  const hasFolderConfigured = Boolean(form.folderPath.trim());
  const hasDeployCommand = Boolean(form.deployCommand.trim());

  useEffect(() => {
    void loadState();
  }, []);

  useEffect(() => {
    if (isTauriRuntime()) {
      return;
    }

    const matchedProfile = profiles.find((profile) => profile.id === selectedProfileId);
    if (!matchedProfile || !matchedProfile.id.startsWith("preview-profile")) {
      return;
    }

    const needsHydration =
      connection === null ||
      inspection === null ||
      logs.length === 0 ||
      form.id !== matchedProfile.id;

    if (needsHydration) {
      applyPreviewWorkspace(matchedProfile);
    }
  }, [profiles, selectedProfileId, connection, inspection, logs.length, form.id]);

  function applyPreviewWorkspace(profile: ProjectProfile) {
    setForm(profile);
    setConnection(createPreviewConnection(profile));
    setInspection(createPreviewInspection(profile));
    setLogs(createPreviewLogs(profile));
    const now = getPanelTimestamp();
    setLastConnectionCheckAt(now);
    setLastInspectionAt(now);
    setLastSyncAt(now);
    setCommitMessage(getPreviewCommitMessage(profile));
  }

  async function loadState() {
    try {
      const state = isTauriRuntime()
        ? await invoke<PersistedState>("load_state")
        : loadWebState();

      if (!isTauriRuntime() && shouldRefreshPreviewState(state)) {
        const previewState: PersistedState = {
          profiles: previewProfiles,
          selectedProfileId: previewProfiles[0].id
        };
        saveWebState(previewState);
        setProfiles(previewState.profiles);
        setSelectedProfileId(previewProfiles[0].id);
        applyPreviewWorkspace(previewProfiles[0]);
        return;
      }

      if (state.profiles.length === 0) {
        setProfiles([emptyProfile]);
        setSelectedProfileId(emptyProfile.id);
        setForm(emptyProfile);
        return;
      }

      const normalized = state.profiles.map(normalizeProfile);
      const firstId = state.selectedProfileId ?? normalized[0].id;
      const current = normalized.find((profile) => profile.id === firstId) ?? normalized[0];

      setProfiles(normalized);
      setSelectedProfileId(current.id);
      if (!isTauriRuntime() && current.id.startsWith("preview-profile")) {
        applyPreviewWorkspace(current);
      } else {
        setForm(current);
      }
    } catch (error) {
      appendLog(`读取本地配置失败：${String(error)}`, "error");
    }
  }

  async function saveState(nextProfiles: ProjectProfile[], nextSelectedId: string) {
    const payload: PersistedState = {
      profiles: nextProfiles,
      selectedProfileId: nextSelectedId
    };

    if (isTauriRuntime()) {
      await invoke("save_state", { state: payload });
    } else {
      saveWebState(payload);
    }

    setProfiles(nextProfiles);
    setSelectedProfileId(nextSelectedId);
  }

  function appendLog(message: string, level: LogLevel = "info") {
    const entry: LogEntry = {
      id: createLogId(),
      time: getLogTimestamp(),
      level,
      message
    };

    setLogs((current) => [entry, ...current].slice(0, 160));
  }

  function waitForPaint() {
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  function updateForm<K extends keyof ProjectProfile>(key: K, value: ProjectProfile[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handlePickFolder() {
    if (!isTauriRuntime()) {
      appendLog("浏览器预览模式下无法打开系统目录选择器，请直接输入本地路径。", "warn");
      return;
    }

    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择需要同步到仓库的文件夹"
    });

    if (typeof selected === "string") {
      updateForm("folderPath", selected);
      setInspection(null);
      setConnection(null);
      appendLog(`已选择本地目录：${selected}`);
    }
  }

  async function handleInspect() {
    if (!form.folderPath.trim()) {
      appendLog("请先选择本地文件夹。", "warn");
      return;
    }

    if (!isTauriRuntime()) {
      const mockInspection: ProjectInspection = {
        folderExists: true,
        gitInitialized: form.folderPath.includes(".git") || form.folderPath.length > 0,
        hasOriginRemote: Boolean(form.repoUrl.trim()),
        remoteUrl: form.repoUrl.trim() || null,
        currentBranch: effectiveBranch,
        gitUserName: form.gitUserName || "Preview User",
        gitUserEmail: form.gitUserEmail || "preview@example.com",
        hasChanges: true,
        statusSummary: "当前为浏览器预览模式，展示的是本地模拟状态。"
      };

      setInspection(mockInspection);
      setLastInspectionAt(getPanelTimestamp());
      appendLog("浏览器预览模式：已生成模拟本地状态。", "info");
      return;
    }

    setBusyAction("inspect");
    try {
      const result = await invoke<ProjectInspection>("inspect_project", {
        request: {
          folderPath: form.folderPath
        }
      });
      setInspection(result);
      setForm((current) => ({
        ...current,
        repoUrl: result.remoteUrl || current.repoUrl,
        branch: result.currentBranch || current.branch,
        gitUserName: result.gitUserName || current.gitUserName,
        gitUserEmail: result.gitUserEmail || current.gitUserEmail
      }));
      setLastInspectionAt(getPanelTimestamp());
      appendLog(`本地状态检查完成：${result.statusSummary}`, "success");
    } catch (error) {
      appendLog(`检查失败：${String(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCheckConnection() {
    if (!form.repoUrl.trim()) {
      appendLog("请先输入 Git 仓库地址。", "warn");
      return;
    }

    if (!isTauriRuntime()) {
      const mockConnection: RepositoryConnectionReport = {
        repoUrlValid: form.repoUrl.startsWith("http") || form.repoUrl.startsWith("git@"),
        remoteReachable: true,
        defaultBranch: form.branch.trim() || "main",
        remoteBranches: ["main", "develop", "release"],
        gitUserName: form.gitUserName || "Preview User",
        gitUserEmail: form.gitUserEmail || "preview@example.com",
        authenticationHint: "当前为浏览器预览模式，未执行真实远程鉴权。",
        summary: "浏览器预览模式：已生成模拟仓库连接结果。"
      };

      setConnection(mockConnection);
      setLastConnectionCheckAt(getPanelTimestamp());
      appendLog("浏览器预览模式：已生成模拟仓库连接结果。", "info");
      return;
    }

    setBusyAction("connect");
    try {
      const result = await invoke<RepositoryConnectionReport>("check_repository_connection", {
        request: {
          repoUrl: form.repoUrl,
          folderPath: form.folderPath || null
        }
      });
      setConnection(result);
      setLastConnectionCheckAt(getPanelTimestamp());
      appendLog(`仓库连接检查完成：${result.summary}`, result.remoteReachable ? "success" : "warn");

      if (!form.branch.trim() && result.defaultBranch) {
        updateForm("branch", result.defaultBranch);
      }

      if (!form.gitUserName.trim() && result.gitUserName) {
        updateForm("gitUserName", result.gitUserName);
      }

      if (!form.gitUserEmail.trim() && result.gitUserEmail) {
        updateForm("gitUserEmail", result.gitUserEmail);
      }
    } catch (error) {
      appendLog(`连接检查失败：${String(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveProfile(event: FormEvent) {
    event.preventDefault();

    const nextProfile = normalizeProfile({
      ...form,
      id: !form.id || form.id === "default" ? createProfileId() : form.id,
      name: form.name.trim() || "未命名项目",
      branch: form.branch.trim() || connection?.defaultBranch || "main",
      gitUserName: form.gitUserName.trim(),
      gitUserEmail: form.gitUserEmail.trim()
    });

    const existingIndex = profiles.findIndex((profile) => profile.id === nextProfile.id);
    const nextProfiles =
      existingIndex >= 0
        ? profiles.map((profile) => (profile.id === nextProfile.id ? nextProfile : profile))
        : [nextProfile, ...profiles.filter((profile) => profile.id !== "default")];

    await saveState(nextProfiles, nextProfile.id);
    setForm(nextProfile);
    appendLog(`已保存项目配置：${nextProfile.name}`, "success");
  }

  function handleCreateProfile() {
    const nextProfile = {
      ...emptyProfile,
      id: createProfileId(),
      name: "新项目"
    };

    setForm(nextProfile);
    setSelectedProfileId(nextProfile.id);
    setInspection(null);
    setConnection(null);
    appendLog("已创建新的项目草稿。");
  }

  async function handleSelectProfile(profileId: string) {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) {
      return;
    }

    setForm(normalizeProfile(profile));
    setSelectedProfileId(profileId);
    setInspection(null);
    setConnection(null);
    await saveState(profiles, profileId);
    if (!isTauriRuntime() && profile.id.startsWith("preview-profile")) {
      applyPreviewWorkspace(normalizeProfile(profile));
    }
    appendLog(`已切换到项目：${profile.name}`);
  }

  async function handleRefreshProfiles() {
    await loadState();
    appendLog("已重新加载本地项目配置。");
  }

  async function handleCopyLogs() {
    if (logs.length === 0) {
      appendLog("当前没有可复制的日志。", "warn");
      return;
    }

    try {
      const content = logs
        .slice()
        .reverse()
        .map((entry) => `[${entry.time}] ${entry.level.toUpperCase()} ${entry.message}`)
        .join("\n");
      await navigator.clipboard.writeText(content);
      appendLog("日志已复制到剪贴板。", "success");
    } catch (error) {
      appendLog(`复制日志失败：${String(error)}`, "error");
    }
  }

  function handleClearLogs() {
    setLogs([]);
  }

  async function runSync(withDeploy: boolean) {
    if (!form.repoUrl.trim()) {
      appendLog("请先输入 Git 仓库地址。", "warn");
      return;
    }

    if (!form.folderPath.trim()) {
      appendLog("请先选择本地文件夹。", "warn");
      return;
    }

    if (!commitMessage.trim()) {
      appendLog("请填写提交信息。", "warn");
      return;
    }

    if (!isTauriRuntime()) {
      setLastSyncAt(getPanelTimestamp());
      appendLog("浏览器预览模式：未执行真实 Git 命令，以下为模拟执行摘要。", "warn");
      appendLog(`git add -A\n git commit -m "${commitMessage}"\n git push -u origin ${effectiveBranch}`, "success");
      if (withDeploy && form.deployCommand.trim()) {
        appendLog(`deploy\n${form.deployCommand}`, "success");
      }
      return;
    }

    setBusyAction(withDeploy ? "sync-deploy" : "sync");
    appendLog(withDeploy ? "开始执行提交流程并准备部署。" : "开始执行 Git 同步流程。");

    await waitForPaint();

    try {
      const result = await invoke<SyncReport>("run_repository_sync", {
        request: {
          folderPath: form.folderPath,
          repoUrl: form.repoUrl,
          branch: effectiveBranch,
          commitMessage,
          deployCommand: withDeploy ? form.deployCommand : "",
          gitUserName: form.gitUserName,
          gitUserEmail: form.gitUserEmail
        }
      });

      setInspection(result.inspection);
      setLastInspectionAt(getPanelTimestamp());
      setLastSyncAt(getPanelTimestamp());
      for (const step of result.steps) {
        appendLog(
          `${step.title}\n${step.command}\n${step.output}`,
          step.success ? "success" : "error"
        );
      }
      appendLog(withDeploy ? "所有任务已完成，部署流程结束。" : "同步流程已完成。", "success");
    } catch (error) {
      appendLog(`执行失败：${String(error)}`, "error");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="app-shell">
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar__brand">
            <div className="brand-lockup">
              <span className="brand-lockup__mark">RD</span>
              <div>
                <h1>Repo Deployer</h1>
              </div>
            </div>
            <button type="button" className="primary-button primary-button--block" onClick={handleCreateProfile}>
              <Icon name="spark" />
              新建项目
            </button>
          </div>

          <div className="sidebar__section">
            <div className="sidebar__section-header">
              <span>我的项目 ({savedProfiles.length})</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => void handleRefreshProfiles()}
                aria-label="刷新项目配置"
              >
                <Icon name="refresh" />
              </button>
            </div>

            <label className="sidebar-search" aria-label="搜索项目">
              <Icon name="inspect" />
              <input
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
                placeholder="搜索项目"
              />
            </label>

            <div className="profile-list">
              {visibleProfiles.length > 0 ? (
                visibleProfiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={`profile-card ${selectedProfileId === profile.id ? "profile-card--active" : ""}`}
                    onClick={() => void handleSelectProfile(profile.id)}
                  >
                    <div className="profile-card__header">
                      <strong>{profile.name}</strong>
                      <span className={`mini-badge mini-badge--${getProfileStatus(profile).tone}`}>
                        {getProfileStatus(profile).label}
                      </span>
                    </div>
                    <span className="profile-card__meta">
                      <Icon name="repo" />
                      {toRepoDomain(profile.repoUrl)}
                    </span>
                    <div className="profile-card__footer">
                      <span className="profile-card__branch">
                        <Icon name="clock" />
                        {getProjectSyncLabel(profile)}
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <div className="sidebar-empty">
                  <div className="sidebar-empty__art" />
                  <strong>还没有项目</strong>
                  <p>点击“新建项目”开始配置你的第一个同步任务。</p>
                </div>
              )}
            </div>
          </div>

          <div className="sidebar__footer">
            <button type="button" className="icon-button" aria-label="设置">
              <Icon name="settings" />
            </button>
            <button type="button" className="icon-button" aria-label="外观">
              <Icon name="theme" />
            </button>
          </div>
        </aside>

        <main className="content">
          <section className="hero-panel">
            <div className="hero-panel__intro">
              <div className="hero-panel__badge">
                <Icon name="rocket" />
              </div>
              <div>
                <h2>输入仓库地址并选择项目目录，一键完成 Git 初始化、提交与部署</h2>
                <p>Git workflow automation · repository manager · deployment console</p>
              </div>
            </div>

            <div className="hero-panel__actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void handleCheckConnection()}
              >
                <Icon name="link" />
                {busyAction === "connect" ? "检测中..." : "检测仓库连接"}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void handleInspect()}
              >
                <Icon name="inspect" />
                {busyAction === "inspect" ? "检查中..." : "检查本地状态"}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void runSync(true)}
              >
                <Icon name="deploy" />
                {busyAction === "sync-deploy" ? "处理中..." : "一键提交并部署"}
              </button>
            </div>
          </section>

          <section className="top-grid">
            <form className="panel panel--form" onSubmit={(event) => void handleSaveProfile(event)}>
              <div className="panel__header">
                <SectionTitle label="项目配置" accent="brand" icon="repo" />
                <button type="submit" className="primary-button panel-save-button">
                  <Icon name="save" />
                  保存配置
                </button>
              </div>

              <div className="form-grid">
                <label className="field">
                  <span className="field__label field__label--icon">
                    <Icon name="spark" />
                    项目名称
                  </span>
                  <div className="input-shell">
                    <input
                      value={form.name}
                      onChange={(event) => updateForm("name", event.target.value)}
                      placeholder="例如：awesome-portfolio"
                    />
                  </div>
                  <small className="field__hint">用于左侧项目列表与后续快速切换。</small>
                </label>

                <label className="field">
                  <span className="field__label field__label--icon">
                    <Icon name="link" />
                    Git 仓库地址
                  </span>
                  <div className="input-shell input-shell--with-addon">
                    <span className="input-addon input-addon--leading">origin</span>
                    <input
                      value={form.repoUrl}
                      onChange={(event) => updateForm("repoUrl", event.target.value)}
                      placeholder="https://github.com/your-name/your-repo.git"
                    />
                  </div>
                  <small className="field__hint">支持 HTTPS 或 SSH 仓库地址。</small>
                </label>

                <label className="field field--span-2">
                  <span className="field__label field__label--icon">
                    <Icon name="folder" />
                    本地文件夹路径
                  </span>
                  <div className="inline-field">
                    <div className="input-shell input-shell--with-addon input-shell--grow">
                      <span className="input-addon input-addon--leading">path</span>
                      <input
                        value={form.folderPath}
                        onChange={(event) => updateForm("folderPath", event.target.value)}
                        placeholder="选择要同步的本地目录"
                      />
                      <span className={`input-addon input-addon--status ${hasFolderConfigured ? "input-addon--good" : ""}`}>
                        {hasFolderConfigured ? "已选择" : "待选择"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="ghost-button ghost-button--compact"
                      onClick={() => void handlePickFolder()}
                    >
                      <Icon name="folder" />
                      选择文件夹
                    </button>
                  </div>
                  <small className="field__hint">选择需要同步到远程仓库的本地项目目录。</small>
                </label>

                <label className="field">
                  <span className="field__label field__label--icon">
                    <Icon name="branch" />
                    推送分支
                  </span>
                  <div className="chip-row chip-row--branch">
                    {branchOptions.map((branch) => (
                      <button
                        key={branch}
                        type="button"
                        className={`chip ${effectiveBranch === branch ? "chip--active" : ""}`}
                        onClick={() => updateForm("branch", branch)}
                      >
                        {branch}
                      </button>
                    ))}
                  </div>
                  <small className="field__hint">
                    {detectedBranches.length > 0 ? "已按检测到的真实分支优先展示。" : "未检测到分支时显示常用预设。"}
                  </small>
                </label>

                <label className="field">
                  <span className="field__label field__label--icon">
                    <Icon name="user" />
                    Git 用户名
                  </span>
                  <div className="input-shell input-shell--with-addon">
                    <span className="input-addon input-addon--leading">git</span>
                    <input
                      value={form.gitUserName}
                      onChange={(event) => updateForm("gitUserName", event.target.value)}
                      placeholder={connection?.gitUserName || "用于本仓库提交记录"}
                    />
                    <span className="input-addon input-addon--status">
                      {connection?.gitUserName ? "自动识别" : "手动填写"}
                    </span>
                  </div>
                  <small className="field__hint">为空时会尝试读取本机或仓库已有配置。</small>
                </label>

                <label className="field">
                  <span className="field__label field__label--icon">
                    <Icon name="mail" />
                    Git 邮箱
                  </span>
                  <div className="input-shell input-shell--with-addon">
                    <span className="input-addon input-addon--leading">mail</span>
                    <input
                      value={form.gitUserEmail}
                      onChange={(event) => updateForm("gitUserEmail", event.target.value)}
                      placeholder={connection?.gitUserEmail || "you@example.com"}
                    />
                    <span className="input-addon input-addon--status">
                      {connection?.gitUserEmail ? "已检测" : "待补充"}
                    </span>
                  </div>
                  <small className="field__hint">用于仓库级提交身份识别。</small>
                </label>

                <label className="field">
                  <span className="field__label field__label--icon">
                    <Icon name="terminal" />
                    部署命令（可选）
                  </span>
                  <div className="input-shell input-shell--with-addon">
                    <span className="input-addon input-addon--leading">cmd</span>
                    <input
                      value={form.deployCommand}
                      onChange={(event) => updateForm("deployCommand", event.target.value)}
                      placeholder="例如：npm run deploy"
                    />
                    <span className="input-addon input-addon--status">
                      {hasDeployCommand ? "已启用" : "跳过部署"}
                    </span>
                  </div>
                  <small className="field__hint">可选项，提交推送成功后自动执行。</small>
                </label>
              </div>

            </form>

            <section className="panel panel--actions">
              <div className="panel__header">
                <SectionTitle label="执行操作" accent="brand" icon="deploy" />
              </div>

              <label className="field">
                <span className="field__label field__label--icon">
                  <Icon name="terminal" />
                  提交信息
                </span>
                <textarea
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  rows={3}
                  placeholder="chore: update project"
                />
              </label>

              <div className="action-group">
                <button
                  type="button"
                  className="secondary-button secondary-button--fill"
                  disabled={busy}
                  onClick={() => void runSync(false)}
                >
                  <Icon name="save" />
                  {busyAction === "sync" ? "处理中..." : "初始化并提交"}
                </button>
                <button
                  type="button"
                  className="primary-button primary-button--fill"
                  disabled={busy}
                  onClick={() => void runSync(true)}
                >
                  <Icon name="deploy" />
                  {busyAction === "sync-deploy" ? "处理中..." : "提交后执行部署"}
                </button>
              </div>

              <div className="tips-grid">
                <article className="tips-card tips-card--workflow">
                  <div className="tips-card__header">
                    <span className="tips-card__badge">
                      <Icon name="spark" />
                    </span>
                    <strong>Workflow Preview</strong>
                  </div>
                  <div className="workflow-preview">
                    {workflowPreviewSteps.map((step, index) => (
                      <span key={step} className="workflow-preview__step">
                        {step}
                        {index < workflowPreviewSteps.length - 1 ? <b>↓</b> : null}
                      </span>
                    ))}
                  </div>
                  <p className="tips-card__summary">{getWorkflowSummary(form)}</p>
                </article>

                <article className="tips-card tips-card--warm tips-card--auth">
                  <div className="tips-card__header">
                    <span className="tips-card__badge tips-card__badge--warm">
                      <Icon name="shield" />
                    </span>
                    <strong>认证提醒</strong>
                  </div>
                  <div className="tips-card__meta">
                    <span className="mini-badge mini-badge--neutral">{getRepoAccessMode(displayedRepoUrl)}</span>
                    <span
                      className={`mini-badge mini-badge--${
                        connection?.authenticationHint
                          ? "warn"
                          : connection?.remoteReachable
                            ? "good"
                            : "neutral"
                      }`}
                    >
                      {connection?.authenticationHint
                        ? "需确认认证"
                        : connection?.remoteReachable
                          ? "连接已验证"
                          : "待检测"}
                    </span>
                  </div>
                  <p className="tips-card__summary">
                    {getAuthCallout(displayedRepoUrl, connection?.authenticationHint ?? null)}
                  </p>
                  <ul className="tips-list tips-list--wrap">
                    {authTips.map((tip) => (
                      <li key={tip}>{tip}</li>
                    ))}
                  </ul>
                </article>
              </div>
            </section>
          </section>

          <section className="panel status-panel status-panel--remote">
            <div className="panel__header">
              <SectionTitle label="远程仓库状态" accent="success" icon="link" />
              <span className="panel-meta">
                <Icon name="clock" />
                {lastConnectionCheckAt ? `最近检查 ${lastConnectionCheckAt}` : "尚未检查"}
              </span>
            </div>

            {connection ? (
              <div className="status-strip">
                <article className={`metric-card metric-card--${getStatusTone(connection.repoUrlValid)}`}>
                  <span className="metric-card__label">
                    <Icon name="repo" />
                    仓库地址
                  </span>
                  <strong>{connection.repoUrlValid ? "有效" : "无效"}</strong>
                  <small>{toRepoLabel(displayedRepoUrl)}</small>
                </article>
                <article className={`metric-card metric-card--${getStatusTone(connection.remoteReachable)}`}>
                  <span className="metric-card__label">
                    <Icon name="link" />
                    连接状态
                  </span>
                  <strong>{connection.remoteReachable ? "可连接" : "不可连接"}</strong>
                  <small>{connection.remoteReachable ? "已通过远程检查" : "请检查凭据或地址"}</small>
                </article>
                <article className="metric-card metric-card--neutral">
                  <span className="metric-card__label">
                    <Icon name="branch" />
                    默认分支
                  </span>
                  <strong>{connection.defaultBranch || "未识别"}</strong>
                  <small>将优先作为推送目标</small>
                </article>
                <article
                  className={`metric-card metric-card--${
                    connection.gitUserName && connection.gitUserEmail ? "good" : "warn"
                  }`}
                >
                  <span className="metric-card__label">
                    <Icon name="user" />
                    Git 身份
                  </span>
                  <strong>{getIdentityLabel(connection)}</strong>
                  <small>
                    {connection.gitUserName && connection.gitUserEmail
                      ? `${connection.gitUserName} <${connection.gitUserEmail}>`
                      : "需要补充提交身份信息"}
                  </small>
                </article>
                <article className="metric-card metric-card--wide metric-card--summary">
                  <span className="metric-card__label">
                    <Icon name="spark" />
                    摘要
                  </span>
                  <strong>{connection.summary}</strong>
                </article>
                <article className="metric-card metric-card--wide metric-card--summary">
                  <span className="metric-card__label">
                    <Icon name="shield" />
                    认证提示
                  </span>
                  <strong>{connection.authenticationHint || "当前没有检测到明显认证问题。"}</strong>
                </article>
              </div>
            ) : (
              <div className="empty-card">
                点击“检测仓库连接”后，这里会展示仓库地址有效性、远程可达性、默认分支和 Git 身份识别结果。
              </div>
            )}
          </section>

          <section className="panel status-panel status-panel--local">
            <div className="panel__header">
              <SectionTitle label="本地仓库状态" accent="success" icon="folder" />
              <span className="panel-meta">
                <Icon name="clock" />
                {lastInspectionAt ? `最近检查 ${lastInspectionAt}` : "尚未检查"}
              </span>
            </div>

            {inspection ? (
              <div className="status-strip">
                <article className={`metric-card metric-card--${getStatusTone(inspection.folderExists)}`}>
                  <span className="metric-card__label">
                    <Icon name="folder" />
                    文件夹存在
                  </span>
                  <strong>{inspection.folderExists ? "是" : "否"}</strong>
                  <small>{form.folderPath || "未选择目录"}</small>
                </article>
                <article className={`metric-card metric-card--${getStatusTone(inspection.gitInitialized)}`}>
                  <span className="metric-card__label">
                    <Icon name="repo" />
                    Git 初始化
                  </span>
                  <strong>{inspection.gitInitialized ? "已初始化" : "未初始化"}</strong>
                  <small>{inspection.gitInitialized ? ".git 目录已存在" : "首次同步时会自动初始化"}</small>
                </article>
                <article className={`metric-card metric-card--${getStatusTone(inspection.hasOriginRemote)}`}>
                  <span className="metric-card__label">
                    <Icon name="link" />
                    已绑定 origin
                  </span>
                  <strong>{inspection.hasOriginRemote ? "已绑定" : "未绑定"}</strong>
                  <small>{inspection.remoteUrl || "尚未绑定远程地址"}</small>
                </article>
                <article className="metric-card metric-card--neutral">
                  <span className="metric-card__label">
                    <Icon name="branch" />
                    当前分支
                  </span>
                  <strong>{inspection.currentBranch || "未检测到"}</strong>
                  <small>{inspection.hasChanges ? "检测到待提交改动" : "当前工作区干净"}</small>
                </article>
                <article className="metric-card metric-card--wide metric-card--summary">
                  <span className="metric-card__label">
                    <Icon name="spark" />
                    状态摘要
                  </span>
                  <strong>{inspection.statusSummary}</strong>
                </article>
                <article className="metric-card metric-card--wide metric-card--summary">
                  <span className="metric-card__label">
                    <Icon name="repo" />
                    当前远程地址
                  </span>
                  <strong>{inspection.remoteUrl || "尚未绑定"}</strong>
                </article>
              </div>
            ) : (
              <div className="empty-card">
                点击“检查本地状态”后，这里会展示目录是否存在、是否已经初始化 Git、是否绑定远程仓库以及当前分支。
              </div>
            )}
          </section>

          <section className="panel log-panel">
            <div className="panel__header">
              <SectionTitle label="执行日志" accent="neutral" icon="terminal" />
              <div className="log-panel__actions">
                <span className="panel-meta">
                  <Icon name="clock" />
                  {lastSyncAt ? `最近同步 ${lastSyncAt}` : "尚未同步"}
                </span>
                <button type="button" className="ghost-button ghost-button--compact">
                  自动滚动
                </button>
                <button type="button" className="ghost-button ghost-button--compact">
                  搜索日志
                </button>
                <button type="button" className="text-button text-button--danger" onClick={handleClearLogs}>
                  清空日志
                </button>
                <button type="button" className="ghost-button ghost-button--compact" onClick={() => void handleCopyLogs()}>
                  <Icon name="save" />
                  复制日志
                </button>
                <button type="button" className="ghost-button ghost-button--compact" onClick={() => void handleCopyLogs()}>
                  导出日志
                </button>
              </div>
            </div>

            <div className="terminal">
              <div className="terminal__toolbar" aria-hidden="true">
                <span className="terminal__dot terminal__dot--red" />
                <span className="terminal__dot terminal__dot--yellow" />
                <span className="terminal__dot terminal__dot--green" />
              </div>
              {logs.length === 0 ? (
                <div className="terminal__empty">
                  暂无日志输出。执行一次仓库检查或同步后，这里会展示完整的 Git 与部署过程。
                </div>
              ) : (
                logs.map((entry) => (
                  <div className="log-row" key={entry.id}>
                    <span className="log-row__time">[{entry.time}]</span>
                    <span className={`log-row__level log-row__level--${entry.level}`}>
                      {entry.level.toUpperCase()}
                    </span>
                    <pre className="log-row__message">{entry.message}</pre>
                  </div>
                ))
              )}
            </div>
          </section>

          <footer className="desktop-statusbar">
            <span>Git 2.48.1</span>
            <span>SSH Connected</span>
            <span>Deploy Ready</span>
            <span>Env production</span>
            <span>Last deploy 3 min ago</span>
            <strong>v1.3.0</strong>
          </footer>

        </main>
      </div>
    </div>
  );
}

export default App;
