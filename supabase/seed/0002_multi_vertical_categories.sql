-- ══════════════════════════════════════════════════════════════════════
-- Seed: add cleaning, handyman, lawn care categories + backfill
-- moving's places_query_template / extraction_schema.
--
-- Run this AFTER 0001_service_categories.sql and migration 0005.
--
-- Design notes:
--
--   • extraction_schema carries *category-specific prompt augmentation*,
--     not the full quote shape. The universal quote shape (price_min,
--     price_max, includes, excludes, notes, etc.) is hardcoded in
--     lib/calls/extract-quote.ts — those columns already exist on the
--     `quotes` table. extraction_schema gives the LLM context like
--     "for cleaning, price is usually hourly" or "handymen rarely
--     quote without seeing the job."
--
--   • places_query_template: the Google Places textSearch is very
--     literal. "movers near 10001" works well; "cleaners near 10001"
--     is fine; "handyman near 10001" is a touch too narrow — prefer
--     "handyman services near 10001". Each template should include
--     {zip} OR {city}/{state} placeholders for the ingest CLI to fill.
-- ══════════════════════════════════════════════════════════════════════

-- 1. Backfill moving with the new columns.
update public.service_categories
set
  places_query_template = 'movers near {zip}',
  extraction_schema = jsonb_build_object(
    'domain_notes',
      'Movers quote either a flat rate OR an hourly rate with estimated hours. Both are common — capture whichever they gave. If they only quote after an in-home estimate, set requiresOnsiteEstimate=true and leave prices null.',
    'includes_examples', jsonb_build_array('# of movers', 'truck size', 'packing', 'basic liability', 'furniture assembly'),
    'excludes_examples', jsonb_build_array('stairs fee per flight', 'long-carry fee', 'fuel surcharge', 'packing materials'),
    'price_anchors',
      'Local 1BR: $400-900. Local 2-3BR: $900-2000. Interstate depends heavily on distance + weight.',
    'onsite_estimate_common', false
  )
where slug = 'moving';


-- 2. House cleaning.
insert into public.service_categories (
  name, slug, description, icon, is_active,
  intake_form_schema, call_script_template, disclosure_text,
  extraction_schema, places_query_template
) values (
  'House Cleaning',
  'cleaning',
  'Get quotes from local cleaning services — one-time or recurring.',
  'sparkles',
  true,

  jsonb_build_object(
    'version', 1,
    'steps', jsonb_build_array(
      jsonb_build_object(
        'id', 'location',
        'title', 'Where should we clean?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','address','label','Street address','type','text','required',true),
          jsonb_build_object('name','city','label','City','type','text','required',true),
          jsonb_build_object('name','state','label','State','type','us_state','required',true),
          jsonb_build_object('name','zip','label','ZIP','type','zip','required',true)
        )
      ),
      jsonb_build_object(
        'id', 'home',
        'title', 'About your home',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'name','home_size','label','Home size','type','select','required',true,
            'options', jsonb_build_array('Studio','1 bedroom','2 bedroom','3 bedroom','4 bedroom','5+ bedroom','Office / commercial')
          ),
          jsonb_build_object(
            'name','bathrooms','label','Bathrooms','type','select','required',true,
            'options', jsonb_build_array('1','1.5','2','2.5','3','3.5','4+')
          ),
          jsonb_build_object(
            'name','pets','label','Pets in the home?','type','select','required',false,
            'options', jsonb_build_array('None','Cats','Dogs','Both','Other')
          )
        )
      ),
      jsonb_build_object(
        'id', 'service',
        'title', 'What kind of clean?',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'name','cleaning_type','label','Type of cleaning','type','select','required',true,
            'options', jsonb_build_array('Standard','Deep clean','Move-in / move-out','Post-construction')
          ),
          jsonb_build_object(
            'name','frequency','label','How often?','type','select','required',true,
            'options', jsonb_build_array('One-time','Weekly','Every two weeks','Monthly')
          ),
          jsonb_build_object(
            'name','earliest_date','label','Earliest date that works','type','date','required',true
          ),
          jsonb_build_object(
            'name','extras','label','Any extras?','type','multiselect','required',false,
            'options', jsonb_build_array('Inside oven','Inside fridge','Inside windows','Laundry','Dishes','Baseboards')
          ),
          jsonb_build_object('name','additional_notes','label','Anything else?','type','textarea','required',false)
        )
      ),
      jsonb_build_object(
        'id', 'contact',
        'title', 'How should cleaners reach you?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','contact_name','label','Full name','type','text','required',true),
          jsonb_build_object('name','contact_phone','label','Phone','type','phone','required',true),
          jsonb_build_object('name','contact_email','label','Email','type','email','required',true)
        )
      )
    )
  ),

  $SCRIPT$
[DISCLOSURE — must be said first]
{{disclosure_text}}

[If they say yes, proceed:]

