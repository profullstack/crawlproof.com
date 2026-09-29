-- The campaign autopilot is gone (route, runner and UI removed). Its tick
-- would now 404 every fifteen minutes, so the schedule goes too.
--
-- The campaign tables and their run history stay: they are the record of
-- what was sent, and dropping them would buy nothing.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'crawlproof-outreach') then
    perform cron.unschedule('crawlproof-outreach');
  end if;
end $$;
