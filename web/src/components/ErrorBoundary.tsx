import { Component, type ReactNode } from "react";

/**
 * Catches an error thrown while rendering the page below it and shows one line with a way home, so
 * an unexpected failure is never a blank page. A plain link: it reloads the app, whatever state broke.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="view">
        <p className="note" role="alert">
          Something went wrong showing this page. <a href="/">Go to the home page</a>.
        </p>
      </div>
    );
  }
}
