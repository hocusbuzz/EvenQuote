-- ══════════════════════════════════════════════════════════════════════
-- Seed: businesses (20 fake moving companies)
-- All phones use +1 555-01XX (North American reserved fictional range,
-- safe for development — will never route to a real line).
-- Spread across 5 real SoCal ZIP codes for realistic location queries.
-- ══════════════════════════════════════════════════════════════════════

with moving_cat as (
  select id from public.service_categories where slug = 'moving'
)
insert into public.businesses (
  name, phone, email, website, category_id,
  city, state, zip_code, latitude, longitude,
  google_rating, google_review_count, google_place_id, is_active
)
select
  name, phone, email, website, (select id from moving_cat),
  city, state, zip_code, latitude, longitude,
  rating, reviews, place_id, true
from (values
  -- San Diego, 92101
  ('Pacific Breeze Movers',       '+15550100', 'hello@pacificbreezemovers.test',  'https://example.test/pbm',   'San Diego',  'CA', '92101', 32.7157, -117.1611, 4.8, 342, 'seed_place_001'),
  ('Harbor City Moving Co',       '+15550101', 'book@harborcitymoving.test',      'https://example.test/hcm',   'San Diego',  'CA', '92101', 32.7180, -117.1650, 4.6, 128, 'seed_place_002'),
  ('Gaslamp Express Movers',      '+15550102', null,                               'https://example.test/gem',   'San Diego',  'CA', '92101', 32.7110, -117.1595, 4.2,  76, 'seed_place_003'),
  ('Sunset Cliffs Moving',        '+15550103', 'quotes@sunsetcliffs.test',        null,                         'San Diego',  'CA', '92101', 32.7200, -117.1700, 4.9, 512, 'seed_place_004'),

  -- Carlsbad, 92008
  ('North County Movers',         '+15550104', 'info@northcountymovers.test',     'https://example.test/ncm',   'Carlsbad',   'CA', '92008', 33.1581, -117.3506, 4.7, 203, 'seed_place_005'),
  ('Coastal Haul & Co',           '+15550105', null,                               'https://example.test/coastal','Carlsbad',  'CA', '92008', 33.1600, -117.3470, 4.4,  89, 'seed_place_006'),
  ('Carlsbad Family Moving',      '+15550106', 'team@carlsbadfamily.test',        null,                         'Carlsbad',   'CA', '92008', 33.1550, -117.3530, 4.5, 145, 'seed_place_007'),

  -- Encinitas, 92024
  ('Seaside Professional Movers', '+15550107', 'go@seasidepro.test',              'https://example.test/seaside','Encinitas', 'CA', '92024', 33.0370, -117.2920, 4.6, 167, 'seed_place_008'),
  ('Leucadia Moving Group',       '+15550108', null,                               null,                         'Encinitas',  'CA', '92024', 33.0400, -117.2950, 4.1,  54, 'seed_place_009'),

  -- Los Angeles, 90014
  ('Downtown LA Movers',          '+15550109', 'dispatch@dtlamovers.test',        'https://example.test/dtla',  'Los Angeles','CA', '90014', 34.0430, -118.2540, 4.3, 421, 'seed_place_010'),
  ('City of Angels Relocation',   '+15550110', 'hello@coarelocation.test',        'https://example.test/coa',   'Los Angeles','CA', '90014', 34.0450, -118.2510, 4.7, 892, 'seed_place_011'),
  ('Sunset Boulevard Movers',     '+15550111', null,                               'https://example.test/sbm',   'Los Angeles','CA', '90014', 34.0400, -118.2580, 4.0, 238, 'seed_place_012'),
  ('Golden State Moving',         '+15550112', 'quote@goldenstatemoving.test',    null,                         'Los Angeles','CA', '90014', 34.0410, -118.2560, 4.8, 611, 'seed_place_013'),

  -- San Francisco, 94103
  ('Bay Area Premier Movers',     '+15550113', 'book@bayareapremier.test',        'https://example.test/bapm',  'San Francisco','CA','94103', 37.7749, -122.4194, 4.6, 734, 'seed_place_014'),
  ('Golden Gate Moving Co',       '+15550114', 'hi@goldengatemoving.test',        'https://example.test/ggm',   'San Francisco','CA','94103', 37.7760, -122.4180, 4.5, 389, 'seed_place_015'),
  ('SOMA Swift Movers',           '+15550115', null,                               null,                         'San Francisco','CA','94103', 37.7780, -122.4170, 4.2, 112, 'seed_place_016'),
  ('Mission District Relocation', '+15550116', 'moves@missionrelo.test',          'https://example.test/mdr',   'San Francisco','CA','94103', 37.7730, -122.4160, 4.9, 456, 'seed_place_017'),

  -- A few that we flag as inactive or historical — useful for testing
  -- filters later. Still 92101 but is_active overridden below.
  ('Old Town Movers (retired)',   '+15550117', null,                               null,                         'San Diego',  'CA', '92101', 32.7540, -117.1980, 3.8,  45, 'seed_place_018'),

  -- Two more spread across zips for volume
  ('Palomar Peak Movers',         '+15550118', 'contact@palomarpeak.test',        null,                         'Carlsbad',   'CA', '92008', 33.1570, -117.3490, 4.4,  98, 'seed_place_019'),
  ('Oceanside-to-Anywhere',       '+15550119', 'go@ota-movers.test',              'https://example.test/ota',   'Carlsbad',   'CA', '92008', 33.1610, -117.3510, 4.3, 156, 'seed_place_020')
) as t(name, phone, email, website, city, state, zip_code, latitude, longitude, rating, reviews, place_id);

-- Flag the "retired" business as inactive so queries filtering on
-- is_active have a negative case to exercise.
update public.businesses set is_active = false where google_place_id = 'seed_place_018';
