import type { ReactNode } from "react";
import { Reveal } from "@/components/motion/Reveal";
import { cx } from "@/lib/cx";

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-[1200px] px-6 lg:px-12", className)}>{children}</div>;
}

/** Section heading: eyebrow pill → Semibold title → Light supporting copy. */
export function SectionHeader({ eyebrow, title, intro, align = "center", id }: { eyebrow: string; title: ReactNode; intro?: ReactNode; align?: "center" | "left"; id?: string }) {
  return (
    <div className={cx("max-w-2xl", align === "center" && "mx-auto text-center")}>
      <Reveal><span className="eyebrow">{eyebrow}</span></Reveal>
      <Reveal delay={80}>
        <h2 id={id} className="mt-4 text-[1.875rem] font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[2.5rem]">{title}</h2>
      </Reveal>
      {intro && (
        <Reveal delay={160}>
          <p className="mt-4 text-[1.0625rem] font-light leading-relaxed text-muted sm:text-lg">{intro}</p>
        </Reveal>
      )}
    </div>
  );
}
