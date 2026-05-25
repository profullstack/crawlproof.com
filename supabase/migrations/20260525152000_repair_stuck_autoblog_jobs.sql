-- Repair rows stranded while backend AI usage limits were exhausted or
-- while worker notifications were unreliable. The application now runs
-- the same repair logic continuously, but this unblocks existing rows
-- across all sites on deploy.

update public.lx_article
   set status = 'ready',
       webhook_last_error = 'recovered from stuck publishing'
 where status = 'publishing'
   and updated_at < now() - interval '10 minutes';

update public.lx_keyword
   set status = 'published'
 where status = 'generating'
   and article_id is not null;

update public.lx_keyword
   set status = 'queued'
 where status = 'generating'
   and article_id is null
   and updated_at < now() - interval '10 minutes';

update public.lx_guest_post_request
   set status = 'queued',
       error_text = null
 where status = 'generating'
   and updated_at < now() - interval '10 minutes';

update public.lx_guest_post_request
   set status = 'queued',
       error_text = null
 where status = 'failed'
   and error_text ~* '(specified API usage limits|usage limits|rate.?limit)';
