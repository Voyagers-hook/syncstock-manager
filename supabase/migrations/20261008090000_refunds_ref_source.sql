-- Support auto-captured refunds: a dedup reference per platform and a source flag.
alter table refunds add column if not exists refund_ref text;
alter table refunds add column if not exists source text;
create unique index if not exists refunds_platform_ref_uidx on refunds(platform, refund_ref) where refund_ref is not null;
