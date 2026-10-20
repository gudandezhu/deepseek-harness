//! 取消正在进行的预装插件安装。
//!
//! 跨平台结束由本应用拉起的 `dsh plugin` 安装进程树：
//! - Unix（macOS/Linux）：进程以独立进程组启动（`process_group(0)`，见
//!   `process.rs`），此处对注册的 PID 强制结束整组（含 pnpm / git 等子进程）；
//! - Windows：对创建时记录的精确 PID 执行 `taskkill /T /F`，不再按命令行模糊
//!   枚举，避免误杀其它插件操作或用户进程。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::process::{ActivePluginProcess, ProcessOwner};

/// 前端监听“安装已取消”事件名
const PREINSTALL_CANCEL_EVENT: &str = "preinstall-cancelled";

/// 取消事件载荷（预留扩展字段）
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallCancelPayload {}

/// 强制结束当前插件安装进程树。返回是否找到并成功结束了活动进程。
pub(crate) async fn terminate_active_install() -> bool {
    let active = super::process::active_plugin_processes();
    if active.is_empty() {
        log::debug!("plugin install cancel: no active install process");
        return false;
    }
    tauri::async_runtime::spawn_blocking(move || terminate_pid_trees(active))
        .await
        .unwrap_or_else(|e| {
            log::warn!("plugin install cancel task failed: {e}");
            false
        })
}

/// 退出前同步回收所有进行中的插件安装进程树（`RunEvent::Exit` 调用）。
///
/// 安装子进程以独立进程组启动（`process_group(0)`），父进程退出**不会**连带结束
/// 它们；而取消只由前端命令（`cancel_plugin_processes` / `cancel_internal_plugins`）
/// 触发。用户在安装看起来毫无进展时关窗，留下的孤儿会继续占着档案与 pnpm store，
/// 下一次启动的安装便排在它后面——表现为永久卡在「Loading internal plugins…」且
/// 后端日志一行输出都没有。回收必须在退出路径上显式做。
pub(crate) fn terminate_active_installs_blocking() -> bool {
    let active = super::process::active_plugin_processes();
    if active.is_empty() {
        return false;
    }
    log::warn!(
        "plugin install cancel: reaping {} in-flight install process(es) before exit",
        active.len()
    );
    terminate_pid_trees(active)
}

/// 逐个结束进程树；单个失败不影响其余，返回是否全部成功。
fn terminate_pid_trees(active: Vec<(ProcessOwner, ActivePluginProcess)>) -> bool {
    let mut all_terminated = true;
    for (owner, process) in active {
        let terminate = if process.child.is_some() {
            terminate_probe_tree
        } else {
            terminate_pid_tree
        };
        all_terminated &= terminate_registered_process(owner, &process, terminate);
    }
    all_terminated
}

pub(crate) fn terminate_registered_process(
    owner: ProcessOwner,
    process: &ActivePluginProcess,
    terminate: impl FnOnce(u32) -> bool,
) -> bool {
    let Some(child) = &process.child else {
        return terminate(process.pid);
    };
    let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
    let terminated = match child.try_wait() {
        Ok(Some(_)) => return true,
        Ok(None) => {
            let tree_killed = terminate(process.pid);
            let _ = child.kill();
            tree_killed
        }
        Err(error) => {
            log::warn!(
                "registered plugin process wait failed for pid {}: {error}",
                process.pid
            );
            false
        }
    };
    if !terminated {
        super::process::mark_process_cleanup_failed(
            owner,
            "PNPM_PROBE_TREE_CLEANUP_FAILED: pnpm version probe process tree termination was not confirmed".to_string(),
        );
    }
    terminated
}

pub(crate) async fn terminate_owned_install(owner: ProcessOwner) -> bool {
    let Some(process) = super::process::active_plugin_process(owner) else {
        return false;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let terminate = if process.child.is_some() {
            terminate_probe_tree
        } else {
            terminate_pid_tree
        };
        terminate_registered_process(owner, &process, terminate)
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("owned plugin install cancel task failed: {e}");
        false
    })
}

#[cfg(windows)]
pub(crate) fn terminate_pid_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000);
    let ok = command
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    log::warn!("plugin install cancel: taskkill pid {pid} success={ok}");
    ok
}