CUSTOMER DETAILS
- Location: {{city}}, {{state}} {{zip}}
- Home: {{home_size}}, {{bathrooms}} bathroom(s)
- Cleaning type: {{cleaning_type}}
- Frequency: {{frequency}}
- Earliest date: {{earliest_date}}
- Extras: {{extras}}
- Pets: {{pets}}
- Notes: {{additional_notes}}

GOALS
1. Confirm they service the area
2. Get a price: hourly rate OR flat per-clean rate
3. For recurring: confirm which frequencies they offer at what price
4. What's included at that price (bedrooms, bathrooms, kitchen, common)
5. Extras menu and individual prices (oven, fridge, windows, etc.)
6. Earliest available date for the first clean
7. Contact name for scheduling

RULES
- Under 3 minutes if possible
- Capture both hourly AND flat if they quote both
- Never make up prices
- "I'm with EvenQuote, an AI service that helps customers gather cleaning quotes"
  $SCRIPT$,

  'Hi — quick heads-up, this is an AI assistant calling on behalf of a customer who''s looking for a cleaning quote. Is that okay to continue?',

  jsonb_build_object(
    'domain_notes',
      'House cleaning is usually quoted as either a flat per-clean rate OR an hourly rate. Capture both if given. Recurring cleans (weekly/biweekly) are usually cheaper per visit than a one-time clean of the same home. Onsite estimates are rare for cleaning.',
    'includes_examples', jsonb_build_array('all bedrooms', 'all bathrooms', 'kitchen', 'common areas', 'supplies provided'),
    'excludes_examples', jsonb_build_array('inside oven', 'inside fridge', 'inside windows', 'laundry', 'dishes', 'exterior'),
    'price_anchors',
      'One-time 2BR standard clean: $120-220. Biweekly 2BR: $90-160/visit. Deep clean is typically 1.5-2x standard.',
    'onsite_estimate_common', false
  ),

  'house cleaning services near {zip}'
);


-- 3. Handyman.
insert into public.service_categories (
  name, slug, description, icon, is_active,
  intake_form_schema, call_script_template, disclosure_text,
  extraction_schema, places_query_template
) values (
  'Handyman',
  'handyman',
  'Get quotes from local handymen for small home jobs.',
  'wrench',
  true,

  jsonb_build_object(
    'version', 1,
    'steps', jsonb_build_array(
      jsonb_build_object(
        'id', 'location',
        'title', 'Where is the work?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','address','label','Street address','type','text','required',true),
          jsonb_build_object('name','city','label','City','type','text','required',true),
          jsonb_build_object('name','state','label','State','type','us_state','required',true),
          jsonb_build_object('name','zip','label','ZIP','type','zip','required',true)
        )
      ),
      jsonb_build_object(
        'id', 'job',
        'title', 'What do you need done?',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'name','job_type','label','Job category','type','select','required',true,
            'options', jsonb_build_array(
              'Mount / install','Assemble furniture','Minor electrical (fan, fixture)',
              'Minor plumbing (faucet, toilet)','Drywall repair','Painting (small area)',
              'Door / lock repair','Hang shelves / art','Yard cleanup','Other'
            )
          ),
          jsonb_build_object(
            'name','job_size','label','Rough size of job','type','select','required',true,
            'options', jsonb_build_array('Under an hour','1–2 hours','Half day','Full day','Multiple days')
          ),
          jsonb_build_object('name','job_description','label','Describe the job briefly','type','textarea','required',true),
          jsonb_build_object('name','ideal_date','label','Ideal date','type','date','required',true),
          jsonb_build_object('name','materials_needed','label','Do you need them to bring materials?','type','boolean','required',false)
        )
      ),
      jsonb_build_object(
        'id', 'contact',
        'title', 'How should handymen reach you?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','contact_name','label','Full name','type','text','required',true),
          jsonb_build_object('name','contact_phone','label','Phone','type','phone','required',true),
          jsonb_build_object('name','contact_email','label','Email','type','email','required',true)
        )
      )
    )
  ),

  $SCRIPT$
[DISCLOSURE — must be said first]
{{disclosure_text}}

[If they say yes, proceed:]

JOB DETAILS
- Location: {{city}}, {{state}} {{zip}}
- Type: {{job_type}}
- Rough size: {{job_size}}
- Description: {{job_description}}
- Ideal date: {{ideal_date}}
- Materials from them: {{materials_needed}}

GOALS
1. Confirm they take this kind of work
2. Price: hourly rate AND/OR estimated total for the job
3. Minimum service fee (many handymen have a 1-hour or 2-hour minimum)
4. Whether materials are included or added
5. Availability around the ideal date
6. Whether they'd need to see the job in person first

