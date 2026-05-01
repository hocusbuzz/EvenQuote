// /get-quotes/[category]
//
// Dynamic dispatcher for category-specific intake. Server component:
//   - Looks up service_categories by slug (404s on miss).
//   - Renders the right client shell depending on whether the vertical
//     is "live" (real intake form) or "deferred" (waitlist capture).
//
// Route priority: specific routes (checkout, claim, success) win over
// this dynamic segment in Next's router, so those paths keep working.
//
// Adding a new live vertical = add its slug to LIVE_FORMS and write
// the matching IntakeFormShell. Adding a waitlist-only vertical = just
// seed the category; this page handles it automatically.

import { notFound } from 'next/navigation';
import { SiteNavbar } from '@/components/site/navbar';
import { SiteFooter } from '@/components/site/footer';
import { createAdminClient } from '@/lib/supabase/admin';
import { IntakeFormShell } from '@/components/get-quotes/form-shell';
import { CleaningFormShell } from '@/components/get-quotes/cleaning-form-shell';
import { HandymanFormShell } from '@/components/get-quotes/handyman-form-shell';
import { LawnCareFormShell } from '@/components/get-quotes/lawn-care-form-shell';
import { JunkRemovalFormShell } from '@/components/get-quotes/junk-removal-form-shell';
import { WaitlistCapture } from '@/components/get-quotes/waitlist-capture';
import { UtmCapture } from '@/components/get-quotes/utm-capture';

// Force per-request SSR. Without this, Next.js may statically generate the
// page at build time. If the build sandbox can't reach Supabase, the
// resulting page will 404 every category forever (we 404 on miss). Sibling
// /get-quotes/page.tsx hit the same staleness bug at launch.
export const dynamic = 'force-dynamic';

// Map of slug → live intake shell. Anything not in here renders the
// waitlist capture using the category's name + description.
const LIVE_FORMS: Record<string, React.ComponentType> = {
  moving: IntakeFormShell,
  cleaning: CleaningFormShell,
  handyman: HandymanFormShell,
  'lawn-care': LawnCareFormShell,
  'junk-removal': JunkRemovalFormShell,
};

type CategoryRow = {
  name: string;
  slug: string;
  description: string | null;
};

export async function generateMetadata({
  params,
}: {
  params: { category: string };
}) {
  const category = await loadCategory(params.category);
  if (!category) return { title: 'Get quotes — EvenQuote' };
  const live = params.category in LIVE_FORMS;
  return {
    title: `${category.name} quotes — EvenQuote`,
    description: live
      ? `Tell us about your ${category.name.toLowerCase()}. We'll call the pros and send you the numbers.`
      : `Join the waitlist — we'll email you when ${category.name.toLowerCase()} goes live.`,
  };
}

export default async function CategoryIntakePage({
  params,
}: {
  params: { category: string };
}) {
  const category = await loadCategory(params.category);
  if (!category) notFound();

  const live = params.category in LIVE_FORMS;
  const Shell = LIVE_FORMS[params.category];

  return (
    <>
      <SiteNavbar />
      <UtmCapture />
      <main className="container max-w-2xl py-12 sm:py-16">
        <div className="mb-8">
          <p className="label-eyebrow mb-2">{category.name} quote</p>
          {live ? (
            <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
              Let's get you some numbers.
            </h1>
          ) : null}
        </div>

        {live ? (
          <Shell />
        ) : (
          <WaitlistCapture
            categorySlug={category.slug}
            categoryName={category.name}
            description={
              category.description ??
              "We'll call local pros for you once this category ships."
            }
          />
        )}

        {live ? (
          <p className="mt-10 text-center text-xs text-muted-foreground">
            Progress is saved in your browser. Close this tab — it'll be here when you come back.
          </p>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}

async function loadCategory(slug: string): Promise<CategoryRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('service_categories')
    .select('name, slug, description')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !data) return null;
  return data as CategoryRow;
}
