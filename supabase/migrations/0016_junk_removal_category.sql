-- ══════════════════════════════════════════════════════════════════════
-- Seed: junk removal / haul-away service category (Tier 0b — top new pick).
--
-- Why this vertical: huge demand variance ($75–$1,500 per load) + zero
-- transparent online pricing + customers stressed (clearing parent's
-- house, post-renovation). Perfect AI-fit — volume bucket + heavy-item
-- Y/N → ballpark in 4 questions. See docs/IMPROVEMENT_BACKLOG.md §B1.
--
-- Mirrors the shape of the lawn-care + handyman seed entries from
-- supabase/seed/0002_multi_vertical_categories.sql (extracted into a
-- migration here because the seed file is post-launch unmaintained
-- and we don't re-run it on every deploy).
--
-- Idempotent — `on conflict (slug) do nothing` so a re-run is a no-op.
-- The frontend (lib/forms/junk-removal-intake.ts + steps + shell)
-- mirrors this JSONB schema; if you edit one, update the other.
-- ══════════════════════════════════════════════════════════════════════

insert into public.service_categories (
  name, slug, description, icon, is_active,
  intake_form_schema, call_script_template, disclosure_text,
  extraction_schema, places_query_template
) values (
  'Junk Removal',
  'junk-removal',
  'Get quotes for haul-away — single items, full loads, post-reno cleanouts.',
  'trash-2',
  true,

  jsonb_build_object(
    'version', 1,
    'steps', jsonb_build_array(
      jsonb_build_object(
        'id', 'location',
        'title', 'Where is the pickup?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','address','label','Street address','type','text','required',true),
          jsonb_build_object('name','city','label','City','type','text','required',true),
          jsonb_build_object('name','state','label','State','type','us_state','required',true),
          jsonb_build_object('name','zip','label','ZIP','type','zip','required',true)
        )
      ),
      jsonb_build_object(
        'id', 'load',
        'title', 'About the load',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'name','volume_bucket','label','Roughly how much?','type','select','required',true,
            'options', jsonb_build_array('Single couch / armchair','Pickup-truck load','Half a truck','Full truck','Multiple loads')
          ),
          jsonb_build_object(
            'name','heavy_items','label','Any heavy / specialty items?','type','multiselect','required',false,
            'options', jsonb_build_array('Piano','Hot tub','Appliances (fridge / washer)','Construction debris','Yard waste','Mattress / box spring','Electronics / TVs')
          ),
          jsonb_build_object(
            'name','pickup_location','label','Where is it?','type','select','required',true,
            'options', jsonb_build_array('Curb / driveway','Garage','Inside the home — ground floor','Inside the home — upstairs')
          ),
          jsonb_build_object(
            'name','same_day_needed','label','Need it gone today?','type','boolean','required',false
          ),
          jsonb_build_object('name','preferred_date','label','Preferred pickup date','type','date','required',true),
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

PICKUP DETAILS
- Location: {{city}}, {{state}} {{zip}}
- Volume: {{volume_bucket}}
- Heavy / specialty items: {{heavy_items}}
- Where it is: {{pickup_location}}
- Same-day needed: {{same_day_needed}}
- Preferred date: {{preferred_date}}
- Notes: {{additional_notes}}

GOALS
1. Confirm they service the area
2. Price for the volume + items described — flat OR per-truckload
3. Surcharges: heavy items (piano, hot tub, fridges, mattresses,
   construction debris all commonly priced separately)
4. Stair / interior-access fees if pickup is upstairs / inside
5. Same-day availability + earliest day they could come otherwise
6. Whether they recycle / donate vs. landfill (some customers care)

RULES
- Under 2 minutes if possible
- Junk removal pricing varies wildly with the heavy items — capture
  base + every surcharge separately so the report is honest
- "I'm with EvenQuote, an AI service that helps customers gather
  junk removal quotes"
  $SCRIPT$,

  'Hi — quick heads-up, this is an AI assistant calling on behalf of a customer looking for a junk removal quote. Is that okay to continue?',

  jsonb_build_object(
    'domain_notes',
      'Junk removal is volume-bucket priced (couch / pickup / half-truck / full-truck / multi-load). Heavy items (piano, hot tub, fridges, construction debris, mattresses) are almost always surcharged on top of the base. Interior / upstairs pickup adds labor fees. Capture base + each surcharge.',
    'includes_examples', jsonb_build_array('haul-away', 'loading', 'disposal fee', 'curbside pickup'),
    'excludes_examples', jsonb_build_array('hazardous waste', 'paint / chemicals', 'asbestos', 'tires (sometimes)'),
    'price_anchors',
      'Single item: $75-$150. Pickup-truck load: $150-$350. Half-truck: $250-$500. Full truck: $400-$800. Multi-load / cleanouts: $800-$1,500+. Heavy item surcharges: piano $150-$400, hot tub $200-$500, fridge / appliance $50-$100 each.',
    'onsite_estimate_common', false
  ),

  'junk removal services near {zip}'
)
on conflict (slug) do nothing;
