# Template images (deploy copies)

These are the images the server sends back as auto-replies. They are
copies of the canonical files in
`~/workspace/your_files/whatsapp-auto-reply-templates/` — that folder is
the original; this folder is what gets deployed to Render.

- `prayer-request.jpg` — sent for prayer requests
- `offering-thanks.jpg` — sent for offerings
- `joining-welcome.jpg` — sent for new members wanting to join
  (the serif "Praise the Lord sister!" image, confirmed by Sujitha
  2026-11-20 evening)

**Templates change once a month.** When Sujitha sends new ones, replace
the files in BOTH folders (the canonical folder and this one), then
`git push` — Render redeploys automatically and picks up the new images.
No code change is ever needed for a template change.
