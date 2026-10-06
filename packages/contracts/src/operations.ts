export const transitions: Record<string, readonly string[]> = {
  preflight: ["downloading", "canceled", "failed"],
  downloading: ["verifying", "canceled", "failed"],
  verifying: ["staging", "canceled", "failed"],
  staging: ["installing", "canceled", "failed"],
  installing: ["checking", "recovery-required"],
  checking: ["committing", "recovery-required"],
  committing: ["installed", "recovery-required"],
  installed: [],
  canceled: [],
  failed: [],
  "recovery-required": [],
};
export function canTransition(from: string, to: string): boolean {
  return transitions[from]?.includes(to) ?? false;
}
export function isTerminal(stage: string): boolean {
  return Object.hasOwn(transitions, stage) && transitions[stage]?.length === 0;
}
export function reconcileStage(stage: string): string {
  if (!Object.hasOwn(transitions, stage))
    throw new Error("Unknown operation stage");
  if (isTerminal(stage)) return stage;
  return ["installing", "checking", "committing"].includes(stage)
    ? "recovery-required"
    : "failed";
}
