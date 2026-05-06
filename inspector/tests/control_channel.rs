//! Integration test — bidirectional control channel (v0.5 #4).
//!
//! Stands up a localhost TCP echo-pair: a server side that simulates the
//! runtime (writes a `request.approval` JSONL line and reads back any
//! response), and a client side that opens a bidirectional `Source::SocketControl`
//! transport, parses the approval, and replies with a serialized
//! `ControlCommand::ApprovalResponse`.

use enchanter_inspector::control::{ApprovalDecision, ControlCommand};
use enchanter_inspector::event::Event;
use enchanter_inspector::transport::{Source, Transport};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// End-to-end: server writes a request.approval line, the inspector's transport
/// parses it via the JSONL reader, app code crafts an approval.response, and
/// the server reads the matching JSON back from its connection.
#[tokio::test]
async fn approval_round_trip_over_socket_control() {
    // Bind a localhost listener on an ephemeral port.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr").to_string();

    // Server task: accept ONE connection, write a request.approval line,
    // then read until newline and stash the bytes into a oneshot.
    let (server_reply_tx, server_reply_rx) =
        tokio::sync::oneshot::channel::<String>();
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        let (read_half, mut write_half) = sock.into_split();
        // Write a request.approval JSONL line.
        let req = r#"{"type":"request.approval","time":1.0,"correlation_id":"cid-roundtrip","plugin":"trust-pin","reason":"schema digest mismatch","phase":"trust-gate"}"#;
        write_half.write_all(req.as_bytes()).await.expect("write req");
        write_half.write_all(b"\n").await.expect("write nl");
        write_half.flush().await.expect("flush");

        // Read one line back from the inspector.
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.expect("read_line");
        assert!(n > 0, "expected inspector to write a response");
        let _ = server_reply_tx.send(line);
    });

    // Client side — open the bidirectional transport.
    let mut transport = Transport::try_spawn(Source::SocketControl(addr), 16)
        .await
        .expect("transport open");

    // Read the inbound request.approval event.
    let evt = transport.recv().await.expect("inbound event");
    let cid = match &evt {
        Event::RequestApproval { correlation_id, plugin, reason, .. } => {
            assert_eq!(plugin, "trust-pin");
            assert_eq!(reason, "schema digest mismatch");
            correlation_id.clone()
        }
        other => panic!("expected RequestApproval, got {:?}", other),
    };

    // Send an approve response back over the same socket.
    let cmd = ControlCommand::approval_response(&cid, ApprovalDecision::Approve, None);
    let line = cmd.to_line();
    transport
        .send_control(&line)
        .await
        .expect("send_control approve");

    // The server side should have received the response.
    let received = server_reply_rx.await.expect("server reply oneshot");
    let v: serde_json::Value = serde_json::from_str(received.trim()).expect("server reply parse");
    assert_eq!(v["kind"], "control.command");
    assert_eq!(v["command"], "approval.response");
    assert_eq!(v["correlation_id"], "cid-roundtrip");
    assert_eq!(v["decision"], "approve");

    let _ = server.await;
}

/// Read-only `Source::Socket` exposes a disconnected control writer — sending
/// returns NotConnected so misconfiguration is loud.
#[tokio::test]
async fn read_only_socket_rejects_send_control() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr").to_string();
    // Hold the accepted socket open so the connect succeeds; we don't write.
    let server = tokio::spawn(async move {
        let _accepted = listener.accept().await.expect("accept");
        // Hold open for the duration of the test.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    });

    let transport = Transport::try_spawn(Source::Socket(addr), 16)
        .await
        .expect("transport open");
    let err = transport
        .send_control("anything\n")
        .await
        .expect_err("read-only socket must reject send_control");
    assert_eq!(err.kind(), std::io::ErrorKind::NotConnected);
    let _ = server.await;
}

/// `Source::SocketControl` exposes a connected writer; `is_connected` reflects it.
#[tokio::test]
async fn control_socket_is_connected() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr").to_string();
    let server = tokio::spawn(async move {
        let (sock, _peer) = listener.accept().await.expect("accept");
        // Hold open.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        drop(sock);
    });

    let transport = Transport::try_spawn(Source::SocketControl(addr), 16)
        .await
        .expect("transport open");
    let writer = transport.writer();
    assert!(writer.is_connected().await, "writer must be connected for SocketControl");
    let _ = server.await;
}
