-- Brand profile gains an image style. Each value maps to a different
-- prompt template in lib/sp/imageGen.ts:
--   editorial   — single focal photographic/illustrative subject
--   infographic — two-panel comparison, bold headline, on-image text
--   quote_card  — minimalist text-forward card with a pulled headline
--   diagram     — labelled flow / architecture diagram
--   screenshot  — fake-product-UI mockup look

alter table public.sp_project_config
  add column if not exists image_style text not null default 'editorial'
    check (image_style in ('editorial','infographic','quote_card','diagram','screenshot'));
