create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'ticket_status') then
    create type public.ticket_status as enum (
      'available',
      'held',
      'reserved_pending_payment',
      'paid_confirmed',
      'conflict'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'reservation_status') then
    create type public.reservation_status as enum (
      'held',
      'reserved_pending_payment',
      'paid_confirmed',
      'released',
      'expired',
      'conflict'
    );
  end if;
end $$;

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  access_token text not null default encode(gen_random_bytes(24), 'hex'),
  status public.reservation_status not null default 'held',
  buyer_name text not null,
  buyer_phone text not null,
  buyer_email text,
  notes text,
  hold_expires_at timestamptz not null,
  reserved_at timestamptz not null default timezone('utc', now()),
  paid_at timestamptz,
  payment_validated_by text,
  released_at timestamptz,
  release_reason text,
  conflict_reason text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.tickets (
  id bigserial primary key,
  number integer not null unique check (number between 1 and 300),
  status public.ticket_status not null default 'available',
  active_reservation_id uuid references public.reservations(id) on delete set null,
  buyer_name text,
  buyer_phone text,
  buyer_email text,
  hold_expires_at timestamptz,
  reserved_at timestamptz,
  paid_at timestamptz,
  payment_validated_by text,
  notes text,
  conflict_note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.reservation_tickets (
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  ticket_number integer not null references public.tickets(number),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (reservation_id, ticket_number)
);

create table if not exists public.ticket_events (
  id bigserial primary key,
  reservation_id uuid references public.reservations(id) on delete set null,
  ticket_number integer not null,
  event_type text not null,
  event_at timestamptz not null default timezone('utc', now()),
  actor text not null,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists idx_tickets_status on public.tickets(status);
create index if not exists idx_tickets_active_reservation on public.tickets(active_reservation_id);
create index if not exists idx_reservations_status on public.reservations(status);
create index if not exists idx_reservations_hold_expires_at on public.reservations(hold_expires_at);
create index if not exists idx_ticket_events_ticket_number on public.ticket_events(ticket_number, event_at desc);
create index if not exists idx_ticket_events_reservation_id on public.ticket_events(reservation_id, event_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_reservations_updated_at on public.reservations;
create trigger trg_reservations_updated_at
before update on public.reservations
for each row
execute function public.set_updated_at();

drop trigger if exists trg_tickets_updated_at on public.tickets;
create trigger trg_tickets_updated_at
before update on public.tickets
for each row
execute function public.set_updated_at();

insert into public.tickets (number)
select series_number
from generate_series(1, 300) as series_number
on conflict (number) do nothing;

create or replace function public.log_reservation_ticket_event(
  p_reservation_id uuid,
  p_event_type text,
  p_actor text,
  p_detail jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ticket_events (
    reservation_id,
    ticket_number,
    event_type,
    actor,
    detail
  )
  select
    rt.reservation_id,
    rt.ticket_number,
    p_event_type,
    p_actor,
    coalesce(p_detail, '{}'::jsonb)
  from public.reservation_tickets rt
  where rt.reservation_id = p_reservation_id;
$$;

create or replace function public.release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation_ids uuid[];
  v_count integer := 0;
begin
  select coalesce(array_agg(id), '{}'::uuid[])
  into v_reservation_ids
  from (
    select r.id
    from public.reservations r
    where r.status in ('held', 'reserved_pending_payment')
      and r.hold_expires_at <= timezone('utc', now())
    for update skip locked
  ) expired_reservations;

  if array_length(v_reservation_ids, 1) is null then
    return 0;
  end if;

  insert into public.ticket_events (
    reservation_id,
    ticket_number,
    event_type,
    actor,
    detail
  )
  select
    rt.reservation_id,
    rt.ticket_number,
    'released_expired',
    'system',
    jsonb_build_object('reason', 'expired_30min')
  from public.reservation_tickets rt
  where rt.reservation_id = any(v_reservation_ids);

  update public.tickets
  set
    status = 'available',
    active_reservation_id = null,
    buyer_name = null,
    buyer_phone = null,
    buyer_email = null,
    hold_expires_at = null,
    reserved_at = null,
    paid_at = null,
    payment_validated_by = null,
    notes = null,
    conflict_note = null
  where active_reservation_id = any(v_reservation_ids)
    and status in ('held', 'reserved_pending_payment');

  update public.reservations
  set
    status = 'expired',
    released_at = timezone('utc', now()),
    release_reason = 'expired_30min'
  where id = any(v_reservation_ids);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.create_reservation_hold(
  p_numbers integer[],
  p_buyer_name text,
  p_buyer_phone text,
  p_buyer_email text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_numbers integer[];
  v_unavailable integer[];
  v_reservation_id uuid;
  v_reservation_code text;
  v_access_token text;
  v_hold_expires_at timestamptz := timezone('utc', now()) + interval '30 minutes';
begin
  perform public.release_expired_reservations();

  select array_agg(distinct number_value order by number_value)
  into v_numbers
  from unnest(p_numbers) as number_value;

  if array_length(v_numbers, 1) is null then
    return jsonb_build_object(
      'ok', false,
      'message', 'Debes seleccionar al menos un número.'
    );
  end if;

  if exists (
    select 1
    from unnest(v_numbers) as number_value
    where number_value < 1 or number_value > 300
  ) then
    return jsonb_build_object(
      'ok', false,
      'message', 'Hay números fuera del rango 001-300.'
    );
  end if;

  if trim(coalesce(p_buyer_name, '')) = '' or trim(coalesce(p_buyer_phone, '')) = '' then
    return jsonb_build_object(
      'ok', false,
      'message', 'Nombre y teléfono son obligatorios.'
    );
  end if;

  perform 1
  from public.tickets
  where number = any(v_numbers)
  order by number
  for update;

  select coalesce(array_agg(number order by number), '{}'::integer[])
  into v_unavailable
  from public.tickets
  where number = any(v_numbers)
    and status <> 'available';

  if array_length(v_unavailable, 1) is not null then
    return jsonb_build_object(
      'ok', false,
      'message', 'Uno o más números ya no están disponibles.',
      'unavailable_numbers', v_unavailable
    );
  end if;

  insert into public.reservations (
    status,
    buyer_name,
    buyer_phone,
    buyer_email,
    notes,
    hold_expires_at
  )
  values (
    'held',
    trim(p_buyer_name),
    trim(p_buyer_phone),
    nullif(trim(coalesce(p_buyer_email, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    v_hold_expires_at
  )
  returning id, reservation_code, access_token
  into v_reservation_id, v_reservation_code, v_access_token;

  insert into public.reservation_tickets (reservation_id, ticket_number)
  select v_reservation_id, number_value
  from unnest(v_numbers) as number_value;

  update public.tickets
  set
    status = 'held',
    active_reservation_id = v_reservation_id,
    buyer_name = trim(p_buyer_name),
    buyer_phone = trim(p_buyer_phone),
    buyer_email = nullif(trim(coalesce(p_buyer_email, '')), ''),
    hold_expires_at = v_hold_expires_at,
    reserved_at = timezone('utc', now()),
    notes = nullif(trim(coalesce(p_notes, '')), '')
  where number = any(v_numbers);

  perform public.log_reservation_ticket_event(
    v_reservation_id,
    'hold_created',
    'public',
    jsonb_build_object(
      'buyer_name', trim(p_buyer_name),
      'buyer_phone', trim(p_buyer_phone)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'message', 'Reserva creada y números bloqueados por 30 minutos.',
    'reservation', jsonb_build_object(
      'id', v_reservation_id,
      'reservation_code', v_reservation_code,
      'access_token', v_access_token,
      'status', 'held',
      'buyer_name', trim(p_buyer_name),
      'buyer_phone', trim(p_buyer_phone),
      'buyer_email', nullif(trim(coalesce(p_buyer_email, '')), ''),
      'notes', nullif(trim(coalesce(p_notes, '')), ''),
      'hold_expires_at', v_hold_expires_at,
      'numbers', v_numbers
    )
  );
end;
$$;

create or replace function public.get_public_reservation(
  p_reservation_id uuid,
  p_access_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  perform public.release_expired_reservations();

  select jsonb_build_object(
    'ok', true,
    'reservation', jsonb_build_object(
      'id', r.id,
      'reservation_code', r.reservation_code,
      'status', r.status,
      'buyer_name', r.buyer_name,
      'buyer_phone', r.buyer_phone,
      'buyer_email', r.buyer_email,
      'notes', r.notes,
      'hold_expires_at', r.hold_expires_at,
      'reserved_at', r.reserved_at,
      'paid_at', r.paid_at,
      'payment_validated_by', r.payment_validated_by,
      'release_reason', r.release_reason,
      'conflict_reason', r.conflict_reason,
      'numbers', coalesce((
        select jsonb_agg(rt.ticket_number order by rt.ticket_number)
        from public.reservation_tickets rt
        where rt.reservation_id = r.id
      ), '[]'::jsonb)
    )
  )
  into v_payload
  from public.reservations r
  where r.id = p_reservation_id
    and r.access_token = p_access_token;

  if v_payload is null then
    return jsonb_build_object(
      'ok', false,
      'message', 'La reserva no existe o ya no está disponible.'
    );
  end if;

  return v_payload;
end;
$$;

create or replace function public.admin_update_reservation_status(
  p_reservation_id uuid,
  p_action text,
  p_actor text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform public.release_expired_reservations();

  select *
  into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'message', 'La reserva no fue encontrada.'
    );
  end if;

  case p_action
    when 'mark_pending' then
      if v_reservation.status not in ('held', 'reserved_pending_payment') then
        return jsonb_build_object(
          'ok', false,
          'message', 'Solo reservas activas pueden pasar a pendiente de pago.'
        );
      end if;

      update public.reservations
      set
        status = 'reserved_pending_payment'
      where id = p_reservation_id;

      update public.tickets
      set
        status = 'reserved_pending_payment'
      where active_reservation_id = p_reservation_id
        and status in ('held', 'reserved_pending_payment');

      perform public.log_reservation_ticket_event(
        p_reservation_id,
        'payment_pending',
        coalesce(trim(p_actor), 'admin'),
        jsonb_build_object('note', v_note)
      );

      return jsonb_build_object(
        'ok', true,
        'message', 'Reserva marcada como pendiente de validación.'
      );

    when 'confirm_payment' then
      if v_reservation.status in ('released', 'expired') then
        return jsonb_build_object(
          'ok', false,
          'message', 'La reserva ya fue liberada o expiró.'
        );
      end if;

      update public.reservations
      set
        status = 'paid_confirmed',
        paid_at = timezone('utc', now()),
        payment_validated_by = coalesce(trim(p_actor), 'admin'),
        hold_expires_at = null
      where id = p_reservation_id;

      update public.tickets
      set
        status = 'paid_confirmed',
        paid_at = timezone('utc', now()),
        payment_validated_by = coalesce(trim(p_actor), 'admin'),
        hold_expires_at = null
      where active_reservation_id = p_reservation_id;

      perform public.log_reservation_ticket_event(
        p_reservation_id,
        'payment_confirmed',
        coalesce(trim(p_actor), 'admin'),
        jsonb_build_object('note', v_note)
      );

      return jsonb_build_object(
        'ok', true,
        'message', 'Pago confirmado correctamente.'
      );

    when 'release' then
      if v_reservation.status = 'paid_confirmed' then
        return jsonb_build_object(
          'ok', false,
          'message', 'No se puede liberar una reserva ya pagada.'
        );
      end if;

      if v_reservation.status in ('released', 'expired') then
        return jsonb_build_object(
          'ok', false,
          'message', 'La reserva ya fue liberada previamente.'
        );
      end if;

      update public.reservations
      set
        status = 'released',
        released_at = timezone('utc', now()),
        release_reason = coalesce(v_note, 'manual_release')
      where id = p_reservation_id;

      update public.tickets
      set
        status = 'available',
        active_reservation_id = null,
        buyer_name = null,
        buyer_phone = null,
        buyer_email = null,
        hold_expires_at = null,
        reserved_at = null,
        paid_at = null,
        payment_validated_by = null,
        notes = null,
        conflict_note = null
      where active_reservation_id = p_reservation_id;

      perform public.log_reservation_ticket_event(
        p_reservation_id,
        'released_manual',
        coalesce(trim(p_actor), 'admin'),
        jsonb_build_object('note', v_note)
      );

      return jsonb_build_object(
        'ok', true,
        'message', 'Reserva liberada manualmente.'
      );

    when 'mark_conflict' then
      update public.reservations
      set
        status = 'conflict',
        hold_expires_at = null,
        conflict_reason = coalesce(v_note, 'Conflicto marcado manualmente')
      where id = p_reservation_id;

      update public.tickets
      set
        status = 'conflict',
        hold_expires_at = null,
        conflict_note = coalesce(v_note, 'Conflicto marcado manualmente')
      where active_reservation_id = p_reservation_id;

      perform public.log_reservation_ticket_event(
        p_reservation_id,
        'marked_conflict',
        coalesce(trim(p_actor), 'admin'),
        jsonb_build_object('note', v_note)
      );

      return jsonb_build_object(
        'ok', true,
        'message', 'Reserva marcada como conflicto.'
      );

    else
      return jsonb_build_object(
        'ok', false,
        'message', 'Acción administrativa no soportada.'
      );
  end case;
end;
$$;

create or replace view public.ticket_public_view as
select
  t.number,
  lpad(t.number::text, 3, '0') as label,
  t.status,
  t.hold_expires_at
from public.tickets t;

create or replace view public.ticket_admin_view as
select
  t.number,
  lpad(t.number::text, 3, '0') as label,
  t.status,
  t.hold_expires_at,
  t.active_reservation_id,
  t.buyer_name,
  t.buyer_phone,
  t.paid_at,
  t.payment_validated_by,
  t.updated_at
from public.tickets t;

create or replace view public.reservation_admin_view as
select
  r.id,
  r.reservation_code,
  r.status,
  r.buyer_name,
  r.buyer_phone,
  r.buyer_email,
  r.notes,
  r.hold_expires_at,
  r.reserved_at,
  r.paid_at,
  r.payment_validated_by,
  r.released_at,
  r.release_reason,
  r.conflict_reason,
  coalesce(
    array_agg(rt.ticket_number order by rt.ticket_number) filter (where rt.ticket_number is not null),
    '{}'::integer[]
  ) as numbers,
  coalesce(string_agg(lpad(rt.ticket_number::text, 3, '0'), '-' order by rt.ticket_number), '') as numbers_label,
  count(rt.ticket_number) as ticket_count
from public.reservations r
left join public.reservation_tickets rt on rt.reservation_id = r.id
group by r.id;

create or replace view public.ticket_events_view as
select
  e.id,
  e.reservation_id,
  r.reservation_code,
  r.buyer_name,
  r.buyer_phone,
  e.ticket_number,
  e.event_type,
  e.actor,
  e.event_at,
  e.detail
from public.ticket_events e
left join public.reservations r on r.id = e.reservation_id;

alter table public.reservations enable row level security;
alter table public.tickets enable row level security;
alter table public.reservation_tickets enable row level security;
alter table public.ticket_events enable row level security;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule(jobid)
      from cron.job
      where jobname = 'ccs_release_expired_reservations';
    exception
      when undefined_table or invalid_schema_name then
        null;
    end;

    perform cron.schedule(
      'ccs_release_expired_reservations',
      '* * * * *',
      $cron$select public.release_expired_reservations();$cron$
    );
  end if;
exception
  when undefined_function or invalid_schema_name then
    raise notice 'pg_cron no disponible, se mantiene liberación por acceso a la app.';
end $$;
