-- Competitor prices: store the matched eBay listing title (so you can see what was
-- compared) and when it was checked (drives the daily refresh + staleness skip).
alter table competitor_prices add column if not exists title text;
alter table competitor_prices add column if not exists checked_at timestamptz default now();
