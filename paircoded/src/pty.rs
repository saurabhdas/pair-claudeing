//! PTY (pseudo-terminal) spawning and management.
//!
//! Uses portable-pty for cross-platform support (Unix PTY and Windows ConPTY).

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info};

/// Default terminal size
pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;

/// Handle to a spawned PTY process
pub struct PtyHandle {
    /// The master side of the PTY for I/O
    master: Box<dyn MasterPty + Send>,
    /// Writer for sending input to PTY (taken once from master)
    writer: Box<dyn Write + Send>,
    /// Child process
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtyHandle {
    /// Spawn a new PTY with the given shell command
    pub fn spawn(shell: &str, args: &[&str]) -> Result<Self> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")?;

        let mut cmd = CommandBuilder::new(shell);
        for arg in args {
            cmd.arg(*arg);
        }

        // Set working directory to current directory
        if let Ok(cwd) = std::env::current_dir() {
            cmd.cwd(cwd);
        }

        // Inherit environment
        for (key, value) in std::env::vars() {
            cmd.env(key, value);
        }

        // Set TERM if not already set
        if std::env::var("TERM").is_err() {
            cmd.env("TERM", "xterm-256color");
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("failed to spawn command")?;

        // Take the writer once and store it
        let writer = pair
            .master
            .take_writer()
            .context("failed to take PTY writer")?;

        info!(shell = %shell, "spawned PTY process");

        Ok(PtyHandle {
            master: pair.master,
            writer,
            child,
        })
    }

    /// Resize the PTY
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize PTY")?;
        debug!(cols, rows, "resized PTY");
        Ok(())
    }

    /// Write data to the PTY (input from remote)
    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    /// Try to get the reader for PTY output
    pub fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>> {
        self.master
            .try_clone_reader()
            .context("failed to clone PTY reader")
    }

    /// Check if the child process has exited
    pub fn try_wait(&mut self) -> Result<Option<portable_pty::ExitStatus>> {
        self.child
            .try_wait()
            .context("failed to check child status")
    }

    /// Wait for the child process to exit
    #[allow(dead_code)]
    pub fn wait(&mut self) -> Result<portable_pty::ExitStatus> {
        self.child.wait().context("failed to wait for child")
    }

    /// Kill the child process
    #[allow(dead_code)]
    pub fn kill(&mut self) -> Result<()> {
        self.child.kill().context("failed to kill child")
    }
}

/// Async wrapper around PTY operations
pub struct AsyncPty {
    handle: Arc<Mutex<PtyHandle>>,
    /// Pre-cloned reader, wrapped in Option so we can take it once
    reader: Arc<Mutex<Option<Box<dyn Read + Send>>>>,
}

impl AsyncPty {
    /// Create a new async PTY wrapper
    ///
    /// This clones the PTY reader immediately to avoid blocking in async context later.
    pub fn new(handle: PtyHandle) -> Result<Self> {
        // Clone the reader now, before entering async context
        let reader = handle.try_clone_reader()?;

        Ok(AsyncPty {
            handle: Arc::new(Mutex::new(handle)),
            reader: Arc::new(Mutex::new(Some(reader))),
        })
    }

    /// Resize the PTY
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let handle = self.handle.lock().await;
        handle.resize(cols, rows)
    }

    /// Write data to the PTY
    pub async fn write(&self, data: &[u8]) -> Result<()> {
        let mut handle = self.handle.lock().await;
        handle.write(data)
    }

    /// Check if the child has exited
    pub async fn try_wait(&self) -> Result<Option<portable_pty::ExitStatus>> {
        let mut handle = self.handle.lock().await;
        handle.try_wait()
    }

    /// Kill the child process
    #[allow(dead_code)]
    pub async fn kill(&self) -> Result<()> {
        let mut handle = self.handle.lock().await;
        handle.kill()
    }

    /// Start reading from PTY and send output to a channel
    /// Returns a receiver for PTY output data
    ///
    /// This can only be called once per AsyncPty instance.
    pub async fn start_reader(&self) -> Result<mpsc::Receiver<Vec<u8>>> {
        let (tx, rx) = mpsc::channel(64);

        // Take the pre-cloned reader
        let reader = {
            let mut reader_guard = self.reader.lock().await;
            reader_guard.take().context("PTY reader already started")?
        };

        // Spawn a blocking task to read from PTY
        tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        debug!("PTY reader got EOF");
                        break;
                    }
                    Ok(n) => {
                        let data = buf[..n].to_vec();
                        if tx.blocking_send(data).is_err() {
                            debug!("PTY reader channel closed");
                            break;
                        }
                    }
                    Err(e) => {
                        if e.kind() != std::io::ErrorKind::WouldBlock {
                            error!(error = %e, "PTY read error");
                            break;
                        }
                    }
                }
            }

            info!("PTY reader task finished");
        });

        Ok(rx)
    }
}

/// Get exit code from portable_pty ExitStatus
#[allow(dead_code)]
pub fn exit_code(status: &portable_pty::ExitStatus) -> i32 {
    if status.success() {
        0
    } else {
        // Try to extract the exit code, default to 1 for failure
        1
    }
}
