-- Intent qualification on by default.
--
-- Writing to people who never asked for anything is the failure mode the
-- feature exists to avoid, so it should be what somebody turns off
-- deliberately rather than what they remember to turn on.
--
-- 50 is taken from the measured spread rather than picked round: at a 72-hour
-- half-life a day-old "can anyone recommend a X" scores 56 and a fresh
-- unattributed grumble scores 42, so the bar sits in the gap between a request
-- and a complaint.
alter table public.outreach_campaigns
  alter column min_intent set default 50;

-- Existing campaigns were created before the column existed and would
-- otherwise keep selecting purely on resemblance forever.
update public.outreach_campaigns
set min_intent = 50
where min_intent is null;
