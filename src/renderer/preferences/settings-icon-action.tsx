import { Renderer } from "@freelensapp/extensions";
import { NativeTooltip } from "../native-tooltip";

export function SettingsIconAction({
  material,
  label,
  disabled = false,
  onClick,
}: {
  material: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <NativeTooltip title={label}>
      <button
        type="button"
        className="power-settings-icon-action"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <Renderer.Component.Icon material={material} size={18} />
      </button>
    </NativeTooltip>
  );
}
