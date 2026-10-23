import { observer } from "mobx-react";
import { AiPreferencesStore } from "../common/store/ai-preferences-store";

import type { ButtonHTMLAttributes } from "react";

export const DiagnosticExplainButton = observer(function DiagnosticExplainButton(
  props: ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const enabled = AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>().enabled;
  return (
    <button
      {...props}
      disabled={!enabled || props.disabled}
      title={enabled ? props.title : "Enable AI in Power settings to explain this finding"}
    />
  );
});
