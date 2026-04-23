// Layout for /legal/* pages.
//
// Reuses the site nav + footer so legal pages feel part of the product,
// not an orphan 80s-stylesheet dump. Constrains text width for readability.

import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteNavbar />
      <main className="container mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <article className="prose prose-neutral max-w-none prose-headings:font-serif prose-h1:text-5xl prose-h1:font-semibold prose-h2:mt-12 prose-h2:text-2xl prose-h2:font-semibold prose-p:leading-relaxed prose-li:leading-relaxed">
          {children}
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
