-- Retention (ROPA T-05, DEC-2026-10-27-002): il purge seleziona per data
-- pura, ma l'unico indice esistente su messages è il composito
-- (conversation_id, created_at) — inutilizzabile con la colonna guida
-- assente. Indici semplici per le tre scansioni del job giornaliero.

create index if not exists idx_messages_created_at
  on public.messages (created_at);

create index if not exists idx_conversations_last_message_at
  on public.conversations (last_message_at);

create index if not exists idx_contacts_updated_at
  on public.contacts (updated_at);
