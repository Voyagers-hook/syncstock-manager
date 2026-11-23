-- Upcoming birthdays for the SyncStock dashboard (UK dates). 29 Feb birthdays fall on 28 Feb in non-leap years.
create or replace function public.member_birthdays(p_days int default 14)
returns table (member_id uuid, name text, child_name text, email text, tier text, date_of_birth date,
               next_birthday date, days_left int, turning int, photo_consent boolean)
language sql
stable
security definer
set search_path to 'public'
as $$
  with today as (select (now() at time zone 'Europe/London')::date as d),
  b as (
    select m.*, t.d,
      (select case when x < t.d then
                make_date(extract(year from t.d)::int + 1, extract(month from m.date_of_birth)::int,
                          least(extract(day from m.date_of_birth)::int,
                                extract(day from (make_date(extract(year from t.d)::int + 1, extract(month from m.date_of_birth)::int, 1) + interval '1 month - 1 day'))::int))
              else x end
       from (select make_date(extract(year from t.d)::int, extract(month from m.date_of_birth)::int,
                    least(extract(day from m.date_of_birth)::int,
                          extract(day from (make_date(extract(year from t.d)::int, extract(month from m.date_of_birth)::int, 1) + interval '1 month - 1 day'))::int)) as x) s) as nb
    from members m, today t
    where m.date_of_birth is not null and coalesce(m.status, 'active') <> 'cancelled'
  )
  select id, name, child_name, email, tier, date_of_birth, nb, (nb - d)::int,
         (extract(year from nb) - extract(year from date_of_birth))::int, photo_consent
  from b where (nb - d) between 0 and greatest(0, coalesce(p_days, 14))
  order by nb, name;
$$;

revoke all on function public.member_birthdays(int) from public, anon, authenticated;
