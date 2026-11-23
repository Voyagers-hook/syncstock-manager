-- ============================================================
-- Hook Club sign-up points, added automatically.
--   Cast 100, Little Voyagers 100, Strike 300, Specimen 500.
-- Given when a member is created (any route except the old-sheet import, which already
-- carried its own points), and topped up to the difference when a member moves to a
-- higher plan. Points stay locked until the first completed purchase (points_status).
-- Manual "New Member" / "Sign Up Bonus" entries already given count towards the total,
-- so nobody is paid twice.
-- ============================================================

create or replace function public.signup_bonus_for(p_tier text)
returns int language sql immutable as $$
  select case lower(coalesce(p_tier, ''))
    when 'cast' then 100 when 'little_voyagers' then 100
    when 'strike' then 300 when 'specimen' then 500 else 0 end
$$;

create or replace function public.award_signup_bonus(p_member uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $$
declare m members%rowtype; target int; done int; give int; nb int;
begin
  select * into m from members where id = p_member for update;
  if not found then return 0; end if;
  target := signup_bonus_for(m.tier);
  select coalesce(sum(change), 0) into done from points_ledger
   where member_id = p_member and change > 0
     and (reason = 'signup'
          or (reason = 'manual' and (note ilike '%new member%' or note ilike '%sign up%' or note ilike '%signup%' or note ilike '%joining%')));
  give := target - done;
  if give <= 0 then return 0; end if;
  if exists (select 1 from points_ledger where ref = 'signup:' || p_member || ':' || lower(m.tier)) then return 0; end if;
  update members set points_balance = coalesce(points_balance, 0) + give, updated_at = now()
   where id = p_member returning points_balance into nb;
  insert into points_ledger (member_id, change, reason, ref, balance_after, note)
  values (p_member, give, 'signup', 'signup:' || p_member || ':' || lower(m.tier), nb,
          case when done = 0 then initcap(replace(m.tier, '_', ' ')) || ' sign-up bonus'
               else 'Upgrade to ' || initcap(replace(m.tier, '_', ' ')) || ' bonus' end);
  return give;
end $$;

revoke all on function public.award_signup_bonus(uuid) from public, anon, authenticated;

create or replace function public.trg_signup_bonus()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  begin   -- never let the bonus stop a member being created or updated
    if tg_op = 'INSERT' then
      if coalesce(new.source, '') <> 'sheet' then perform award_signup_bonus(new.id); end if;
    elsif new.tier is distinct from old.tier and signup_bonus_for(new.tier) > signup_bonus_for(old.tier) then
      perform award_signup_bonus(new.id);
    end if;
  exception when others then
    insert into sync_log (sync_type, status, source, error_message) values ('points_signup', 'failed', 'trigger', new.email || ': ' || sqlerrm);
  end;
  return null;
end $$;

drop trigger if exists trg_members_signup_bonus on public.members;
create trigger trg_members_signup_bonus
  after insert or update of tier on public.members
  for each row execute function public.trg_signup_bonus();
