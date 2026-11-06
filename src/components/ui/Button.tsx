import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Icon } from "@/components/icons";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { cx } from "@/lib/cx";

type Variant = "primary" | "secondary";
type Size = "sm" | "md" | "lg";

type Common = {
  variant?: Variant;
  size?: Size;
  /** Trailing icon (Regular → Fill on hover via .icon-host). */
  iconRight?: PhosphorIcon;
  iconLeft?: PhosphorIcon;
  children: ReactNode;
  className?: string;
};

const classes = (variant: Variant, size: Size, className?: string) =>
  cx("btn icon-host", `btn-${variant}`, size === "lg" && "btn-lg", size === "sm" && "btn-sm", className);
const iconSize = (size: Size) => (size === "lg" ? 20 : 18);

function Inner({ iconLeft, iconRight, size, children }: Pick<Common, "iconLeft" | "iconRight" | "children"> & { size: Size }) {
  return (
    <>
      {iconLeft && <Icon icon={iconLeft} size={iconSize(size)} />}
      <span>{children}</span>
      {iconRight && <Icon icon={iconRight} size={iconSize(size)} />}
    </>
  );
}

/** A link styled as a button (navigation). */
export function ButtonLink({ href, variant = "primary", size = "md", iconLeft, iconRight, children, className, ...rest }: Common & Omit<ComponentProps<typeof Link>, "className" | "children">) {
  return (
    <Link href={href} className={classes(variant, size, className)} {...rest}>
      <Inner iconLeft={iconLeft} iconRight={iconRight} size={size}>{children}</Inner>
    </Link>
  );
}

/** A real <button> (actions). */
export function Button({ variant = "primary", size = "md", iconLeft, iconRight, children, className, type = "button", ...rest }: Common & Omit<ComponentProps<"button">, "className" | "children">) {
  return (
    <button type={type} className={classes(variant, size, className)} {...rest}>
      <Inner iconLeft={iconLeft} iconRight={iconRight} size={size}>{children}</Inner>
    </button>
  );
}
