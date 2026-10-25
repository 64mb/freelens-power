import { observer } from "mobx-react";
import { AiPreferencesStore } from "../common/store/ai-preferences-store";
import { NativeTooltip } from "./native-tooltip";

import type { ButtonHTMLAttributes } from "react";

export const DiagnosticExplainButton = observer(function DiagnosticExplainButton(
  props: ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const enabled = AiPreferencesStore.getInstanceOrCreate<AiPreferencesStore>().enabled;
  return (
    <NativeTooltip title={enabled ? props.title : "Enable AI in Power settings to explain this finding"}>
      <button {...props} disabled={!enabled || props.disabled} />
    </NativeTooltip>
  );
});
