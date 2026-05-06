//! Control — outbound commands the inspector sends to the runtime.
//!
//! v0.5 #4 introduces a bidirectional control channel: the same TCP socket
//! that delivers JSONL events also accepts JSONL commands going the other
//! direction. The first (and only) command shape is `approval.response`,
//! emitted in reply to a `request.approval` event so the orchestrator's
//! trust-gate phase can resume.
//!
//! Direction is inferred from `kind`. Inbound events carry `type`; outbound
//! commands carry `kind: "control.command"`. Keeping the discriminator
//! distinct lets the runtime route on a single socket without ambiguity.

use serde::{Deserialize, Serialize};

/// Two-state decision the inspector returns for a pending approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    Approve,
    Veto,
}

/// Outbound `approval.response` command. Echoes the `correlation_id` from the
/// inbound `request.approval` so the runtime can match the response to the
/// pending await.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum ControlCommandBody {
    #[serde(rename = "approval.response")]
    ApprovalResponse {
        correlation_id: String,
        decision: ApprovalDecision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// Outbound command envelope. Always carries `kind: "control.command"` so the
/// runtime's read half can distinguish commands from events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlCommand {
    /// Discriminator. Always `"control.command"`. Lives at the top level so
    /// JSONL readers can branch on `kind` without parsing the body.
    pub kind: ControlKind,
    #[serde(flatten)]
    pub body: ControlCommandBody,
}

/// Singleton-ish enum so serde emits the literal string `"control.command"`
/// (avoids stringly-typed mistakes at construction sites).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlKind {
    #[serde(rename = "control.command")]
    ControlCommand,
}

impl ControlCommand {
    /// Build an `approval.response` command for a given correlation_id.
    pub fn approval_response(
        correlation_id: impl Into<String>,
        decision: ApprovalDecision,
        reason: Option<String>,
    ) -> Self {
        Self {
            kind: ControlKind::ControlCommand,
            body: ControlCommandBody::ApprovalResponse {
                correlation_id: correlation_id.into(),
                decision,
                reason,
            },
        }
    }

    /// Serialize to a single JSONL line (no trailing `\n` — caller appends).
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("serialize ControlCommand never fails")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_response_approve_serializes_to_expected_shape() {
        let cmd = ControlCommand::approval_response("cid-1", ApprovalDecision::Approve, None);
        let line = cmd.to_line();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["kind"], "control.command");
        assert_eq!(v["command"], "approval.response");
        assert_eq!(v["correlation_id"], "cid-1");
        assert_eq!(v["decision"], "approve");
        // reason omitted when None.
        assert!(v.get("reason").is_none());
    }

    #[test]
    fn approval_response_veto_with_reason_serializes_with_reason() {
        let cmd = ControlCommand::approval_response(
            "cid-2",
            ApprovalDecision::Veto,
            Some("schema mismatch".into()),
        );
        let line = cmd.to_line();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["decision"], "veto");
        assert_eq!(v["reason"], "schema mismatch");
    }
}
