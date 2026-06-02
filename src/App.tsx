import { FormEvent, useEffect, useMemo, useState } from "react";
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

function createProfileId() {
  return `profile-${Date.now()}`;
}

function normalizeProfile(profile: ProjectProfile): ProjectProfile {
  return {
    ...emptyProfile,
    ...profile,
    gitUserName: profile.gitUserName ?? "",
    gitUserEmail: profile.gitUserEmail ?? ""
  };
}

export default function App() {
  const [profiles, setProfiles] = useState<ProjectProfile[]>([emptyProfile]);
  const [selectedProfileId, setSelectedProfileId] = useState("default");
  const [form, setForm] = useState<ProjectProfile>(emptyProfile);
  const [commitMessage, setCommitMessage] = useState("chore: update project");
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [connection, setConnection] = useState<RepositoryConnectionReport | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? form,
    [profiles, selectedProfileId, form]
  );

  useEffect(() => {
    void loadState();
  }, []);

  async function loadState() {
    try {
      const state = await invoke<PersistedState>("load_state");
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
      setForm(current);
    } catch (error) {
      appendLog(`读取本地配置失败：${String(error)}`);
    }
  }

  async function saveState(nextProfiles: ProjectProfile[], nextSelectedId: string) {
    const payload: PersistedState = {
      profiles: nextProfiles,
      selectedProfileId: nextSelectedId
    };

    await invoke("save_state", { state: payload });
    setProfiles(nextProfiles);
    setSelectedProfileId(nextSelectedId);
  }

  function appendLog(message: string) {
    setLogs((current) => [message, ...current].slice(0, 120));
  }

  function updateForm<K extends keyof ProjectProfile>(key: K, value: ProjectProfile[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handlePickFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择需要同步到仓库的文件夹"
    });

    if (typeof selected === "string") {
      updateForm("folderPath", selected);
      setInspection(null);
    }
  }

  async function handleInspect() {
    if (!form.folderPath.trim()) {
      appendLog("请先选择本地文件夹。");
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
      appendLog(`已检查项目：${result.statusSummary}`);
    } catch (error) {
      appendLog(`检查失败：${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCheckConnection() {
    if (!form.repoUrl.trim()) {
      appendLog("请先输入 Git 仓库地址。");
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
      appendLog(`仓库连接检查：${result.summary}`);

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
      appendLog(`连接检查失败：${String(error)}`);
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
    appendLog(`已保存项目配置：${nextProfile.name}`);
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
  }

  async function runSync(withDeploy: boolean) {
    if (!form.repoUrl.trim()) {
      appendLog("请先输入 Git 仓库地址。");
      return;
    }

    if (!form.folderPath.trim()) {
      appendLog("请先选择本地文件夹。");
      return;
    }

    if (!commitMessage.trim()) {
      appendLog("请填写提交信息。");
      return;
    }

    setBusyAction(withDeploy ? "sync-deploy" : "sync");
    try {
      const result = await invoke<SyncReport>("run_repository_sync", {
        request: {
          folderPath: form.folderPath,
          repoUrl: form.repoUrl,
          branch: form.branch || connection?.defaultBranch || "main",
          commitMessage,
          deployCommand: withDeploy ? form.deployCommand : "",
          gitUserName: form.gitUserName,
          gitUserEmail: form.gitUserEmail
        }
      });
      setInspection(result.inspection);
      for (const step of result.steps) {
        appendLog(
          `${step.success ? "成功" : "失败"} | ${step.title}\n${step.command}\n${step.output}`
        );
      }
    } catch (error) {
      appendLog(`执行失败：${String(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  const busy = busyAction !== null;
  const remoteBranchChips = connection?.remoteBranches.slice(0, 8) ?? [];
  const effectiveBranch = form.branch.trim() || connection?.defaultBranch || "main";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__header">
          <div>
            <p className="eyebrow">Tauri Desktop</p>
            <h1>Repo Deployer</h1>
          </div>
          <button type="button" className="ghost-button" onClick={handleCreateProfile}>
            新建项目
          </button>
        </div>

        <div className="profile-list">
          {profiles
            .filter((profile) => profile.id !== "default")
            .map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={`profile-card ${
                  selectedProfile.id === profile.id ? "profile-card--active" : ""
                }`}
                onClick={() => void handleSelectProfile(profile.id)}
              >
                <strong>{profile.name}</strong>
                <span>{profile.repoUrl || "未配置仓库地址"}</span>
              </button>
            ))}

          {profiles.filter((profile) => profile.id !== "default").length === 0 ? (
            <div className="empty-card">先保存一个项目配置，之后就能一键复用。</div>
          ) : null}
        </div>
      </aside>

      <main className="content">
        <section className="hero">
          <div>
            <p className="eyebrow">自动初始化、绑定远程、校验连接、提交并推送</p>
            <h2>输入仓库地址，选择文件夹，工具会自动把本地目录接到远程仓库上</h2>
          </div>
          <div className="hero__actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void handleCheckConnection()}
            >
              {busyAction === "connect" ? "检测中..." : "检测仓库连接"}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void handleInspect()}>
              {busyAction === "inspect" ? "检查中..." : "检查本地状态"}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void runSync(true)}
            >
              {busyAction === "sync-deploy" ? "处理中..." : "一键提交并部署"}
            </button>
          </div>
        </section>

        <section className="panel-grid">
          <form className="panel" onSubmit={(event) => void handleSaveProfile(event)}>
            <div className="panel__header">
              <h3>项目配置</h3>
              <button type="submit" className="ghost-button">
                保存配置
              </button>
            </div>

            <label>
              项目名称
              <input
                value={form.name}
                onChange={(event) => updateForm("name", event.target.value)}
                placeholder="例如：官网发布工具"
              />
            </label>

            <label>
              Git 仓库地址
              <input
                value={form.repoUrl}
                onChange={(event) => updateForm("repoUrl", event.target.value)}
                placeholder="https://github.com/your-name/your-repo.git"
              />
            </label>

            <label>
              本地文件夹
              <div className="inline-field">
                <input
                  value={form.folderPath}
                  onChange={(event) => updateForm("folderPath", event.target.value)}
                  placeholder="选择要同步的本地目录"
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handlePickFolder()}
                >
                  选择
                </button>
              </div>
            </label>

            <label>
              推送分支
              <input
                value={form.branch}
                onChange={(event) => updateForm("branch", event.target.value)}
                placeholder={connection?.defaultBranch || "main"}
              />
            </label>

            <div className="chip-row">
              {remoteBranchChips.length > 0 ? (
                remoteBranchChips.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    className={`chip ${effectiveBranch === branch ? "chip--active" : ""}`}
                    onClick={() => updateForm("branch", branch)}
                  >
                    {branch}
                  </button>
                ))
              ) : (
                <span className="chip chip--muted">检测仓库连接后会显示远程分支</span>
              )}
            </div>

            <label>
              Git 用户名
              <input
                value={form.gitUserName}
                onChange={(event) => updateForm("gitUserName", event.target.value)}
                placeholder={connection?.gitUserName || "用于本仓库提交记录"}
              />
            </label>

            <label>
              Git 邮箱
              <input
                value={form.gitUserEmail}
                onChange={(event) => updateForm("gitUserEmail", event.target.value)}
                placeholder={connection?.gitUserEmail || "you@example.com"}
              />
            </label>

            <label>
              部署命令
              <input
                value={form.deployCommand}
                onChange={(event) => updateForm("deployCommand", event.target.value)}
                placeholder="可选，例如：npm run deploy"
              />
            </label>
          </form>

          <section className="panel">
            <div className="panel__header">
              <h3>执行操作</h3>
            </div>

            <label>
              提交信息
              <input
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="chore: update project"
              />
            </label>

            <div className="action-group">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void runSync(false)}
              >
                {busyAction === "sync" ? "处理中..." : "初始化并提交到仓库"}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void runSync(true)}
              >
                {busyAction === "sync-deploy" ? "处理中..." : "提交后执行部署"}
              </button>
            </div>

            <div className="tips">
              <p>自动流程</p>
              <ul>
                <li>目录没初始化 Git 时，会自动 `git init`。</li>
                <li>目录没绑定 `origin` 时，会自动绑定到你输入的仓库地址。</li>
                <li>首次提交前会自动确认仓库级 Git 用户名和邮箱。</li>
                <li>远程分支已存在时，会先尝试拉取并合并远程历史。</li>
              </ul>
            </div>

            <div className="tips tips--warm">
              <p>认证提醒</p>
              <ul>
                <li>HTTPS 仓库通常需要 Git 凭据或平台令牌。</li>
                <li>SSH 仓库需要本机已经配置好 SSH Key。</li>
                <li>如果远程已有大量历史或冲突文件，第一次同步仍可能需要你手动解决冲突。</li>
              </ul>
            </div>
          </section>
        </section>

        <section className="panel-grid">
          <section className="panel">
            <div className="panel__header">
              <h3>连接状态</h3>
            </div>

            {connection ? (
              <div className="status-grid">
                <article className="status-card">
                  <span>仓库地址</span>
                  <strong>{connection.repoUrlValid ? "有效" : "无效"}</strong>
                </article>
                <article className="status-card">
                  <span>远程可连接</span>
                  <strong>{connection.remoteReachable ? "可连接" : "不可连接"}</strong>
                </article>
                <article className="status-card">
                  <span>默认分支</span>
                  <strong>{connection.defaultBranch || "未识别"}</strong>
                </article>
                <article className="status-card">
                  <span>Git 身份</span>
                  <strong>
                    {connection.gitUserName && connection.gitUserEmail
                      ? "已检测到"
                      : "需要补充"}
                  </strong>
                </article>
                <article className="status-card status-card--wide">
                  <span>摘要</span>
                  <strong>{connection.summary}</strong>
                </article>
                <article className="status-card status-card--wide">
                  <span>认证提示</span>
                  <strong>{connection.authenticationHint || "当前没有检测到明显认证问题"}</strong>
                </article>
              </div>
            ) : (
              <div className="empty-card">
                先点“检测仓库连接”，工具会尝试识别默认分支、远程可达性和当前机器的 Git 身份。
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel__header">
              <h3>仓库状态</h3>
            </div>

            {inspection ? (
              <div className="status-grid">
                <article className="status-card">
                  <span>文件夹</span>
                  <strong>{inspection.folderExists ? "存在" : "不存在"}</strong>
                </article>
                <article className="status-card">
                  <span>Git 初始化</span>
                  <strong>{inspection.gitInitialized ? "已初始化" : "未初始化"}</strong>
                </article>
                <article className="status-card">
                  <span>Origin 远程</span>
                  <strong>{inspection.hasOriginRemote ? "已绑定" : "未绑定"}</strong>
                </article>
                <article className="status-card">
                  <span>当前分支</span>
                  <strong>{inspection.currentBranch || "未检测到"}</strong>
                </article>
                <article className="status-card status-card--wide">
                  <span>状态摘要</span>
                  <strong>{inspection.statusSummary}</strong>
                </article>
                <article className="status-card status-card--wide">
                  <span>远程地址</span>
                  <strong>{inspection.remoteUrl || "尚未绑定"}</strong>
                </article>
              </div>
            ) : (
              <div className="empty-card">点击“检查本地状态”后，这里会显示目录初始化和绑定情况。</div>
            )}
          </section>
        </section>

        <section className="panel">
          <div className="panel__header">
            <h3>执行日志</h3>
          </div>

          <div className="log-list">
            {logs.length === 0 ? (
              <div className="empty-card">还没有日志，执行一次检测或同步后会在这里展示完整输出。</div>
            ) : (
              logs.map((log, index) => (
                <pre className="log-item" key={`${index}-${log.slice(0, 24)}`}>
                  {log}
                </pre>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
