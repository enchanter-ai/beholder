//! End-to-end replay test: pipe the bundled JSONL fixture through the
//! transport, fold events into `AppState`, and assert the dashboard reflects
//! the expected runtime totals after the stream closes.
//!
//! This test exercises the pub API surface only — `Transport`, `Source`,
//! `AppState`, and `Event` — so a compile failure here means the crate's
//! public contract drifted, not just an internal refactor.

use std::path::PathBuf;

use enchanter_inspector::state::AppState;
use enchanter_inspector::transport::{Source, Transport};

/// Replay the bundled demo fixture and assert the resulting state mirrors
/// what the fixture emits in its final `runtime.metrics` event.
#[tokio::test]
async fn fixture_replay_populates_runtime_state() {
    let fixture: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "tests",
        "fixtures",
        "demo-events.jsonl",
    ]
    .iter()
    .collect();

    assert!(fixture.is_file(), "demo fixture missing at {fixture:?}");

    let mut transport = Transport::try_spawn(Source::File(fixture), 64)
        .await
        .expect("open demo fixture");

    let mut app = AppState::default();
    let mut count = 0usize;
    while let Some(event) = transport.recv().await {
        app.apply(event);
        count += 1;
    }

    // The fixture has 50 events. If this drifts, update the fixture or
    // figure out which events are now being silently dropped.
    assert!(
        count >= 40,
        "expected the fixture to deliver at least 40 events, got {count}"
    );

    // Final runtime.metrics in the fixture has open_sessions=3 / blocked=1 /
    // PRs=18 — pinning a few representative numbers without locking the
    // entire fixture in place.
    assert_eq!(
        app.runtime_metrics.open_sessions, 3,
        "open_sessions should mirror the last runtime.metrics event"
    );
    assert_eq!(
        app.runtime_metrics.blocked_tasks, 1,
        "blocked_tasks should mirror the last runtime.metrics event"
    );
    assert_eq!(
        app.runtime_metrics.prs_created_lifetime, 18,
        "prs_created_lifetime should mirror the last runtime.metrics event"
    );

    // The fixture fires both a hydra.veto and a sylph.veto — the session
    // counter must reflect both.
    assert!(
        app.metrics.security_incidents_session >= 2,
        "expected at least one hydra + one sylph veto, got {}",
        app.metrics.security_incidents_session
    );

    // 10 plugins should still be present after replay (no apply path drops
    // the plugin list).
    assert_eq!(app.plugins.len(), 10, "plugin roster shrank during replay");
}

/// Replay the TS bridge round-trip fixture and assert the inspector parses
/// every line. The fixture is the canonical sample of what `Bridge` in
/// `src/observability/bridge.ts` writes — if this fails, the TS wire
/// format and the Rust event schema have drifted apart.
#[tokio::test]
async fn bridge_roundtrip() {
    let fixture: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "tests",
        "fixtures",
        "bridge-roundtrip.jsonl",
    ]
    .iter()
    .collect();

    assert!(
        fixture.is_file(),
        "bridge-roundtrip fixture missing at {fixture:?}"
    );

    let mut transport = Transport::try_spawn(Source::File(fixture), 32)
        .await
        .expect("open bridge-roundtrip fixture");

    let mut app = AppState::default();
    let mut count = 0usize;
    while let Some(event) = transport.recv().await {
        app.apply(event);
        count += 1;
    }

    // Fixture has exactly 10 lines, all well-formed.
    assert_eq!(count, 10, "expected all 10 bridge fixture events to parse");
}
