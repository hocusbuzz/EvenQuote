// POST /auth/signout
//
// Using a POST route (not a GET link) so pre-fetchers and link crawlers
// can't accidentally sign a user out. The dashboard header renders a
// <form method="POST" action="/auth/signout"> which is progressive-
// enhancement friendly and works without JS.

import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/', request.url), { status: 303 });
}
