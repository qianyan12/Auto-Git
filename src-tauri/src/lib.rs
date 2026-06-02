use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectProfile {
    id: String,
    name: String,
    folder_path: String,
    repo_url: String,
    branch: String,
    deploy_command: String,
    git_user_name: Option<String>,
    git_user_email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    profiles: Vec<ProjectProfile>,
    selected_profile_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectRequest {
    folder_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRequest {
    folder_path: Option<String>,
    repo_url: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRequest {
    folder_path: String,
    repo_url: String,
    branch: String,
    commit_message: String,
    deploy_command: String,
    git_user_name: Option<String>,
    git_user_email: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInspection {
    folder_exists: bool,
    git_initialized: bool,
    has_origin_remote: bool,
    remote_url: Option<String>,
    current_branch: Option<String>,
    has_changes: bool,
    status_summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryConnectionReport {
    repo_url_valid: bool,
    remote_reachable: bool,
    default_branch: Option<String>,
    remote_branches: Vec<String>,
    git_user_name: Option<String>,
    git_user_email: Option<String>,
    authentication_hint: Option<String>,
    summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepResult {
    title: String,
    command: String,
    success: bool,
    output: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncReport {
    inspection: ProjectInspection,
    steps: Vec<StepResult>,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl CommandOutput {
    fn combined_output(&self) -> String {
        match (self.stdout.trim(), self.stderr.trim()) {
            ("", "") => "命令执行完成，没有输出。".to_string(),
            ("", stderr) => stderr.to_string(),
            (stdout, "") => stdout.to_string(),
            (stdout, stderr) => format!("{stdout}\n{stderr}"),
        }
    }
}

fn normalize_branch(branch: Option<&str>) -> String {
    let value = branch.unwrap_or("main").trim();
    if value.is_empty() {
        "main".to_string()
    } else {
        value.to_string()
    }
}

fn normalize_path(value: &str) -> PathBuf {
    PathBuf::from(value.trim())
}

fn validate_repo_url(repo_url: &str) -> bool {
    let url = repo_url.trim();
    (url.starts_with("https://") || url.starts_with("http://") || url.starts_with("git@"))
        && (url.ends_with(".git") || url.contains(':') || url.contains('/'))
}

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法获取配置目录：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    dir.push("projects.json");
    Ok(dir)
}

fn run_command(program: &str, args: &[&str], working_dir: &Path) -> Result<CommandOutput, String> {
    let mut command = Command::new(program);
    command.args(args).current_dir(working_dir);

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|error| format!("执行命令失败 {program}: {error}"))?;

    Ok(CommandOutput {
        success: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn run_shell(command_line: &str, working_dir: &Path) -> Result<CommandOutput, String> {
    #[cfg(target_os = "windows")]
    let output = {
        let mut command = Command::new("powershell");
        command
            .args(["-NoProfile", "-Command", command_line])
            .current_dir(working_dir)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("执行部署命令失败：{error}"))?
    };

    #[cfg(not(target_os = "windows"))]
    let output = {
        let mut command = Command::new("sh");
        command
            .args(["-lc", command_line])
            .current_dir(working_dir)
            .output()
            .map_err(|error| format!("执行部署命令失败：{error}"))?
    };

    Ok(CommandOutput {
        success: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn make_step(title: &str, command: String, output: CommandOutput) -> StepResult {
    StepResult {
        title: title.to_string(),
        command,
        success: output.success,
        output: output.combined_output(),
    }
}

fn git_config(path: Option<&Path>, key: &str) -> Option<String> {
    let result = if let Some(working_dir) = path {
        run_command("git", &["config", "--get", key], working_dir)
    } else {
        let current_dir = std::env::current_dir().ok()?;
        run_command("git", &["config", "--global", "--get", key], &current_dir)
    };

    result.ok().and_then(|output| {
        if output.success && !output.stdout.trim().is_empty() {
            Some(output.stdout.trim().to_string())
        } else {
            None
        }
    })
}

fn ensure_folder_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("目录不存在：{}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("目标不是文件夹：{}", path.display()));
    }

    Ok(())
}

fn is_git_repo(path: &Path) -> bool {
    run_command("git", &["rev-parse", "--is-inside-work-tree"], path)
        .map(|output| output.success)
        .unwrap_or(false)
}

fn current_branch(path: &Path) -> Option<String> {
    run_command("git", &["branch", "--show-current"], path)
        .ok()
        .and_then(|output| {
            if output.success && !output.stdout.trim().is_empty() {
                Some(output.stdout.trim().to_string())
            } else {
                None
            }
        })
}

fn current_remote(path: &Path) -> Option<String> {
    run_command("git", &["remote", "get-url", "origin"], path)
        .ok()
        .and_then(|output| {
            if output.success && !output.stdout.trim().is_empty() {
                Some(output.stdout.trim().to_string())
            } else {
                None
            }
        })
}

fn has_changes(path: &Path) -> bool {
    run_command("git", &["status", "--porcelain"], path)
        .map(|output| output.success && !output.stdout.trim().is_empty())
        .unwrap_or(false)
}

fn has_head_commit(path: &Path) -> bool {
    run_command("git", &["rev-parse", "--verify", "HEAD"], path)
        .map(|output| output.success)
        .unwrap_or(false)
}

fn remote_branch_exists(path: &Path, branch: &str) -> bool {
    run_command("git", &["ls-remote", "--heads", "origin", branch], path)
        .map(|output| output.success && !output.stdout.trim().is_empty())
        .unwrap_or(false)
}

fn parse_default_branch(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        if line.contains("refs/heads/") && line.contains("HEAD") {
            line.split("refs/heads/").nth(1).map(|part| part.trim().to_string())
        } else {
            None
        }
    })
}

fn parse_remote_branches(text: &str) -> Vec<String> {
    let mut branches = Vec::new();
    for line in text.lines() {
        if let Some(branch) = line.split("refs/heads/").nth(1) {
            let branch = branch.trim().to_string();
            if !branch.is_empty() && !branches.contains(&branch) {
                branches.push(branch);
            }
        }
    }
    branches
}

fn authentication_hint(repo_url: &str, stderr: &str) -> Option<String> {
    let lower = stderr.to_lowercase();
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("permission denied")
        || lower.contains("repository not found")
    {
        if repo_url.contains("github.com") {
            Some("GitHub HTTPS 仓库通常需要登录凭据或 Personal Access Token，建议先在本机完成 Git Credential Manager 登录。".to_string())
        } else if repo_url.starts_with("git@") {
            Some("当前仓库使用 SSH 地址，请确认本机已经配置可用的 SSH Key，并且远程平台已经添加对应公钥。".to_string())
        } else {
            Some("当前仓库需要认证，请先确认本机 Git 凭据已经可用，然后再重试连接。".to_string())
        }
    } else {
        None
    }
}

fn inspect_remote(repo_url: &str, working_dir: &Path) -> Result<RepositoryConnectionReport, String> {
    let git_user_name = git_config(Some(working_dir), "user.name").or_else(|| git_config(None, "user.name"));
    let git_user_email =
        git_config(Some(working_dir), "user.email").or_else(|| git_config(None, "user.email"));

    if !validate_repo_url(repo_url) {
        return Ok(RepositoryConnectionReport {
            repo_url_valid: false,
            remote_reachable: false,
            default_branch: None,
            remote_branches: Vec::new(),
            git_user_name,
            git_user_email,
            authentication_hint: Some("仓库地址格式看起来不完整，建议使用 https://...git 或 git@...:...git。".to_string()),
            summary: "仓库地址格式不正确".to_string(),
        });
    }

    let output = run_command("git", &["ls-remote", "--symref", repo_url, "HEAD"], working_dir)?;
    let default_branch = parse_default_branch(&output.stdout);
    let branches = parse_remote_branches(&output.stdout);
    let auth_hint = if output.success {
        None
    } else {
        authentication_hint(repo_url, &output.combined_output())
    };

    let summary = if output.success {
        if let Some(branch) = &default_branch {
            format!("仓库连接正常，默认分支是 {branch}")
        } else {
            "仓库连接正常，但没有识别出默认分支".to_string()
        }
    } else {
        "无法连接远程仓库，请检查地址和认证状态".to_string()
    };

    Ok(RepositoryConnectionReport {
        repo_url_valid: true,
        remote_reachable: output.success,
        default_branch,
        remote_branches: branches,
        git_user_name,
        git_user_email,
        authentication_hint: auth_hint,
        summary,
    })
}

fn inspect(path: &Path) -> ProjectInspection {
    let folder_exists = path.exists() && path.is_dir();
    let git_initialized = folder_exists && is_git_repo(path);
    let remote_url = if git_initialized { current_remote(path) } else { None };
    let current_branch = if git_initialized { current_branch(path) } else { None };
    let has_changes = if git_initialized { has_changes(path) } else { false };

    let status_summary = if !folder_exists {
        "本地文件夹不存在".to_string()
    } else if !git_initialized {
        "文件夹还没有初始化 Git，首次同步时会自动初始化并绑定远程仓库".to_string()
    } else if remote_url.is_none() {
        "Git 已初始化，但还没有配置 origin 远程仓库".to_string()
    } else if has_changes {
        "检测到本地变更，可以直接提交并推送".to_string()
    } else {
        "仓库已连接，当前没有未提交改动".to_string()
    };

    ProjectInspection {
        folder_exists,
        git_initialized,
        has_origin_remote: remote_url.is_some(),
        remote_url,
        current_branch,
        has_changes,
        status_summary,
    }
}

fn ensure_git_link(
    path: &Path,
    repo_url: &str,
    branch: &str,
    steps: &mut Vec<StepResult>,
) -> Result<(), String> {
    if !is_git_repo(path) {
        let init = run_command("git", &["init"], path)?;
        let init_success = init.success;
        steps.push(make_step("初始化 Git 仓库", "git init".to_string(), init));
        if !init_success {
            return Err("Git 初始化失败。".to_string());
        }
    }

    let remote = current_remote(path);
    match remote {
        Some(existing) if existing == repo_url => {}
        Some(_) => {
            let update = run_command("git", &["remote", "set-url", "origin", repo_url], path)?;
            let success = update.success;
            steps.push(make_step(
                "更新 origin 远程仓库",
                format!("git remote set-url origin {repo_url}"),
                update,
            ));
            if !success {
                return Err("更新 origin 远程仓库失败。".to_string());
            }
        }
        None => {
            let add = run_command("git", &["remote", "add", "origin", repo_url], path)?;
            let success = add.success;
            steps.push(make_step(
                "绑定 origin 远程仓库",
                format!("git remote add origin {repo_url}"),
                add,
            ));
            if !success {
                return Err("绑定 origin 远程仓库失败。".to_string());
            }
        }
    }

    let current = current_branch(path).unwrap_or_default();
    if current != branch {
        let rename = run_command("git", &["branch", "-M", branch], path)?;
        let success = rename.success;
        steps.push(make_step(
            "切换默认分支",
            format!("git branch -M {branch}"),
            rename,
        ));
        if !success {
            return Err("切换分支失败。".to_string());
        }
    }

    Ok(())
}

fn ensure_git_identity(
    path: &Path,
    git_user_name: Option<&str>,
    git_user_email: Option<&str>,
    steps: &mut Vec<StepResult>,
) -> Result<(), String> {
    let effective_name = git_user_name
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| git_config(Some(path), "user.name"))
        .or_else(|| git_config(None, "user.name"));

    let effective_email = git_user_email
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| git_config(Some(path), "user.email"))
        .or_else(|| git_config(None, "user.email"));

    let Some(name) = effective_name else {
        return Err("Git 用户名未配置。请在界面填写 Git 用户名，或先执行 git config --global user.name \"Your Name\"。".to_string());
    };

    let Some(email) = effective_email else {
        return Err("Git 邮箱未配置。请在界面填写 Git 邮箱，或先执行 git config --global user.email \"you@example.com\"。".to_string());
    };

    let set_name = run_command("git", &["config", "user.name", &name], path)?;
    let set_name_success = set_name.success;
    steps.push(make_step(
        "设置仓库 Git 用户名",
        format!("git config user.name \"{name}\""),
        set_name,
    ));
    if !set_name_success {
        return Err("设置仓库 Git 用户名失败。".to_string());
    }

    let set_email = run_command("git", &["config", "user.email", &email], path)?;
    let set_email_success = set_email.success;
    steps.push(make_step(
        "设置仓库 Git 邮箱",
        format!("git config user.email \"{email}\""),
        set_email,
    ));
    if !set_email_success {
        return Err("设置仓库 Git 邮箱失败。".to_string());
    }

    Ok(())
}

fn commit_and_push(
    path: &Path,
    commit_message: &str,
    branch: &str,
    steps: &mut Vec<StepResult>,
) -> Result<(), String> {
    let add = run_command("git", &["add", "-A"], path)?;
    let add_success = add.success;
    steps.push(make_step("暂存所有改动", "git add -A".to_string(), add));
    if !add_success {
        return Err("暂存文件失败。".to_string());
    }

    let staged = run_command("git", &["diff", "--cached", "--quiet"], path)?;
    if staged.exit_code == Some(0) {
        if has_head_commit(path) {
            steps.push(StepResult {
                title: "检查是否存在待提交改动".to_string(),
                command: "git diff --cached --quiet".to_string(),
                success: true,
                output: "没有检测到新的文件改动，本次跳过 commit。".to_string(),
            });
        } else {
            let empty_commit =
                run_command("git", &["commit", "--allow-empty", "-m", commit_message], path)?;
            let success = empty_commit.success;
            steps.push(make_step(
                "创建初始化提交",
                format!("git commit --allow-empty -m \"{commit_message}\""),
                empty_commit,
            ));
            if !success {
                return Err("初始化提交失败。".to_string());
            }
        }
    } else {
        let commit = run_command("git", &["commit", "-m", commit_message], path)?;
        let success = commit.success;
        steps.push(make_step(
            "创建提交记录",
            format!("git commit -m \"{commit_message}\""),
            commit,
        ));
        if !success {
            return Err("提交改动失败。".to_string());
        }
    }

    if remote_branch_exists(path, branch) {
        let pull = run_command(
            "git",
            &["pull", "origin", branch, "--no-rebase", "--allow-unrelated-histories"],
            path,
        )?;
        let success = pull.success;
        steps.push(make_step(
            "合并远程分支更新",
            format!("git pull origin {branch} --no-rebase --allow-unrelated-histories"),
            pull,
        ));
        if !success {
            return Err("自动合并远程分支失败，请先手动解决冲突后再重试。".to_string());
        }
    }

    let push = run_command("git", &["push", "-u", "origin", branch], path)?;
    let success = push.success;
    steps.push(make_step(
        "推送到远程仓库",
        format!("git push -u origin {branch}"),
        push,
    ));
    if !success {
        return Err(
            "推送失败，可能是远程仓库已有历史记录需要先手动处理，或当前凭据没有推送权限。"
                .to_string(),
        );
    }

    Ok(())
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<PersistedState, String> {
    let file = state_file(&app)?;
    if !file.exists() {
        return Ok(PersistedState::default());
    }

    let text = fs::read_to_string(file).map_err(|error| format!("读取配置失败：{error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("解析配置失败：{error}"))
}

#[tauri::command]
fn save_state(app: AppHandle, state: PersistedState) -> Result<(), String> {
    let file = state_file(&app)?;
    let text =
        serde_json::to_string_pretty(&state).map_err(|error| format!("写入配置失败：{error}"))?;
    fs::write(file, text).map_err(|error| format!("保存配置失败：{error}"))
}

#[tauri::command]
fn inspect_project(request: InspectRequest) -> Result<ProjectInspection, String> {
    let folder = normalize_path(&request.folder_path);
    Ok(inspect(&folder))
}

#[tauri::command]
fn check_repository_connection(request: ConnectionRequest) -> Result<RepositoryConnectionReport, String> {
    let working_dir = request
        .folder_path
        .as_deref()
        .map(normalize_path)
        .filter(|path| path.exists() && path.is_dir())
        .unwrap_or(std::env::current_dir().map_err(|error| format!("无法读取当前目录：{error}"))?);

    inspect_remote(request.repo_url.trim(), &working_dir)
}

#[tauri::command]
fn run_repository_sync(request: SyncRequest) -> Result<SyncReport, String> {
    let folder = normalize_path(&request.folder_path);
    ensure_folder_exists(&folder)?;

    let repo_url = request.repo_url.trim();
    if repo_url.is_empty() {
        return Err("仓库地址不能为空。".to_string());
    }

    let commit_message = request.commit_message.trim();
    if commit_message.is_empty() {
        return Err("提交信息不能为空。".to_string());
    }

    let branch = normalize_branch(Some(&request.branch));
    let mut steps = Vec::new();

    ensure_git_link(&folder, repo_url, &branch, &mut steps)?;
    ensure_git_identity(
        &folder,
        request.git_user_name.as_deref(),
        request.git_user_email.as_deref(),
        &mut steps,
    )?;
    commit_and_push(&folder, commit_message, &branch, &mut steps)?;

    let deploy_command = request.deploy_command.trim();
    if !deploy_command.is_empty() {
        let deploy = run_shell(deploy_command, &folder)?;
        let success = deploy.success;
        steps.push(make_step(
            "执行部署命令",
            deploy_command.to_string(),
            deploy,
        ));
        if !success {
            return Err("部署命令执行失败。".to_string());
        }
    }

    Ok(SyncReport {
        inspection: inspect(&folder),
        steps,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            inspect_project,
            check_repository_connection,
            run_repository_sync
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
