import type { CSSProperties } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { cx } from "@/lib/cx";

export type IconState = "default" | "disabled";

type IconProps = {
  /** A Phosphor icon component, imported from "@/components/icons" (the only allowed source). */
  icon: PhosphorIcon;
  /** Pixel size; defaults to 20. */
  size?: number;
  /**
   * default  → Regular outline. It swaps to the SAME icon's Fill only when the icon sits inside an
   *            interactive element marked `.icon-host` (button, link, clickable card) that is hovered,
   *            focused, pressed, selected or expanded. Static icons therefore always stay Regular.
   * disabled → muted Regular, never swaps.
   */
  state?: IconState;
  /** Set to false where a Fill variant is not appropriate; colour then signals state. */
  swap?: boolean;
  /** Accessible name for a meaningful standalone icon. Omit for decorative icons (hidden from AT). */
  label?: string;
  className?: string;
};

/**
 * EmployAI's single icon primitive. It renders the Regular and Fill weights of the SAME Phosphor
 * glyph stacked on top of each other and cross-fades between them in CSS (globals.css → .eai-icon),
 * so it works in Server Components and needs no client JavaScript.
 */
export function Icon({ icon: Glyph, size = 20, state = "default", swap = true, label, className }: IconProps) {
  const style = { "--icon-size": `${size}px` } as CSSProperties;
  return (
    <span
      className={cx("eai-icon", className)}
      data-state={state}
      data-swap={swap ? "true" : "false"}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Glyph weight="regular" size={size} className="eai-icon-regular" aria-hidden="true" focusable="false" />
      {swap && <Glyph weight="fill" size={size} className="eai-icon-fill" aria-hidden="true" focusable="false" />}
    </span>
  );
}
