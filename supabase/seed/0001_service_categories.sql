-- ══════════════════════════════════════════════════════════════════════
-- Seed: service_categories
-- Phase 1 ships with just "Moving". More categories in later phases.
-- ══════════════════════════════════════════════════════════════════════

insert into public.service_categories (
  name, slug, description, icon, intake_form_schema, call_script_template, disclosure_text
) values (
  'Moving',
  'moving',
  'Get quotes from local moving companies for your upcoming move.',
  'truck',
  -- intake_form_schema: consumed by the multi-step form in Phase 4.
  -- Each step is an ordered list of fields; `type` drives the UI
  -- component; `validation` is a hint for Zod schema generation.
  jsonb_build_object(
    'version', 1,
    'steps', jsonb_build_array(
      jsonb_build_object(
        'id', 'origin',
        'title', 'Where are you moving from?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','origin_address','label','Street address','type','text','required',true),
          jsonb_build_object('name','origin_city','label','City','type','text','required',true),
          jsonb_build_object('name','origin_state','label','State','type','us_state','required',true),
          jsonb_build_object('name','origin_zip','label','ZIP code','type','zip','required',true)
        )
      ),
      jsonb_build_object(
        'id', 'destination',
        'title', 'Where are you moving to?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','destination_address','label','Street address','type','text','required',true),
          jsonb_build_object('name','destination_city','label','City','type','text','required',true),
          jsonb_build_object('name','destination_state','label','State','type','us_state','required',true),
          jsonb_build_object('name','destination_zip','label','ZIP code','type','zip','required',true)
        )
      ),
      jsonb_build_object(
        'id', 'details',
        'title', 'Tell us about your move',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'name','home_size','label','Home size','type','select','required',true,
            'options', jsonb_build_array(
              'Studio','1 bedroom','2 bedroom','3 bedroom','4 bedroom','5+ bedroom','Office / commercial'
            )
          ),
          jsonb_build_object('name','move_date','label','Preferred move date','type','date','required',true),
          jsonb_build_object('name','flexible_dates','label','Are your dates flexible?','type','boolean','required',false),
          jsonb_build_object(
            'name','special_items','label','Any special items?',
            'type','multiselect','required',false,
            'options', jsonb_build_array('Piano','Safe','Artwork','Antiques','Pool table','Hot tub','Vehicle','Gym equipment')
          ),
          jsonb_build_object('name','additional_notes','label','Anything else?','type','textarea','required',false)
        )
      ),
      jsonb_build_object(
        'id', 'contact',
        'title', 'How should movers reach you?',
        'fields', jsonb_build_array(
          jsonb_build_object('name','contact_name','label','Full name','type','text','required',true),
          jsonb_build_object('name','contact_phone','label','Phone','type','phone','required',true),
          jsonb_build_object('name','contact_email','label','Email','type','email','required',true)
        )
      )
    )
  ),
  -- call_script_template: rendered by Phase 7 with {{placeholders}}.
  -- The AI-disclosure line is the FIRST thing said; other opener
  -- content comes after confirmation.
  $SCRIPT$
[DISCLOSURE — must be said first, verbatim or close to it]
{{disclosure_text}}

[If they say yes, or ask what this is about, proceed:]

CUSTOMER DETAILS
- Moving from: {{origin_city}}, {{origin_state}} {{origin_zip}}
- Moving to: {{destination_city}}, {{destination_state}} {{destination_zip}}
- Home size: {{home_size}}
- Move date: {{move_date}}
- Special items: {{special_items}}
- Additional notes: {{additional_notes}}

GOALS (in priority order)
1. Confirm they service the customer's area
2. Get a ballpark price estimate (a range is fine)
3. Ask about availability around the requested date
4. Ask what's included (number of movers, truck size, packing, insurance)
5. Ask about any additional fees or surcharges
6. Get the best contact name and method for follow-up

RULES
- Be concise — aim for under 3 minutes
- If they only quote after an in-home estimate, capture what the process is
- If they ask who you're with: "I'm with EvenQuote, an AI service that helps customers gather moving quotes"
- Never make up info or prices
- Never agree to anything on the customer's behalf
- If they ask to be removed from future calls, acknowledge and confirm you'll flag their number; end the call politely
- If hostile, apologize once and end the call

OPENER (after disclosure is accepted)
"Thanks! They're planning to move a {{home_size}} from {{origin_city}} to {{destination_city}} around {{move_date}}. Do you have a quick moment to help with a ballpark estimate?"
  $SCRIPT$,
  'Hi — quick heads-up, this is an AI assistant calling on behalf of a customer who''s looking for a moving quote. Is that okay to continue?'
);
