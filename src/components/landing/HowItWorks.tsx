import { Icon, ChatTextIcon, CompassIcon, UserCheckIcon, TreeStructureIcon } from "@/components/icons";
import { Container, SectionHeader } from "@/components/ui/Section";
import { Reveal } from "@/components/motion/Reveal";

const STEPS = [
  { icon: ChatTextIcon, title: "Describe your business", body: "Tell EmployAI what you do, how customers order and what slows you down — in your own words." },
  { icon: CompassIcon, title: "Discover your operations", body: "A business consultant asks focused follow-up questions and keeps a clear summary of what it has understood." },
  { icon: UserCheckIcon, title: "Review your AI workforce", body: "See the recommended team: what each agent does, which tools it may use, its limits and what it never does." },
  { icon: TreeStructureIcon, title: "Build, validate and approve workflows", body: "EmployAI generates the workflows and checks every step, then waits for your approval." },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="py-20 sm:py-28">
      <Container>
        <SectionHeader
          id="how-title"
          eyebrow="How EmployAI works"
          title="From a conversation to a working AI team"
          intro="No workflow builders, no code. You explain the business; EmployAI does the design work and asks for your approval at every step that matters."
        />
        <ol className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.title} delay={i * 80} className="card relative p-6">
              <span className="absolute right-5 top-5 text-sm font-semibold text-muted" aria-hidden="true">0{i + 1}</span>
              <span className="icon-tile">
                <Icon icon={s.icon} size={24} swap={false} />
              </span>
              <h3 className="mt-5 text-lg font-semibold text-ink">
                <span className="sr-only">Step {i + 1}: </span>{s.title}
              </h3>
              <p className="mt-2 text-[0.9375rem] font-light leading-relaxed text-muted">{s.body}</p>
            </Reveal>
          ))}
        </ol>
      </Container>
    </section>
  );
}
