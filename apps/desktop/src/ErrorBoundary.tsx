import { Component, type ReactNode } from "react";
import { text } from "./strings";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="fatal-state" role="alert">
          <h1>{text.renderErrorTitle}</h1>
          <p>{text.renderError}</p>
          <button onClick={() => window.location.reload()}>
            Reload RepoReady
          </button>
        </main>
      );
    return this.props.children;
  }
}
