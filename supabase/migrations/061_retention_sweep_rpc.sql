-- Retention sweep come RPC atomiche (review del branch feat/retention:
-- I1 cap PostgREST sulla verifica residui, I2 FK deals.conversation_id
-- senza azione che bloccherebbe il batch, I3 TOCTOU fra verifica e
-- delete, I4 cascate oltre il criterio ratificato).
--
-- Un'unica DELETE con i predicati nel WHERE: il NOT EXISTS è valutato
-- dal planner (niente select troncabile), verifica e cancellazione sono
-- lo stesso statement, e ciò che è agganciato a dati dal termine «da
-- definire» (deals, contact_notes — gate Piruzza) è ESCLUSO, non
-- incontrato dalla FK o distrutto per cascata.

create or replace function public.retention_sweep_conversations(cutoff timestamptz)
returns integer
language sql
security definer
set search_path = public
as $$
  with del as (
    delete from conversations c
    where c.last_message_at < cutoff
      and not exists (select 1 from messages m where m.conversation_id = c.id)
      and not exists (select 1 from deals d where d.conversation_id = c.id)
    returning 1
  )
  select count(*)::int from del;
$$;

create or replace function public.retention_sweep_contacts(cutoff timestamptz)
returns integer
language sql
security definer
set search_path = public
as $$
  with del as (
    delete from contacts c
    where c.updated_at < cutoff
      and not exists (select 1 from conversations v where v.contact_id = c.id)
      and not exists (select 1 from deals d where d.contact_id = c.id)
      and not exists (select 1 from contact_notes n where n.contact_id = c.id)
    returning 1
  )
  select count(*)::int from del;
$$;

-- Solo il job server-side può invocarle.
revoke all on function public.retention_sweep_conversations(timestamptz) from public, anon, authenticated;
revoke all on function public.retention_sweep_contacts(timestamptz) from public, anon, authenticated;
grant execute on function public.retention_sweep_conversations(timestamptz) to service_role;
grant execute on function public.retention_sweep_contacts(timestamptz) to service_role;
