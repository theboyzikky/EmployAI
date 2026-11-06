import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { ProductStory } from "@/components/landing/story/ProductStory";
import { Workforce } from "@/components/landing/Workforce";
import { WorkflowDemo } from "@/components/landing/WorkflowDemo";
import { Security } from "@/components/landing/Security";
import { Integrations } from "@/components/landing/Integrations";
import { Faq } from "@/components/landing/Faq";
import { FinalCta } from "@/components/landing/FinalCta";
import { Footer } from "@/components/landing/Footer";

// Landing page: a complete marketing site. The hero chat is optional; every section works without it.
export default function Home() {
  return (
    <>
      <Navbar />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <Hero />
        <HowItWorks />
        <ProductStory />
        <Workforce />
        <WorkflowDemo />
        <Security />
        <Integrations />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