RULES
- Accept "I'd need to see it" as an answer — set requiresOnsiteEstimate=true
- Under 2 minutes if possible
- Never commit the customer to a booking
- "I'm with EvenQuote, an AI service that helps customers gather handyman quotes"
  $SCRIPT$,

  'Hi — quick heads-up, this is an AI assistant calling on behalf of a customer looking for a handyman quote. Is that okay to continue?',

  jsonb_build_object(
    'domain_notes',
      'Handymen usually quote an hourly rate ($50-100/hr) with a 1-2 hour minimum. Some will ballpark a flat total for a known job. Many will say "I need to see it" — capture that as requiresOnsiteEstimate=true with null prices rather than forcing a number.',
    'includes_examples', jsonb_build_array('labor', 'basic tools', 'small materials (screws, etc.)'),
    'excludes_examples', jsonb_build_array('major materials', 'permits', 'disposal fees'),
    'price_anchors',
      'Hourly: $50-100/hr typical. 1hr minimum common. Simple mount/assemble: $75-150. Complex install: $200-500+.',
    'onsite_estimate_common', true
  ),

  'handyman services near {zip}'
);


-- 4. Lawn care.
insert into public.service_categories (
  name, slug, description, icon, is_active,
  intake_form_schema, call_script_template, disclosure_text,
  extraction_schema, places_query_template
) values (
  'Lawn Care',
  'lawn-care',
  'Get quotes for mowing, maintenance, and seasonal yard work.',
  'leaf',
  true,

  jsonb_build_object(
    'version', 1,
    'steps', jsonb_build_array(
      jsonb_build_object(
        'id', 'location',
        'title', 'Where is the yard?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','address','label','Street address','type','text','required',true),
          jsonb_build_object('name','city','label','City','type','text','required',true),
          jsonb_build_object('name','state','label','State','type','us_state','required',true),
          jsonb_build_object('name','zip','label','ZIP','type','zip','required',true)
        )
      ),
      jsonb_build_object(
        'id', 'yard',
        'title', 'About your yard',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'name','lot_size','label','Lot size','type','select','required',true,
            'options', jsonb_build_array('Under 1/8 acre','1/8 – 1/4 acre','1/4 – 1/2 acre','1/2 – 1 acre','1 – 2 acres','2+ acres')
          ),
          jsonb_build_object(
            'name','service_type','label','Service type','type','multiselect','required',true,
            'options', jsonb_build_array('Mowing','Edging','Blowing / cleanup','Hedge trimming','Fertilizer / treatment','Leaf removal','Spring cleanup','Fall cleanup')
          ),
          jsonb_build_object(
            'name','frequency','label','How often?','type','select','required',true,
            'options', jsonb_build_array('One-time','Weekly','Every two weeks','Monthly','Seasonal contract')
          ),
          jsonb_build_object('name','start_date','label','Preferred start date','type','date','required',true),
          jsonb_build_object('name','additional_notes','label','Anything else?','type','textarea','required',false)
        )
      ),
      jsonb_build_object(
        'id', 'contact',
        'title', 'How should crews reach you?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','contact_name','label','Full name','type','text','required',true),
          jsonb_build_object('name','contact_phone','label','Phone','type','phone','required',true),
          jsonb_build_object('name','contact_email','label','Email','type','email','required',true)
        )
      )
    )
  ),

  $SCRIPT$
[DISCLOSURE — must be said first]
{{disclosure_text}}

[If they say yes, proceed:]

YARD DETAILS
- Location: {{city}}, {{state}} {{zip}}
- Lot size: {{lot_size}}
- Services needed: {{service_type}}
- Frequency: {{frequency}}
- Start date: {{start_date}}
- Notes: {{additional_notes}}

GOALS
1. Confirm they service the area
2. Price per visit for the requested services
3. For seasonal contracts: total season price OR monthly breakdown
4. What's included (single pass vs. full detail — edging, blowing)
5. Minimum visits or contract terms
6. Start date availability

RULES
- Under 2 minutes if possible
- Recurring lawn care is usually per-visit pricing; capture that rate
- Seasonal contracts are a separate number — capture both if quoted
- "I'm with EvenQuote, an AI service that helps customers gather lawn care quotes"
  $SCRIPT$,

  'Hi — quick heads-up, this is an AI assistant calling on behalf of a customer looking for a lawn care quote. Is that okay to continue?',

  jsonb_build_object(
    'domain_notes',
      'Lawn care is usually per-visit pricing. Seasonal contracts bundle a set number of visits for a flat total — capture both if offered. Mowing-only is cheaper than full-service (mow + edge + blow).',
    'includes_examples', jsonb_build_array('mowing', 'edging', 'blowing', 'bagging clippings'),
    'excludes_examples', jsonb_build_array('hedge trimming', 'fertilizer', 'leaf removal', 'extensive cleanup'),
    'price_anchors',
      'Per-visit mow under 1/4 acre: $35-60. 1/4-1/2 acre: $50-90. Seasonal contract typically 20-28 visits × per-visit rate.',
    'onsite_estimate_common', false
  ),

  'lawn care services near {zip}'
);
