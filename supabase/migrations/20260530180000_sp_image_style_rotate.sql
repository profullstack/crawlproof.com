-- Allow "rotate" as an image_style preference (cycle through all styles,
-- one per post). Widens the CHECK constraint added in
-- 20260528220000_sp_image_style.sql.
alter table sp_project_config
  drop constraint if exists sp_project_config_image_style_check;

alter table sp_project_config
  add constraint sp_project_config_image_style_check
  check (
    image_style in (
      'editorial',
      'infographic',
      'quote_card',
      'diagram',
      'screenshot',
      'rotate'
    )
  );
