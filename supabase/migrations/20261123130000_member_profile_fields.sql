-- Sign-up form details copied from MailerLite by members-mailerlite-sync.
alter table public.members
  add column if not exists parent_name text,
  add column if not exists child_name text,
  add column if not exists date_of_birth date,
  add column if not exists fishing_style text,
  add column if not exists photo_consent boolean,
  add column if not exists location text;
