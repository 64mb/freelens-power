import { Renderer } from "@freelensapp/extensions";

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
    <button
      type="button"
      className="power-settings-icon-action"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Renderer.Component.Icon material={material} size={18} />
    </button>
  );
}