#[cfg(not(windows))]
pub(crate) fn terminate_pid_tree(pid: u32) -> bool {
    // `--` 防止负 PID 被解析为信号；KILL 保证忽略 TERM 的 pnpm/git 后代也退出。
    let group = std::process::Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    let direct = group
        || std::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    log::warn!("plugin install cancel: kill process group {pid} success={direct}");
    direct
}

#[cfg(windows)]
pub(crate) use terminate_pid_tree as terminate_probe_tree;

#[cfg(not(windows))]
pub(crate) fn terminate_probe_tree(pid: u32) -> bool {
    unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) == 0 }
}

/// 取消正在进行的预装插件安装。
pub async fn cancel(app_handle: &AppHandle) {
    terminate_active_install().await;

    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit(PREINSTALL_CANCEL_EVENT, PreinstallCancelPayload {});
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn spawn_hung_child() -> std::process::Child {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("cmd.exe");
        command
            .args(["/C", "ping -n 60 127.0.0.1 >NUL"])
            .creation_flags(0x08000000);
        command.spawn().unwrap()
    }

    #[cfg(unix)]
    fn spawn_hung_child() -> std::process::Child {
        use std::os::unix::process::CommandExt;
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 60"]).process_group(0);
        command.spawn().unwrap()
    }

    #[tokio::test]
    async fn stale_probe_snapshot_never_kills_after_the_child_is_reaped() {
        use std::sync::{Arc, Mutex};

        let _test_guard = super::super::process::TEST_PROCESS_LOCK.lock().await;
        #[cfg(windows)]
        let child = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd.exe")
                .creation_flags(0x08000000)
                .args(["/D", "/C", "exit 0"])
                .spawn()
                .unwrap()
        };
        #[cfg(unix)]
        let child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let child = Arc::new(Mutex::new(child));
        let owner = super::super::process::new_process_owner();
        let guard = super::super::process::PidGuard::set_child(owner, &child);
        let snapshot = super::super::process::active_plugin_processes()
            .into_iter()
            .find(|(active_owner, _)| *active_owner == owner)
            .unwrap()
            .1;
        assert!(child.lock().unwrap().wait().unwrap().success());
        drop(guard);
        let mut killed = false;
        assert!(terminate_registered_process(owner, &snapshot, |_| {
            killed = true;
            true
        }));
        assert!(
            !killed,
            "a copied probe record must preserve the reaped child identity"
        );
        assert_eq!(super::super::process::active_plugin_pid(owner), None);
    }

    #[tokio::test]
    async fn failed_probe_cancel_keeps_tree_failure_after_root_exit() {
        use std::sync::{Arc, Mutex};

        let _test_guard = super::super::process::TEST_PROCESS_LOCK.lock().await;
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new("cmd.exe");
            command
                .creation_flags(0x08000000)
                .args(["/D", "/C", "set /p token="]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            use std::os::unix::process::CommandExt;
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "read -r token"]).process_group(0);
            command
        };
        let child = Arc::new(Mutex::new(
            command.stdin(std::process::Stdio::piped()).spawn().unwrap(),
        ));
        let owner = super::super::process::new_process_owner();
        let guard = super::super::process::PidGuard::set_child(owner, &child);
        let process = super::super::process::active_plugin_process(owner).unwrap();
        let terminated = terminate_registered_process(owner, &process, |_| false);
        {
            let mut child = child.lock().unwrap();
            let _ = child.kill();
            child.wait().unwrap();
        }
        let failure = super::super::process::acquire_process_lock().await;
        drop(guard);
        super::super::process::clear_process_cleanup_failed(owner);
        assert!(!terminated);
        assert!(
            matches!(failure, Err(reason) if reason.starts_with("PNPM_PROBE_TREE_CLEANUP_FAILED:"))
        );
    }

    #[tokio::test]
    async fn forced_cancel_kills_hung_child_and_releases_pid_slot() {
        let _test_guard = super::super::process::TEST_PROCESS_LOCK.lock().await;
        let mut child = spawn_hung_child();
        let pid = child.id();
        let owner = super::super::process::new_process_owner();
        let guard = super::super::process::PidGuard::set(owner, pid);

        assert_eq!(super::super::process::active_plugin_pid(owner), Some(pid));
        assert!(terminate_owned_install(owner).await);

        let exited = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if child.try_wait().unwrap().is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await;
        assert!(exited.is_ok(), "hung plugin child should be force-killed");

        drop(guard);
        assert_eq!(super::super::process::active_plugin_pid(owner), None);
    }
}
