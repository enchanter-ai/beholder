//! enchanter-inspector — terminal cockpit for the Enchanter AI runtime.
//!
//! Module ownership:
//! - `event`     — wire types for the JSONL event stream (owned elsewhere)
//! - `transport` — stdin / file / socket source adapters (owned elsewhere)
//! - `state`     — application state, plugin state, derived views (owned elsewhere)
//! - `app`       — main loop, input, terminal lifecycle (owned elsewhere)
//! - `ui`        — shared theme, widgets, layout primitives
//! - `views`     — per-view rendering (overview, plugins, events, ...)

pub mod event;
pub mod transport;
pub mod state;
pub mod app;
pub mod control;
pub mod demo;
pub mod ui;
pub mod views;

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// Where the inspector pulls events from.
#[derive(Debug, Clone)]
pub enum Source {
    /// Read newline-delimited JSON from stdin (default; pairs with
    /// `enchanter-runtime | enchanter-inspector`).
    Stdin,
    /// Replay a previously captured JSONL file.
    File(PathBuf),
    /// Connect to a runtime socket (TCP `host:port` or unix path) READ-ONLY.
    /// Inbound events only; the inspector cannot send commands back.
    Socket(String),
    /// v0.5 #4 — connect bidirectionally to a runtime socket. Reads inbound
    /// events AND writes outbound `approval.response` commands on the same
    /// socket. Opt-in via `--control-socket`; the read-only `--socket`
    /// remains the default for back-compatibility.
    SocketControl(String),
}

/// Resolved runtime configuration handed to `app::run`.
#[derive(Debug, Clone)]
pub struct Config {
    pub source: Source,
}

#[derive(Parser, Debug)]
#[command(
    name = "enchanter",
    version,
    about = "Terminal cockpit for the Enchanter AI runtime",
    long_about = "Terminal is the cockpit. Web/Electron is the studio."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Open the inspector against a live or recorded event stream (default).
    Inspect(InspectArgs),
}

#[derive(Args, Debug, Default)]
struct InspectArgs {
    /// Replay events from a JSONL file instead of stdin.
    #[arg(long, value_name = "JSONL_FILE", conflicts_with_all = ["socket", "control_socket"])]
    from: Option<PathBuf>,

    /// Connect READ-ONLY to a runtime socket (e.g. `127.0.0.1:7878`). The
    /// inspector receives events but cannot send commands back.
    #[arg(long, value_name = "ADDR", conflicts_with = "control_socket")]
    socket: Option<String>,

    /// v0.5 #4 — connect bidirectionally to a runtime socket. Reads events
    /// AND sends approve/veto decisions on the same socket. Opt-in.
    #[arg(long, value_name = "ADDR")]
    control_socket: Option<String>,
}

impl InspectArgs {
    fn into_config(self) -> Config {
        let source = match (self.from, self.socket, self.control_socket) {
            (Some(path), _, _) => Source::File(path),
            (None, _, Some(addr)) => Source::SocketControl(addr),
            (None, Some(addr), None) => Source::Socket(addr),
            (None, None, None) => Source::Stdin,
        };
        Config { source }
    }
}

/// Library entry point invoked from `main`.
///
/// Builds a multi-thread tokio runtime and dispatches into `app::run`.
pub fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = match cli.command.unwrap_or(Command::Inspect(InspectArgs::default())) {
        Command::Inspect(args) => args.into_config(),
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    runtime.block_on(async move { app::run(config).await })
}
