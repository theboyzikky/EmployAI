import { ArrowLeftIcon, ArrowRightIcon } from "@/components/icons";
import { ButtonLink } from "@/components/ui/Button";
import { Logo } from "@/components/ui/Logo";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo />
      <div>
        <h1 className="text-3xl font-bold tracking-[-0.02em] text-ink">We couldn&rsquo;t find that page</h1>
        <p className="mx-auto mt-3 max-w-md font-light text-muted">
          The link may be mistyped, or this conversation belongs to a different browser session.
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <ButtonLink href="/" variant="secondary" iconLeft={ArrowLeftIcon}>Back to home</ButtonLink>
        <ButtonLink href="/start" iconRight={ArrowRightIcon}>Start a new conversation</ButtonLink>
      </div>
    </main>
  );
}
