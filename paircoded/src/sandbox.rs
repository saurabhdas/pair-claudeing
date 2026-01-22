//! Sandbox support for restricting terminal filesystem access.
//!
//! - Linux: Uses bubblewrap (bwrap) for namespace-based isolation
//! - macOS: Uses sandbox-exec with a custom Seatbelt profile
//!
//! Provides filesystem isolation to prevent the terminal from accessing
//! directories outside the specified working directory.

use anyhow::{Context, Result};
#[cfg(target_os = "linux")]
use anyhow::anyhow;
use std::path::Path;
use tracing::info;

#[cfg(target_os = "linux")]
use std::process::Command;

#[cfg(target_os = "linux")]
/// Check if bubblewrap is available on the system
pub fn is_sandbox_available() -> bool {
    Command::new("bwrap")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
/// Check if sandbox-exec is available (always true on macOS)
pub fn is_sandbox_available() -> bool {
    // sandbox-exec is built into macOS
    Path::new("/usr/bin/sandbox-exec").exists()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
/// Sandbox not available on other platforms
pub fn is_sandbox_available() -> bool {
    false
}

/// Build sandbox command arguments for the current platform.
///
/// Returns (command, args) tuple to execute the sandboxed shell.
pub fn build_sandbox_args(
    shell: &str,
    shell_args: &[&str],
    working_dir: &Path,
) -> Result<(String, Vec<String>)> {
    #[cfg(target_os = "linux")]
    {
        build_bwrap_args(shell, shell_args, working_dir)
    }

    #[cfg(target_os = "macos")]
    {
        build_sandbox_exec_args(shell, shell_args, working_dir)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err(anyhow!("Sandboxing is not supported on this platform"))
    }
}

#[cfg(target_os = "linux")]
/// Build the bwrap command arguments for sandboxing a shell.
///
/// The sandbox:
/// - Bind-mounts essential system directories read-only (/usr, /lib, /bin, etc.)
/// - Bind-mounts the working directory read-write
/// - Sets up /proc, /dev, /tmp
/// - Unshares all namespaces except network
/// - Dies when parent process dies
fn build_bwrap_args(
    shell: &str,
    shell_args: &[&str],
    working_dir: &Path,
) -> Result<(String, Vec<String>)> {
    if !is_sandbox_available() {
        return Err(anyhow!(
            "bubblewrap (bwrap) is not installed. Install it with:\n\
             - Debian/Ubuntu: sudo apt install bubblewrap\n\
             - Fedora: sudo dnf install bubblewrap\n\
             - Arch: sudo pacman -S bubblewrap"
        ));
    }

    let working_dir_str = working_dir
        .to_str()
        .context("working directory path is not valid UTF-8")?;

    let mut args: Vec<String> = vec![
        // Mount essential system directories read-only
        "--ro-bind".into(), "/usr".into(), "/usr".into(),
        "--ro-bind".into(), "/bin".into(), "/bin".into(),
        "--ro-bind".into(), "/sbin".into(), "/sbin".into(),
        "--ro-bind".into(), "/etc".into(), "/etc".into(),
    ];

    // /lib and /lib64 may or may not exist depending on distro
    if Path::new("/lib").exists() {
        args.extend(["--ro-bind".into(), "/lib".into(), "/lib".into()]);
    }
    if Path::new("/lib64").exists() {
        args.extend(["--ro-bind".into(), "/lib64".into(), "/lib64".into()]);
    }

    // Some systems have /lib32
    if Path::new("/lib32").exists() {
        args.extend(["--ro-bind".into(), "/lib32".into(), "/lib32".into()]);
    }

    // Mount special filesystems
    args.extend([
        "--proc".into(), "/proc".into(),
        "--dev".into(), "/dev".into(),
        "--tmpfs".into(), "/tmp".into(),
    ]);

    // Bind the working directory read-write
    args.extend([
        "--bind".into(),
        working_dir_str.into(),
        working_dir_str.into(),
    ]);

    // Set working directory inside sandbox
    args.extend(["--chdir".into(), working_dir_str.into()]);

    // Unshare namespaces but keep network (for git, curl, etc.)
    args.extend([
        "--unshare-user".into(),
        "--unshare-pid".into(),
        "--unshare-ipc".into(),
        "--unshare-uts".into(),
        "--unshare-cgroup".into(),
    ]);

    // Die when parent dies (prevents orphaned sandboxes)
    args.push("--die-with-parent".into());

    // Add the shell command
    args.push(shell.into());

    // Add shell arguments
    for arg in shell_args {
        args.push((*arg).into());
    }

    info!(
        working_dir = %working_dir_str,
        shell = %shell,
        "sandboxing with bubblewrap"
    );

    Ok(("bwrap".into(), args))
}

#[cfg(target_os = "macos")]
/// Build the sandbox-exec command arguments for sandboxing a shell.
///
/// The sandbox profile:
/// - Allows most operations by default
/// - Denies file access to /Users (except the working directory)
/// - This prevents access to other user directories while allowing system access
fn build_sandbox_exec_args(
    shell: &str,
    shell_args: &[&str],
    working_dir: &Path,
) -> Result<(String, Vec<String>)> {
    let working_dir_str = working_dir
        .to_str()
        .context("working directory path is not valid UTF-8")?;

    // Build the Seatbelt sandbox profile
    // Strategy: allow everything by default, deny /Users, then re-allow working directory
    let profile = format!(
        r#"(version 1)
(allow default)

;; Deny access to all user home directories
(deny file-read* file-write*
    (subpath "/Users")
)

;; Re-allow access to the specific working directory
(allow file-read* file-write*
    (subpath "{working_dir}")
)
"#,
        working_dir = working_dir_str
    );

    let args = vec![
        "-p".into(),
        profile,
        shell.into(),
    ];

    // Add shell arguments
    let mut args = args;
    for arg in shell_args {
        args.push((*arg).into());
    }

    info!(
        working_dir = %working_dir_str,
        shell = %shell,
        "sandboxing with sandbox-exec"
    );

    Ok(("sandbox-exec".into(), args))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_sandbox_available() {
        // This should return true on supported platforms
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            // May or may not be available depending on system
            let _ = is_sandbox_available();
        }

        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            assert!(!is_sandbox_available());
        }
    }

    #[test]
    fn test_build_sandbox_args() {
        let working_dir = PathBuf::from("/home/user/project");

        if is_sandbox_available() {
            let result = build_sandbox_args("/bin/bash", &[], &working_dir);
            assert!(result.is_ok());
            let (cmd, _args) = result.unwrap();

            #[cfg(target_os = "linux")]
            assert_eq!(cmd, "bwrap");

            #[cfg(target_os = "macos")]
            assert_eq!(cmd, "sandbox-exec");
        }
    }
}
