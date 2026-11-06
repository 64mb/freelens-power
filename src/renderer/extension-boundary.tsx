import { Common } from "@freelensapp/extensions";
import { Component, type ReactNode } from "react";

export class ExtensionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    Common.logger.warn("[Freelens Power] a component could not render");
  }

  render(): ReactNode {
    return this.state.failed ? (
      <span role="alert">Freelens Power could not display this view</span>
    ) : (
      this.props.children
    );
  }
}
