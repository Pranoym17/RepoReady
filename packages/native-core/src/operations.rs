pub fn next(from: &str) -> Option<&'static [&'static str]> {
    match from {
        "preflight" => Some(&["downloading", "canceled", "failed"]),
        "downloading" => Some(&["verifying", "canceled", "failed"]),
        "verifying" => Some(&["staging", "canceled", "failed"]),
        "staging" => Some(&["installing", "canceled", "failed"]),
        "installing" => Some(&["checking", "recovery-required"]),
        "checking" => Some(&["committing", "recovery-required"]),
        "committing" => Some(&["installed", "recovery-required"]),
        "installed" | "canceled" | "failed" | "recovery-required" => Some(&[]),
        _ => None,
    }
}
pub fn can_transition(from: &str, to: &str) -> bool {
    next(from).is_some_and(|stages| stages.contains(&to))
}
pub fn reconcile(stage: &str) -> Result<&str, &'static str> {
    let stages = next(stage).ok_or("Unknown stage")?;
    if stages.is_empty() {
        return Ok(stage);
    }
    Ok(
        if ["installing", "checking", "committing"].contains(&stage) {
            "recovery-required"
        } else {
            "failed"
        },
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crashes_never_invent_success() {
        assert!(!can_transition("preflight", "installed"));
        assert!(!can_transition("installing", "canceled"));
        assert!(can_transition("checking", "committing"));
        assert_eq!(reconcile("installing"), Ok("recovery-required"));
        assert_eq!(reconcile("downloading"), Ok("failed"));
        assert_eq!(reconcile("installed"), Ok("installed"));
        assert!(reconcile("unknown").is_err());
    }
}
