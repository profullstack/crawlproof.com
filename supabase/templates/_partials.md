# CrawlProof email templates

These HTML files are uploaded to Supabase via `supabase config push` and
override the default GoTrue email content. Supabase exposes a handful of
template variables; the ones we use:

| Variable | Meaning |
|---|---|
| `{{ .ConfirmationURL }}` | Pre-built verification link (already includes our `redirect_to`) |
| `{{ .Email }}` | Recipient's email |
| `{{ .Token }}` | 6-digit OTP (alternative to clicking the link) |
| `{{ .SiteURL }}` | Site URL as configured in Auth settings |
| `{{ .Data.* }}` | Any user_metadata passed at sign-up |

To preview locally, render the template with sample values in any HTML
viewer. To deploy, run `supabase config push --linked` from the repo root.

Brand palette is kept in `supabase/templates/_styles.html` style block
(inlined per template — Gmail strips `<style>` in `<head>` and many
clients drop external CSS). Keep the inlined styles in sync across
templates.
