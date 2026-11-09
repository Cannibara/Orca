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
        <div className="state err" role="alert">
          <span className="ic" aria-hidden="true">
            <svg className="ico" viewBox="0 0 16 16">
              <path d="M8 2.5 14 13H2L8 2.5z" />
              <path d="M8 6.75v3M8 11.4v.01" />
            </svg>
          </span>
          <p>
            Something went wrong showing this page. <a href="/">Go to the home page</a>.
          </p>
        </div>
      </div>
    );
  }
}
